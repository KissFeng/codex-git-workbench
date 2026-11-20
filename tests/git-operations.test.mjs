import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gitOperation, gitReferences } from '../plugins/source-control-proof/git-operations.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trimEnd();
const remoteTip = remote => git(remote, `--git-dir=${remote}`, 'rev-parse', 'HEAD');

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-git-operations-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  return { dir, gitOperation, gitReferences };
}

async function checkout(t) {
  const { dir, gitOperation, gitReferences } = await fixture(t);
  const repoPath = join(dir, 'repo');
  git(dir, 'init', '-b', 'main', repoPath);
  identity(repoPath);
  await writeFile(join(repoPath, 'file.txt'), 'base\n');
  git(repoPath, 'add', '.');
  git(repoPath, 'commit', '-m', 'Initial commit');
  return {
    dir, repoPath, gitOperation,
    run: (action, args) => gitOperation({ repoPath, action, ...args }),
    refs: () => gitReferences({ repoPath }),
  };
}

function identity(path) {
  git(path, 'config', 'user.name', 'Fixture');
  git(path, 'config', 'user.email', 'fixture@example.test');
  git(path, 'config', 'commit.gpgSign', 'false');
}

async function commit(path, contents, name = 'file.txt') {
  await writeFile(join(path, name), contents);
  git(path, 'add', '--', name);
  git(path, 'commit', '-m', contents.trim());
  return git(path, 'rev-parse', 'HEAD');
}

async function diverged(t) {
  const repo = await checkout(t);
  await repo.run('createBranch', { name: 'side', checkout: true });
  const side = await commit(repo.repoPath, 'theirs\n');
  await repo.run('switchBranch', { name: 'main' });
  const main = await commit(repo.repoPath, 'ours\n');
  return { ...repo, main, side };
}

async function remoteFixture(t) {
  const repo = await checkout(t);
  const remote = join(repo.dir, 'remote with spaces.git');
  git(repo.dir, 'init', '--bare', '-b', 'main', remote);
  await repo.run('addRemote', { name: 'origin', url: remote });
  await repo.run('publish', { remote: 'origin', confirmed: true });
  const peer = join(repo.dir, 'peer');
  await repo.gitOperation({ action: 'clone', destination: peer, url: remote, confirmed: true });
  identity(peer);
  return { ...repo, remote, peer };
}

test('initializes an explicit destination with confirmation and clones only supported transports', async t => {
  const { dir, gitOperation, gitReferences } = await fixture(t);
  const destination = join(dir, 'folder with spaces');
  await assert.rejects(gitOperation({ action: 'init', destination }), /confirmation/i);
  const result = await gitOperation({ action: 'init', destination, confirmed: true });
  assert.equal(result.checkout, git(destination, 'rev-parse', '--show-toplevel'));
  assert.deepEqual((await gitReferences({ repoPath: destination })).branches, []);
  await assert.rejects(gitOperation({ action: 'clone', destination: join(dir, 'blocked'), url: 'ext::echo forbidden', confirmed: true }), /transport/i);
  await assert.rejects(gitOperation({ action: 'clone', destination: join(dir, 'blocked'), url: '--upload-pack=blocked', confirmed: true }), /transport/i);
});

test('clones submodules only when explicitly requested', async t => {
  const { dir, repoPath, gitOperation } = await checkout(t);
  const modulePath = join(dir, 'module');
  git(dir, 'init', '-b', 'main', modulePath);
  identity(modulePath);
  await commit(modulePath, 'submodule content\n');
  git(repoPath, '-c', 'protocol.file.allow=always', 'submodule', 'add', modulePath, 'module');
  git(repoPath, 'commit', '-m', 'Record submodule');
  const clone = (destination, recursive) => gitOperation({ action: 'clone', destination, url: repoPath, confirmed: true, recursive });
  const nonRecursive = join(dir, 'ordinary clone');
  await clone(nonRecursive, false);
  await assert.rejects(readFile(join(nonRecursive, 'module', 'file.txt'), 'utf8'), { code: 'ENOENT' });
  const recursive = join(dir, 'recursive clone');
  await clone(recursive, true);
  assert.equal(await readFile(join(recursive, 'module', 'file.txt'), 'utf8'), 'submodule content\n');
});

