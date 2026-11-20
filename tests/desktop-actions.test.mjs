import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { handle } from '../plugins/source-control-proof/server.mjs';

test('desktop tools are app-only and reject invalid file actions', async () => {
  const { tools } = await handle('tools/list');
  for (const name of ['desktop_pick_checkout', 'desktop_file_action']) {
    assert.deepEqual(tools.find(tool => tool.name === name)?._meta.ui.visibility, ['app']);
  }
  await assert.rejects(handle('tools/call', { name: 'desktop_file_action', arguments: {
    repoPath: '/checkout', path: 'notes.txt', action: 'execute',
  } }), /Invalid action/);
});

async function repository(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-desktop-actions-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repoPath = join(root, '仓库 checkout');
  await mkdir(repoPath);
  execFileSync('git', ['-C', repoPath, 'init', '-q']);
  const path = 'src/文档 [1] & notes.txt';
  await mkdir(dirname(join(repoPath, path)));
  await writeFile(join(repoPath, path), 'fixture');
  return { root, repoPath, path };
}

test('native picker returns the Git root, handles cancellation and rejects non-Git folders', async t => {
  const { pickCheckout } = await import('../plugins/source-control-proof/desktop-actions.mjs');
  const { root, repoPath, path } = await repository(t);
  const child = dirname(join(repoPath, path));
  const calls = [];
  const select = (platform, stdout) => pickCheckout({ repoPath }, { platform, run: async (...args) => {
    calls.push(args);
    return { stdout };
  } });
  assert.deepEqual(await select('darwin', child + '\n'), { checkout: repoPath });
  assert.match(calls[0][0], /osascript$/);
  assert.deepEqual(await select('win32', child + '\r\n'), { checkout: repoPath });
  assert.match(calls[1][0], /powershell\.exe$/i);
  assert.deepEqual(await select('win32', ''), { checkout: null });
  await assert.rejects(select('darwin', root + '\n'), /No Git checkout/);
  await assert.rejects(select('linux', ''), /Folder picker is unavailable/);
});

test('desktop file actions use literal paths and support opening the parent of a deleted file', async t => {
  const { openCheckoutItem } = await import('../plugins/source-control-proof/desktop-actions.mjs');
  const { root, repoPath, path } = await repository(t);
  const calls = [];
  const launch = (platform, action, file = path) => openCheckoutItem({ repoPath, path: file, action }, {
    platform, run: async (...args) => { calls.push(args); return { stdout: '' }; },
  });
  const target = join(repoPath, path);
  await launch('darwin', 'open');
  assert.deepEqual(calls[0].slice(0, 2), ['/usr/bin/open', [target]]);
  await launch('win32', 'folder');
  assert.match(calls[1][0], /powershell\.exe$/i);
  assert.equal(calls[1][2].env.CODEX_GIT_WORKBENCH_TARGET, dirname(target));
  await rm(target);
  await assert.rejects(launch('darwin', 'open'), /no longer exists/);
  await launch('darwin', 'folder');
  assert.deepEqual(calls[2][1], [dirname(target)]);
  await assert.rejects(launch('darwin', 'open', '../outside.txt'), /inside the checkout/);
  await symlink(root, join(repoPath, 'outside'), 'junction');
  await assert.rejects(launch('darwin', 'folder', 'outside/file.txt'), /inside the checkout/);
  assert.equal(calls.length, 3);
});
