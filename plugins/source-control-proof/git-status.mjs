import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const repositoryEnvironment = [
  'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX',
];

function runGit(cwd, args, encoding, { input, timeout = 10000, env = {}, indexPath } = {}) {
  const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...env };
  for (const key of repositoryEnvironment) delete gitEnv[key];
  if (indexPath !== undefined) gitEnv.GIT_INDEX_FILE = indexPath;
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['--no-optional-locks', '--literal-pathspecs', '-C', cwd, ...args], {
      encoding, maxBuffer: 16 * 1024 * 1024, timeout, env: gitEnv,
    }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export const runGitCommand = (cwd, args, options) => runGit(cwd, args, 'utf8', options);
export const git = async (cwd, ...args) => (await runGitCommand(cwd, args)).stdout;
export const gitBytes = async (cwd, ...args) => (await runGit(cwd, args, 'buffer')).stdout;

export async function checkoutRoot(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    throw new Error('Checkout path must be absolute.');
  }
  try {
    return (await git(path, 'rev-parse', '--show-toplevel')).replace(/\r?\n$/, '');
  } catch {
    throw new Error('No Git checkout at ' + path);
  }
}

function addFile(groups, status, path, originalPath) {
  const [index, working] = status;
  const file = { path, status };
  if (originalPath !== undefined) file.originalPath = originalPath;
  if (status === '??') groups.untracked.push(file);
  else if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(status)) groups.conflicts.push(file);
  else {
    if (index !== ' ') groups.staged.push({ ...file, change: index });
    if (working !== ' ') groups.unstaged.push({ ...file, change: working });
  }
}

const emptyGroups = () => ({ staged: [], unstaged: [], untracked: [], conflicts: [] });

export function parseStatus(output) {
  const groups = emptyGroups();
  const records = output.split('\0');
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    addFile(groups, status, record.slice(3), /[RC]/.test(status) ? records[++index] : undefined);
  }
  return groups;
}

function parseBranchStatus(output) {
  const groups = emptyGroups();
  const branchInfo = { branch: null, head: null, upstream: null, ahead: null, behind: null, detached: false };
  const records = output.split('\0');
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.startsWith('# branch.oid ')) {
      const object = record.slice(13);
      if (object !== '(initial)') branchInfo.head = object;
    } else if (record.startsWith('# branch.head ')) {
      branchInfo.branch = record.slice(14);
    } else if (record.startsWith('# branch.upstream ')) {
      branchInfo.upstream = record.slice(18);
    } else if (record.startsWith('# branch.ab ')) {
      const counts = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
      if (counts) [branchInfo.ahead, branchInfo.behind] = counts.slice(1).map(Number);
    } else if (record.startsWith('? ')) {
      addFile(groups, '??', record.slice(2));
    } else if (record[0] === '1' || record[0] === '2' || record[0] === 'u') {
      const prefixFields = { 1: 8, 2: 9, u: 10 }[record[0]];
      const prefix = record.split(' ', prefixFields);
      const path = record.slice(prefix.join(' ').length + 1);
      addFile(groups, prefix[1].replaceAll('.', ' '), path, record[0] === '2' ? records[++index] : undefined);
    }
  }
  if (branchInfo.branch === '(detached)') {
    branchInfo.detached = true;
    branchInfo.branch = 'Detached HEAD · ' + branchInfo.head?.slice(0, 7);
  }
  return { ...branchInfo, ...groups };
}

async function operationType(checkout) {
  const gitDir = (await git(checkout, 'rev-parse', '--absolute-git-dir')).replace(/\r?\n$/, '');
  const markers = [
    ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherryPick'], ['sequencer/todo', 'cherryPick'],
  ];
  const types = await Promise.all(markers.map(async ([file, type]) => {
    try {
      await stat(join(gitDir, file));
      return type;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return null;
    }
  }));
  return types.find(Boolean) ?? null;
}

export async function getStatus(repoPath) {
  const launchDirectory = process.cwd();
  const contextSource = repoPath ? 'explicit checkout' : 'server launch directory';
  const checkout = await checkoutRoot(repoPath || launchDirectory);
  const [status, operation, remotes] = await Promise.all([
    git(checkout, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'),
    operationType(checkout),
    git(checkout, 'remote'),
  ]);
  const branch = parseBranchStatus(status);
  return {
    checkout, contextSource, launchDirectory, checkedAt: new Date().toISOString(), ...branch,
    operation: operation ?? (branch.conflicts.length ? 'conflict' : null), hasRemote: Boolean(remotes.trim()),
  };
}