test('manages local and detached branches without dropping dirty changes', async t => {
  const { repoPath, run, refs } = await checkout(t);
  const head = git(repoPath, 'rev-parse', 'HEAD');
  await writeFile(join(repoPath, 'file.txt'), 'dirty\n');
  await run('createBranch', { name: 'feature/slash', startPoint: head, checkout: true });
  await run('renameBranch', { name: 'feature/slash', newName: 'feature/new' });
  assert((await refs()).branches.some(branch => branch.current && branch.name === 'feature/new' && branch.head === head));
  await run('checkoutDetached', { ref: head });
  assert.equal((await refs()).worktrees[0].detached, true);
  await run('switchBranch', { name: 'main' });
  await assert.rejects(run('deleteBranch', { name: 'feature/new', force: true }), /confirmation/i);
  await run('deleteBranch', { name: 'feature/new' });
  assert.deepEqual((await refs()).branches.map(branch => branch.name), ['main']);
  assert.equal(await readFile(join(repoPath, 'file.txt'), 'utf8'), 'dirty\n');
  await assert.rejects(run('createBranch', { name: '-f' }), /branch/i);
  await assert.rejects(run('merge', { ref: '--abort' }), /revision/i);
  await run('createTag', { name: 'v1', ref: head, message: 'Release one' });
  assert.equal((await refs()).tags[0].name, 'v1');
  await assert.rejects(run('deleteTag', { name: 'v1' }), /confirmation/i);
  await run('deleteTag', { name: 'v1', confirmed: true });
  assert.deepEqual((await refs()).tags, []);
});

test('pulls fast-forward, reports ahead and behind, and does not push after sync fails', async t => {
  const { repoPath, peer, remote, run, refs } = await remoteFixture(t);
  const remoteSeed = await commit(peer, 'peer change\n', 'peer.txt');
  git(peer, 'push');
  await run('fetch', { remote: 'origin', prune: true });
  const branch = (await refs()).branches.find(item => item.current);
  assert.deepEqual([branch.upstream, branch.remote, branch.remoteRef, branch.ahead, branch.behind], ['origin/main', 'origin', 'refs/heads/main', 0, 1]);
  assert.equal((await refs()).remotes[0].fetchUrl, remote);
  await run('pull');
  assert.equal(git(repoPath, 'rev-parse', 'HEAD'), remoteSeed);
  const localHead = await commit(repoPath, 'local\n', 'local.txt');
  const peerHead = await commit(peer, 'peer second\n', 'peer-2.txt');
  git(peer, 'push');
  git(repoPath, 'config', 'pull.rebase', 'true');
  await assert.rejects(run('sync', { confirmed: true }), /fast.forward/i);
  assert.equal(git(repoPath, 'rev-parse', 'HEAD'), localHead);
  assert.equal(remoteTip(remote), peerHead);
  await run('pullRebase');
  assert.equal(git(repoPath, 'rev-parse', 'HEAD^'), peerHead);
  await run('push', { confirmed: true });
  assert.equal(remoteTip(remote), git(repoPath, 'rev-parse', 'HEAD'));
  await assert.rejects(run('removeRemote', { name: 'origin' }), /confirmation/i);
  await run('removeRemote', { name: 'origin', confirmed: true });
  assert.deepEqual((await refs()).remotes, []);
});

test('sync ignores remote-wide mirror, push refspec and follow-tags configuration', async t => {
  const { repoPath, remote, run } = await remoteFixture(t);
  await commit(repoPath, 'another change\n');
  git(repoPath, 'branch', 'private');
  git(repoPath, 'tag', '-m', 'local tag message', 'private-tag');
  git(repoPath, 'config', 'remote.origin.mirror', 'true');
  git(repoPath, 'config', 'remote.origin.push', 'refs/heads/*:refs/heads/*');
  git(repoPath, 'config', 'push.followTags', 'true');
  await run('sync', { confirmed: true });
  assert.equal(git(remote, `--git-dir=${remote}`, 'for-each-ref', '--format=%(refname)'), 'refs/heads/main');
  assert.equal(remoteTip(remote), git(repoPath, 'rev-parse', 'HEAD'));
});

