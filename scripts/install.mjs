#!/usr/bin/env node
// Auto-detecting installer for Codex desktop and Antigravity 2.0.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAntigravityPlugin } from './install-antigravity.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const MARKETPLACE_ID = 'kissfeng-git-tools';
const CODEX_PLUGIN_ID = `codex-git-workbench@${MARKETPLACE_ID}`;
const CODEX_REPO = 'KissFeng/codex-git-workbench';

export function hasCommand(command, exec = execFileSync) {
  try {
    exec(command, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function detectTargets({
  env = process.env,
  home = homedir(),
  exists = existsSync,
  checkCommand = hasCommand,
} = {}) {
  const codexHome = env.CODEX_HOME || join(home, '.codex');
  const codexCli = checkCommand('codex');
  const codexDir = exists(codexHome);
  const antigravityDir = env.ANTIGRAVITY_APP_DATA_DIR || join(home, '.gemini', 'antigravity');
  const geminiConfigDir = join(home, '.gemini', 'config');
  const antigravity = exists(antigravityDir) || exists(geminiConfigDir);
  return {
    codex: codexCli || codexDir,
    codexCli,
    antigravity,
  };
}

export function parseInstallArgs(argv = process.argv.slice(2)) {
  const options = { codex: false, antigravity: false, all: false, ref: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--codex') options.codex = true;
    else if (arg === '--antigravity') options.antigravity = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--ref' && argv[i + 1]) options.ref = argv[++i];
    else if (arg.startsWith('--ref=')) options.ref = arg.slice(6);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

export function resolveInstallPlan(options, detected) {
  const explicit = options.codex || options.antigravity || options.all;
  return {
    codex: options.all || options.codex || (!explicit && detected.codex),
    antigravity: options.all || options.antigravity || (!explicit && detected.antigravity),
  };
}

function installCodex({ ref, dryRun }, exec = execFileSync) {
  const sourceArgs = ref
    ? ['plugin', 'marketplace', 'add', CODEX_REPO, '--ref', ref]
    : ['plugin', 'marketplace', 'add', repoRoot];
  if (dryRun) {
    console.log(`[dry-run] codex ${sourceArgs.join(' ')}`);
    console.log(`[dry-run] codex plugin add ${CODEX_PLUGIN_ID}`);
    return;
  }
  try {
    exec('codex', ['plugin', 'marketplace', 'remove', MARKETPLACE_ID], { stdio: 'ignore' });
  } catch {
    /* Marketplace may not be configured yet. */
  }
  exec('codex', sourceArgs, { stdio: 'inherit' });
  exec('codex', ['plugin', 'add', CODEX_PLUGIN_ID], { stdio: 'inherit' });
  console.log('[git-workbench] Codex plugin installed. Fully quit and reopen Codex desktop to apply.');
}

async function installAntigravity({ dryRun, home = homedir() }) {
  const targetDir = join(home, '.gemini', 'config', 'plugins', 'antigravity-git-workbench');
  if (dryRun) {
    console.log(`[dry-run] install Antigravity plugin to ${targetDir}`);
    return targetDir;
  }
  const outputDir = await buildAntigravityPlugin(targetDir);
  console.log(`[git-workbench] Antigravity plugin installed to: ${outputDir}`);
  return outputDir;
}

export async function runInstall(argv = process.argv.slice(2), deps = {}) {
  const options = parseInstallArgs(argv);
  if (options.help) {
    console.log('Usage: node scripts/install.mjs [--codex] [--antigravity] [--all] [--ref <tag>] [--dry-run]');
    return { installed: [] };
  }

  const detected = detectTargets(deps);
  const plan = resolveInstallPlan(options, detected);
  const installed = [];

  if (!plan.codex && !plan.antigravity) {
    throw new Error(
      'Neither Codex nor Antigravity was detected on this machine. '
      + 'Pass --codex, --antigravity, or --all to install explicitly.',
    );
  }

  if (plan.codex) {
    if (!detected.codexCli && !options.dryRun) {
      if (options.codex || options.all) {
        throw new Error('Codex CLI ("codex") was not found on PATH.');
      }
      console.warn('[git-workbench] Detected ~/.codex but "codex" CLI is not on PATH; skipping Codex install.');
    } else {
      installCodex(options, deps.exec);
      installed.push('codex');
    }
  }

  if (plan.antigravity) {
    await installAntigravity({ dryRun: options.dryRun, home: deps.home });
    installed.push('antigravity');
  }

  return { detected, plan, installed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runInstall();
  } catch (error) {
    console.error(`[git-workbench] ${error.message}`);
    process.exit(1);
  }
}
