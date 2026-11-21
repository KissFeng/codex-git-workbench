import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  handleToolCall,
  panelHtml,
  readPreferences,
  writePreferences,
} from '../plugins/antigravity-git-workbench/sidecars/git_workbench/main.mjs';
import { buildAntigravityPlugin } from '../scripts/install-antigravity.mjs';
import { detectTargets, parseInstallArgs, resolveInstallPlan, runInstall } from '../scripts/install.mjs';

function initGitRepo(dir, branch = 'main') {
  execFileSync('git', ['-C', dir, 'init', '-b', branch]);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Antigravity Test']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
}

test('Antigravity sidecar panel HTML injects preload.js and parses as a valid ES module', async () => {
  const html = await panelHtml();
  assert.match(html, /<script src="\/preload\.js"><\/script>/);
  assert.match(html, /body,\s*\.sc-app,\s*#action-dialog\s*\{[\s\S]*--muted:\s*light-dark/);
  const [, documentPart, script] = html.match(/^([\s\S]+)<script type="module">([\s\S]+)<\/script>/);
  const ids = new Set([...documentPart.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  for (const [, id] of script.matchAll(/\bel\('([a-z-]+)'\)/g)) assert.ok(ids.has(id), id);
  const check = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: script, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
});

test('Antigravity sidecar resolves active workspace URIs, conversation DB projects, and worktrees', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ag-git-workbench-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const appDataDir = join(root, 'app-data');
  const dataDir = join(root, 'sidecar-data');
  const repoA = join(root, 'repo-a');
  const repoB = join(root, 'repo-b');
  const worktreeA = join(root, 'repo-a-wt');
  const nonGit = join(root, 'plain-folder');
  await Promise.all([appDataDir, dataDir, repoA, repoB, nonGit].map(d => mkdir(d, { recursive: true })));

  initGitRepo(repoA, 'main');
  await writeFile(join(repoA, 'a.txt'), 'hello\n');
  execFileSync('git', ['-C', repoA, 'add', 'a.txt']);
  execFileSync('git', ['-C', repoA, 'commit', '-q', '-m', 'Initial A']);
  execFileSync('git', ['-C', repoA, 'worktree', 'add', '-q', '-b', 'feature-wt', worktreeA]);

  initGitRepo(repoB, 'develop');

  const db = new DatabaseSync(join(appDataDir, 'conversation_summaries.db'));
  db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT "", last_modified_time DATETIME NOT NULL)');
  db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)').run(
    'conv-b',
    JSON.stringify([pathToFileURL(repoB).href]),
    'proj-b',
    '2026-11-21T10:00:00Z',
  );
  db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)').run(
    'conv-non-git',
    JSON.stringify([pathToFileURL(nonGit).href]),
    'proj-none',
    '2026-11-21T09:00:00Z',
  );
  db.close();

  // 1. Active workspaceUris takes priority
  const launchA = await handleToolCall(
    { name: 'source_control_panel', arguments: {}, workspaceUris: [pathToFileURL(worktreeA).href] },
    { appDataDir, dataDir },
  );
  assert.equal(launchA.structuredContent.branch, 'feature-wt');
  assert.equal(launchA.structuredContent.contextSource, 'Antigravity workspace');

  // 2. Fallback to conversationId in SQLite DB when workspaceUris is empty
  const launchB = await handleToolCall(
    { name: 'source_control_panel', arguments: {}, conversationId: 'conv-b' },
    { appDataDir, dataDir },
  );
  assert.equal(launchB.structuredContent.branch, 'develop');
  assert.equal(launchB.structuredContent.projectId, 'proj-b');

  // 3. Non-Git workspace returns needsCheckout
  const launchNone = await handleToolCall(
    { name: 'source_control_panel', arguments: {}, conversationId: 'conv-non-git' },
    { appDataDir, dataDir },
  );
  assert.equal(launchNone.structuredContent.needsCheckout, true);

  // 4. git_projects lists both active workspace (with linked worktree) and DB projects
  const projectsResp = await handleToolCall(
    { name: 'git_projects', arguments: {}, workspaceUris: [pathToFileURL(repoA).href] },
    { appDataDir, dataDir },
  );
  assert.equal(projectsResp.structuredContent.projects.length, 2);
  const projA = projectsResp.structuredContent.projects.find(p => p.label === 'repo-a');
  assert.ok(projA);
  assert.equal(projA.checkouts.length, 2);
  assert.deepEqual(projA.checkouts.map(c => c.branch).sort(), ['feature-wt', 'main']);

  // 5. Missing DB degrades gracefully without throwing
  const emptyAppData = join(root, 'empty-app-data');
  await mkdir(emptyAppData);
  const degraded = await handleToolCall(
    { name: 'git_projects', arguments: {}, workspaceUris: [pathToFileURL(repoA).href] },
    { appDataDir: emptyAppData, dataDir },
  );
  assert.equal(degraded.structuredContent.projects.length, 1);
});

