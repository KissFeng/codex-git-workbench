import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

async function fixture(t, files = {}) {
  const repoPath = await mkdtemp(join(tmpdir(), 'codex-git-actions-'));
  t.after(() => rm(repoPath, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (path, contents) => writeFile(join(repoPath, path), contents);
  const read = path => readFile(join(repoPath, path), 'utf8');
  git('init', '-b', 'main');
  git('config', 'user.name', 'Proof');
  git('config', 'user.email', 'proof@example.test');
  git('config', 'commit.gpgsign', 'false');
  for (const [path, contents] of Object.entries(files)) await write(path, contents);
  if (Object.keys(files).length) {
    git('add', '--all');
    git('commit', '-m', 'Fixture');
  }
  return { repoPath, git, write, read };
}

test('bulk staging and unstaging respect the selected group and unborn HEAD', async t => {
  const { gitChange } = await import('../plugins/source-control-proof/git-staging.mjs');
  const { repoPath, git, write } = await fixture(t);
  await write('staged.txt', 'index');
  await write('new.txt', 'new');
  git('add', 'staged.txt');
  await write('staged.txt', 'working');
  const tracked = await gitChange({ repoPath, action: 'stage', group: 'unstaged' });
  assert.deepEqual(tracked.untracked.map(file => file.path), ['new.txt']);
  assert.equal(git('show', ':staged.txt'), 'working');
  const all = await gitChange({ repoPath, action: 'stage' });
  assert.equal(all.staged.length, 2);
  const unstaged = await gitChange({ repoPath, action: 'unstage' });
  assert.deepEqual(unstaged.untracked.map(file => file.path), ['new.txt', 'staged.txt']);
});

test('discard requires confirmation and restores the index snapshot for tracked files', async t => {
  const { gitChange } = await import('../plugins/source-control-proof/git-staging.mjs');
  const { repoPath, git, write, read } = await fixture(t, { 'partial.txt': 'HEAD', 'keep.txt': 'original' });
  await write('partial.txt', 'index');
  git('add', 'partial.txt');
  await write('partial.txt', 'working');
  await write('keep.txt', 'keep');
  await write('untracked.txt', 'untracked');
  const request = { repoPath, action: 'discard', group: 'unstaged', path: 'partial.txt' };
  await assert.rejects(gitChange(request), /confirm/i);
  assert.equal(await read('partial.txt'), 'working');
  await gitChange({ ...request, confirmed: true });
  assert.equal(await read('partial.txt'), 'index');
  assert.equal(await read('keep.txt'), 'keep');
  assert.equal(await read('untracked.txt'), 'untracked');
});

test('discard refuses to replace an untracked directory or an untracked parent file', async t => {
  const { gitChange } = await import('../plugins/source-control-proof/git-staging.mjs');
  const { repoPath, git, write, read } = await fixture(t, { 'tracked.txt': 'original' });
  await mkdir(join(repoPath, 'previous-directory'));
  await write('previous-directory/tracked.txt', 'original');
  git('add', 'previous-directory/tracked.txt');
  git('commit', '-m', 'Track directory content');
  await rm(join(repoPath, 'tracked.txt'));
  await mkdir(join(repoPath, 'tracked.txt'));
  await write('tracked.txt/valuable.txt', 'keep directory contents');
  await rm(join(repoPath, 'previous-directory'), { recursive: true });
  await write('previous-directory', 'keep untracked file');
  const request = { repoPath, action: 'discard', group: 'unstaged', confirmed: true };
  await assert.rejects(gitChange({ ...request, path: 'tracked.txt' }), /obstruct|directory/i);
  await assert.rejects(gitChange({ ...request, path: 'previous-directory/tracked.txt' }), /obstruct|directory/i);
  assert.equal(await read('tracked.txt/valuable.txt'), 'keep directory contents');
  assert.equal(await read('previous-directory'), 'keep untracked file');
});

test('confirmed discard of the untracked group removes only the listed files', async t => {
  const { gitChange } = await import('../plugins/source-control-proof/git-staging.mjs');
  const { repoPath, write, read } = await fixture(t, { 'tracked.txt': 'HEAD', '.gitignore': '/ignored.txt\n' });
  await mkdir(join(repoPath, 'folder'));
  await write('folder/new [one].txt', 'untracked');
  await write('another.txt', 'untracked');
  await write('tracked.txt', 'unstaged tracked edit');
  await write('ignored.txt', 'ignored');
  const request = { repoPath, action: 'discard', group: 'untracked' };
  await assert.rejects(gitChange(request), /confirm/i);
  const result = await gitChange({ ...request, confirmed: true });
  assert.deepEqual(result.untracked, []);
  assert.equal(await read('tracked.txt'), 'unstaged tracked edit');
  assert.equal(await read('ignored.txt'), 'ignored');
  await assert.rejects(read('folder/new [one].txt'), /ENOENT/);
  await assert.rejects(read('another.txt'), /ENOENT/);
});

test('bulk untracked discard handles two literal paths that link to the same file', async t => {
  const { gitChange } = await import('../plugins/source-control-proof/git-staging.mjs');
  const { repoPath, write, read } = await fixture(t);
  await write('first.txt', 'shared');
  await link(join(repoPath, 'first.txt'), join(repoPath, 'second.txt'));
  const status = await gitChange({ repoPath, action: 'discard', group: 'untracked', confirmed: true });
  assert.deepEqual(status.untracked, []);
  await assert.rejects(read('first.txt'), /ENOENT/);
  await assert.rejects(read('second.txt'), /ENOENT/);
});

test('bulk discard rejects a file list that changed after confirmation', async t => {
  const { gitChange } = await import('../plugins/source-control-proof/git-staging.mjs');
  const { repoPath, write, read } = await fixture(t);
  await write('visible.txt', 'reviewed');
  const request = { repoPath, action: 'discard', group: 'untracked', confirmed: true, expectedPaths: ['visible.txt'] };
  await write('added-later.txt', 'unreviewed');
  await assert.rejects(gitChange(request), /changed.*refresh/i);
  assert.equal(await read('visible.txt'), 'reviewed');
  assert.equal(await read('added-later.txt'), 'unreviewed');
  const updated = await gitChange({ ...request, expectedPaths: ['visible.txt', 'added-later.txt', 'visible.txt'] });
  assert.equal(updated.untracked.length, 0);
});

test('exact path actions ignore special patterns, rename without overwriting and confirm deletion', async t => {
  const { gitChange } = await import('../plugins/source-control-proof/git-staging.mjs');
  const { repoPath, git, write, read } = await fixture(t, { 'tracked.txt': 'head' });
  await write('new [one].txt ', 'ignore me');
  await write('new o.txt ', 'keep visible');
  await gitChange({ repoPath, action: 'ignore', group: 'untracked', path: 'new [one].txt ' });
  assert.match(git('check-ignore', '--', 'new [one].txt '), /one/);
  await assert.rejects(gitChange({ repoPath, action: 'rename', group: 'untracked', path: 'new o.txt ', newPath: 'tracked.txt' }), /exists/i);
  await gitChange({ repoPath, action: 'rename', group: 'untracked', path: 'new o.txt ', newPath: 'renamed.txt' });
  assert.equal(await read('renamed.txt'), 'keep visible');
  const request = { repoPath, action: 'delete', group: 'untracked', path: 'renamed.txt' };
  await assert.rejects(gitChange(request), /confirm/i);
  await gitChange({ ...request, confirmed: true });
  await assert.rejects(read('renamed.txt'), /ENOENT/);
});

test('patch actions stage one hunk, unstage exact lines and preserve unrelated index entries', async t => {
  const { gitPatch, applyGitPatch } = await import('../plugins/source-control-proof/git-patch.mjs');
  const base = Array.from({ length: 24 }, (_, index) => 'line ' + index);
  const updated = [...base];
  updated[1] = 'first change';
  updated[20] = 'second change';
  const path = 'text [literal].txt';
  const { repoPath, git, write, read } = await fixture(t, { [path]: base.join('\n') + '\n', 'keep.txt': 'before' });
  await write('keep.txt', 'already staged');
  git('add', 'keep.txt');
  await write(path, updated.join('\n') + '\n');
  const unstaged = await gitPatch({ repoPath, path, group: 'unstaged' });
  assert.equal(unstaged.hunks.length, 2);
  await applyGitPatch({ repoPath, path, group: 'unstaged', action: 'stage', token: unstaged.token, hunkIds: [unstaged.hunks[0].id] });
  assert.match(git('show', ':' + path), /first change/);
  assert.doesNotMatch(git('show', ':' + path), /second change/);
  const staged = await gitPatch({ repoPath, path, group: 'staged' });
  const changedLines = staged.hunks[0].lines.filter(line => ['addition', 'deletion'].includes(line.kind));
  await applyGitPatch({ repoPath, path, group: 'staged', action: 'unstage', token: staged.token, lineIds: changedLines.map(line => line.id) });
  assert.equal(git('show', ':' + path), base.join('\n') + '\n');
  assert.equal(await read(path), updated.join('\n') + '\n');
  assert.equal(git('show', ':keep.txt'), 'already staged');
});

test('selected hunks keep their source position when an earlier hunk changes the line count', async t => {
  const { gitPatch, applyGitPatch } = await import('../plugins/source-control-proof/git-patch.mjs');
  const original = Array.from({ length: 32 }, (_, index) => 'line ' + index);
  const edited = [...original];
  edited.splice(29, 1, 'last edit');
  edited.splice(15, 1, 'unselected edit');
  edited.splice(2, 0, 'inserted line');
  const expected = [...original];
  expected.splice(29, 1, 'last edit');
  expected.splice(2, 0, 'inserted line');
  const path = 'text.txt';
  const content = lines => lines.join('\n') + '\n';
  const { repoPath, git, write } = await fixture(t, { [path]: content(original) });
  await write(path, content(edited));
  const request = { repoPath, path, group: 'unstaged', action: 'stage' };
  const diff = await gitPatch(request);
  assert.equal(diff.hunks.length, 3);
  await applyGitPatch({ ...request, token: diff.token, hunkIds: [diff.hunks[0].id, diff.hunks[2].id] });
  assert.equal(git('show', ':' + path), content(expected));
});

test('patch actions reject stale selections and discard only the chosen line edits', async t => {
  const { gitPatch, applyGitPatch } = await import('../plugins/source-control-proof/git-patch.mjs');
  const path = 'text.txt';
  const { repoPath, git, write, read } = await fixture(t, { [path]: 'a\nb\n' });
  await write(path, 'a\nb\nfirst\nsecond\n');
  const request = { repoPath, path, group: 'unstaged', action: 'discard', confirmed: true };
  const initial = await gitPatch(request);
  await write(path, 'a\nb\nfirst\nsecond\nthird\n');
  await assert.rejects(applyGitPatch({ ...request, token: initial.token, hunkIds: [initial.hunks[0].id] }), /changed|stale/i);
  const current = await gitPatch(request);
  const line = current.hunks[0].lines.find(item => item.text === '+second');
  await assert.rejects(applyGitPatch({ ...request, token: current.token, lineIds: ['invalid'] }), /selection/i);
  await applyGitPatch({ ...request, token: current.token, lineIds: [line.id] });
  assert.equal(await read(path), 'a\nb\nfirst\nthird\n');
  assert.equal(git('show', ':' + path), 'a\nb\n');
});

test('patch actions handle staged additions and unstaged deletions without a final newline', async t => {
  const { gitPatch, applyGitPatch } = await import('../plugins/source-control-proof/git-patch.mjs');
  const { repoPath, git, write, read } = await fixture(t, { 'deleted.txt': 'first\nsecond' });
  const added = { repoPath, path: 'added.txt', group: 'staged', action: 'unstage' };
  await write(added.path, 'first\nsecond');
  git('add', added.path);
  const addition = await gitPatch(added);
  await applyGitPatch({ ...added, token: addition.token, hunkIds: [addition.hunks[0].id] });
  assert.equal(git('ls-files', added.path), '');
  assert.equal(await read(added.path), 'first\nsecond');
  const deleted = { repoPath, path: 'deleted.txt', group: 'unstaged', action: 'discard', confirmed: true };
  await rm(join(repoPath, deleted.path));
  const deletion = await gitPatch(deleted);
  const selected = deletion.hunks[0].lines.find(line => line.text === '-second');
  await applyGitPatch({ ...deleted, token: deletion.token, lineIds: [selected.id] });
  assert.equal(await read(deleted.path), 'second');
});

test('patch actions preserve CRLF content and quote paths with spaces and control characters', async t => {
  const { gitPatch, applyGitPatch } = await import('../plugins/source-control-proof/git-patch.mjs');
  const path = 'quoted " ñ\t.txt';
  const { repoPath, git, write, read } = await fixture(t, { [path]: 'first\r\nsecond\r\n' });
  git('config', 'core.autocrlf', 'true');
  await write(path, 'first\r\nsecond\r\nthird\r\n');
  const request = { repoPath, path, group: 'unstaged', action: 'discard', confirmed: true };
  const patch = await gitPatch(request);
  const selected = patch.hunks[0].lines.find(line => line.kind === 'addition');
  await applyGitPatch({ ...request, token: patch.token, lineIds: [selected.id] });
  assert.equal(await read(path), 'first\r\nsecond\r\n');
});

test('patch actions accept a single hunk with many short lines under the byte limit', async t => {
  const { gitPatch, applyGitPatch } = await import('../plugins/source-control-proof/git-patch.mjs');
  const path = 'many-lines.txt';
  const { repoPath, git, write } = await fixture(t);
  await write(path, 'a\n'.repeat(130_000));
  git('add', path);
  const request = { repoPath, path, group: 'staged', action: 'unstage' };
  const patch = await gitPatch(request);
  await applyGitPatch({ ...request, token: patch.token, hunkIds: [patch.hunks[0].id] });
  assert.equal(git('ls-files', path), '');
});

test('untracked patch staging rejects stale content and adds only the selected lines to the index', async t => {
  const { gitPatch, applyGitPatch } = await import('../plugins/source-control-proof/git-patch.mjs');
  const path = 'new [ñ].txt';
  const { repoPath, git, write, read } = await fixture(t);
  const request = { repoPath, path, group: 'untracked', action: 'stage' };
  await write(path, 'first\nsecond\n');
  const before = await gitPatch(request);
  await write(path, 'first\nsecond\nthird');
  await assert.rejects(applyGitPatch({ ...request, token: before.token, hunkIds: [before.hunks[0].id] }), /changed/i);
  const current = await gitPatch(request);
  const third = current.hunks[0].lines.find(line => line.text === '+third');
  const result = await applyGitPatch({ ...request, token: current.token, lineIds: [third.id] });
  assert.equal(git('show', ':' + path), 'third');
  assert.equal(await read(path), 'first\nsecond\nthird');
  assert.deepEqual(result.staged.map(file => file.path), [path]);
  assert.deepEqual(result.unstaged.map(file => file.path), [path]);
});

test('untracked patch staging uses Git line normalization and keeps working-copy bytes', async t => {
  const { gitPatch, applyGitPatch } = await import('../plugins/source-control-proof/git-patch.mjs');
  const { repoPath, git, write, read } = await fixture(t);
  git('config', 'core.autocrlf', 'true');
  const path = 'new.txt';
  await write(path, 'first\r\nsecond\r\n');
  const request = { repoPath, path, group: 'untracked', action: 'stage' };
  const patch = await gitPatch(request);
  const first = patch.hunks[0].lines.find(line => line.text === '+first');
  await applyGitPatch({ ...request, token: patch.token, lineIds: [first.id] });
  assert.equal(git('show', ':' + path), 'first\n');
  assert.equal(await read(path), 'first\r\nsecond\r\n');
});

test('untracked patch staging honors core.filemode when the working file is executable', async t => {
  const { gitPatch, applyGitPatch } = await import('../plugins/source-control-proof/git-patch.mjs');
  const { repoPath, git, write } = await fixture(t);
  git('config', 'core.filemode', 'false');
  const path = 'tool.sh';
  await write(path, 'first\nsecond\n');
  await chmod(join(repoPath, path), 0o755);
  const request = { repoPath, path, group: 'untracked', action: 'stage' };
  const patch = await gitPatch(request);
  await applyGitPatch({ ...request, token: patch.token, hunkIds: [patch.hunks[0].id] });
  assert.match(git('ls-files', '--stage', path), /^100644 /);
});

test('a regular commit uses only the index and undo preserves the resulting index and working copy', async t => {
  const { gitCommit } = await import('../plugins/source-control-proof/git-commit.mjs');
  const { repoPath, git, write, read } = await fixture(t, { 'tracked.txt': 'head' });
  await write('tracked.txt', 'index');
  git('add', 'tracked.txt');
  await write('tracked.txt', 'working');
  await write('new.txt', 'new');
  await gitCommit({ repoPath, action: 'commit', message: 'Save selected changes' });
  assert.equal(git('show', 'HEAD:tracked.txt'), 'index');
  assert.equal(git('ls-tree', 'HEAD', 'new.txt'), '');
  await assert.rejects(gitCommit({ repoPath, action: 'undoCommit' }), /confirm/i);
  const undone = await gitCommit({ repoPath, action: 'undoCommit', confirmed: true });
  assert.equal(undone.undoneMessage, 'Save selected changes');
  assert.equal(git('show', 'HEAD:tracked.txt'), 'head');
  assert.equal(git('show', ':tracked.txt'), 'index');
  assert.equal(await read('tracked.txt'), 'working');
});

test('commit all includes untracked files and a failing hook leaves the existing index intact', async t => {
  const { gitCommit } = await import('../plugins/source-control-proof/git-commit.mjs');
  const { repoPath, git, write } = await fixture(t, { 'tracked.txt': 'head' });
  await write('tracked.txt', 'index');
  git('add', 'tracked.txt');
  await write('tracked.txt', 'working');
  await write('new.txt', 'new');
  await mkdir(join(repoPath, '.git', 'proof-hooks'));
  const hook = join('.git', 'proof-hooks', 'pre-commit');
  await write(hook, '#!/bin/sh\nprintf "hook rejected\\n" >&2\nexit 1\n');
  await chmod(join(repoPath, hook), 0o755);
  git('config', 'core.hooksPath', '.git/proof-hooks');
  const request = { repoPath, action: 'commitAll', message: 'Save all changes' };
  await assert.rejects(gitCommit(request), /hook rejected/);
  assert.equal(git('show', ':tracked.txt'), 'index');
  assert.equal(git('ls-files', 'new.txt'), '');
  await gitCommit({ ...request, noVerify: true });
  assert.equal(git('show', 'HEAD:tracked.txt'), 'working');
  assert.equal(git('show', 'HEAD:new.txt'), 'new');
  assert.equal(git('status', '--porcelain'), '');
});

test('amend keeps the message by default and undo refuses a commit present on a remote-tracking branch', async t => {
  const { gitCommit } = await import('../plugins/source-control-proof/git-commit.mjs');
  const { repoPath, git, write } = await fixture(t, { 'tracked.txt': 'head' });
  await write('tracked.txt', 'updated');
  git('add', 'tracked.txt');
  await assert.rejects(gitCommit({ repoPath, action: 'amend' }), /confirm/i);
  await gitCommit({ repoPath, action: 'amend', confirmed: true });
  assert.equal(git('show', '-s', '--format=%B', 'HEAD').trim(), 'Fixture');
  assert.equal(git('show', 'HEAD:tracked.txt'), 'updated');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  await assert.rejects(gitCommit({ repoPath, action: 'undoCommit', confirmed: true }), /remote/i);
});

test('undo of the initial commit retains its staged files', async t => {
  const { gitCommit } = await import('../plugins/source-control-proof/git-commit.mjs');
  const { repoPath, git } = await fixture(t, { 'tracked.txt': 'initial' });
  await gitCommit({ repoPath, action: 'undoCommit', confirmed: true });
  assert.equal(git('symbolic-ref', 'HEAD').trim(), 'refs/heads/main');
  assert.equal(git('show', ':tracked.txt'), 'initial');
  assert.match(git('status', '--porcelain'), /^A  tracked.txt/m);
});

test('an empty commit preserves staged changes for the next commit', async t => {
  const { gitCommit } = await import('../plugins/source-control-proof/git-commit.mjs');
  const { repoPath, git, write } = await fixture(t, { 'tracked.txt': 'head' });
  await write('tracked.txt', 'staged');
  git('add', 'tracked.txt');
  await gitCommit({ repoPath, action: 'commitEmpty', message: 'Recorded with no changes' });
  assert.equal(git('show', 'HEAD:tracked.txt'), 'head');
  assert.equal(git('show', ':tracked.txt'), 'staged');
});
