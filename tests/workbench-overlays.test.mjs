import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionMessages } from '../plugins/source-control-proof/panel-messages-actions.mjs';

const panelSource = file => readFile(new URL('../plugins/source-control-proof/' + file, import.meta.url), 'utf8');
const evaluate = (source, expression, context = {}) => runInNewContext(source + '\n' + expression, context);

test('menu opens inside the viewport and above an anchor near the lower edge', async () => {
  const source = await panelSource('panel-overlays.js');
  const anchor = { left: 310, right: 360, top: 278, bottom: 306 };
  const viewport = { left: 0, top: 0, width: 360, height: 310 };
  const position = evaluate(source, 'workbenchOverlayPosition({ width: 180, height: 125 }, anchor, viewport)', { anchor, viewport });
  assert.equal(position.left, 172);
  assert.equal(position.top, 147);
});

test('menu keyboard selection wraps and skips disabled entries', async () => {
  const source = await panelSource('panel-overlays.js');
  const items = [{}, { disabled: true }, {}];
  const current = items[0];
  assert.equal(evaluate(source, "workbenchMenuTarget(items, current, 'ArrowDown')", { items, current }), items[2]);
  assert.equal(evaluate(source, "workbenchMenuTarget(items, current, 'ArrowUp')", { items, current }), items[2]);
  assert.equal(evaluate(source, "workbenchMenuTarget(items, current, 'Home')", { items, current }), items[0]);
  assert.equal(evaluate(source, "workbenchMenuTarget(items, current, 'End')", { items, current }), items[2]);
});

test('branch filtering preserves local, remote and tag groups and guards the current branch', async () => {
  const source = await panelSource('panel-actions.js');
  const refs = {
    branches: [{ name: 'Release', ref: 'refs/heads/Release', current: true }, { name: 'feature', ref: 'refs/heads/feature', current: false }],
    remoteBranches: [{ name: 'origin/release', remote: 'origin', branch: 'release' }, { name: 'removed/release', remote: null, branch: null }],
    tags: [{ name: 'release-1.0', ref: 'refs/tags/release-1.0' }],
  };
  const calls = [];
  const performAction = (_, args) => calls.push(Object.entries(args));
  const groups = evaluate(source, "filterBranchGroups(branchGroups(refs), ' RELEASE ')", { refs, performAction });
  assert.deepEqual(Array.from(groups, group => group.label), ['Local branches', 'Remote branches', 'Tags']);
  assert.deepEqual(Array.from(groups, group => Array.from(group.entries, entry => entry.label)), [['Release'], ['origin/release'], ['release-1.0']]);
  assert.equal(groups[0].entries[0].disabled, true);
  groups[1].entries[0].run();
  groups[2].entries[0].run();
  assert.deepEqual(calls, [
    [['action', 'switchBranch'], ['name', 'release'], ['remote', 'origin']],
    [['action', 'checkoutDetached'], ['ref', 'refs/tags/release-1.0']],
  ]);
});

test('repository menus guard branch actions against detached and stale checkouts', async () => {
  const source = await panelSource('panel-actions.js');
  const state = { checkout: '/selected', epoch: 1, status: { head: 'a'.repeat(40), branch: 'main', upstream: 'origin/main', detached: false } };
  const workbench = { busy: null };
  const calls = [];
  const performAction = (_, args) => calls.push(args);
  const menu = () => evaluate(source, 'repositoryMenuEntries({ path: state.checkout }, state.status)',
    { state, workbench, performAction });
  const first = menu();
  first.find(item => item.label === 'Fetch').run();
  assert.deepEqual(Array.from(calls, args => args.action), ['fetch']);
  state.epoch++;
  first.find(item => item.label === 'Fetch').run();
  assert.equal(calls.length, 1);

  state.status = { ...state.status, detached: true, upstream: null, branch: null };
  const detached = menu();
  assert.equal(detached.find(item => item.label === 'Pull').disabled, true);
  assert.equal(detached.find(item => item.label === 'Sync Changes').disabled, true);
  assert.equal(detached.find(item => item.label === 'Push').disabled, true);
  state.status.hasRemote = false;
  assert.equal(menu().find(item => item.label === 'Fetch').disabled, true);
});

test('context menu uses the original actionable row element for focus restoration', async () => {
  const source = await panelSource('panel-overlays.js');
  const listeners = {};
  const primary = {};
  const rowAction = {};
  const row = {
    addEventListener(type, listener) { listeners[type] = listener; },
    contains(node) { return node === primary || node === rowAction; },
  };
  const calls = [];
  evaluate(source, `
    openContextMenu = (entries, options) => record(options.anchor);
    bindContextMenu(row, () => [{ label: 'Open' }], { anchor: primary });
  `, { row, primary, record: anchor => calls.push(anchor) });
  const event = target => ({ target: { closest: () => target }, preventDefault() {}, stopPropagation() {} });
  listeners.contextmenu(event(null));
  listeners.keydown({ ...event(rowAction), key: 'F10', shiftKey: true });
  assert.deepEqual(calls, [primary, rowAction]);
});

test('command lists localize actions but preserve Git labels with the same text', async () => {
  const source = await panelSource('panel-actions.js');
  const shown = [];
  evaluate(source, `
    openAction = (_, list) => shown.push(...list.items);
    commandList('Git actions', [
      { label: 'Fetch', run() {} },
      { label: 'Fetch', rawLabel: true, run() {} },
    ]);
  `, {
    shown,
    msg: key => ({ key }),
    element: () => ({ items: [], append(item) { this.items.push(item); } }),
    control: text => ({ label: actionMessages[text?.key] ?? text }),
  });
  assert.deepEqual(shown.map(item => item.label), ['获取', 'Fetch']);
});
