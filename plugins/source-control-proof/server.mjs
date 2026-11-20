// Local MCP adapter. Status/view tools read Git; app-only staging writes the index.
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { getStatus } from './git-status.mjs';
import { getFile } from './git-file.mjs';
import { listProjects } from './projects.mjs';
import { updateStaging } from './git-staging.mjs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { workbenchTools, callWorkbenchTool } from './git-tools.mjs';

const uri = 'ui://source-control-proof/panel-v10.html';
const manifest = JSON.parse(await readFile(new URL('./.codex-plugin/plugin.json', import.meta.url), 'utf8'));
const icon = { src: 'data:image/svg+xml;base64,' + (await readFile(new URL('./assets/branch.svg', import.meta.url))).toString('base64'), mimeType: 'image/svg+xml', sizes: ['any'] };
const inputSchema = { type: 'object', properties: { repoPath: { type: 'string', description: 'Absolute checkout path. Opening the panel without one lets you choose from Codex projects.' } }, additionalProperties: false };
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const tools = [
  { name: 'source_control_panel', title: 'Git Workbench', icons: [icon], description: 'Open the local Git workbench with repository selection, changes, commits and history.', inputSchema, annotations,
    _meta: { ui: { resourceUri: uri }, 'openai/ui': { entrypoints: [{ type: 'thread' }, { type: 'global' }] } } },
  { name: 'git_status', title: 'Refresh Git status', description: 'Read actual local Git status for the displayed checkout.', inputSchema, annotations,
    _meta: { ui: { visibility: ['app', 'model'] } } },
  { name: 'git_projects', title: 'Local checkouts', description: 'Read Codex’s saved local projects, all repository roots, and current Git worktrees.', inputSchema: { type: 'object', properties: {} }, annotations,
    _meta: { ui: { visibility: ['app'] } } },
  { name: 'git_file', title: 'Read file view', description: 'Read a changed file as staged or working-copy source, or its corresponding diff.',
    inputSchema: { type: 'object', properties: { repoPath: { type: 'string' }, path: { type: 'string' },
      group: { enum: ['staged', 'unstaged', 'untracked', 'conflicts'] }, mode: { enum: ['diff', 'source'] } },
      required: ['repoPath', 'path', 'group', 'mode'], additionalProperties: false }, annotations,
    _meta: { ui: { visibility: ['app'] } } },
  { name: 'git_staging', title: 'Stage or unstage a file', description: 'Stage the selected working-copy file or unstage the selected index change. Does not modify working-copy files or commit.',
    inputSchema: { type: 'object', properties: { repoPath: { type: 'string' }, path: { type: 'string' },
      group: { enum: ['staged', 'unstaged', 'untracked', 'conflicts'] }, action: { enum: ['stage', 'unstage'] } },
      required: ['repoPath', 'path', 'group', 'action'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] } } },
  ...workbenchTools,
];

export async function panelHtml() {
  const read = file => readFile(new URL('./' + file, import.meta.url), 'utf8');
  const [html, styles, scripts] = await Promise.all([
    read('panel.html'),
    Promise.all(['panel.css', 'panel-layout.css', 'panel-history.css', 'panel-overlays.css'].map(read)),
    Promise.all(['panel-locale.mjs', 'panel-messages-shell.mjs', 'panel-messages-actions.mjs', 'panel-messages-history.mjs',
      'panel-messages-preview.mjs', 'panel-model.mjs', 'panel-motion.mjs', 'panel-graph.mjs', 'panel-overlays.js', 'panel-actions.js',
      'panel-workspace.js', 'panel-history.js', 'panel-workbench.js', 'panel.js'].map(read)),
  ]);
  return html.replace('/* PANEL_CSS */', () => styles.join('\n'))
    .replace('/* PANEL_JS */', () => scripts.join('\n').replace('/* APP_VERSION */', manifest.version));
}
export async function handle(method, params = {}) {
  switch (method) {
    case 'initialize': return { protocolVersion: '2025-11-25', capabilities: { tools: {}, resources: {} }, serverInfo: { name: manifest.name, version: manifest.version, icons: [icon] } };
    case 'ping': return {};
    case 'tools/list': return { tools };
    case 'resources/list': return { resources: [{ uri, name: 'source-control-panel', mimeType: 'text/html;profile=mcp-app' }] };
    case 'resources/templates/list': return { resourceTemplates: [] };
    case 'prompts/list': return { prompts: [] };
    case 'resources/read': {
      if (![uri, 'ui://source-control-proof/panel-v1.html', 'ui://source-control-proof/panel-v2.html', 'ui://source-control-proof/panel-v3.html', 'ui://source-control-proof/panel-v4.html', 'ui://source-control-proof/panel-v5.html', 'ui://source-control-proof/panel-v6.html', 'ui://source-control-proof/panel-v7.html', 'ui://source-control-proof/panel-v8.html', 'ui://source-control-proof/panel-v9.html'].includes(params.uri)) throw new Error('Unknown resource');
      return { contents: [{ uri: params.uri, mimeType: 'text/html;profile=mcp-app', text: await panelHtml(),
        _meta: { ui: { prefersBorder: false }, 'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'] } } }] };
    }
    case 'tools/call': {
      if (!tools.some(tool => tool.name === params.name)) throw new Error('Unknown tool');
      const args = params.arguments || {};
      if (args.repoPath !== undefined && typeof args.repoPath !== 'string') throw new Error('repoPath must be a string');
      if (workbenchTools.some(tool => tool.name === params.name)) {
        return { content: [], structuredContent: await callWorkbenchTool(params.name, args) };
      }
      if (params.name === 'git_projects') return { content: [], structuredContent: await listProjects() };
      if (params.name === 'git_file') return { content: [], structuredContent: await getFile(args) };
      if (params.name === 'git_staging') return { content: [], structuredContent: await updateStaging(args) };
      if (!args.repoPath) {
        if (params.name === 'source_control_panel') return { content: [], structuredContent: { needsCheckout: true } };
        throw new Error('Choose a repository to refresh its Git status.');
      }
      const status = await getStatus(args.repoPath);
      return { content: [{ type: 'text', text: JSON.stringify(status) }], structuredContent: status };
    }
    default: throw new Error('Unknown method: ' + method);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) createInterface({ input: process.stdin }).on('line', async line => {
  let request;
  try {
    request = JSON.parse(line);
    if (request.id === undefined) return;
    const result = await handle(request.method, request.params);
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  } catch (error) {
    if (request?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
      error: { code: -32603, message: String(error.stderr?.trim() || error.message).replace(/(https?:\/\/)[^/\s@]+@/g, '$1').slice(0, 4000) } }) + '\n');
  }
});
