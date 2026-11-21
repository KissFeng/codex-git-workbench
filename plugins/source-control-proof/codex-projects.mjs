// Read-only compatibility adapter for Codex's local project catalog.
// Keep internal storage details here until MCP Apps exposes a project-list API.
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';

export function codexHome() {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

async function stateDatabases(directory) {
  return (await readdir(directory)).filter(file => /^state_\d+\.sqlite$/.test(file))
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
}

export async function readCodexThread(threadId) {
  if (typeof threadId !== 'string' || !threadId || threadId.length > 128) return null;
  const directory = codexHome();
  try {
    const { DatabaseSync } = await import('node:sqlite');
    for (const file of await stateDatabases(directory)) {
      const db = new DatabaseSync(join(directory, file), { readOnly: true });
      try {
        const columns = new Set(db.prepare("PRAGMA table_info('threads')").all().map(column => column.name));
        if (!columns.has('id') || !columns.has('cwd')) continue;
        const projectId = columns.has('project_id') ? 'project_id' : 'NULL';
        const thread = db.prepare(`SELECT cwd, ${projectId} AS projectId FROM threads WHERE id = ?`).get(threadId);
        return typeof thread?.cwd === 'string' && isAbsolute(thread.cwd) ? thread : null;
      } finally { db.close(); }
    }
  } catch { /* A missing or unreadable catalog cannot identify the launch checkout. */ }
  return null;
}

function validRoots(roots) {
  return [...new Set(roots.filter(root => typeof root === 'string' && isAbsolute(root)))];
}

function savedProjects(state) {
  const saved = state?.['local-projects'];
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;
  const order = Array.isArray(state['project-order']) ? state['project-order'] : [];
  return Object.values(saved).filter(project => Array.isArray(project?.rootPaths)).map(project => ({
    id: project.id, name: project.name, roots: validRoots(project.rootPaths),
  })).sort((a, b) => {
    const rank = id => order.includes(id) ? order.indexOf(id) : order.length;
    return rank(a.id) - rank(b.id);
  });
}

function legacyProjects(state) {
  const projects = savedProjects(state);
  if (projects) return projects;
  const roots = state?.['electron-saved-workspace-roots'];
  if (!Array.isArray(roots)) throw new Error('Codex project catalog format is not recognized.');
  return validRoots(roots).map(root => ({ name: basename(root), roots: [root] }));
}

export async function readCodexProjects() {
  const directory = codexHome();
  try {
    const state = await readFile(join(directory, '.codex-global-state.json'), 'utf8').then(JSON.parse).catch(() => null);
    // Desktop's ordered list can include projects that have no row in the SQLite catalog.
    if (Array.isArray(state?.['project-order'])) {
      const projects = savedProjects(state);
      if (projects) return { projects, source: 'Codex saved workspace state' };
    }
    const databases = await stateDatabases(directory);
    if (databases.length) {
      const { DatabaseSync } = await import('node:sqlite');
      for (const file of databases) {
        const db = new DatabaseSync(join(directory, file), { readOnly: true });
        try {
          const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('projects', 'project_roots')").all();
          if (tables.length !== 2) continue;
          // A single query gives project names and all roots from one consistent snapshot.
          const rows = db.prepare('SELECT p.id, p.name, r.path FROM projects p LEFT JOIN project_roots r ON r.project_id = p.id ORDER BY p.position, r.position').all();
          const projects = new Map();
          for (const row of rows) {
            if (!projects.has(row.id)) projects.set(row.id, { id: row.id, name: row.name, roots: [] });
            if (typeof row.path === 'string' && isAbsolute(row.path)) projects.get(row.id).roots.push(row.path);
          }
          return { projects: [...projects.values()], source: 'Codex local project database' };
        } finally { db.close(); }
      }
    }
    return { projects: legacyProjects(state), source: 'Codex saved workspace state' };
  } catch {
    return { projects: [], source: null,
      warning: 'Could not read Codex’s saved projects. You can still open a checkout by path.' };
  }
}
