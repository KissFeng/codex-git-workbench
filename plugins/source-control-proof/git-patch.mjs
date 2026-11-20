import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { devNull } from 'node:os';
import { getStatus, git, gitBytes, runGitCommand } from './git-status.mjs';
import { withGitWrite } from './git-write.mjs';
import { safePath } from './repo-path.mjs';

const maxPatchBytes = 512 * 1024;
const lineKinds = { ' ': 'context', '+': 'addition', '-': 'deletion', '\\': 'marker' };
const noNewline = '\\ No newline at end of file';

function parseHunks(patch) {
  const hunks = [];
  let hunk;
  for (const text of patch.split('\n')) {
    const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (range) {
      const [oldStart, oldCount, newStart, newCount] = range.slice(1).map(value => Number(value ?? 1));
      hunk = { id: 'h' + hunks.length, header: text, oldStart, oldCount, newStart, newCount, lines: [] };
      hunks.push(hunk);
    } else if (hunk && lineKinds[text[0]]) {
      hunk.lines.push({ id: hunk.id + ':' + hunk.lines.length, kind: lineKinds[text[0]], text });
    }
  }
  return hunks;
}

async function readPatch(root, path, group, status) {
  const target = safePath(root, path);
  const file = status[group].find(item => item.path === path);
  if (!file) throw new Error('This change has changed or is no longer available. Refresh the diff.');
  const fingerprint = createHash('sha256').update(JSON.stringify([root, path, group]));
  const unavailable = (disabledReason, patch = '') => ({ token: fingerprint.digest('hex'), patch, hunks: [], disabledReason });
  const untracked = group === 'untracked';
  if (untracked && !(await lstat(target)).isFile()) return unavailable('Line actions are available for regular text changes.');
  const renamed = ['R', 'C'].includes(file.change) && file.originalPath;
  const paths = untracked ? [devNull, './' + path] : renamed ? [file.originalPath, path] : [path];
  const args = [
    '-c', 'diff.suppressBlankEmpty=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-relative',
    '--src-prefix=a/', '--dst-prefix=b/', '--line-prefix=', '--submodule=short', '--full-index', '--unified=3',
    '--output-indicator-new=+', '--output-indicator-old=-', '--output-indicator-context= ',
    renamed ? '--find-renames' : '--no-renames',
  ];
  if (group === 'staged') args.push('--cached');
  if (untracked) args.push('--no-index');
  let bytes;
  try { bytes = await gitBytes(root, ...args, '--', ...paths); }
  catch (error) {
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return unavailable('Diff is larger than the 512 KB viewer limit.');
    if (!untracked || error.code !== 1 || !Buffer.isBuffer(error.stdout)) throw error;
    bytes = error.stdout;
  }
  fingerprint.update(bytes);
  if (bytes.length > maxPatchBytes) return unavailable('Diff is larger than the 512 KB viewer limit.');
  let patch;
  try { patch = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return unavailable('Line actions are unavailable for non-UTF-8 changes.'); }
  const header = patch.split(/^@@ /m, 1)[0];
  const created = /^new file mode (\d{6})$/m.exec(header);
  const deleted = /^deleted file mode (\d{6})$/m.exec(header);
  let mode = (created || deleted || /^index [\da-f]+\.\.[\da-f]+ (\d{6})$/m.exec(header))?.[1];
  const hunks = parseHunks(patch);
  if (renamed || /^(?:old|new) mode /m.test(header)) return unavailable('Use a whole-file action for renames and mode changes.', patch);
  if (!hunks.length || !['100644', '100755'].includes(mode) || bytes.includes(0)) {
    return unavailable('Line actions are available for regular text changes.', patch);
  }
  if (untracked && mode === '100755') {
    try {
      if ((await git(root, 'config', '--type=bool', '--get', 'core.filemode')).trim() === 'false') mode = '100644';
    } catch (error) {
      if (error.code !== 1) throw error;
    }
  }
  return { token: fingerprint.update(mode).digest('hex'), patch, hunks, mode, created: Boolean(created), deleted: Boolean(deleted) };
}

function validateGroup(group) {
  if (!['staged', 'unstaged', 'untracked'].includes(group)) throw new Error('Select a staged, unstaged or untracked text change.');
}

export async function gitPatch({ repoPath, path, group }) {
  validateGroup(group);
  const status = await getStatus(repoPath);
  const { token, patch, hunks, disabledReason } = await readPatch(status.checkout, path, group, status);
  return { token, patch, hunks: hunks.map(({ id, header, lines }) => ({ id, header, lines })), disabledReason };
}

const isEdited = line => ['addition', 'deletion'].includes(line.kind);

