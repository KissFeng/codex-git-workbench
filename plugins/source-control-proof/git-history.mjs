import { relative } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { checkoutRoot, git } from './git-status.mjs';
import { safePath } from './repo-path.mjs';

const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const metadataFormat = '%H%x00%P%x00%an%x00%aI%x00%s';
const pageLimit = 100;
const offsetLimit = 10_000_000;
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

async function decorate(root, commits, head) {
  if (!commits.length) return;
  const byId = new Map(commits.map(commit => [commit.id, commit]));
  byId.get(head)?.refs.push({ name: 'HEAD', kind: 'head' });
  const output = await optionalGit(root, 'show-ref', '--dereference');
  for (const line of (output ?? '').split('\n')) {
    const [id, fullName] = line.split(' ');
    const match = /^refs\/(heads|remotes|tags)\/(.+?)(?:\^\{\})?$/.exec(fullName);
    const commit = byId.get(id);
    if (!commit || !match || commit.refs.length >= 64) continue;
    const kind = { heads: 'branch', remotes: 'remote', tags: 'tag' }[match[1]];
    commit.refs.push({ name: match[2], kind });
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

function decodeCursor(cursor, root, ref, path, offset) {
  try {
    if (typeof cursor !== 'string' || cursor.length > 16_384 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const state = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (state.version !== 1 || state.root !== root ||
        !Number.isInteger(state.offset) || state.offset < 1 || state.offset > offsetLimit ||
        ![state.head, state.upstream, state.start].every(id => id === null || typeof id === 'string' && objectId.test(id)) ||
        (state.ref !== null && typeof state.ref !== 'string') ||
        (state.path !== null && repositoryPath(root, state.path) !== state.path) ||
        (ref !== undefined && ref !== state.ref) || (path !== undefined && path !== state.path) ||
        (offset !== undefined && offset !== state.offset)) throw new Error();
    return state;
  } catch {
    throw new Error('Invalid Git history cursor.');
  }
}

async function historySnapshot(root, ref, path, offset) {
  const [head, upstream, start] = await Promise.all([
    revision(root, 'HEAD', true),
    revision(root, '@{upstream}', true),
    ref === undefined ? null : revision(root, ref),
  ]);
  return { version: 1, root, head, upstream, start, ref: ref ?? null, path: path ?? null, offset };
}

export async function gitHistory({ repoPath = process.cwd(), limit = 50, offset, cursor, ref, path }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > pageLimit) throw new Error('History limit must be between 1 and ' + pageLimit + '.');
  if (offset !== undefined && (!Number.isInteger(offset) || offset < 0 || offset > offsetLimit)) throw new Error('Invalid history offset.');
  const root = await checkoutRoot(repoPath);
  const target = repositoryPath(root, path);
  const snapshot = cursor === undefined
    ? await historySnapshot(root, ref, target, offset ?? 0)
    : decodeCursor(cursor, root, ref, target, offset);
  const { head, upstream, start } = snapshot;
  const file = snapshot.path;
  const starts = start ? [start] : file ? [head].filter(Boolean) : [...new Set([head, upstream].filter(Boolean))];
  const [output, counts] = await Promise.all([
    starts.length ? git(root, 'log', ...logOptions, '--topo-order', '-z', '--format=' + metadataFormat,
      '--max-count=' + (limit + 1), '--skip=' + snapshot.offset, ...(file ? ['--follow'] : []),
      ...starts, '--', ...(file ? [file] : [])) : '',
    divergence(root, head, upstream),
  ]);
  const commits = parseLog(output);
  const followingOffset = snapshot.offset + limit;
  const nextOffset = commits.length > limit && followingOffset <= offsetLimit ? followingOffset : null;
  commits.length = Math.min(commits.length, limit);
  const withinTips = !start || start === head || start === upstream;
  await Promise.all([
    decorate(root, commits, head),
    assignRelations(root, commits, head, upstream, withinTips ? counts : undefined),
  ]);
  return {
    commits, ...counts, head, upstream, nextOffset,
    cursor: nextOffset === null ? null : Buffer.from(JSON.stringify({ ...snapshot, offset: nextOffset })).toString('base64url'),
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
    decorate(root, [record], head),
    assignRelations(root, [record], head, upstream),
  ]);
  const messageBytes = Buffer.from(message);
  return {
    commit: record, message: messageBytes.subarray(0, messageLimit).toString('utf8'), ...changes,
    ...(messageBytes.length > messageLimit ? { messageTruncated: true } : {}),
  };
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
