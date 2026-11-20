import { constants } from 'node:fs';
import { link, lstat, open, realpath, unlink } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { git, getStatus, runGitCommand } from './git-status.mjs';
import { withGitWrite } from './git-write.mjs';
import { safePath } from './repo-path.mjs';

const stageGroups = ['unstaged', 'untracked', 'conflicts'];
const changeGroups = ['staged', 'unstaged', 'untracked'];

async function runWithPaths(root, args, paths) {
  const uniquePaths = [...new Set(paths)];
  if (!uniquePaths.length) return;
  for (const path of uniquePaths) safePath(root, path);
  await runGitCommand(root, [...args, '--pathspec-from-file=-', '--pathspec-file-nul'], {
    input: uniquePaths.join('\0') + '\0',
  });
}

async function updateIndex(root, action, files) {
  const paths = files.flatMap(file => file.change === 'R' && file.originalPath
    ? [file.originalPath, file.path] : [file.path]);
  if (action === 'stage') {
    await runWithPaths(root, ['add'], paths);
    return;
  }
  if (!paths.length) return;
  let args;
  try {
    await git(root, 'rev-parse', '--verify', 'HEAD');
    args = ['restore', '--staged'];
  } catch (error) {
    if (error.code !== 128) throw error;
    args = ['rm', '--cached', '--force'];
  }
  await runWithPaths(root, args, paths);
}

async function checkedPath(root, path) {
  const target = safePath(root, path);
  if (relative(root, target).split(sep).join('/') !== path || path === '.') {
    throw new Error('Invalid repository-relative file path.');
  }
  const parent = dirname(target);
  const canonicalRoot = await realpath(root);
  if (relative(canonicalRoot, await realpath(parent)) !== relative(root, parent)) {
    throw new Error('The file parent must be inside the checkout without symbolic links.');
  }
  return target;
}

async function checkedWorkingFile(root, path) {
  const target = await checkedPath(root, path);
  const info = await lstat(target, { bigint: true });
  if (!info.isFile() && !info.isSymbolicLink()) throw new Error('This action requires a file or symbolic link.');
  return { target, info };
}

async function checkRestorePath(root, path) {
  safePath(root, path);
  const parts = path.split('/');
  let target = root;
  for (const [index, part] of parts.entries()) {
    target = join(target, part);
    let info;
    try { info = await lstat(target); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    const valid = index === parts.length - 1 ? info.isFile() || info.isSymbolicLink() : info.isDirectory();
    if (!valid) throw new Error('A directory or another working path obstructs restoring ' + path + '.');
  }
}

async function addIgnoreRule(root, path) {
  if (/[\r\n]/.test(path)) throw new Error('This filename cannot be represented as an exact ignore rule.');
  const pattern = '/' + path.replace(/[\\!*?\[\]# ]/g, '\\$&');
  const target = safePath(root, '.gitignore');
  const flags = constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(target, flags, 0o666);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('.gitignore must be a regular file.');
    const finalByte = Buffer.alloc(1);
    if (info.size) await handle.read(finalByte, 0, 1, info.size - 1);
    const newline = info.size && finalByte[0] !== 10 ? '\n' : '';
    await handle.appendFile(newline + pattern + '\n');
  } finally {
    await handle.close();
  }
}

async function updateWorkingPath(root, action, path, newPath) {
  const { target: source } = await checkedWorkingFile(root, path);
  if (action === 'delete') {
    await unlink(source);
    return;
  }
  const destination = await checkedPath(root, newPath);
  try {
    // An exclusive link avoids clobbering a destination created by another process.
    await link(source, destination);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('The rename destination already exists.');
    throw error;
  }
  try {
    await unlink(source);
  } catch (error) {
    await unlink(destination).catch(() => {});
    throw error;
  }
}

async function discardUntracked(root, files) {
  const entries = [];
  for (const file of files) entries.push(await checkedWorkingFile(root, file.path));
  // Validate the entire scope first, and recheck the file identity before deletion.
  for (const [index, { target, info }] of entries.entries()) {
    try {
      const { info: current } = await checkedWorkingFile(root, files[index].path);
      if (current.dev !== info.dev || current.ino !== info.ino || current.mtimeNs !== info.mtimeNs
        || current.size !== info.size || current.mode !== info.mode) {
        throw new Error('The file changed after the request.');
      }
      await unlink(target);
    } catch (error) {
      throw new Error('Removed ' + index + ' untracked files before stopping at ' + files[index].path + '. ' + error.message, { cause: error });
    }
  }
}

export async function gitChange({ repoPath, path, newPath, group, action, confirmed, expectedPaths }) {
  if (typeof repoPath !== 'string' || !['stage', 'unstage', 'discard', 'ignore', 'rename', 'delete'].includes(action)) {
    throw new Error('Invalid staging request.');
  }
  if (['discard', 'delete'].includes(action) && confirmed !== true) throw new Error('Confirm this change before continuing.');
  if (expectedPaths !== undefined && (action !== 'discard' || path !== undefined
    || !Array.isArray(expectedPaths) || expectedPaths.some(file => typeof file !== 'string'))) {
    throw new Error('Invalid list of paths for bulk discard.');
  }
  const groups = {
    stage: stageGroups,
    unstage: ['staged'],
    discard: ['unstaged', 'untracked'],
    ignore: ['untracked'],
    rename: changeGroups,
    delete: changeGroups,
  }[action];
  if (group !== undefined && !groups.includes(group)) throw new Error('Invalid staging group.');
  if (['ignore', 'rename', 'delete'].includes(action) && (group === undefined || path === undefined)) {
    throw new Error('Select an exact file for this action.');
  }
  return withGitWrite(repoPath, async root => {
    if (path !== undefined) safePath(root, path);
    const status = await getStatus(root);
    const defaults = { stage: ['unstaged', 'untracked'], discard: ['unstaged'] };
    const selectedGroups = group ? [group] : defaults[action] || groups;
    const files = selectedGroups.flatMap(current => status[current]).filter(file => path === undefined || file.path === path);
    if (expectedPaths !== undefined) {
      const expected = [...new Set(expectedPaths)].sort();
      const current = [...new Set(files.map(file => file.path))].sort();
      if (current.length !== expected.length || current.some((file, index) => file !== expected[index])) {
        throw new Error('The file list changed. Refresh the changes and confirm again.');
      }
    }
    if (path !== undefined && !files.length) {
      throw new Error('This file is no longer in ' + (group || 'the selected') + ' changes. Refresh the file list.');
    }
    if (action === 'stage' || action === 'unstage') await updateIndex(root, action, files);
    else if (action === 'discard' && group === 'untracked') await discardUntracked(root, files);
    else if (action === 'discard') {
      const paths = files.map(file => file.path);
      // Git restore can remove untracked paths that are in the way of a tracked file.
      for (const target of paths) await checkRestorePath(root, target);
      await runWithPaths(root, ['restore', '--worktree'], paths);
    }
    else if (action === 'ignore') await addIgnoreRule(root, path);
    else await updateWorkingPath(root, action, path, newPath);
    return getStatus(root);
  });
}

export async function updateStaging({ repoPath, path, group, action }) {
  if (typeof repoPath !== 'string' || !['stage', 'unstage'].includes(action)) throw new Error('Invalid staging request.');
  if (action === 'unstage' ? group !== 'staged' : !stageGroups.includes(group)) throw new Error('Invalid staging group.');
  if (typeof path !== 'string') throw new Error('Invalid repository-relative file path.');
  return gitChange({ repoPath, path, group, action });
}
