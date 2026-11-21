import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, relative, sep } from 'node:path';
import { readCodexProjects } from './codex-projects.mjs';
import { checkoutRoot, git } from './git-status.mjs';

function relativePathWithin(directory, path) {
  const offset = relative(directory, path);
  return offset === '..' || offset.startsWith('..' + sep) || isAbsolute(offset) ? null : offset;
}

export async function checkoutForThread({ cwd, projectId }) {
  const checkout = await checkoutRoot(cwd);
  const [checkoutDirectory, chatDirectory] = await Promise.all([realpath(checkout), realpath(cwd)]);
  if (relative(checkoutDirectory, chatDirectory) === '') return checkout;

  const { projects } = await readCodexProjects();
  const project = projectId ? projects.find(candidate => candidate.id === projectId) : undefined;
  const roots = project?.roots ?? projects.flatMap(candidate => candidate.roots);
  for (const root of roots) {
    const projectDirectory = await realpath(root).catch(() => null);
    // A saved project folder between the checkout and the chat is its own boundary.
    if (projectDirectory && relativePathWithin(checkoutDirectory, projectDirectory) &&
        relativePathWithin(projectDirectory, chatDirectory) !== null) return null;
  }
  return checkout;
}

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
