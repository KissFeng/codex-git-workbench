// Antigravity Sidecar adapter for Git Workbench.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  antigravityAppDataDir,
  listAntigravityProjects,
  readConversationWorkspaces,
  rememberCheckout,
  sidecarDataDir,
  uriToLocalPath,
} from './antigravity-projects.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = existsSync(join(__dirname, 'core', 'git-status.mjs'))
  ? join(__dirname, 'core')
  : resolve(__dirname, '../../../source-control-proof');
const PLUGIN_MANIFEST_PATH = existsSync(join(__dirname, '../../plugin.json'))
  ? join(__dirname, '../../plugin.json')
  : join(CORE_DIR, '.codex-plugin/plugin.json');

const importCore = file => import(pathToFileURL(join(CORE_DIR, file)).href);

const [
  { getStatus, git },
  { getFile },
  { updateStaging },
  { workbenchTools, callWorkbenchTool },
  manifestRaw,
] = await Promise.all([
  importCore('git-status.mjs'),
  importCore('git-file.mjs'),
  importCore('git-staging.mjs'),
  importCore('git-tools.mjs'),
  readFile(PLUGIN_MANIFEST_PATH, 'utf8'),
]);

const manifest = JSON.parse(manifestRaw);
const allowedTools = new Set([
  'source_control_panel',
  'git_status',
  'git_projects',
  'git_file',
  'git_staging',
  ...workbenchTools.map(tool => tool.name),
]);

function sanitizeError(error) {
  return String(error?.stderr?.trim() || error?.message || 'Request failed.')
    .replace(/(https?:\/\/)[^/\s@]+@/g, '$1')
    .slice(0, 4000);
}

const SIDECAR_THEME_CSS = `
/* Isolate workbench palette tokens from Antigravity host :root CSS variables (e.g. --muted, --accent, --border). */
body, .sc-app, #action-dialog {
  --bg: light-dark(#fbfcfd, #141619);
  --surface: light-dark(#ffffff, #17191d);
  --sidebar: light-dark(#f6f8fa, #1b1e22);
  --text: light-dark(#232b33, #e5e9ef);
  --muted: light-dark(#65717f, #9aa5b3);
  --faint: light-dark(#86909d, #677381);
  --border: light-dark(#e1e6ec, #2c3239);
  --hover: light-dark(#edf1f5, #252b32);
  --selected: light-dark(#e7f4ee, #21362f);
  --selection: light-dark(#e1f0ea, #203a32);
  --accent: light-dark(#19704f, #8ce0b9);
  --added: light-dark(#edf8f1, #1e3228);
  --removed: light-dark(#fcf0f1, #39252a);
  --focus-border: color-mix(in srgb, var(--border) 70%, var(--muted));
}
body {
  background: var(--bg) !important;
  color: var(--text) !important;
}
`;

export async function panelHtml() {
  const read = file => readFile(join(CORE_DIR, file), 'utf8');
  const [html, styles, scripts] = await Promise.all([
    read('panel.html'),
    Promise.all(['panel.css', 'panel-layout.css', 'panel-history.css', 'panel-overlays.css'].map(read)),
    Promise.all([
      'panel-locale.mjs',
      'panel-messages-shell.mjs',
      'panel-messages-actions.mjs',
      'panel-messages-history.mjs',
      'panel-messages-preview.mjs',
      'panel-model.mjs',
      'panel-motion.mjs',
      'panel-graph.mjs',
      'panel-overlays.js',
      'panel-actions.js',
      'panel-workspace.js',
      'panel-history.js',
      'panel-workbench.js',
      'panel.js',
    ].map(read)),
  ]);
  return html
    .replace('<!-- HOST_PRELOAD -->', '<script src="/preload.js"></script>')
    .replace('/* PANEL_CSS */', () => [...styles, SIDECAR_THEME_CSS].join('\n'))
    .replace('/* PANEL_JS */', () => scripts.join('\n').replace('/* APP_VERSION */', manifest.version || '0.8.1'));
}

export async function readPreferences(dataDir = sidecarDataDir()) {
  try {
    const raw = await readFile(join(dataDir, 'preferences.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function writePreferences(preferences, dataDir = sidecarDataDir()) {
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
    throw new Error('Invalid preferences payload.');
  }
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'preferences.json'), JSON.stringify(preferences, null, 2), 'utf8');
  return { ok: true };
}

async function resolveLaunchCheckout({ workspaceUris = [], conversationId = '', appDataDir }) {
  const candidates = [];
  for (const uri of Array.isArray(workspaceUris) ? workspaceUris : []) {
    const path = uriToLocalPath(uri);
    if (path) candidates.push({ path, projectId: null });
  }
  if (!candidates.length && conversationId) {
    const conv = await readConversationWorkspaces(conversationId, appDataDir);
    if (conv) {
      for (const path of conv.paths) candidates.push({ path, projectId: conv.projectId });
    }
  }
  for (const candidate of candidates) {
    try {
      const status = await getStatus(candidate.path);
      return { ...status, contextSource: 'Antigravity workspace', projectId: candidate.projectId };
    } catch (error) {
      if (!error.message.startsWith('No Git checkout at ')) throw error;
    }
  }
  return { needsCheckout: true };
}

export async function handleToolCall(payload = {}, options = {}) {
  const { name, arguments: args = {}, conversationId = '', workspaceUris = [] } = payload;
  const appDataDir = options.appDataDir || antigravityAppDataDir();
  const dataDir = options.dataDir || sidecarDataDir(appDataDir);

  if (!allowedTools.has(name)) throw new Error('Unknown tool');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid arguments.');
  if (args.repoPath !== undefined && typeof args.repoPath !== 'string') throw new Error('repoPath must be a string');

  try {
    if (workbenchTools.some(tool => tool.name === name)) {
      const structuredContent = await callWorkbenchTool(name, args);
      if (name === 'desktop_pick_checkout' && structuredContent?.checkout) {
        await rememberCheckout(structuredContent.checkout, dataDir);
      }
      if (name === 'git_operation' && structuredContent?.checkout && ['init', 'clone'].includes(args.action)) {
        await rememberCheckout(structuredContent.checkout, dataDir);
      }
      return { content: [], structuredContent };
    }

    if (name === 'git_projects') {
      const structuredContent = await listAntigravityProjects({
        workspaceUris,
        conversationId,
        appDataDir,
        dataDir,
        git,
      });
      return { content: [], structuredContent };
    }

    if (name === 'git_file') {
      return { content: [], structuredContent: await getFile(args) };
    }

    if (name === 'git_staging') {
      return { content: [], structuredContent: await updateStaging(args) };
    }

    if (!args.repoPath) {
      if (name !== 'source_control_panel') throw new Error('Choose a repository to refresh its Git status.');
      const structuredContent = await resolveLaunchCheckout({ workspaceUris, conversationId, appDataDir });
      return { content: [], structuredContent };
    }

    const status = await getStatus(args.repoPath);
    return { content: [{ type: 'text', text: JSON.stringify(status) }], structuredContent: status };
  } catch (error) {
    throw new Error(sanitizeError(error));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { SidecarApp } = await import('sidecar_sdk');
  const app = new SidecarApp();

  app.page('/', () => panelHtml());
  app.api('/api/tool', data => handleToolCall({
    ...data,
    conversationId: data.conversationId || app.config.conversationId || '',
  }), 'POST');
  app.api('/api/preferences', () => readPreferences(), 'GET');
  app.api('/api/preferences', data => writePreferences(data), 'POST');

  await app.run();
}
