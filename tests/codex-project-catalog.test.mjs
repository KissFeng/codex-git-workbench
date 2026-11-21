import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { readCodexProjects } from '../plugins/source-control-proof/codex-projects.mjs';

test('an ordered desktop catalog takes precedence over an incomplete SQLite catalog', async t => {
  const home = await mkdtemp(join(tmpdir(), 'codex-desktop-catalog-'));
  const oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(async () => {
    if (oldHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  });

  const existingRoot = join(home, 'existing');
  const newRoots = [join(home, 'new'), join(home, 'new companion')];
  const db = new DatabaseSync(join(home, 'state_42.sqlite'));
  try {
    db.exec('CREATE TABLE projects (id TEXT, name TEXT, position INTEGER); CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT);');
    db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run('sqlite-id', 'Old project name', 0);
    db.prepare('INSERT INTO project_roots VALUES (?, ?, ?)').run('sqlite-id', 0, existingRoot);
  } finally {
    db.close();
  }

  const desktopState = join(home, '.codex-global-state.json');
  const existing = { id: 'existing', name: 'Existing project', rootPaths: [existingRoot] };
  const added = { id: 'added', name: 'New project', rootPaths: newRoots };
  await writeFile(desktopState, JSON.stringify({
    'local-projects': { existing, added },
    'project-order': [added.id, existing.id],
  }));
  const catalog = await readCodexProjects();
  assert.deepEqual(catalog.projects, [
    { id: added.id, name: added.name, roots: newRoots },
    { id: existing.id, name: existing.name, roots: [existingRoot] },
  ]);
  assert.equal(catalog.source, 'Codex saved workspace state');

  await writeFile(desktopState, JSON.stringify({ 'local-projects': {}, 'project-order': [] }));
  assert.deepEqual((await readCodexProjects()).projects, []);

  await writeFile(desktopState, '{invalid JSON');
  const fallback = await readCodexProjects();
  assert.equal(fallback.source, 'Codex local project database');
  assert.deepEqual(fallback.projects, [{ id: 'sqlite-id', name: 'Old project name', roots: [existingRoot] }]);
});