test('checks out a remote branch with tracking and reuses the existing tracking branch', async t => {
  const { repoPath, peer, run, refs } = await remoteFixture(t);
  git(peer, 'switch', '-c', 'remote-feature');
  const feature = await commit(peer, 'remote feature\n');
  git(peer, 'push', '-u', 'origin', 'remote-feature');
  await run('fetch', { remote: 'origin' });
  assert((await refs()).remoteBranches.some(branch => branch.branch === 'remote-feature' && branch.remote === 'origin' && branch.head === feature));
  await run('switchBranch', { name: 'remote-feature', remote: 'origin' });
  assert.equal(git(repoPath, 'rev-parse', '@{upstream}'), feature);
  await run('switchBranch', { name: 'main' });
  await run('switchBranch', { name: 'remote-feature', remote: 'origin' });
  assert.equal(git(repoPath, 'branch', '--show-current'), 'remote-feature');
});

test('reference listing can opt in to symbolic remote branches for graph history', async t => {
  const { repoPath, refs } = await remoteFixture(t);
  git(repoPath, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const regular = await refs();
  assert.deepEqual(regular.remoteBranches.map(item => item.name), ['origin/main']);
  const extended = await gitReferences({ repoPath, includeSymbolic: true });
  assert.deepEqual(extended.remoteBranches.map(({ name, ref, head }) => [name, ref, head]), [
    ['origin/HEAD', 'refs/remotes/origin/HEAD', regular.remoteBranches[0].head],
    ['origin/main', 'refs/remotes/origin/main', regular.remoteBranches[0].head],
  ]);
});

test('uses a merge for divergent pulls and fast-forwards where possible', async t => {
  const { repoPath, peer, run } = await remoteFixture(t);
  const peerHead = await commit(peer, 'peer fast-forward\n');
  git(peer, 'push');
  await run('pullMerge');
  assert.equal(git(repoPath, 'rev-parse', 'HEAD'), peerHead);

  const localHead = await commit(repoPath, 'local addition\n', 'local.txt');
  const nextPeer = await commit(peer, 'remote addition\n', 'remote.txt');
  git(peer, 'push');
  git(repoPath, 'config', 'pull.ff', 'only');
  await run('pullMerge');
  assert.equal(git(repoPath, 'log', '-1', '--format=%P'), `${localHead} ${nextPeer}`);
});

test('force-push lease uses the provided exact remote tip and ignores changed tracking refs', async t => {
  const { repoPath, peer, remote, run } = await remoteFixture(t);
  const oldTip = remoteTip(remote);
  const local = await commit(repoPath, 'local\n');
  const newTip = await commit(peer, 'peer\n');
  git(peer, 'push');
  await run('fetch', { remote: 'origin' });
  await assert.rejects(run('forcePush', { remote: 'origin', branch: 'main', expected: oldTip, confirmed: true }), /stale info/i);
  assert.equal(remoteTip(remote), newTip);
  await run('forcePush', { remote: 'origin', branch: 'main', expected: newTip, confirmed: true });
  assert.equal(remoteTip(remote), local);
});

test('pushes, fetches and deletes a single explicit branch without affecting other refs', async t => {
  const { repoPath, peer, remote, run, gitOperation } = await remoteFixture(t);
  await run('createBranch', { name: 'selected' });
  await run('createBranch', { name: 'private' });
  const source = 'refs/heads/selected';
  const target = 'refs/heads/shared';
  await assert.rejects(run('pushRef', { remote: 'origin', ref: source, target }), /confirmation/i);
  const pushed = await run('pushRef', { remote: 'origin', ref: source, target, confirmed: true });
  assert.match(pushed.message, /new branch/i);
  const remoteRefs = () => git(remote, `--git-dir=${remote}`, 'for-each-ref', '--format=%(refname)').split('\n');
  assert.deepEqual(remoteRefs(), ['refs/heads/main', target]);
  await gitOperation({ repoPath: peer, action: 'fetchRef', remote: 'origin', ref: target });
  assert.equal(git(peer, 'rev-parse', 'refs/remotes/origin/shared'), git(repoPath, 'rev-parse', source));
  await assert.rejects(run('deleteRemoteBranch', { remote: 'origin', name: 'shared', confirmed: true, expected: 'a'.repeat(40) }), /stale info/i);
  await run('deleteRemoteBranch', { remote: 'origin', name: 'shared', confirmed: true });
  assert.deepEqual(remoteRefs(), ['refs/heads/main']);
});

test('pushes only tags despite configured branch mirror and can delete a selected tag', async t => {
  const { repoPath, peer, remote, run, gitOperation } = await remoteFixture(t);
  await run('createBranch', { name: 'private' });
  await run('createTag', { name: 'v1' });
  await run('createTag', { name: 'v2' });
  git(repoPath, 'config', 'remote.origin.mirror', 'true');
  git(repoPath, 'config', 'remote.origin.push', 'refs/heads/*:refs/heads/*');
  await assert.rejects(run('pushTags', { remote: 'origin' }), /confirmation/i);
  await run('pushTags', { remote: 'origin', confirmed: true });
  const remoteRefs = () => git(remote, `--git-dir=${remote}`, 'for-each-ref', '--format=%(refname)').split('\n');
  assert.deepEqual(remoteRefs(), ['refs/heads/main', 'refs/tags/v1', 'refs/tags/v2']);
  await gitOperation({ repoPath: peer, action: 'fetchRef', remote: 'origin', kind: 'tag', name: 'v2' });
  assert.equal(git(peer, 'tag', '--list'), 'v2');
  await run('deleteRemoteTag', { remote: 'origin', name: 'v1', confirmed: true });
  assert.deepEqual(remoteRefs(), ['refs/heads/main', 'refs/tags/v2']);
  assert.equal(git(repoPath, 'tag', '--list'), 'v1\nv2');
});

test('reads conflict stages and resolves the exact selected conflict', async t => {
  const { repoPath, run, refs, main, side } = await diverged(t);
  await assert.rejects(run('merge', { ref: 'side' }), /conflict/i);
  assert.deepEqual((await refs()).operation, { type: 'merge', conflicts: [{ path: 'file.txt', stages: [1, 2, 3] }] });
  const conflict = await run('conflictRead', { path: 'file.txt' });
  assert.equal(conflict.base, 'base\n');
  assert.equal(conflict.ours, 'ours\n');
  assert.equal(conflict.theirs, 'theirs\n');
  assert.match(conflict.current, /<<<<<<< /);
  await assert.rejects(run('conflictResolve', { path: 'file.txt', choice: 'theirs' }), /confirmation/i);
  await run('conflictResolve', { path: 'file.txt', choice: 'theirs', confirmed: true });
  assert.equal(await readFile(join(repoPath, 'file.txt'), 'utf8'), 'theirs\n');
  await run('mergeContinue');
  assert.equal(git(repoPath, 'log', '-1', '--format=%P'), `${main} ${side}`);
  assert.equal((await refs()).operation, null);
});

test('manual conflict resolution checks the saved preview and stages confirmed text', async t => {
  const { repoPath, run, refs } = await diverged(t);
  await assert.rejects(run('merge', { ref: 'side' }), /conflict/i);
  const path = 'file.txt';
  const first = await run('conflictRead', { path });
  assert.match(first.expected, /^[a-f0-9]{64}$/);
  await writeFile(join(repoPath, path), 'updated outside the panel\n');
  const content = 'combined\nresult\n';
  await assert.rejects(run('conflictResolve', { path, choice: 'edit', expected: first.expected, content, confirmed: true }), /changed/i);
  assert.equal(await readFile(join(repoPath, path), 'utf8'), 'updated outside the panel\n');
  const second = await run('conflictRead', { path });
  assert.notEqual(second.expected, first.expected);
  await assert.rejects(run('conflictResolve', { path, choice: 'edit', expected: second.expected, content }), /confirmation/i);
  await run('conflictResolve', { path, choice: 'edit', expected: second.expected, content, confirmed: true });
  assert.equal((await refs()).operation.conflicts.length, 0);
  assert.equal(await readFile(join(repoPath, path), 'utf8'), content);
  assert.equal(git(repoPath, 'show', `:${path}`), content.trimEnd());
});

test('manual conflict resolution refuses a binary result and symbolic links', async t => {
  const { repoPath, run } = await diverged(t);
  await assert.rejects(run('merge', { ref: 'side' }), /conflict/i);
  const path = 'file.txt';
  const target = join(repoPath, path);
  await writeFile(target, Buffer.from([0xff, 0x00, 0x0a]));
  const binary = await run('conflictRead', { path });
  assert.equal(binary.current, null);
  assert.equal(binary.expected, null);
  await assert.rejects(run('conflictResolve', { path, choice: 'edit', expected: binary.expected, content: 'text', confirmed: true }), /editable/i);
  await rm(target);
  git(repoPath, 'config', 'core.symlinks', 'true');
  await symlink('destination', target);
  const link = await run('conflictRead', { path });
  assert.equal(link.current, 'destination');
  assert.equal(link.expected, null);
});

test('rebase and cherry-pick expose and abort a conflicting operation', async t => {
  const { repoPath, run, refs, main, side } = await diverged(t);
  await assert.rejects(run('cherryPick', { ref: side }), /conflict/i);
  assert.equal((await refs()).operation.type, 'cherryPick');
  await run('cherryPickAbort', { confirmed: true });
  await assert.rejects(run('rebase', { ref: side }), /conflict/i);
  assert.equal((await refs()).operation.type, 'rebase');
  await run('rebaseAbort', { confirmed: true });
  assert.equal(git(repoPath, 'rev-parse', 'HEAD'), main);
  assert.equal((await refs()).operation, null);
});

test('stash preserves selected staged/untracked states and rejects a stale stash index', async t => {
  const { repoPath, run, refs } = await checkout(t);
  await writeFile(join(repoPath, 'staged.txt'), 'staged change\n');
  git(repoPath, 'add', 'staged.txt');
  await writeFile(join(repoPath, 'file.txt'), 'unstaged change\n');
  await run('stashPush', { staged: true, message: 'selected staged' });
  const first = (await refs()).stashes[0];
  assert.match(first.subject, /selected staged/);
  assert.equal(git(repoPath, 'status', '--short').trim(), 'M file.txt');
  await writeFile(join(repoPath, 'untracked.txt'), 'untracked\n');
  await run('stashPush', { includeUntracked: true, message: 'all changes' });
  const second = (await refs()).stashes[0];
  await assert.rejects(run('stashDrop', { ref: first.ref, expected: first.head, confirmed: true }), /stash.*changed/i);
  await run('stashApply', { ref: second.ref, expected: second.head });
  assert.equal(await readFile(join(repoPath, 'untracked.txt'), 'utf8'), 'untracked\n');
  await run('stashDrop', { ref: second.ref, expected: second.head, confirmed: true });
  await run('stashPop', { ref: first.ref, expected: first.head, restoreIndex: true });
  assert.equal(git(repoPath, 'diff', '--cached', '--name-only'), 'staged.txt');
  assert.deepEqual((await refs()).stashes, []);
});

test('dropping all stashes requires explicit confirmation and the unchanged ordered snapshot', async t => {
  const { repoPath, run, refs } = await checkout(t);
  await writeFile(join(repoPath, 'file.txt'), 'first change\n');
  await run('stashPush', { message: 'first' });
  const first = (await refs()).stashes.map(item => item.head);
  await assert.rejects(run('stashDropAll', { expectedStashes: first }), /confirmation/i);
  await writeFile(join(repoPath, 'file.txt'), 'second change\n');
  await run('stashPush', { message: 'second' });
  const stashes = (await refs()).stashes.map(item => item.head);
  await assert.rejects(run('stashDropAll', { expectedStashes: first, confirmed: true }), /stash.*changed/i);
  await assert.rejects(run('stashDropAll', { expectedStashes: [...stashes].reverse(), confirmed: true }), /stash.*changed/i);
  await run('stashDropAll', { expectedStashes: stashes, confirmed: true });
  assert.deepEqual((await refs()).stashes, []);
  assert.throws(() => git(repoPath, 'rev-parse', '--verify', 'refs/stash'));
});

test('creates linked worktrees, moves uncommitted changes, and protects dirty worktrees from removal', async t => {
  const { dir, repoPath, run, refs } = await checkout(t);
  const destination = join(dir, 'linked tree');
  await run('createWorktree', { destination, newBranch: 'linked', confirmed: true });
  assert((await refs()).worktrees.some(item => item.path === git(destination, 'rev-parse', '--show-toplevel') && item.branch === 'linked'));
  await writeFile(join(repoPath, 'file.txt'), 'staged\n');
  git(repoPath, 'add', 'file.txt');
  await writeFile(join(repoPath, 'file.txt'), 'staged\nunstaged\n');
  await writeFile(join(repoPath, 'untracked.txt'), 'untracked\n');
  await run('moveWorktreeChanges', { destination, confirmed: true });
  assert.equal(git(repoPath, 'status', '--short'), '');
  assert.equal(git(destination, 'show', ':file.txt'), 'staged');
  assert.equal(await readFile(join(destination, 'file.txt'), 'utf8'), 'staged\nunstaged\n');
  assert.equal(await readFile(join(destination, 'untracked.txt'), 'utf8'), 'untracked\n');
  await assert.rejects(run('removeWorktree', { destination, confirmed: true }), /modified|untracked/i);
  await run('removeWorktree', { destination, force: true, confirmed: true });
  assert.equal((await refs()).worktrees.length, 1);
});

test('removes registered linked worktree metadata after its directory is gone', async t => {
  const { dir, run, refs } = await checkout(t);
  const destination = join(dir, 'removed tree');
  await run('createWorktree', { destination, newBranch: 'removed', confirmed: true });
  const worktree = (await refs()).worktrees.find(item => item.branch === 'removed');
  await rm(destination, { force: true, recursive: true });
  await run('removeWorktree', { destination: worktree.path, confirmed: true });
  assert.equal((await refs()).worktrees.length, 1);
});

test('a conflicting worktree move keeps a recovery stash with the complete source changes', async t => {
  const { dir, repoPath, run, refs } = await checkout(t);
  const destination = join(dir, 'diverged worktree');
  await run('createWorktree', { destination, newBranch: 'diverged', confirmed: true });
  await commit(destination, 'change in destination branch\n');
  await writeFile(join(repoPath, 'file.txt'), 'change in source worktree\n');
  await assert.rejects(run('moveWorktreeChanges', { destination, confirmed: true }), /source changes are saved in stash/i);
  const [stash] = (await refs()).stashes;
  assert.equal(git(repoPath, 'show', `${stash.head}:file.txt`), 'change in source worktree');
  assert.equal(git(destination, 'status', '--porcelain'), 'UU file.txt');
});

test('refuses unsafe configured remote helpers when fetching', async t => {
  const { repoPath, run } = await checkout(t);
  git(repoPath, 'remote', 'add', 'unsafe', 'ext::echo forbidden');
  await assert.rejects(run('fetch', { remote: 'unsafe' }), /transport/i);
  assert.equal(git(repoPath, 'status', '--porcelain'), '');
});

test('explicit rebase sync rebases diverged local work and then pushes the result', async t => {
  const { repoPath, peer, remote, run } = await remoteFixture(t);
  const local = await commit(repoPath, 'local content\n', 'local.txt');
  const upstream = await commit(peer, 'remote content\n', 'remote.txt');
  git(peer, 'push');
  await assert.rejects(run('syncRebase'), /confirmation/i);
  await run('syncRebase', { confirmed: true });
  const head = git(repoPath, 'rev-parse', 'HEAD');
  assert.notEqual(head, local);
  assert.equal(git(repoPath, 'rev-parse', 'HEAD^'), upstream);
  assert.equal(remoteTip(remote), head);
});

test('push with followed tags publishes reachable annotated tags and the selected branch', async t => {
  const { repoPath, remote, run } = await remoteFixture(t);
  git(repoPath, 'switch', '-c', 'private');
  await commit(repoPath, 'private content\n', 'private.txt');
  git(repoPath, 'tag', '-a', 'private-annotated', '-m', 'Private tag');
  git(repoPath, 'switch', 'main');
  await commit(repoPath, 'publish content\n');
  git(repoPath, 'tag', '-a', 'public-annotated', '-m', 'Release');
  git(repoPath, 'tag', 'local-lightweight');
  await run('push', { confirmed: true });
  assert.equal(git(remote, `--git-dir=${remote}`, 'tag', '--list'), '');
  await run('push', { followTags: true, confirmed: true });
  assert.equal(git(remote, `--git-dir=${remote}`, 'tag', '--list'), 'public-annotated');
  assert.equal(git(remote, `--git-dir=${remote}`, 'branch', '--format=%(refname:short)'), 'main');
});
