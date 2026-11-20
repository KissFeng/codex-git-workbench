import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gitBlame, gitCompare, gitHistory, gitHistoryDetail } from '../plugins/source-control-proof/git-history.mjs';

async function repository(t) {
  const repoPath = await mkdtemp(join(tmpdir(), 'codex-git-history-'));
  t.after(() => rm(repoPath, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['--literal-pathspecs', '-C', repoPath, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Proof Author');
  git('config', 'user.email', 'proof@example.test');
  git('config', 'commit.gpgsign', 'false');
  const write = (path, content) => writeFile(join(repoPath, path), content);
  async function commit(path, content, message) {
    await write(path, content);
    git('add', '--', path);
    git('commit', '-m', message);
    return git('rev-parse', 'HEAD');
  }
  return { repoPath, git, write, commit };
}

async function fork(t) {
  const fixture = await repository(t);
  const { git, commit } = fixture;
  const base = await commit('story.txt', 'base\n', 'Base');
  git('tag', '-a', 'v1', '-m', 'Version 1', base);
  git('switch', '-c', 'side');
  const side = await commit('side.txt', 'side\n', 'Side');
  git('switch', '-c', 'upstream', base);
  const remote = await commit('remote.txt', 'remote\n', 'Remote');
  git('update-ref', 'refs/remotes/origin/main', remote);
  git('config', 'remote.origin.url', '.');
  git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  git('config', 'branch.main.remote', 'origin');
  git('config', 'branch.main.merge', 'refs/heads/main');
  git('switch', 'main');
  const local = await commit('story.txt', 'base\nlocal\n', 'Local');
  git('merge', '--no-ff', '-m', 'Merge side', 'side');
  const head = git('rev-parse', 'HEAD');
  return { ...fixture, base, side, remote, local, head };
}

test('history shows forks, merge parents, refs and divergence', async t => {
  const { repoPath, base, side, remote, local, head } = await fork(t);
  const result = await gitHistory({ repoPath });
  assert.deepEqual([result.head, result.upstream, result.base, result.ahead, result.behind], [head, remote, base, 3, 1]);
  const commits = new Map(result.commits.map(commit => [commit.id, commit]));
  assert.deepEqual(commits.get(head).parents, [local, side]);
  assert.equal(commits.get(head).subject, 'Merge side');
  assert.equal(commits.get(head).author, 'Proof Author');
  assert.match(commits.get(head).date, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(commits.get(head).relation, 'ahead');
  assert.equal(commits.get(remote).relation, 'behind');
  assert.equal(commits.get(base).relation, 'shared');
  assert(commits.get(head).refs.some(ref => ref.kind === 'head'));
  assert(commits.get(head).refs.some(ref => ref.kind === 'branch' && ref.name === 'main'));
  assert(commits.get(remote).refs.some(ref => ref.kind === 'remote' && ref.name === 'origin/main'));
  assert(commits.get(base).refs.some(ref => ref.kind === 'tag' && ref.name === 'v1'));
  assert.equal(result.nextOffset, null);
  assert.equal(result.cursor, null);
});

test('history continuation keeps its original start commits when HEAD advances', async t => {
  const { repoPath, commit, head } = await fork(t);
  const full = await gitHistory({ repoPath });
  const first = await gitHistory({ repoPath, limit: 2 });
  assert.equal(first.nextOffset, 2);
  assert.equal(typeof first.cursor, 'string');
  const newHead = await commit('after.txt', 'new\n', 'New after page one');
  const next = await gitHistory({ repoPath, limit: 2, cursor: first.cursor });
  const last = await gitHistory({ repoPath, limit: 2, offset: next.nextOffset, cursor: next.cursor });
  assert.equal(next.head, head);
  assert.deepEqual([...first.commits, ...next.commits, ...last.commits].map(commit => commit.id), full.commits.map(commit => commit.id));
  assert.equal((await gitHistory({ repoPath })).head, newHead);
});

test('file history takes a branch and a literal checkout-relative path', async t => {
  const { repoPath, base, remote, git, commit } = await fork(t);
  const path = ':(glob)literal file.txt';
  git('switch', 'side');
  const only = await commit(path, 'literal\n', 'Literal file');
  const subdirectory = join(repoPath, 'subdirectory');
  await mkdir(subdirectory);
  const result = await gitHistory({ repoPath: subdirectory, ref: 'side', path });
  assert.deepEqual(result.commits.map(commit => commit.id), [only]);
  assert.deepEqual((await gitHistory({ repoPath, ref: 'origin/main' })).commits.map(commit => commit.id), [remote, base]);
});

test('history handles an unborn branch and a detached HEAD', async t => {
  const { repoPath, git, commit } = await repository(t);
  assert.deepEqual(await gitHistory({ repoPath }), {
    commits: [], head: null, upstream: null, base: null, ahead: 0, behind: 0, nextOffset: null, cursor: null,
  });
  const id = await commit('file', 'one\n', 'First');
  git('switch', '--detach');
  const result = await gitHistory({ repoPath });
  assert.equal(result.head, id);
  assert.equal(result.upstream, null);
  assert.equal(result.commits[0].relation, 'local');
});

test('commit detail reads root patches, full messages and a selected merge parent', async t => {
  const { repoPath, base, side, head } = await fork(t);
  const first = await gitHistoryDetail({ repoPath, commit: base, path: 'story.txt' });
  assert.equal(first.message, 'Base');
  assert.deepEqual(first.files, [{ path: 'story.txt', status: 'A' }]);
  assert.match(first.diff, /^\+base$/m);
  const firstParent = await gitHistoryDetail({ repoPath, commit: head });
  assert.deepEqual(firstParent.files, [{ path: 'side.txt', status: 'A' }]);
  const secondParent = await gitHistoryDetail({ repoPath, commit: head, parent: side, path: 'story.txt' });
  assert.deepEqual(secondParent.files, [{ path: 'story.txt', status: 'M' }]);
  assert.match(secondParent.diff, /^\+local$/m);
  await assert.rejects(gitHistoryDetail({ repoPath, commit: head, parent: base }), /parent/i);
});

test('detail and comparison report rename paths and patch them together', async t => {
  const { repoPath, git, commit } = await repository(t);
  const oldPath = 'old\tname.txt', path = 'new\nname.txt';
  const from = await commit(oldPath, 'one\n', 'Old');
  await rename(join(repoPath, oldPath), join(repoPath, path));
  git('add', '-A');
  git('commit', '-m', 'Rename', '-m', 'Preserve the message body.');
  const to = git('rev-parse', 'HEAD');
  const expected = [{ path, originalPath: oldPath, status: 'R' }];
  const detail = await gitHistoryDetail({ repoPath, commit: to, path });
  assert.deepEqual(detail.files, expected);
  assert.equal(detail.message, 'Rename\n\nPreserve the message body.');
  assert.match(detail.diff, /^rename to /m);
  const comparison = await gitCompare({ repoPath, from, to, path: oldPath });
  assert.deepEqual(comparison.files, expected);
  assert.match(comparison.diff, /^rename from /m);
  assert.deepEqual((await gitHistory({ repoPath, path })).commits.map(commit => commit.id), [to, from]);
});

test('comparison supports merge bases and tracked working changes without invoking external diff', async t => {
  const { repoPath, git, write, head, remote } = await fork(t);
  const direct = await gitCompare({ repoPath, from: head, to: remote });
  assert.deepEqual(direct.files.map(file => file.status), ['A', 'D', 'M']);
  assert.deepEqual((await gitCompare({ repoPath, from: head, to: remote, mergeBase: true })).files,
    [{ path: 'remote.txt', status: 'A' }]);
  git('config', 'diff.external', './nonexistent-diff');
  git('config', 'diff.unsafe.textconv', './nonexistent-textconv');
  await write('.gitattributes', '*.txt diff=unsafe\n');
  await write('stage.txt', 'stage\n');
  git('add', 'stage.txt');
  await write('story.txt', 'base\nlocal\nworktree\n');
  const before = git('status', '--porcelain=v1', '-z');
  const working = await gitCompare({ repoPath, from: head, path: 'story.txt' });
  assert.deepEqual(working.files, [{ path: 'story.txt', status: 'M' }]);
  assert.match(working.diff, /^\+worktree$/m);
  assert((await gitCompare({ repoPath, from: head })).files.some(file => file.path === 'stage.txt'));
  assert.equal(git('status', '--porcelain=v1', '-z'), before);
});

test('blame reads committed and working-copy line attribution', async t => {
  const { repoPath, base, local, write } = await fork(t);
  const path = 'story.txt';
  await write(path, 'base\nlocal\nworking\n');
  const atCommit = await gitBlame({ repoPath, ref: local, path });
  assert.deepEqual(atCommit.lines, [
    { line: 1, commit: base, author: 'Proof Author', summary: 'Base' },
    { line: 2, commit: local, author: 'Proof Author', summary: 'Local' },
  ]);
  const working = await gitBlame({ repoPath, path });
  assert.deepEqual(working.lines.slice(0, 2), atCommit.lines);
  assert.equal(working.lines[2].line, 3);
  assert.equal(working.lines[2].commit, null);
});

test('blame returns an empty array for an empty file', async t => {
  const { repoPath, commit } = await repository(t);
  const id = await commit('empty.txt', '', 'Empty');
  assert.deepEqual(await gitBlame({ repoPath, path: 'empty.txt', ref: id }), { lines: [] });
  assert.deepEqual(await gitBlame({ repoPath, path: 'empty.txt' }), { lines: [] });
});

test('large patches and blame responses report their limits', async t => {
  const { repoPath, commit } = await repository(t);
  const from = await commit('large.txt', '', 'Empty');
  const to = await commit('large.txt', ('a'.repeat(270) + '\n').repeat(2002), 'Large');
  const comparison = await gitCompare({ repoPath, from, to, path: 'large.txt' });
  assert.deepEqual(comparison, { files: [{ path: 'large.txt', status: 'M' }], diffTruncated: true });
  const attribution = await gitBlame({ repoPath, path: 'large.txt', ref: to });
  assert.equal(attribution.lines.length, 2000);
  assert.equal(attribution.linesTruncated, true);
});

test('working-copy blame rejects a tracked path redirected outside the checkout', async t => {
  const { repoPath, commit } = await repository(t);
  await mkdir(join(repoPath, 'directory'));
  const id = await commit('directory/file', 'inside\n', 'Inside');
  const external = await mkdtemp(join(tmpdir(), 'codex-git-outside-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(join(external, 'file'), 'outside\n');
  await rm(join(repoPath, 'directory'), { recursive: true });
  await symlink(external, join(repoPath, 'directory'), 'dir');
  await assert.rejects(gitBlame({ repoPath, path: 'directory/file' }), /inside the checkout/i);
  assert.equal((await gitBlame({ repoPath, path: 'directory/file', ref: id })).lines[0].commit, id);
});

test('history commands reject flags, paths outside the checkout and invalid cursors', async t => {
  const { repoPath, head } = await fork(t);
  await assert.rejects(gitHistory({ repoPath, ref: '--all' }), /revision/i);
  await assert.rejects(gitHistory({ repoPath, cursor: 'bad' }), /cursor/i);
  await assert.rejects(gitCompare({ repoPath, from: '--no-index', to: head }), /revision/i);
  await assert.rejects(gitHistoryDetail({ repoPath, commit: head, path: '../secret' }), /inside the checkout/i);
  await assert.rejects(gitBlame({ repoPath, path: '.git/config' }), /inside the checkout/i);
});
