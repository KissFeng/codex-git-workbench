import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { checkoutRoot, git, runGitCommand } from './git-status.mjs';
import { safePath } from './repo-path.mjs';

const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const metadataFormat = '%H%x00%P%x00%an%x00%aI%x00%s';
const pageLimit = 100;
const offsetLimit = 10_000_000;
const referenceLimit = 10_000;
const snapshotLimit = 32;
const snapshotBudget = 32 * 1024 * 1024;
const snapshots = new Map();
let snapshotBytes = 0;
const referenceName = /^refs\/(heads|remotes|tags)\/(.+)$/;
const referenceKinds = { heads: 'branch', remotes: 'remote', tags: 'tag' };
const fileLimit = 1000;
const blameLimit = 2000;
const diffLimit = 512 * 1024;
const messageLimit = 64 * 1024;
const diffOptions = ['--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '--submodule=short'];
const logOptions = ['--no-show-signature', '--no-notes', '--no-ext-diff', '--no-textconv', '--no-color', '--encoding=UTF-8'];

function repositoryPath(root, path) {
  if (path === undefined) return undefined;
  const normalized = relative(root, safePath(root, path));
  if (!normalized) throw new Error('Invalid repository-relative file path.');
  return normalized;
}

async function optionalGit(root, ...args) {
  try {
    return await git(root, ...args);
  } catch (error) {
    if (error.code !== 1) throw error;
    return null;
  }
}

async function revision(root, value, optional = false) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /^-|[:\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Invalid Git revision.');
  }
  const id = (await optionalGit(root, 'rev-parse', '--verify', '--quiet', '--end-of-options', value + '^{commit}'))?.trim();
  if (objectId.test(id)) return id;
  if (optional) return null;
  throw new Error('Git revision does not identify a commit: ' + value);
}

async function commonBase(root, head, upstream) {
  return (await optionalGit(root, 'merge-base', head, upstream))?.trim() ?? null;
}

async function divergence(root, head, upstream) {
  if (!head || !upstream) return { ahead: 0, behind: 0, base: null };
  const [counts, base] = await Promise.all([
    git(root, 'rev-list', '--left-right', '--count', head + '...' + upstream),
    commonBase(root, head, upstream),
  ]);
  const [ahead, behind] = counts.trim().split(/\s+/).map(Number);
  return { ahead, behind, base };
}

function commitRecord([id, parentIds, author, date, subject]) {
  return {
    id, parents: parentIds ? parentIds.split(' ') : [], author: author.slice(0, 512),
    date, subject: subject.slice(0, 4096), refs: [], relation: 'other',
  };
}

function parseLog(output) {
  const fields = output.split('\0');
  const commits = [];
  for (let index = 0; index + 5 < fields.length; index += 5) {
    commits.push(commitRecord(fields.slice(index, index + 5)));
  }
  return commits;
}

async function readReferences(root) {
  const output = await optionalGit(root, 'show-ref', '--dereference') ?? '';
  const refs = new Map();
  for (const line of output.split('\n')) {
    const [id, fullName] = line.split(' ');
    if (!fullName || !objectId.test(id)) continue;
    const ref = fullName.replace(/\^\{\}$/, '');
    const match = referenceName.exec(ref);
    if (match) refs.set(ref, { id, label: { name: match[2], kind: referenceKinds[match[1]], ref } });
  }
  return { refs, bytes: output.length * 2 + refs.size * 160 };
}

function decorate(commits, head, refs) {
  if (!commits.length) return;
  const byId = new Map(commits.map(commit => [commit.id, commit]));
  byId.get(head)?.refs.push({ name: 'HEAD', kind: 'head', ref: 'HEAD' });
  for (const { id, label } of refs.values()) {
    const commit = byId.get(id);
    if (commit && commit.refs.length < 64) commit.refs.push({ ...label });
  }
}

const reaches = async (root, id, tip) => !!tip &&
  (id === tip || await optionalGit(root, 'merge-base', '--is-ancestor', id, tip) !== null);

