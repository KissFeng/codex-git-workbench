import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getStatus } from '../plugins/source-control-proof/git-status.mjs';

test('status reports unborn, tracking and detached branch state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.com');
  let status = await getStatus(root);
  assert.equal(status.branch, 'main');
  assert.equal(status.head, null);
  assert.equal(status.upstream, null);
  assert.equal(status.operation, null);
  assert.equal(status.hasRemote, false);
  git('commit', '--allow-empty', '-m', 'base');
  git('branch', 'tracked');
  git('branch', '--set-upstream-to=tracked', 'main');
  git('commit', '--allow-empty', '-m', 'ahead');
  git('config', 'status.aheadBehind', 'false');
  const head = git('rev-parse', 'HEAD');
  status = await getStatus(root);
  assert.equal(status.head, head);
  assert.equal(status.upstream, 'tracked');
  assert.equal(status.hasRemote, false);
  assert.equal(status.ahead, 1);
  assert.equal(status.behind, 0);
  git('remote', 'add', 'upstream', 'https://example.test/workbench.git');
  assert.equal((await getStatus(root)).hasRemote, true);
  git('checkout', '--detach');
  status = await getStatus(root);
  assert.equal(status.detached, true);
  assert.equal(status.head, head);
});

test('status recognizes merge, rebase and cherry-pick in a linked worktree', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-operation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'linked');
  const repo = join(root, 'repository');
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git(root, 'init', '-b', 'main', repo);
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(repo, 'file'), 'base\n');
  git(repo, 'add', 'file');
  git(repo, 'commit', '-m', 'base');
  git(repo, 'worktree', 'add', '-b', 'topic', checkout);
  await writeFile(join(repo, 'file'), 'main\n');
  git(repo, 'commit', '-am', 'main');
  await writeFile(join(checkout, 'file'), 'topic\n');
  git(checkout, 'commit', '-am', 'topic');

  for (const [command, operation] of [['merge', 'merge'], ['rebase', 'rebase'], ['cherry-pick', 'cherryPick']]) {
    assert.throws(() => git(checkout, command, 'main'), /Command failed/);
    const conflicted = await getStatus(checkout);
    assert.equal(conflicted.operation, operation);
    assert.equal(conflicted.conflicts.length, 1);
    assert.equal((await getStatus(repo)).operation, null);
    git(checkout, command, '--abort');
    assert.equal((await getStatus(checkout)).operation, null);
  }
});