function selectLines(hunks, hunkIds = [], lineIds = []) {
  if (!Array.isArray(hunkIds) || !Array.isArray(lineIds) || (!hunkIds.length && !lineIds.length)) {
    throw new Error('Select at least one hunk or changed line.');
  }
  const byHunk = new Map(hunks.map(hunk => [hunk.id, hunk]));
  const byLine = new Set(hunks.flatMap(hunk => hunk.lines.filter(isEdited).map(line => line.id)));
  const selected = new Set(lineIds);
  if (lineIds.some(id => !byLine.has(id)) || hunkIds.some(id => !byHunk.has(id))) {
    throw new Error('The selection contains a line or hunk outside the current diff.');
  }
  for (const id of hunkIds) for (const line of byHunk.get(id).lines.filter(isEdited)) selected.add(line.id);
  return { selected, complete: selected.size === byLine.size };
}

function quotePath(prefix, path) {
  const escaped = [...Buffer.from(prefix + path)].map(byte => {
    if (byte === 34 || byte === 92) return '\\' + String.fromCharCode(byte);
    if (byte < 32 || byte >= 127) return '\\' + byte.toString(8).padStart(3, '0');
    return String.fromCharCode(byte);
  }).join('');
  return '"' + escaped + '"';
}

const offset = (start, count) => count ? start - 1 : start;
const range = (start, count) => (count ? start + 1 : start) + ',' + count;

function patchHunk(hunk, selected, reverse) {
  const preimage = [], postimage = [];
  for (const [index, line] of hunk.lines.entries()) {
    if (line.kind === 'marker') continue;
    const payload = { text: line.text.slice(1), final: hunk.lines[index + 1]?.kind === 'marker' };
    const before = line.kind === (reverse ? 'addition' : 'deletion');
    if (before || line.kind === 'context') preimage.push(payload);
    if (line.kind === 'context' || selected.has(line.id) !== before) postimage.push(payload);
  }
  const start = reverse ? offset(hunk.newStart, hunk.newCount) : offset(hunk.oldStart, hunk.oldCount);
  return { start, preimage, postimage };
}

function appendLines(patch, prefix, lines) {
  for (const [index, line] of lines.entries()) {
    patch.push(prefix + line.text);
    // A retained EOF line needs a separator when selected additions follow it.
    if (line.final && (prefix === '-' || index === lines.length - 1)) patch.push(noNewline);
  }
}

function selectionPatch(path, diff, selection, reverse) {
  const { selected, complete } = selection;
  const fromAbsent = reverse ? diff.deleted : diff.created;
  const toAbsent = complete && (reverse ? diff.created : diff.deleted);
  const a = quotePath('a/', path), b = quotePath('b/', path);
  const patch = ['diff --git ' + a + ' ' + b];
  if (fromAbsent) patch.push('new file mode ' + diff.mode);
  if (toAbsent) patch.push('deleted file mode ' + diff.mode);
  patch.push('--- ' + (fromAbsent ? '/dev/null' : a), '+++ ' + (toAbsent ? '/dev/null' : b));
  let delta = 0;
  for (const hunk of diff.hunks) {
    if (!hunk.lines.some(line => selected.has(line.id))) continue;
    const { start, preimage, postimage } = patchHunk(hunk, selected, reverse);
    patch.push('@@ -' + range(start, preimage.length) + ' +' + range(start + delta, postimage.length) + ' @@');
    appendLines(patch, '-', preimage);
    appendLines(patch, '+', postimage);
    delta += postimage.length - preimage.length;
  }
  return patch.join('\n') + '\n';
}

export async function applyGitPatch({ repoPath, path, group, action, token, hunkIds, lineIds, confirmed }) {
  validateGroup(group);
  const actions = { staged: ['unstage'], unstaged: ['stage', 'discard'], untracked: ['stage'] };
  if (!actions[group].includes(action)) {
    throw new Error('This patch action is unavailable for the selected group.');
  }
  if (action === 'discard' && confirmed !== true) throw new Error('Confirm this discard before continuing.');
  return withGitWrite(repoPath, async root => {
    const status = await getStatus(root);
    const diff = await readPatch(root, path, group, status);
    if (typeof token !== 'string' || token !== diff.token) throw new Error('The diff has changed. Refresh it and select the changes again.');
    if (diff.disabledReason) throw new Error(diff.disabledReason);
    const selection = selectLines(diff.hunks, hunkIds, lineIds);
    const input = selectionPatch(path, diff, selection, action !== 'stage');
    const args = ['-c', 'apply.ignoreWhitespace=no', 'apply', '--unidiff-zero', '--whitespace=nowarn'];
    if (action !== 'discard') args.push('--cached');
    await runGitCommand(root, args, { input });
    return getStatus(root);
  });
}
