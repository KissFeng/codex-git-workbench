import { copyFile, lstat, mkdtemp, open, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getStatus, git, runGitCommand } from './git-status.mjs';
import { withGitWrite } from './git-write.mjs';

const commitActions = ['commit', 'commitAll', 'amend', 'undoCommit', 'commitEmpty'];
const inProgressPaths = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REBASE_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'];
const endOfLine = /\r?\n$/;

async function existingPath(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}

async function requireLocalHead(root, status) {
  if (!status.head) throw new Error('The checkout has no commit yet.');
  const refs = await git(root, 'for-each-ref', '--contains', status.head, '--format=%(refname)', 'refs/remotes');
  if (refs.trim()) throw new Error('The commit is already present on a remote-tracking branch.');
  return status.head;
}

async function undoCommit(root, status) {
  const head = await requireLocalHead(root, status);
  const gitDir = (await git(root, 'rev-parse', '--absolute-git-dir')).replace(endOfLine, '');
  const inProgress = await Promise.all(inProgressPaths.map(path => existingPath(join(gitDir, path))));
  if (status.conflicts.length || inProgress.some(Boolean)) throw new Error('Finish the Git operation before undoing a commit.');
  const raw = await git(root, 'cat-file', 'commit', head);
  const parents = [...raw.split('\n\n', 1)[0].matchAll(/^parent ([a-f0-9]+)$/gm)].map(match => match[1]);
  if (parents.length > 1) throw new Error('Undo is unavailable for merge commits.');
  const undoneMessage = (await git(root, 'show', '-s', '--format=%B', head)).trimEnd();
  const ref = status.detached ? 'HEAD' : (await git(root, 'symbolic-ref', 'HEAD')).trim();
  if (parents.length) {
    await git(root, 'update-ref', '-m', 'undo commit: ' + head, ref, parents[0], head);
  } else {
    if (status.detached) throw new Error('Switch to a branch before undoing an initial commit.');
    await git(root, 'update-ref', '-d', ref, head);
  }
  return { ...await getStatus(root), undoneMessage };
}

async function commitAll(root, args, options) {
  const indexPath = (await git(root, 'rev-parse', '--path-format=absolute', '--git-path', 'index')).replace(endOfLine, '');
  const lockPath = indexPath + '.lock';
  let lock;
  try {
    lock = await open(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another Git process has locked the index.');
    throw error;
  }
  let directory;
  try {
    directory = await mkdtemp(join(dirname(indexPath), 'codex-commit-'));
    const temporaryIndex = join(directory, 'index');
    try { await copyFile(indexPath, temporaryIndex); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await runGitCommand(root, ['add', '--all'], { timeout: options.timeout, indexPath: temporaryIndex });
    await runGitCommand(root, args, { ...options, indexPath: temporaryIndex });
    // Install the staged snapshot only after Git returns success. Other Git writers
    // see the real index lock throughout, and a failed hook leaves the index intact.
    await rename(temporaryIndex, indexPath);
  } finally {
    try { await lock.close(); }
    finally {
      try { await unlink(lockPath); }
      finally { if (directory) await rm(directory, { recursive: true, force: true }); }
    }
  }
}

export async function gitCommit({ repoPath, action, message, signed, noVerify, confirmed }) {
  if (typeof repoPath !== 'string' || !commitActions.includes(action)
    || (message !== undefined && (typeof message !== 'string' || message.includes('\0')))
    || (signed !== undefined && typeof signed !== 'boolean') || (noVerify !== undefined && typeof noVerify !== 'boolean')) {
    throw new Error('Invalid commit request.');
  }
  if (['amend', 'undoCommit'].includes(action) && confirmed !== true) throw new Error('Confirm this commit action before continuing.');
  if (!['amend', 'undoCommit'].includes(action) && !message?.trim()) throw new Error('Enter a commit message.');
  const args = ['commit'];
  if (action === 'amend') args.push('--amend');
  if (action === 'commitEmpty') args.push('--only', '--allow-empty');
  if (signed !== undefined) args.push(signed ? '--gpg-sign' : '--no-gpg-sign');
  if (noVerify) args.push('--no-verify');
  if (message?.trim()) args.push('--file=-');
  else if (action === 'amend') args.push('--no-edit');
  return withGitWrite(repoPath, async root => {
    const status = await getStatus(root);
    if (action === 'undoCommit') return undoCommit(root, status);
    if (action === 'amend') await requireLocalHead(root, status);
    if (status.conflicts.length) throw new Error('Resolve conflicts before committing.');
    const options = { input: message, timeout: 120000 };
    try {
      if (action === 'commitAll') await commitAll(root, args, options);
      else await runGitCommand(root, args, options);
    } catch (error) {
      const currentHead = await git(root, 'rev-parse', '--verify', 'HEAD').then(stdout => stdout.trim(), () => null);
      if (currentHead && currentHead !== status.head) {
        throw new Error('HEAD moved to ' + currentHead + ' before Git reported an error. Refresh the repository state. ' + error.message, { cause: error });
      }
      if (!error.stderr?.trim() && error.stdout?.trim()) throw new Error(error.stdout.trim(), { cause: error });
      throw error;
    }
    return getStatus(root);
  });
}
