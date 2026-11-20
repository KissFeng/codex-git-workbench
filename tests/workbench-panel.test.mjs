import { test } from 'node:test';
import assert from 'node:assert/strict';

test('panel helpers build aligned diff rows and a literal path tree', async () => {
  const { diffRows, buildFileTree } = await import('../plugins/source-control-proof/panel-model.mjs');
  const rows = diffRows('@@ -2,2 +2,3 @@\n-old\n+new\n+extra\n same\n');
  assert.deepEqual(rows.map(({ old, next }) => [old?.number, next?.number]), [
    [undefined, undefined], [2, 2], [undefined, 3], [3, 4],
  ]);
  assert.equal(rows[1].old.text, 'old');
  assert.equal(rows[2].next.text, 'extra');
  const files = [{ path: 'docs/one.txt' }, { path: 'docs/nested/two.txt' }, { path: '__proto__/a.txt' }];
  const tree = buildFileTree(files);
  assert.deepEqual(tree.map(item => item.name), ['docs', '__proto__']);
  assert.equal(tree[0].children[1].children[0].file, files[1]);
});

test('workbench tools restrict operations to the panel and reject unknown arguments', async () => {
  const { handle } = await import('../plugins/source-control-proof/server.mjs');
  const { tools } = await handle('tools/list');
  for (const name of ['git_history', 'git_history_detail', 'git_history_stats', 'git_compare', 'git_blame', 'git_patch', 'git_apply_patch', 'git_change', 'git_commit', 'git_commit_template', 'git_references', 'git_operation', 'git_conflict']) {
    const tool = tools.find(item => item.name === name);
    assert.ok(tool, name);
    assert.deepEqual(tool._meta.ui.visibility, ['app']);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  assert.equal(tools.find(item => item.name === 'git_commit').annotations.readOnlyHint, false);
  assert.equal(tools.find(item => item.name === 'git_conflict').annotations.readOnlyHint, true);
  await assert.rejects(handle('tools/call', { name: 'git_operation', arguments: { action: 'arbitraryShell' } }), /Invalid action/);
  await assert.rejects(handle('tools/call', { name: 'git_history', arguments: { repoPath: '/unused', surprise: true } }), /Unknown argument/);
  const resource = await handle('resources/read', { uri: tools[0]._meta.ui.resourceUri });
  assert.match(resource.contents[0].text, /id="commit-form"/);
  assert.match(resource.contents[0].text, /<textarea id="commit-message"[^>]*rows="1"[^>]*><\/textarea>\s*<button id="commit-submit"/);
  assert.doesNotMatch(resource.contents[0].text, /id="(?:commit-options|history-current)"/);
  assert.match(resource.contents[0].text, /id="history-list"/);
});

test('assembled panel script parses as one module and only targets declared IDs', async () => {
  const { spawnSync } = await import('node:child_process');
  const { panelHtml } = await import('../plugins/source-control-proof/server.mjs');
  const html = await panelHtml();
  const [, document, script] = html.match(/^([\s\S]+)<script type="module">([\s\S]+)<\/script>/);
  const ids = new Set([...document.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  for (const [, id] of script.matchAll(/\bel\('([a-z-]+)'\)/g)) assert.ok(ids.has(id), id);
  const check = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: script, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
});

test('packaged panel has two single-line separators, a repository name and a fixed Star footer', async () => {
  const { panelHtml } = await import('../plugins/source-control-proof/server.mjs');
  const { shellMessages } = await import('../plugins/source-control-proof/panel-messages-shell.mjs');
  const html = (await panelHtml()).split('<script type="module">')[0];
  assert.equal([...html.matchAll(/role="separator"/g)].length, 2);
  assert.match(html, /id="repositories-section"[\s\S]*id="repository-divider"[\s\S]*id="changes-section"[\s\S]*id="scm-divider"[\s\S]*id="history-section"/);
  assert.match(html, /\.sc-scm-divider::after\s*\{[^}]*height:\s*1px/);
  assert.match(html, /id="current-project"[^>]*hidden/);
  const footer = html.match(/<footer[^>]*>([\s\S]*?)<\/footer>/)[1];
  assert.match(footer.trim(), /^<a[^>]*href="https:\/\/github\.com\/KissFeng\/codex-git-workbench"[^>]*>Thanks for your support! Give us a star ⭐<\/a>$/);
  assert.equal(shellMessages['Thanks for your support! Give us a star ⭐'], '感谢支持，欢迎点个star⭐');
  assert.match(html, /class="sc-footer"/);
  assert.match(html, /\.sc-footer a\s*\{[^}]*white-space:\s*nowrap/);
});

test('controls use subtle focus styles while selected file rows keep their highlight', async () => {
  const { panelHtml } = await import('../plugins/source-control-proof/server.mjs');
  const css = (await panelHtml()).match(/<style>([\s\S]+?)<\/style>/)[1];
  assert.doesNotMatch(css, /outline:\s*\d+px solid var\(--accent\)/);
  assert.match(css, /button:focus-visible,\s*select:focus-visible\s*\{[^}]*outline:\s*none;[^}]*background-color:\s*var\(--hover\)/);
  assert.match(css, /textarea:focus\s*\{[^}]*border-color:\s*var\(--focus-border\)/);
  assert.match(css, /\.sc-file-row\[data-selected=true\]\s*\{[^}]*background:\s*var\(--selection\)/);
});

test('MCP panel tools stage selected new lines, commit the index and read the same commit history', async t => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { handle } = await import('../plugins/source-control-proof/server.mjs');
  const root = await mkdtemp(join(tmpdir(), 'codex-workbench-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const tool = async (name, args = {}) =>
    (await handle('tools/call', { name, arguments: { repoPath: root, ...args } })).structuredContent;
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'commit.gpgsign', 'false');
  const file = { path: 'notes.txt', group: 'untracked' };
  await writeFile(join(root, file.path), 'selected\nkept in working copy\n');
  const patch = await tool('git_patch', file);
  const lineIds = [patch.hunks[0].lines.find(line => line.kind === 'addition').id];
  const staged = await tool('git_apply_patch', { ...file, action: 'stage', token: patch.token, lineIds });
  assert.deepEqual(staged.staged.map(item => item.path), [file.path]);
  assert.deepEqual(staged.unstaged.map(item => item.path), [file.path]);
  const result = await tool('git_commit', { action: 'commit', message: 'Create notes' });
  assert.equal(git('show', 'HEAD:notes.txt'), 'selected\n');
  assert.equal(result.unstaged[0].path, file.path);
  const history = await tool('git_history');
  assert.equal(history.commits[0].id, result.head);
  const detail = await tool('git_history_detail', { commit: result.head, path: file.path });
  assert.match(detail.diff, /\+selected/);
  assert.doesNotMatch(detail.diff, /kept in working copy/);
  assert.deepEqual(await tool('git_history_stats', { commit: result.head }), {
    additions: 1, deletions: 0, binaryFiles: 0, filesChanged: 1, message: '',
  });
});

test('SCM primary action distinguishes staged, unstaged, conflicts, and tracking', async () => {
  const { scmPrimaryAction } = await import('../plugins/source-control-proof/panel-model.mjs');
  const clean = {
    head: 'abcdef', branch: 'main', upstream: 'origin/main', hasRemote: true, detached: false,
    ahead: 0, behind: 0, operation: null, staged: [], unstaged: [], untracked: [], conflicts: [],
  };
  const paths = [{ path: 'one.txt' }];
  assert.deepEqual(scmPrimaryAction({ ...clean, ahead: 1 }), { kind: 'sync', label: 'Sync Changes ↑1', enabled: true });
  assert.equal(scmPrimaryAction({ ...clean, behind: 3 }).label, 'Sync Changes ↓3');
  assert.equal(scmPrimaryAction({ ...clean, behind: 1, ahead: 1 }).kind, 'diverged');
  assert.equal(scmPrimaryAction({ ...clean, upstream: null }).kind, 'publish');
  assert.equal(scmPrimaryAction({ ...clean, upstream: null, head: null }).enabled, false);
  assert.equal(scmPrimaryAction({ ...clean, detached: true, upstream: null }).enabled, false);
  assert.equal(scmPrimaryAction({ ...clean, staged: paths, unstaged: paths, ahead: 1 }).kind, 'commit');
  assert.equal(scmPrimaryAction({ ...clean, unstaged: paths, ahead: 1 }).kind, 'commitAll');
  assert.equal(scmPrimaryAction({ ...clean, conflicts: paths, operation: 'merge' }).kind, 'conflicts');
  assert.equal(scmPrimaryAction({ ...clean, staged: paths, operation: 'rebase' }).kind, 'continue');
  assert.equal(scmPrimaryAction(null).enabled, false);
});

test('workspace split stays usable when dragged or restored from preferences', async () => {
  const { scmSplitRatio } = await import('../plugins/source-control-proof/panel-model.mjs');
  assert.equal(scmSplitRatio(undefined), 0.6);
  assert.equal(scmSplitRatio(0.01), 0.2);
  assert.equal(scmSplitRatio(0.99), 0.8);
  assert.equal(scmSplitRatio(0.4), 0.4);
  assert.equal(scmSplitRatio('0.3'), 0.6);
});

test('clean branch one commit ahead shows a sync action and matching outgoing comparison', async t => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { handle } = await import('../plugins/source-control-proof/server.mjs');
  const { scmPrimaryAction } = await import('../plugins/source-control-proof/panel-model.mjs');
  const { buildHistoryGraph } = await import('../plugins/source-control-proof/panel-graph.mjs');
  const root = await mkdtemp(join(tmpdir(), 'codex-workbench-outgoing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const tool = async (name, args = {}) =>
    (await handle('tools/call', { name, arguments: { repoPath: root, ...args } })).structuredContent;
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('commit', '--allow-empty', '-m', 'Base');
  const base = git('rev-parse', 'HEAD');
  git('remote', 'add', 'origin', join(root, 'remote.git'));
  git('update-ref', 'refs/remotes/origin/main', base);
  git('branch', '--set-upstream-to=origin/main');
  await writeFile(join(root, 'notes.txt'), 'outgoing\n');
  git('add', 'notes.txt');
  git('commit', '-m', 'Outgoing');
  const status = await tool('git_status');
  assert.equal(status.branch, 'main');
  assert.equal(status.ahead, 1);
  assert.equal(status.behind, 0);
  assert.deepEqual(scmPrimaryAction(status), { kind: 'sync', label: 'Sync Changes ↑1', enabled: true });
  const history = await tool('git_history', { scope: 'all' });
  const outgoing = buildHistoryGraph(history.commits, history).find(row => row.kind === 'outgoing');
  assert.equal(outgoing.count, 1);
  assert.deepEqual(outgoing.comparison, { from: base, to: status.head });
  assert.deepEqual((await tool('git_compare', outgoing.comparison)).files, [{ path: 'notes.txt', status: 'A' }]);
});
