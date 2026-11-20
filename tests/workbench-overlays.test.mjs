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

test('interactive commit card prefers the right side and remains inside a narrow panel', async () => {
  const source = await panelSource('panel-overlays.js');
  const anchor = { left: 10, top: 130, right: 310, bottom: 158 };
  const viewport = { left: 0, top: 0, width: 780, height: 300 };
  const options = { tooltip: true, placement: 'side' };
  const position = evaluate(source, 'workbenchOverlayPosition({ width: 370, height: 100 }, anchor, viewport, options)', { anchor, viewport, options });
  assert.equal(position.left, 316);
  assert.equal(position.top, 130);
  viewport.width = 350;
  const fallback = evaluate(source, 'workbenchOverlayPosition({ width: 300, height: 100 }, anchor, viewport, options)', { anchor, viewport, options });
  assert.equal(fallback.top, 164);
  assert.ok(fallback.left + 300 <= viewport.width - 8);
});

test('interactive hover keeps the card open across the pointer gap and focuses Copy on Tab', async () => {
  const source = await panelSource('panel-overlays.js');
  const timers = new Map();
  let next = 0;
  function node() {
    return {
      listeners: {}, children: [], attributes: new Map(), isConnected: true,
      setAttribute(name, value) { this.attributes.set(name, value); },
      getAttribute(name) { return this.attributes.get(name) ?? null; },
      removeAttribute(name) { this.attributes.delete(name); },
      addEventListener(type, listener) { this.listeners[type] = listener; },
      contains(target) { return target === this || this.children.includes(target); },
      closest() { return null; },
      append(child) { this.children.push(child); },
      querySelector() { return this.children[0]; },
      remove() { this.isConnected = false; },
    };
  }
  const anchor = node();
  const copy = node();
  const card = node();
  const document = {
    activeElement: anchor, addEventListener() {},
    body: { append() {} },
  };
  copy.focus = () => { document.activeElement = copy; };
  anchor.focus = () => { document.activeElement = anchor; };
  const fireTimers = () => {
    for (const [id, run] of [...timers]) if (timers.delete(id)) run();
  };
  evaluate(source, `
    positionWorkbenchOverlay = () => {};
    monitorWorkbenchOverlay = () => ({ disconnect() {} });
    bindTooltip(anchor, () => copy, { interactive: true, placement: 'side' });
  `, {
    anchor, copy, document, element: () => card, Node: Object,
    uiAttr: (node, name, value) => node.setAttribute(name, value), msg: value => value,
    setTimeout: run => { timers.set(++next, run); return next; }, clearTimeout: id => timers.delete(id),
  });
  anchor.listeners.pointerenter();
  fireTimers();
  assert.equal(card.getAttribute('role'), 'dialog');
  anchor.listeners.pointerleave({ relatedTarget: null });
  card.listeners.pointerenter();
  fireTimers();
  assert.equal(card.isConnected, true);
  anchor.listeners.keydown({ key: 'Tab', preventDefault() {} });
  assert.equal(document.activeElement, copy);
  card.listeners.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(card.isConnected, false);
  assert.equal(document.activeElement, anchor);
});

test('copy opens and selects the full hash when desktop clipboard permission is unavailable', async () => {
  const source = await panelSource('panel-actions.js');
  const hash = '0123456789abcdef0123456789abcdef01234567';
  const field = {
    focus() { this.focused = true; },
    select() { this.selected = true; },
  };
  let copied;
  await evaluate(source, `
    openAction = (_title, field) => display(field);
    copyText(hash);
  `, {
    hash, element: () => field,
    navigator: { clipboard: { writeText: async value => {
      copied = value;
      throw new Error('Document is not focused');
    } } },
    display: value => assert.equal(value, field),
  });
  assert.equal(copied, hash);
  assert.equal(field.value, hash);
  assert.equal(field.readOnly, true);
  assert.equal(field.focused && field.selected, true);
});