test('Antigravity sidecar tools support staging, committing, history, preferences and argument validation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ag-git-workbench-ops-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const repo = join(root, 'repo');
  const dataDir = join(root, 'data');
  await mkdir(repo);
  initGitRepo(repo, 'main');
  await writeFile(join(repo, 'hello.txt'), 'line 1\n');

  const stageRes = await handleToolCall(
    { name: 'git_staging', arguments: { repoPath: repo, path: 'hello.txt', group: 'untracked', action: 'stage' } },
    { dataDir },
  );
  assert.equal(stageRes.structuredContent.staged.length, 1);

  const commitRes = await handleToolCall(
    { name: 'git_commit', arguments: { repoPath: repo, action: 'commit', message: 'feat: initial commit' } },
    { dataDir },
  );
  assert.equal(commitRes.structuredContent.staged.length, 0);

  const historyRes = await handleToolCall(
    { name: 'git_history', arguments: { repoPath: repo } },
    { dataDir },
  );
  assert.equal(historyRes.structuredContent.commits[0].subject, 'feat: initial commit');

  await assert.rejects(
    handleToolCall({ name: 'unknown_tool', arguments: {} }, { dataDir }),
    /Unknown tool/,
  );
  await assert.rejects(
    handleToolCall({ name: 'git_operation', arguments: { action: 'arbitraryShell' } }, { dataDir }),
    /Invalid action/,
  );

  // Preferences round-trip
  assert.deepEqual(await readPreferences(dataDir), {});
  await writePreferences({ mode: 'split', language: 'zh-CN', tree: true }, dataDir);
  assert.deepEqual(await readPreferences(dataDir), { mode: 'split', language: 'zh-CN', tree: true });
});

test('buildAntigravityPlugin produces a self-contained plugin bundle', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ag-git-workbench-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const outDir = join(root, 'antigravity-git-workbench');
  await buildAntigravityPlugin(outDir);

  const pluginJson = JSON.parse(await readFile(join(outDir, 'plugin.json'), 'utf8'));
  assert.equal(pluginJson.name, 'antigravity-git-workbench');
  assert.equal(pluginJson.logo, 'assets/branch.svg');

  const sidecarJson = JSON.parse(await readFile(join(outDir, 'sidecars', 'git_workbench', 'sidecar.json'), 'utf8'));
  assert.equal(sidecarJson.has_web_ui, true);
  assert.equal(sidecarJson.ui_config.views[0].entrypoint, 'SIDECAR_UI_ENTRYPOINT_AUX_PANE');

  const bundledMain = await import(pathToFileURL(join(outDir, 'sidecars', 'git_workbench', 'main.mjs')).href);
  const html = await bundledMain.panelHtml();
  assert.match(html, /<script src="\/preload\.js"><\/script>/);
  assert.match(html, /id="commit-form"/);
});

test('auto-detect installer resolves targets, dry-runs cleanly, and install.sh has valid POSIX syntax', async () => {
  const detectedBoth = detectTargets({
    home: '/fake/home',
    env: {},
    exists: p => p === '/fake/home/.gemini/antigravity',
    checkCommand: cmd => cmd === 'codex',
  });
  assert.deepEqual(detectedBoth, { codex: true, codexCli: true, antigravity: true });

  assert.deepEqual(resolveInstallPlan(parseInstallArgs([]), detectedBoth), { codex: true, antigravity: true });
  assert.deepEqual(resolveInstallPlan(parseInstallArgs(['--antigravity']), detectedBoth), { codex: false, antigravity: true });
  assert.deepEqual(resolveInstallPlan(parseInstallArgs(['--codex', '--ref=v0.9.0']), detectedBoth), { codex: true, antigravity: false });

  const dryResult = await runInstall(['--dry-run'], {
    home: '/fake/home',
    env: {},
    exists: p => p === '/fake/home/.gemini/antigravity',
    checkCommand: () => false,
  });
  assert.deepEqual(dryResult.installed, ['antigravity']);

  const shCheck = spawnSync('sh', ['-n', join(process.cwd(), 'install.sh')], { encoding: 'utf8' });
  assert.equal(shCheck.status, 0, shCheck.stderr);

  const flags = ['--all', '--ref', 'v0.9.0', '--dry-run'];
  const shInstall = spawnSync('sh', ['install.sh', ...flags], { encoding: 'utf8' });
  const nodeInstall = spawnSync(process.execPath, ['scripts/install.mjs', ...flags], { encoding: 'utf8' });
  for (const install of [shInstall, nodeInstall]) {
    assert.equal(install.status, 0, install.stderr);
    assert.match(install.stdout, /codex plugin marketplace add KissFeng\/git-workbench --ref v0\.9\.0/);
    assert.match(install.stdout, /codex plugin add codex-git-workbench@kissfeng-git-tools/);
  }
  assert.match(shInstall.stdout, /https:\/\/github\.com\/KissFeng\/git-workbench\/archive\/v0\.9\.0\.tar\.gz/);
});