async function assignRelations(root, commits, head, upstream, counts) {
  if (!commits.length) return;
  if (counts && head && (!upstream || head === upstream)) {
    for (const commit of commits) commit.relation = upstream ? 'shared' : 'local';
    return;
  }
  // The default walk is within the two tips' ancestry. Its shared commits are
  // the complement of the symmetric difference, which is usually small.
  if (counts && head && upstream && counts.ahead + counts.behind <= 10_000) {
    const output = await git(root, 'rev-list', '--left-right', head + '...' + upstream);
    const relations = new Map(output.trimEnd().split('\n').map(line => [
      line.slice(1), line[0] === '<' ? 'ahead' : 'behind',
    ]));
    for (const commit of commits) commit.relation = relations.get(commit.id) ?? 'shared';
    return;
  }
  for (let index = 0; index < commits.length; index += 12) {
    await Promise.all(commits.slice(index, index + 12).map(async commit => {
      const [inHead, inUpstream] = await Promise.all([
        reaches(root, commit.id, head),
        head === upstream ? false : reaches(root, commit.id, upstream),
      ]);
      if (inHead) commit.relation = !upstream ? 'local' : inUpstream || head === upstream ? 'shared' : 'ahead';
      else if (inUpstream) commit.relation = 'behind';
    }));
  }
}

function selectedReferences(refs) {
  if (refs === undefined) return undefined;
  if (!Array.isArray(refs) || refs.length > referenceLimit) throw new Error('Invalid Git history references.');
  const selected = [...new Set(refs)];
  if (selected.some(ref =>
    typeof ref !== 'string' || ref.length > 1024 || (ref !== 'HEAD' && !referenceName.test(ref)))) {
    throw new Error('Invalid Git history references.');
  }
  return selected.sort();
}

function continueHistory(cursor, { root, ref, selected, scope, path, offset }) {
  const match = typeof cursor === 'string' && /^([a-f0-9-]{36})_(\d{1,8})$/.exec(cursor);
  const snapshotId = match?.[1];
  const next = Number(match?.[2]);
  const snapshot = snapshots.get(snapshotId);
  if (!snapshot || snapshot.root !== root || next < 1 || next > offsetLimit ||
      (offset !== undefined && offset !== next) || (ref !== undefined && ref !== snapshot.ref) ||
      (selected !== undefined && (selected.length !== snapshot.selected.length || selected.some((name, index) => name !== snapshot.selected[index]))) ||
      (scope !== undefined && scope !== snapshot.scope) || (path !== undefined && path !== snapshot.path)) {
    throw new Error('Invalid Git history cursor.');
  }
  snapshots.delete(snapshotId);
  snapshots.set(snapshotId, snapshot);
  return { snapshot, snapshotId, skip: next };
}

function saveSnapshot(snapshot) {
  while (snapshots.size && (snapshots.size === snapshotLimit || snapshotBytes + snapshot.bytes > snapshotBudget)) {
    const [id, oldest] = snapshots.entries().next().value;
    snapshotBytes -= oldest.bytes;
    snapshots.delete(id);
  }
  const id = randomUUID();
  snapshots.set(id, snapshot);
  snapshotBytes += snapshot.bytes;
  return id;
}

async function commitTips(root, ids) {
  if (!ids.length) return [];
  const { stdout } = await runGitCommand(root, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
    input: ids.join('\n') + '\n',
  });
  return stdout.split('\n').filter(line => line.endsWith(' commit')).map(line => line.slice(0, -7));
}

async function historySnapshot({ root, ref, selected = [], scope = 'auto', path }) {
  const [head, upstream, start, { refs, bytes }] = await Promise.all([
    revision(root, 'HEAD', true),
    revision(root, '@{upstream}', true),
    ref === undefined || selected.length ? null : revision(root, ref),
    readReferences(root),
  ]);
  let starts = start ? [start] : path ? [head] : [head, upstream];
  if (selected.length) {
    starts = selected.map(name => name === 'HEAD' ? head : refs.get(name)?.id);
    const commits = new Set(await commitTips(root, [...new Set(starts.filter(Boolean))]));
    const invalid = selected.find((name, index) => !commits.has(starts[index]));
    if (invalid) throw new Error('Git history reference does not identify a commit: ' + invalid);
  } else if (scope === 'all' && !start) {
    const ids = [...new Set([...refs.values()].map(({ id }) => id))];
    starts = [head, upstream, ...await commitTips(root, ids)];
  }
  const counts = await divergence(root, head, upstream);
  return { root, head, upstream, starts: [...new Set(starts.filter(Boolean))], ref, selected, scope, path, refs, counts, bytes };
}

