import { test } from 'node:test';
import assert from 'node:assert/strict';

test('panel helpers build graph edges, aligned diff rows and a literal path tree', async () => {
  const { graphRows, diffRows, buildFileTree } = await import('../plugins/source-control-proof/panel-model.mjs');
  const graph = graphRows([
    { id: 'merge', parents: ['main', 'topic'] },
    { id: 'main', parents: ['root'] },
    { id: 'topic', parents: ['root'] },
    { id: 'root', parents: [] },
  ]);
  assert.deepEqual(graph[0].edges.map(({ from, to }) => [from, to]), [[0, 0], [0, 1]]);
  assert.equal(graph[2].edges.find(edge => edge.from === 1).to, 0);
  assert.deepEqual(graph[3].edges, []);
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
  for (const name of ['git_history', 'git_history_detail', 'git_compare', 'git_blame', 'git_patch', 'git_apply_patch', 'git_change', 'git_commit', 'git_commit_template', 'git_references', 'git_operation', 'git_conflict']) {
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
});
