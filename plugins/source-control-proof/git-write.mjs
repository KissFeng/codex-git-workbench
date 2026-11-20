import { realpath } from 'node:fs/promises';
import { checkoutRoot, git } from './git-status.mjs';

const queues = new Map();

export async function withGitWrite(repoPath, callback) {
  const root = await checkoutRoot(repoPath);
  const common = (await git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')).replace(/\r?\n$/, '');
  const key = await realpath(common);
  const previous = queues.get(key) || Promise.resolve();
  const operation = previous.catch(() => {}).then(() => callback(root));
  queues.set(key, operation);
  try {
    return await operation;
  } finally {
    if (queues.get(key) === operation) queues.delete(key);
  }
}
