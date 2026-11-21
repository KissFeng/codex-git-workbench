// Antigravity workspace and project discovery adapter for Git Workbench.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_RECENT_CHECKOUTS = 50;

export function antigravityAppDataDir() {
  return process.env.ANTIGRAVITY_APP_DATA_DIR || join(homedir(), '.gemini', 'antigravity');
}

export function sidecarDataDir(appDataDir = antigravityAppDataDir()) {
  return process.env.ANTIGRAVITY_GIT_WORKBENCH_DATA_DIR
    || join(appDataDir, 'sidecar_data', 'antigravity-git-workbench', 'git_workbench');
}

export function uriToLocalPath(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  const trimmed = input.trim();
  if (trimmed.startsWith('file://')) {
    try {
      const converted = fileURLToPath(trimmed);
      return isAbsolute(converted) ? converted : null;
    } catch {
      return null;
    }
  }
  return isAbsolute(trimmed) ? trimmed : null;
}

function parseWorkspaceUris(raw) {
  if (Array.isArray(raw)) return raw.map(uriToLocalPath).filter(Boolean);
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(uriToLocalPath).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export async function readConversationWorkspaces(conversationId, appDataDir = antigravityAppDataDir()) {
  if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 128) return null;
  const dbPath = join(appDataDir, 'conversation_summaries.db');
  if (!existsSync(dbPath)) return null;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const columns = new Set(db.prepare("PRAGMA table_info('conversation_summaries')").all().map(c => c.name));
      if (!columns.has('conversation_id') || !columns.has('workspace_uris')) return null;
      const projectColumn = columns.has('project_id') ? 'project_id' : 'NULL';
      const row = db.prepare(
        `SELECT workspace_uris AS workspaceUris, ${projectColumn} AS projectId FROM conversation_summaries WHERE conversation_id = ?`,
      ).get(conversationId);
      if (!row) return null;
      const paths = parseWorkspaceUris(row.workspaceUris);
      return paths.length ? { paths, projectId: row.projectId || null } : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function readAntigravitySavedWorkspaces(appDataDir = antigravityAppDataDir()) {
  const dbPath = join(appDataDir, 'conversation_summaries.db');
  if (!existsSync(dbPath)) return { entries: [], source: null };
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const columns = new Set(db.prepare("PRAGMA table_info('conversation_summaries')").all().map(c => c.name));
      if (!columns.has('workspace_uris')) return { entries: [], source: null };
      const projectColumn = columns.has('project_id') ? 'project_id' : 'NULL';
      const orderColumn = columns.has('last_modified_time') ? 'ORDER BY last_modified_time DESC' : '';
      const rows = db.prepare(
        `SELECT workspace_uris AS workspaceUris, ${projectColumn} AS projectId FROM conversation_summaries WHERE workspace_uris != '' AND workspace_uris != '[]' ${orderColumn} LIMIT 200`,
      ).all();
      const seen = new Set();
      const entries = [];
      for (const row of rows) {
        for (const path of parseWorkspaceUris(row.workspaceUris)) {
          if (seen.has(path)) continue;
          seen.add(path);
          entries.push({ path, projectId: row.projectId || null });
        }
      }
      return { entries, source: 'Antigravity conversation catalog' };
    } finally {
      db.close();
    }
  } catch {
    return { entries: [], source: null };
  }
}

export async function readRecentCheckouts(dataDir = sidecarDataDir()) {
  try {
    const raw = await readFile(join(dataDir, 'recent-checkouts.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string' && isAbsolute(item)) : [];
  } catch {
    return [];
  }
}

export async function rememberCheckout(repoPath, dataDir = sidecarDataDir()) {
  if (typeof repoPath !== 'string' || !isAbsolute(repoPath)) return;
  try {
    const existing = await readRecentCheckouts(dataDir);
    const next = [repoPath, ...existing.filter(item => item !== repoPath)].slice(0, MAX_RECENT_CHECKOUTS);
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'recent-checkouts.json'), JSON.stringify(next, null, 2), 'utf8');
  } catch {
    /* Non-fatal: history persistence is best-effort. */
  }
}

export async function listAntigravityProjects({
  workspaceUris = [],
  conversationId = '',
  appDataDir = antigravityAppDataDir(),
  dataDir = sidecarDataDir(appDataDir),
  git,
}) {
  const candidates = [];
  const seenCandidate = new Set();
  const addCandidate = (path, projectId = null) => {
    if (!path || seenCandidate.has(path)) return;
    seenCandidate.add(path);
    candidates.push({ path, projectId });
  };

  for (const path of parseWorkspaceUris(workspaceUris)) addCandidate(path);
  const currentConv = await readConversationWorkspaces(conversationId, appDataDir);
  if (currentConv) {
    for (const path of currentConv.paths) addCandidate(path, currentConv.projectId);
  }
  for (const path of await readRecentCheckouts(dataDir)) addCandidate(path);
  const saved = await readAntigravitySavedWorkspaces(appDataDir);
  for (const entry of saved.entries) addCandidate(entry.path, entry.projectId);

  const resolved = await Promise.all(candidates.map(async candidate => {
    try {
      const topLevel = (await git(candidate.path, 'rev-parse', '--show-toplevel')).trim();
      const raw = await git(topLevel, 'worktree', 'list', '--porcelain', '-z');
      const checkouts = [];
      let checkout;
      for (const field of raw.split('\0')) {
        if (field.startsWith('worktree ')) {
          checkout = { path: field.slice(9), branch: 'Detached HEAD' };
          checkouts.push(checkout);
        } else if (checkout && field.startsWith('branch ')) {
          checkout.branch = field.slice(7).replace(/^refs\/heads\//, '');
        } else if (checkout && field.startsWith('prunable')) {
          checkout.prunable = true;
        }
      }
      const activeCheckouts = checkouts.filter(item => !item.prunable);
      const mainCheckout = activeCheckouts[0]?.path || topLevel;
      const name = basename(mainCheckout);
      return {
        projectId: candidate.projectId || mainCheckout,
        projectName: name,
        label: name,
        path: mainCheckout,
        checkouts: activeCheckouts,
      };
    } catch {
      return null;
    }
  }));

  const projects = [];
  const seenRepos = new Set();
  for (const project of resolved) {
    if (!project || seenRepos.has(project.path)) continue;
    seenRepos.add(project.path);
    projects.push(project);
  }

  return {
    projects,
    homeDirectory: homedir(),
    discovery: {
      source: saved.source || 'Antigravity active workspace',
    },
  };
}
