const string = { type: 'string' };
const boolean = { type: 'boolean' };
const integer = { type: 'integer', minimum: 0 };
const strings = { type: 'array', items: string, maxItems: 10000 };
const choices = (...values) => ({ type: 'string', enum: values });
const group = choices('staged', 'unstaged', 'untracked', 'conflicts');
const history = () => import('./git-history.mjs');
const operations = () => import('./git-operations.mjs');
const staging = () => import('./git-staging.mjs');
const patch = () => import('./git-patch.mjs');
const commit = () => import('./git-commit.mjs');
const desktop = () => import('./desktop-actions.mjs');
const optionalRepoPath = new Set(['git_operation', 'desktop_pick_checkout']);

const operationActions = [
  'init', 'clone', 'createBranch', 'switchBranch', 'checkoutDetached', 'renameBranch', 'deleteBranch',
  'createTag', 'deleteTag', 'deleteRemoteBranch', 'deleteRemoteTag', 'fetch', 'fetchRef', 'pushRef', 'pushTags', 'pull', 'pullMerge', 'pullRebase', 'push', 'publish', 'sync', 'syncRebase',
  'forcePush', 'addRemote', 'removeRemote', 'merge', 'rebase', 'cherryPick', 'mergeContinue',
  'rebaseContinue', 'cherryPickContinue', 'mergeAbort', 'rebaseAbort', 'cherryPickAbort',
  'stashPush', 'stashApply', 'stashPop', 'stashDrop', 'stashDropAll', 'createWorktree', 'removeWorktree',
  'moveWorktreeChanges', 'conflictResolve',
];
const definitions = [
  ['git_history', 'Read Git history', history, 'gitHistory', {
    limit: integer, offset: integer, cursor: string, ref: string, path: string, scope: choices('auto', 'all'), refs: strings,
  }],
  ['git_history_detail', 'Read a commit and its changes', history, 'gitHistoryDetail',
    { commit: string, path: string, parent: { anyOf: [string, integer] } }, ['commit']],
  ['git_history_stats', 'Read commit change totals and the Git message body', history, 'gitHistoryStats', { commit: string }, ['commit']],
  ['git_compare', 'Compare Git references or the working copy', history, 'gitCompare',
    { from: string, to: string, path: string, mergeBase: boolean }, ['from']],
  ['git_blame', 'Read line attribution', history, 'gitBlame', { path: string, ref: string }, ['path']],
  ['git_patch', 'Read selectable patch', patch, 'gitPatch', { path: string, group }, ['path', 'group']],
  ['git_apply_patch', 'Apply selected changes', patch, 'applyGitPatch', {
    path: string, group, action: choices('stage', 'unstage', 'discard'),
    token: string, hunkIds: strings, lineIds: strings, confirmed: boolean,
  }, ['path', 'group', 'action', 'token'], true],
  ['git_change', 'Stage or modify selected changes', staging, 'gitChange', {
    action: choices('stage', 'unstage', 'discard', 'ignore', 'rename', 'delete'), group,
    path: string, newPath: string, confirmed: boolean, expectedPaths: strings,
  }, ['action'], true],
  ['git_commit_template', 'Read the configured commit template', commit, 'gitCommitTemplate', {}],
  ['git_commit', 'Create, amend or undo a commit', commit, 'gitCommit', {
    action: choices('commit', 'commitAll', 'amend', 'undoCommit', 'commitEmpty'),
    message: string, signed: boolean, signoff: boolean, noVerify: boolean, all: boolean, confirmed: boolean,
  }, ['action'], true],
  ['git_references', 'Read branches, tags, remotes, stashes and worktrees', operations, 'gitReferences', { includeSymbolic: boolean }],
  ['git_operation', 'Run a selected Git operation', operations, 'gitOperation', {
    action: choices(...operationActions), name: string, startPoint: string, checkout: boolean,
    newName: string, force: boolean, ref: string, message: string, remote: string, branch: string,
    prune: boolean, confirmed: boolean, expected: string, url: string, includeUntracked: boolean,
    recursive: boolean, followTags: boolean, kind: choices('branch', 'tag'), target: string,
    staged: boolean, restoreIndex: boolean, expectedStashes: strings, destination: string, newBranch: string, open: boolean,
    path: string, content: string, choice: choices('ours', 'theirs', 'base', 'current', 'delete', 'edit'),
  }, ['action'], true, true],
  ['git_conflict', 'Read the versions of a conflicted file', operations, 'gitOperation', { path: string }, ['path']],
  ['desktop_pick_checkout', 'Choose a Git working copy', desktop, 'pickCheckout', { path: string, language: choices('en', 'zh-CN') }],
  ['desktop_file_action', 'Open a working copy file or its folder', desktop, 'openCheckoutItem', {
    path: string, action: choices('open', 'folder'),
  }, ['path', 'action']],
];

export const workbenchTools = definitions.map(([name, title, , , properties, required = [], writes = false, network = false]) => ({
  name,
  title,
  description: title + '.',
  inputSchema: {
    type: 'object', properties: { repoPath: string, ...properties },
    required: optionalRepoPath.has(name) ? required : ['repoPath', ...required],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: !writes && !name.startsWith('desktop_'), destructiveHint: writes,
    idempotentHint: !writes && !name.startsWith('desktop_'), openWorldHint: network,
  },
  _meta: { ui: { visibility: ['app'] } },
}));

function validValue(value, schema) {
  if (schema.anyOf) return schema.anyOf.some(option => validValue(value, option));
  if (schema.enum) return schema.enum.includes(value);
  if (schema.type === 'integer') return Number.isSafeInteger(value) && value >= schema.minimum;
  if (schema.type === 'array') return Array.isArray(value) && value.length <= schema.maxItems && value.every(item => validValue(item, schema.items));
  return typeof value === schema.type;
}

export async function callWorkbenchTool(name, args) {
  const index = definitions.findIndex(definition => definition[0] === name);
  const schema = workbenchTools[index].inputSchema;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid arguments.');
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(schema.properties, key)) throw new Error('Unknown argument: ' + key);
    if (!validValue(value, schema.properties[key])) throw new Error('Invalid ' + key + '.');
  }
  for (const key of schema.required) {
    if (!Object.hasOwn(args, key)) throw new Error('Missing ' + key + '.');
  }
  const [, , load, method] = definitions[index];
  if (name === 'git_operation' && !['init', 'clone'].includes(args.action) && !args.repoPath) {
    throw new Error('Choose a checkout before running this operation.');
  }
  const handler = (await load())[method];
  return handler(name === 'git_conflict' ? { ...args, action: 'conflictRead' } : args);
}
