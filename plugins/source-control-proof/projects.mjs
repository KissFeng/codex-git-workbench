import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, relative } from 'node:path';
import { readCodexProjects } from './codex-projects.mjs';
import { git } from './git-status.mjs';

export async function listProjects() {
  const catalog = await readCodexProjects();
  const roots = catalog.projects.flatMap(project => project.roots.map(path => ({
    projectId: project.id, projectName: project.name || basename(path), path,
    label: (project.name || basename(path)) + (project.roots.length > 1 ? ' · ' + basename(path) : ''),
  })));
  const projects = await Promise.all(roots.map(async project => {
    const unavailable = { ...project, checkouts: [], unavailable: true };
    try {
      const path = (await git(project.path, 'rev-parse', '--show-toplevel')).trim();
      // Git searches parent directories, but a saved folder must itself be a checkout.
      if (relative(await realpath(path), await realpath(project.path))) return unavailable;
      const raw = await git(path, 'worktree', 'list', '--porcelain', '-z');
      const checkouts = [];
      let checkout;
      for (const field of raw.split('\0')) {
        if (field.startsWith('worktree ')) {
          checkout = { path: field.slice(9), branch: 'Detached HEAD' };
          checkouts.push(checkout);
        } else if (checkout && field.startsWith('branch ')) checkout.branch = field.slice(7).replace(/^refs\/heads\//, '');
        else if (checkout && field.startsWith('prunable')) checkout.prunable = true;
      }
      return { ...project, path, checkouts: checkouts.filter(c => !c.prunable) };
    } catch {
      return unavailable;
    }
  }));
  return { projects, homeDirectory: homedir(), discovery: { source: catalog.source, warning: catalog.warning } };
}