export async function gitHistory({ repoPath = process.cwd(), limit = 50, offset, cursor, ref, refs, scope, path }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > pageLimit) throw new Error('History limit must be between 1 and ' + pageLimit + '.');
  if (offset !== undefined && (!Number.isInteger(offset) || offset < 0 || offset > offsetLimit)) throw new Error('Invalid history offset.');
  if (scope !== undefined && scope !== 'auto' && scope !== 'all') throw new Error('Invalid Git history scope.');
  const selected = selectedReferences(refs);
  const root = await checkoutRoot(repoPath);
  const query = { root, ref, selected, scope, path: repositoryPath(root, path), offset };
  const { snapshot, snapshotId, skip } = cursor === undefined
    ? { snapshot: await historySnapshot(query), skip: offset ?? 0 }
    : continueHistory(cursor, query);
  const { head, upstream, starts, counts, path: file } = snapshot;
  // Feed resolved IDs on stdin so repositories with many refs stay within argv limits.
  const args = ['log', ...logOptions, '--topo-order', '-z', '--format=' + metadataFormat,
    '--max-count=' + (limit + 1), '--skip=' + skip, ...(file ? ['--follow'] : []), '--stdin', '--', ...(file ? [file] : [])];
  const commits = starts.length ? parseLog((await runGitCommand(root, args, { input: starts.join('\n') + '\n' })).stdout) : [];
  const followingOffset = skip + limit;
  const nextOffset = commits.length > limit && followingOffset <= offsetLimit ? followingOffset : null;
  commits.length = Math.min(commits.length, limit);
  decorate(commits, head, snapshot.refs);
  const withinTips = starts.every(tip => tip === head || tip === upstream);
  await assignRelations(root, commits, head, upstream, withinTips ? counts : undefined);
  const cursorId = nextOffset === null ? null : snapshots.has(snapshotId) ? snapshotId : saveSnapshot(snapshot);
  return {
    commits, ...counts, head, upstream, nextOffset,
    cursor: cursorId === null ? null : cursorId + '_' + nextOffset,
  };
}

function changedFiles(output) {
  const fields = output.split('\0');
  const files = [];
  for (let index = 0; index + 1 < fields.length;) {
    const status = fields[index++][0];
    const first = fields[index++];
    if (status === 'R' || status === 'C') files.push({ path: fields[index++], originalPath: first, status });
    else files.push({ path: first, status });
  }
  return files;
}

