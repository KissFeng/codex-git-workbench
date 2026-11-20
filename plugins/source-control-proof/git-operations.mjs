import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdtemp, open, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { checkoutRoot, git, gitBytes, runGitCommand } from './git-status.mjs';
import { withGitWrite } from './git-write.mjs';
import { safePath } from './repo-path.mjs';

const localPrefix = 'refs/heads/';
const remotePrefix = 'refs/remotes/';
const tagPrefix = 'refs/tags/';
const previewLimit = 512 * 1024;
const objectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const quietEnv = { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' };
const transportEnv = { GIT_ALLOW_PROTOCOL: 'file:git:http:https:ssh' };
const withoutEol = value => value.replace(/\r?\n$/, '');

function redactUrls(text) {
  return text.replace(/\b((?:https?|ssh|git):\/\/)[^/\s]*@/gi, '$1[redacted]@')
    .replace(/\b((?:https?|ssh|git):\/\/[^\s?#]+)[?#][^\s]*/gi, '$1');
}

function diagnostics(stdout, stderr) {
  const text = redactUrls([stdout, stderr].filter(Boolean).join('\n'))
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/[^\S\r\n]*\r(?!\n)/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .trim();
  const limit = 6000;
  return text.length > limit ? text.slice(0, limit) + '\n[Output truncated]' : text;
}

async function execute(root, args, network = false, gitConfig = {}) {
  try {
    const { stdout, stderr } = await runGitCommand(root, args, {
      timeout: network ? 120000 : 30000,
      env: { ...quietEnv, ...(network ? transportEnv : {}), ...gitConfig },
    });
    const message = diagnostics(stdout, stderr);
    return message ? { message } : {};
  } catch (error) {
    const message = diagnostics(error.stdout, error.stderr);
    throw new Error(message || (error.killed ? 'Git operation timed out.' : 'Git operation failed.'));
  }
}

function confirm(args) {
  if (args.confirmed !== true) throw new Error('This operation requires explicit confirmation.');
}

function required(value, label) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

function destinationPath(destination) {
  if (typeof destination !== 'string' || !isAbsolute(destination) || destination.includes('\0')) {
    throw new Error('Destination path must be absolute.');
  }
  return resolve(destination);
}

function transport(value) {
  const url = required(value, 'Git transport URL');
  if (isAbsolute(url) || /^(?:https?|ssh|git|file):\/\//i.test(url)
      || /^(?:[^\s@:/]+@)?(?:\[[0-9a-f:]+\]|[a-z0-9_.][a-z0-9_.-]*):[^:]/i.test(url)) return url;
  throw new Error('Unsupported Git transport. Use HTTPS, SSH, Git, or an absolute local path.');
}

async function verifyName(root, name, kind) {
  const label = `${kind} name`;
  const value = required(name, label);
  if (value.startsWith('-')) throw new Error(`Invalid ${label}.`);
  try {
    const ref = kind === 'branch' ? localPrefix + value : kind === 'tag' ? tagPrefix + value : remotePrefix + value + '/HEAD';
    await git(root, 'check-ref-format', ref);
    if (kind === 'branch') await git(root, 'check-ref-format', '--branch', value);
  } catch {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

async function commitId(root, ref) {
  const revision = required(ref, 'revision');
  try {
    const hash = (await git(root, 'rev-parse', '--verify', '--end-of-options', revision + '^{commit}')).trim();
    if (objectId.test(hash)) return hash;
  } catch {
    throw new Error('Invalid or unknown Git revision.');
  }
  throw new Error('Invalid or unknown Git revision.');
}

async function listRefs(root, prefix, fields, env) {
  const format = fields.map(field => `%(${field})`).join('%00');
  const { stdout } = await runGitCommand(root, ['for-each-ref', `--format=${format}`, prefix], { env });
  return stdout.split('\n').filter(Boolean).map(line => line.split('\0'));
}

async function listBranches(root) {
  const refs = await listRefs(root, localPrefix, ['refname', 'objectname', 'HEAD', 'upstream:short', 'upstream:remotename', 'upstream:remoteref', 'upstream:track', 'subject'], { LC_ALL: 'C' });
  return refs.map(([ref, head, current, upstream, remote, remoteRef, track, subject]) => ({
    name: ref.slice(localPrefix.length), ref, head, current: current === '*',
    upstream: upstream || null, remote: remote || null, remoteRef: remoteRef || null,
    ahead: upstream && track !== '[gone]' ? Number(/ahead (\d+)/.exec(track)?.[1] || 0) : null,
    behind: upstream && track !== '[gone]' ? Number(/behind (\d+)/.exec(track)?.[1] || 0) : null,
    subject,
  }));
}

async function listRemotes(root) {
  const names = (await git(root, 'remote')).split('\n').filter(Boolean);
  return Promise.all(names.map(async name => {
    const [fetchUrl, pushUrl] = await Promise.all([
      git(root, 'remote', 'get-url', '--', name),
      git(root, 'remote', 'get-url', '--push', '--', name),
    ]);
    return { name, fetchUrl: redactUrls(withoutEol(fetchUrl)), pushUrl: redactUrls(withoutEol(pushUrl)) };
  }));
}

async function listRemoteBranches(root, remotes, includeSymbolic) {
  const refs = await listRefs(root, remotePrefix, ['refname', 'objectname', 'symref', 'subject']);
  const remoteNames = remotes.map(remote => remote.name).sort((a, b) => b.length - a.length);
  return refs.filter(([, , symbolic]) => includeSymbolic || !symbolic).map(([ref, head, , subject]) => {
    const name = ref.slice(remotePrefix.length);
    const remote = remoteNames.find(value => name.startsWith(value + '/')) || null;
    return { name, ref, head, remote, branch: remote ? name.slice(remote.length + 1) : null, subject };
  });
}

async function listTags(root) {
  const refs = await listRefs(root, tagPrefix, ['refname', 'objectname', 'subject']);
  return refs.map(([ref, head, subject]) => ({ name: ref.slice(tagPrefix.length), ref, head, subject }));
}

async function listStashes(root) {
  const output = await git(root, 'stash', 'list', '--format=%gd%x00%H%x00%gs');
  return output.split('\n').filter(Boolean).map(line => {
    const [ref, head, subject] = line.split('\0');
    return { name: ref, ref, head, subject };
  });
}

// Git's internal untracked cleanup uses the special pathspec `:/`.
const stashPush = (root, options) => execute(root, ['--no-literal-pathspecs', 'stash', 'push', ...options]);

async function listWorktrees(root) {
  const records = (await git(root, 'worktree', 'list', '--porcelain', '-z')).split('\0\0');
  return records.filter(Boolean).map((record, index) => {
    const fields = new Map(record.split('\0').map(field => {
      const space = field.indexOf(' ');
      return space < 0 ? [field, ''] : [field.slice(0, space), field.slice(space + 1)];
    }));
    return {
      path: fields.get('worktree'), branch: fields.get('branch')?.slice(localPrefix.length) || null,
      head: fields.get('HEAD') || null, detached: fields.has('detached'), locked: fields.has('locked'),
      prunable: fields.has('prunable'), bare: fields.has('bare'), main: index === 0,
    };
  });
}

async function unmergedEntries(root, file) {
  const records = (await git(root, 'ls-files', '--unmerged', '-z', ...(file ? ['--', file] : []))).split('\0');
  const entries = new Map();
  for (const record of records) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [mode, head, stage] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (file && path !== file) continue;
    if (!entries.has(path)) entries.set(path, []);
    entries.get(path).push({ mode, head, stage: Number(stage) });
  }
  return entries;
}

async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function operationState(root) {
  const gitDir = withoutEol(await git(root, 'rev-parse', '--absolute-git-dir'));
  const markers = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'sequencer/todo'];
  const [rebaseMerge, rebaseApply, merge, cherryPick, sequencer] = await Promise.all(markers.map(marker => exists(join(gitDir, marker))));
  const entries = await unmergedEntries(root);
  const conflicts = [...entries].map(([path, stages]) => ({ path, stages: stages.map(({ stage }) => stage) }));
  const type = rebaseMerge || rebaseApply ? 'rebase' : merge ? 'merge' : cherryPick || sequencer ? 'cherryPick' : conflicts.length ? 'conflict' : null;
  return type ? { type, conflicts } : null;
}

export async function gitReferences({ repoPath, includeSymbolic = false }) {
  const root = await checkoutRoot(repoPath);
  const [branches, remotes, tags, stashes, worktrees, operation] = await Promise.all([
    listBranches(root), listRemotes(root), listTags(root), listStashes(root), listWorktrees(root), operationState(root),
  ]);
  const remoteBranches = await listRemoteBranches(root, remotes, includeSymbolic);
  return { branches, remoteBranches, remotes, tags, stashes, worktrees, operation };
}

async function currentBranch(root) {
  try {
    return withoutEol(await git(root, 'symbolic-ref', '--quiet', 'HEAD')).slice(localPrefix.length);
  } catch (error) {
    if (error.code === 1) throw new Error('Check out a local branch first.');
    throw error;
  }
}

const remoteNames = async root => (await git(root, 'remote')).split('\n').filter(Boolean);

async function knownRemote(root, remote) {
  if (!(await remoteNames(root)).includes(remote)) throw new Error('Unknown remote.');
  return remote;
}

async function originFor(root, args, allowNewUpstream = false) {
  const local = await currentBranch(root);
  const upstream = (await listBranches(root)).find(branch => branch.current);
  const remotes = await remoteNames(root);
  const remote = args.remote ?? (allowNewUpstream ? upstream?.remote || (remotes.length === 1 ? remotes[0] : null) : upstream?.remote);
  if (!remote) throw new Error('Choose a remote or set an upstream branch.');
  if (!remotes.includes(remote)) throw new Error('Unknown remote.');
  const upstreamBranch = upstream?.remote === remote && upstream.remoteRef?.startsWith(localPrefix)
    ? upstream.remoteRef.slice(localPrefix.length) : null;
  const branch = await verifyName(root, args.branch ?? upstreamBranch ?? local, 'branch');
  return { remote, branch };
}

async function pull(root, mode, { remote, branch }) {
  const options = mode === 'pullRebase' ? ['--rebase', '--no-ff']
    : mode === 'pullMerge' ? ['--no-rebase', '--ff', '--no-edit'] : ['--no-rebase', '--ff-only'];
  return execute(root, ['pull', ...options, '--no-recurse-submodules', '--', remote, localPrefix + branch], true);
}

function leaseOption(ref, expected) {
  if (typeof expected !== 'string' || !objectId.test(expected)) throw new Error('A full expected remote commit hash is required.');
  return `--force-with-lease=${ref}:${expected}`;
}

function pushRefspec(root, remote, refspec, options = []) {
  // Git applies the per-remote mirror setting independently of --no-mirror.
  const configIndex = Number(process.env.GIT_CONFIG_COUNT || 0);
  const config = {
    GIT_CONFIG_COUNT: String(configIndex + 1),
    [`GIT_CONFIG_KEY_${configIndex}`]: `remote.${remote}.mirror`,
    [`GIT_CONFIG_VALUE_${configIndex}`]: 'false',
  };
  return execute(root, ['push', '--no-mirror', '--no-follow-tags', '--recurse-submodules=no', ...options, '--', remote, refspec], true, config);
}

function push(root, action, { remote, branch }, { expected, followTags }) {
  const ref = localPrefix + branch;
  const options = action === 'publish' ? ['--set-upstream'] : action === 'forcePush' ? [leaseOption(ref, expected)] : [];
  if (followTags === true) options.push('--follow-tags');
  return pushRefspec(root, remote, 'HEAD:' + ref, options);
}

async function selectedRef(root, { ref, kind, name }) {
  if (ref === undefined) {
    if (!['branch', 'tag'].includes(kind)) throw new Error('Choose a branch or tag ref.');
    const prefix = kind === 'branch' ? localPrefix : tagPrefix;
    return prefix + await verifyName(root, name, kind);
  }
  if (typeof ref !== 'string') throw new Error('Choose a branch or tag ref.');
  if (ref.startsWith(localPrefix)) return localPrefix + await verifyName(root, ref.slice(localPrefix.length), 'branch');
  if (ref.startsWith(tagPrefix)) return tagPrefix + await verifyName(root, ref.slice(tagPrefix.length), 'tag');
  throw new Error('Choose a branch or tag ref.');
}

async function remoteRefOperation(root, args) {
  const { action } = args;
  if (action !== 'fetchRef') confirm(args);
  const remote = await knownRemote(root, args.remote);
  if (action === 'pushTags') return pushRefspec(root, remote, 'refs/tags/*:refs/tags/*');
  const kind = action === 'deleteRemoteBranch' ? 'branch' : action === 'deleteRemoteTag' ? 'tag' : args.kind;
  const ref = await selectedRef(root, { ...args, kind });
  const isBranch = ref.startsWith(localPrefix);
  switch (action) {
    case 'fetchRef': {
      const target = isBranch ? `${remotePrefix}${remote}/${ref.slice(localPrefix.length)}` : ref;
      return execute(root, ['fetch', '--no-tags', '--no-prune', '--no-prune-tags', '--no-recurse-submodules', '--refmap=', '--', remote, `${ref}:${target}`], true);
    }
    case 'pushRef': {
      const target = args.target === undefined ? ref : await selectedRef(root, { ref: args.target });
      if (isBranch !== target.startsWith(localPrefix)) throw new Error('Source and destination must both be branches or both be tags.');
      return pushRefspec(root, remote, `${ref}:${target}`);
    }
    default: {
      if ((kind === 'branch') !== isBranch) throw new Error('The selected ref does not match the requested deletion.');
      const options = args.expected === undefined ? [] : [leaseOption(ref, args.expected)];
      return pushRefspec(root, remote, ':' + ref, options);
    }
  }
}

async function stashEntry(root, ref, expected) {
  if (typeof ref !== 'string' || !/^stash@\{\d+\}$/.test(ref)) throw new Error('Invalid stash reference.');
  const entry = (await listStashes(root)).find(stash => stash.ref === ref);
  if (!entry || (expected !== undefined && entry.head !== expected)) throw new Error('The stash list changed. Refresh the stashes and try again.');
  return entry;
}

async function requireWorktree(root, destination) {
  let path = destinationPath(destination);
  try { path = await realpath(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const trees = await listWorktrees(root);
  const worktree = trees.find(tree => tree.path === path);
  if (!worktree) throw new Error('Destination is not a registered worktree of this repository.');
  return worktree;
}

async function moveWorktreeChanges(root, destination) {
  const { path } = await requireWorktree(root, destination);
  if (path === await realpath(root)) throw new Error('Choose a different worktree.');
  if (await git(path, 'status', '--porcelain', '-z', '--untracked-files=all') || await operationState(path)) {
    throw new Error('The destination worktree has pending changes.');
  }
  const message = `Move worktree changes (${randomUUID()})`;
  await stashPush(root, ['--include-untracked', '-m', message]);
  const stash = (await listStashes(root)).find(entry => entry.subject.endsWith(': ' + message));
  if (!stash) return { message: 'No pending changes to move.' };
  try {
    await execute(path, ['stash', 'apply', '--index', '--', stash.head]);
  } catch (error) {
    throw new Error(`Move stopped. The source changes are saved in stash ${stash.head}.\n${error.message}`);
  }
  const moved = (await listStashes(root)).find(entry => entry.head === stash.head);
  if (moved) await execute(root, ['stash', 'drop', '--', moved.ref]);
  return { path };
}

function decode(bytes) {
  if (bytes.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return null; }
}

async function conflictBlob(root, entry) {
  if (entry.mode === '160000') return null;
  if (Number((await git(root, 'cat-file', '-s', entry.head)).trim()) > previewLimit) return null;
  return decode(await gitBytes(root, 'cat-file', 'blob', entry.head));
}

async function currentConflict(root, path) {
  const target = safePath(root, path);
  try {
    const info = await lstat(target);
    const canonicalRoot = await realpath(root);
    if (info.isSymbolicLink()) {
      const parent = await realpath(resolve(target, '..'));
      safePath(canonicalRoot, relative(canonicalRoot, join(parent, 'file')));
      return { kind: 'link', text: await readlink(target) };
    }
    if (!info.isFile() || info.size > previewLimit) return { kind: 'unavailable', text: null };
    const canonical = await realpath(target);
    safePath(canonicalRoot, relative(canonicalRoot, canonical));
    const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = Buffer.alloc(previewLimit + 1);
      const { bytesRead } = await file.read(bytes);
      const text = bytesRead > previewLimit ? null : decode(bytes.subarray(0, bytesRead));
      return text === null ? { kind: 'unavailable', text } : { kind: 'text', text, mode: info.mode & 0o777 };
    } finally { await file.close(); }
  } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'missing', text: null };
    throw error;
  }
}

async function exactConflict(root, path) {
  safePath(root, path);
  const entries = (await unmergedEntries(root, path)).get(path);
  if (!entries) throw new Error('This file is no longer in conflict.');
  return entries;
}

function conflictFingerprint(path, entries, current) {
  return createHash('sha256').update(JSON.stringify([path, entries, current])).digest('hex');
}

async function conflictSnapshot(root, path, entries) {
  const views = await Promise.all(entries.map(async entry => [entry.stage, await conflictBlob(root, entry)]));
  const stages = new Map(views);
  const current = await currentConflict(root, path);
  const unavailable = current.kind === 'unavailable' || views.some(([, text]) => text === null);
  const editable = !unavailable && ['missing', 'text'].includes(current.kind) && entries.every(entry => entry.mode !== '120000');
  const expected = editable ? conflictFingerprint(path, entries, current) : null;
  return { current, stages, expected, unavailable };
}

async function readConflict(root, path) {
  const entries = await exactConflict(root, path);
  const { current, stages, expected, unavailable } = await conflictSnapshot(root, path, entries);
  const message = unavailable ? 'One or more versions cannot be previewed as UTF-8 text within the 512 KB limit.' : undefined;
  return { path, base: stages.get(1) ?? null, ours: stages.get(2) ?? null, theirs: stages.get(3) ?? null, current: current.text, expected, message };
}

async function editConflict(root, { path, content, expected }, entries) {
  if (typeof content !== 'string' || !content.isWellFormed() || content.includes('\0') || Buffer.byteLength(content) > previewLimit) {
    throw new Error('Edited conflict text must be valid UTF-8 and at most 512 KB.');
  }
  const snapshot = await conflictSnapshot(root, path, entries);
  if (!snapshot.expected) throw new Error('This conflict is not editable as plain text.');
  if (snapshot.expected !== expected) throw new Error('The conflict changed. Refresh its preview before saving.');

  const rootPath = await realpath(root);
  const target = safePath(rootPath, path);
  const parent = dirname(target);
  if (parent !== await realpath(parent)) throw new Error('This conflict is not editable through a symbolic link.');
  const temporary = await mkdtemp(join(parent, '.codex-conflict-'));
  const result = join(temporary, 'result');
  try {
    await writeFile(result, content, { mode: snapshot.current.mode ?? 0o666 });
    if (snapshot.current.mode !== undefined) await chmod(result, snapshot.current.mode);
    const [latestEntries, latestCurrent] = await Promise.all([exactConflict(root, path), currentConflict(root, path)]);
    if (conflictFingerprint(path, latestEntries, latestCurrent) !== expected) throw new Error('The conflict changed. Refresh its preview before saving.');
    if (latestCurrent.kind === 'missing') await link(result, target);
    else await rename(result, target);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return execute(root, ['add', '--', path]);
}

async function resolveConflict(root, args) {
  const { path, choice } = args;
  const entries = await exactConflict(root, path);
  if (choice === 'edit') return editConflict(root, args, entries);
  if (choice === 'current') return execute(root, ['add', '--', path]);
  const stage = new Map([['base', 1], ['ours', 2], ['theirs', 3]]).get(choice);
  if (choice !== 'delete' && !stage) throw new Error('Invalid conflict resolution.');
  const entry = entries.find(value => value.stage === stage);
  if (choice === 'base' && !entry) throw new Error('There is no base version of this conflict.');
  if (!entry) return execute(root, ['rm', '-f', '--', path]);
  await execute(root, ['checkout-index', '--force', `--stage=${stage}`, '--', path]);
  return execute(root, ['update-index', '--add', '--cacheinfo', entry.mode, entry.head, path]);
}

async function projectOperation(args) {
  confirm(args);
  const destination = destinationPath(args.destination);
  let result;
  if (args.action === 'init') {
    result = await execute(process.cwd(), ['init', '--', destination]);
  } else {
    const url = transport(args.url);
    const local = isAbsolute(url) || /^file:\/\//i.test(url);
    const configuredTransport = args.recursive === true && !local ? { GIT_ALLOW_PROTOCOL: 'git:http:https:ssh' } : {};
    const recurse = args.recursive === true ? '--recurse-submodules' : '--no-recurse-submodules';
    result = await execute(process.cwd(), ['clone', recurse, '--', url, destination], true, configuredTransport);
  }
  return { ...result, checkout: await checkoutRoot(destination) };
}

export async function gitOperation(args) {
  const { repoPath, action } = args;
  if (['init', 'clone'].includes(action)) return projectOperation(args);
  if (action === 'conflictRead') return readConflict(await checkoutRoot(repoPath), args.path);
  return withGitWrite(repoPath, async root => {
    switch (action) {
      case 'createBranch': {
        const name = await verifyName(root, args.name, 'branch');
        const start = args.startPoint === undefined ? [] : [await commitId(root, args.startPoint)];
        return execute(root, args.checkout ? ['switch', '-c', name, ...start] : ['branch', '--', name, ...start]);
      }
      case 'switchBranch': {
        const name = await verifyName(root, args.name, 'branch');
        if (args.remote === undefined) return execute(root, ['switch', '--no-guess', '--', name]);
        const remote = await verifyName(root, args.remote, 'remote');
        const existing = (await listBranches(root)).find(branch => branch.name === name);
        if (existing) {
          if (existing.remote !== remote || existing.remoteRef !== localPrefix + name) {
            throw new Error('A local branch with this name already exists without the selected upstream.');
          }
          return execute(root, ['switch', '--no-guess', '--', name]);
        }
        return execute(root, ['switch', '-c', name, '--track', '--', `${remotePrefix}${remote}/${name}`]);
      }
      case 'checkoutDetached': return execute(root, ['switch', '--detach', await commitId(root, args.ref)]);
      case 'renameBranch': return execute(root, ['branch', '-m', '--', await verifyName(root, args.name, 'branch'), await verifyName(root, args.newName, 'branch')]);
      case 'deleteBranch': {
        if (args.force) confirm(args);
        return execute(root, ['branch', args.force ? '-D' : '-d', '--', await verifyName(root, args.name, 'branch')]);
      }
      case 'createTag': {
        const name = await verifyName(root, args.name, 'tag');
        const ref = await commitId(root, args.ref ?? 'HEAD');
        const message = args.message === undefined || args.message === '' ? [] : ['-m', args.message];
        if (message.length && (typeof args.message !== 'string' || args.message.includes('\0'))) throw new Error('Invalid tag message.');
        return execute(root, ['tag', ...message, '--', name, ref]);
      }
      case 'deleteTag':
        confirm(args);
        return execute(root, ['tag', '-d', '--', await verifyName(root, args.name, 'tag')]);
      case 'addRemote': return execute(root, ['remote', 'add', '--', await verifyName(root, args.name, 'remote'), transport(args.url)]);
      case 'removeRemote':
        confirm(args);
        return execute(root, ['remote', 'remove', '--', await verifyName(root, args.name, 'remote')]);
      case 'fetch': {
        const options = args.prune ? ['--prune'] : [];
        const target = args.remote === undefined ? ['--all'] : ['--', await knownRemote(root, args.remote)];
        return execute(root, ['fetch', ...options, '--no-recurse-submodules', ...target], true);
      }
      case 'fetchRef':
      case 'pushRef':
      case 'pushTags':
      case 'deleteRemoteBranch':
      case 'deleteRemoteTag': return remoteRefOperation(root, args);
      case 'pull':
      case 'pullMerge':
      case 'pullRebase': return pull(root, action, await originFor(root, args));
      case 'push':
      case 'forcePush':
      case 'publish':
      case 'sync':
      case 'syncRebase': {
        confirm(args);
        if (action === 'forcePush' && (!args.remote || !args.branch)) throw new Error('Choose the exact remote branch to update.');
        const origin = await originFor(root, args, action === 'publish');
        const syncMode = { sync: 'pull', syncRebase: 'pullRebase' }[action];
        const pulled = syncMode ? await pull(root, syncMode, origin) : {};
        const pushed = await push(root, action, origin, args);
        const message = diagnostics(pulled.message, pushed.message);
        return message ? { message } : {};
      }
      case 'merge': return execute(root, ['merge', '--no-edit', await commitId(root, args.ref)]);
      case 'rebase': return execute(root, ['rebase', await commitId(root, args.ref)]);
      case 'cherryPick': return execute(root, ['cherry-pick', await commitId(root, args.ref)]);
      case 'mergeContinue': return execute(root, ['merge', '--continue']);
      case 'rebaseContinue': return execute(root, ['rebase', '--continue']);
      case 'cherryPickContinue': return execute(root, ['cherry-pick', '--continue']);
      case 'mergeAbort':
      case 'rebaseAbort':
      case 'cherryPickAbort':
        confirm(args);
        return execute(root, [action === 'cherryPickAbort' ? 'cherry-pick' : action.slice(0, -5), '--abort']);
      case 'stashPush': {
        const options = [];
        if (args.staged) options.push('--staged');
        if (args.includeUntracked) options.push('--include-untracked');
        if (args.message !== undefined && args.message !== '') {
          if (typeof args.message !== 'string' || args.message.includes('\0')) throw new Error('Invalid stash message.');
          options.push('-m', args.message);
        }
        return stashPush(root, options);
      }
      case 'stashApply':
      case 'stashPop':
      case 'stashDrop': {
        if (action === 'stashDrop') confirm(args);
        const entry = await stashEntry(root, args.ref, args.expected);
        if (action === 'stashDrop') return execute(root, ['stash', 'drop', '--', entry.ref]);
        const applied = await execute(root, ['stash', 'apply', ...(args.restoreIndex ? ['--index'] : []), '--', entry.head]);
        if (action === 'stashPop') {
          const stash = await stashEntry(root, entry.ref, entry.head);
          return execute(root, ['stash', 'drop', '--', stash.ref]);
        }
        return applied;
      }
      case 'stashDropAll': {
        confirm(args);
        const stashes = await listStashes(root);
        const expected = args.expectedStashes;
        if (!Array.isArray(expected) || expected.length !== stashes.length || stashes.some((stash, index) => stash.head !== expected[index])) {
          throw new Error('The stash list changed. Refresh the stashes and try again.');
        }
        if (!stashes.length) return { message: 'No stashes to drop.' };
        await execute(root, ['update-ref', '--no-deref', '-d', 'refs/stash', stashes[0].head]);
        return { message: `Dropped ${stashes.length} stash entries.` };
      }
      case 'createWorktree': {
        confirm(args);
        const path = destinationPath(args.destination);
        if (args.branch && (args.newBranch || args.ref)) throw new Error('Select one worktree starting branch or revision.');
        const options = args.newBranch ? ['-b', await verifyName(root, args.newBranch, 'branch')]
          : args.branch ? [] : ['--detach'];
        const start = args.branch ? await verifyName(root, args.branch, 'branch') : await commitId(root, args.ref ?? 'HEAD');
        if (args.branch && !(await listBranches(root)).some(branch => branch.name === start)) throw new Error('Unknown local branch.');
        const result = await execute(root, ['worktree', 'add', ...options, '--', path, start]);
        return args.open === true ? { ...result, path, checkout: await checkoutRoot(path) } : { ...result, path };
      }
      case 'removeWorktree': {
        confirm(args);
        const worktree = await requireWorktree(root, args.destination);
        if (worktree.main || worktree.path === await realpath(root)) throw new Error('Choose a linked worktree other than the currently open checkout.');
        return execute(root, ['worktree', 'remove', ...(args.force ? ['--force'] : []), '--', worktree.path]);
      }
      case 'moveWorktreeChanges':
        confirm(args);
        return moveWorktreeChanges(root, args.destination);
      case 'conflictResolve':
        confirm(args);
        return resolveConflict(root, args);
      default: throw new Error('Unknown Git operation.');
    }
  });
}
