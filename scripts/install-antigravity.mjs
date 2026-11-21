#!/usr/bin/env node
// Build or install a self-contained Antigravity Git Workbench plugin bundle.
import { cp, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const sourcePluginDir = join(repoRoot, 'plugins', 'antigravity-git-workbench');
const sharedCoreDir = join(repoRoot, 'plugins', 'source-control-proof');

const CORE_FILES = [
  'desktop-actions.mjs',
  'git-commit.mjs',
  'git-file.mjs',
  'git-history.mjs',
  'git-images.mjs',
  'git-operations.mjs',
  'git-patch.mjs',
  'git-staging.mjs',
  'git-status.mjs',
  'git-tools.mjs',
  'git-write.mjs',
  'repo-path.mjs',
  'panel-actions.js',
  'panel-graph.mjs',
  'panel-history.css',
  'panel-history.js',
  'panel-layout.css',
  'panel-locale.mjs',
  'panel-messages-actions.mjs',
  'panel-messages-history.mjs',
  'panel-messages-preview.mjs',
  'panel-messages-shell.mjs',
  'panel-model.mjs',
  'panel-motion.mjs',
  'panel-overlays.css',
  'panel-overlays.js',
  'panel-workbench.js',
  'panel-workspace.js',
  'panel.css',
  'panel.html',
  'panel.js',
];

export async function buildAntigravityPlugin(targetDir) {
  const outputDir = resolve(targetDir);
  const sidecarDir = join(outputDir, 'sidecars', 'git_workbench');
  const coreOutputDir = join(sidecarDir, 'core');
  const assetsOutputDir = join(outputDir, 'assets');

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(coreOutputDir, { recursive: true });
  await mkdir(assetsOutputDir, { recursive: true });

  await cp(join(sourcePluginDir, 'plugin.json'), join(outputDir, 'plugin.json'));
  await cp(join(sourcePluginDir, 'sidecars', 'git_workbench', 'sidecar.json'), join(sidecarDir, 'sidecar.json'));
  await cp(join(sourcePluginDir, 'sidecars', 'git_workbench', 'main.mjs'), join(sidecarDir, 'main.mjs'));
  await cp(join(sourcePluginDir, 'sidecars', 'git_workbench', 'antigravity-projects.mjs'), join(sidecarDir, 'antigravity-projects.mjs'));
  await cp(join(sharedCoreDir, 'assets', 'branch.svg'), join(assetsOutputDir, 'branch.svg'));
  await cp(join(repoRoot, 'LICENSE'), join(outputDir, 'LICENSE'));
  await cp(join(sharedCoreDir, 'THIRD_PARTY_NOTICES.md'), join(outputDir, 'THIRD_PARTY_NOTICES.md'));

  await Promise.all(
    CORE_FILES.map(file => cp(join(sharedCoreDir, file), join(coreOutputDir, file))),
  );

  return outputDir;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const outIndex = args.indexOf('--out');
  if (outIndex !== -1 && args[outIndex + 1]) {
    return { target: resolve(process.cwd(), args[outIndex + 1]), mode: 'build' };
  }
  if (args.includes('--install') || args.length === 0) {
    return { target: join(homedir(), '.gemini', 'config', 'plugins', 'antigravity-git-workbench'), mode: 'install' };
  }
  throw new Error('Usage: node scripts/install-antigravity.mjs [--install | --out <dir>]');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { target, mode } = parseArgs(process.argv);
  const outputDir = await buildAntigravityPlugin(target);
  console.log(`[antigravity-git-workbench] ${mode === 'install' ? 'Installed to' : 'Built at'}: ${outputDir}`);
}