async function diffResult(root, command, endpoints, path) {
  const output = await git(root, ...command, ...diffOptions, '--name-status', '-z', ...endpoints, '--');
  const matches = file => file && (file === path || file.startsWith(path + '/'));
  const allFiles = changedFiles(output);
  const files = path === undefined ? allFiles : allFiles.filter(file => matches(file.path) || matches(file.originalPath));
  const result = { files: files.slice(0, fileLimit) };
  if (files.length > fileLimit) result.filesTruncated = true;
  if (path === undefined) return result;
  if (result.filesTruncated) return { ...result, diffTruncated: true };
  const counterparts = files.filter(file => file.originalPath)
    .map(file => matches(file.path) ? file.originalPath : file.path)
    .filter(file => !matches(file));
  const paths = [...new Set([path, ...counterparts])];
  try {
    const diff = await git(root, ...command, ...diffOptions, '--patch', '--unified=3', ...endpoints, '--', ...paths);
    if (Buffer.byteLength(diff) > diffLimit) result.diffTruncated = true;
    else result.diff = diff;
  } catch (error) {
    if (error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw error;
    result.diffTruncated = true;
  }
  return result;
}

export async function gitHistoryDetail({ repoPath = process.cwd(), commit, path, parent }) {
  const root = await checkoutRoot(repoPath);
  const file = repositoryPath(root, path);
  const id = await revision(root, commit);
  const output = await git(root, 'log', ...logOptions, '-1', '-z', '--format=' + metadataFormat + '%x00%B', id, '--');
  const fields = output.split('\0');
  const record = commitRecord(fields);
  const message = fields[5].replace(/\n$/, '');
  const [head, upstream] = await Promise.all([revision(root, 'HEAD', true), revision(root, '@{upstream}', true)]);
  let parentId = record.parents[0];
  if (parent !== undefined) {
    parentId = Number.isInteger(parent) ? record.parents[parent - 1] : await revision(root, parent);
    if (!record.parents.includes(parentId)) throw new Error('Selected parent is not a parent of this commit.');
  }
  const [changes] = await Promise.all([
    diffResult(root, parentId ? ['diff'] : ['diff-tree', '--root', '--no-commit-id', '-r'], parentId ? [parentId, id] : [id], file),
    readReferences(root).then(({ refs }) => decorate([record], head, refs)),
    assignRelations(root, [record], head, upstream),
  ]);
  const messageBytes = Buffer.from(message);
  return {
    commit: record, message: messageBytes.subarray(0, messageLimit).toString('utf8'), ...changes,
    ...(messageBytes.length > messageLimit ? { messageTruncated: true } : {}),
  };
}

export async function gitHistoryStats({ repoPath = process.cwd(), commit }) {
  const root = await checkoutRoot(repoPath);
  const id = await revision(root, commit);
  const output = await git(root, 'log', ...logOptions, '--find-renames', '--submodule=short', '-1',
    '--format=tformat:%b', '--root', '--diff-merges=first-parent', '--numstat', '-z', id, '--');
  // Git emits the commit body, a NUL terminator, then a newline before any numstat records.
  const separator = output.indexOf('\0');
  if (separator < 0) throw new Error('Invalid Git line stats output.');
  const body = Buffer.from(output.slice(0, separator).replace(/\n$/, ''));
  const message = new TextDecoder('utf8', { ignoreBOM: true }).decode(body.subarray(0, messageLimit), { stream: true });
  const stats = { additions: 0, deletions: 0, binaryFiles: 0, filesChanged: 0, message };
  const records = output.slice(separator + 1).replace(/^\n/, '').split('\0');
  for (let index = 0; index < records.length - 1; index++) {
    const record = records[index];
    const counts = /^(\d+|-)\t(\d+|-)\t/.exec(record);
    if (!counts) throw new Error('Invalid Git line stats output.');
    // Renames and copies put both paths in separate NUL-delimited fields.
    if (record.length === counts[0].length) index += 2;
    stats.filesChanged++;
    if (counts[1] === '-') stats.binaryFiles++;
    else {
      stats.additions += Number(counts[1]);
      stats.deletions += Number(counts[2]);
    }
  }
  return stats;
}

export async function gitCompare({ repoPath = process.cwd(), from, to, path, mergeBase = false }) {
  if (typeof mergeBase !== 'boolean') throw new Error('Merge base selection must be a boolean.');
  const root = await checkoutRoot(repoPath);
  const file = repositoryPath(root, path);
  const [first, last] = await Promise.all([
    revision(root, from),
    to === undefined ? null : revision(root, to),
  ]);
  let start = first;
  if (mergeBase) {
    start = await commonBase(root, first, last ?? await revision(root, 'HEAD'));
    if (!start) throw new Error('The Git revisions have no common ancestor.');
  }
  return diffResult(root, ['diff'], last ? [start, last] : [start], file);
}

export async function gitBlame({ repoPath = process.cwd(), path, ref }) {
  const root = await checkoutRoot(repoPath);
  const file = repositoryPath(root, path);
  if (file === undefined) throw new Error('A repository-relative file path is required for blame.');
  const id = ref === undefined ? null : await revision(root, ref);
  let target;
  if (!id) {
    const canonicalRoot = await realpath(root);
    target = await realpath(safePath(root, file));
    safePath(canonicalRoot, relative(canonicalRoot, target));
  }
  let output;
  try {
    output = await git(root, 'blame', '--incremental', '--no-textconv', '--encoding=UTF-8',
      '-L', '1,+' + (blameLimit + 1), ...(id ? [id] : []), '--', file);
  } catch (error) {
    // Git rejects a 1-based line range on an empty file.
    if (error.code === 128) {
      const size = id ? await git(root, 'cat-file', '-s', id + ':' + file).then(Number, () => NaN)
        : await stat(target).then(entry => entry.size, () => NaN);
      if (size === 0) return { lines: [] };
    }
    throw error;
  }
  const lines = [];
  const metadata = new Map();
  let record, firstLine, lineCount;
  for (const line of output.split('\n')) {
    const header = /^([a-f0-9]{40}|[a-f0-9]{64}) \d+ (\d+) (\d+)$/.exec(line);
    if (header) {
      const [, hash, lineNumber, count] = header;
      firstLine = Number(lineNumber);
      lineCount = Number(count);
      if (!metadata.has(hash)) metadata.set(hash, { commit: /^0+$/.test(hash) ? null : hash, author: '', summary: '' });
      record = metadata.get(hash);
    } else if (record && line.startsWith('author ')) record.author = line.slice(7, 519);
    else if (record && line.startsWith('summary ')) record.summary = line.slice(8, 4104);
    else if (record && line.startsWith('filename ')) {
      const end = Math.min(firstLine + lineCount, blameLimit + 2);
      for (let number = firstLine; number < end; number++) lines[number - 1] = { line: number, ...record };
      record = undefined;
    }
  }
  return lines.length > blameLimit ? { lines: lines.slice(0, blameLimit), linesTruncated: true } : { lines };
}
