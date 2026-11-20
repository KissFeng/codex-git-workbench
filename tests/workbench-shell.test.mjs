import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setPanelContentVisible } from '../plugins/source-control-proof/panel-motion.mjs';
import { scmPrimaryAction, scmSplitRatio } from '../plugins/source-control-proof/panel-model.mjs';

const panelSection = file => readFile(new URL('../plugins/source-control-proof/' + file, import.meta.url), 'utf8');
const scopes = ['repositories', 'changes', 'history'];

function shellFixture() {
  const nodes = new Map();
  const app = { dataset: { pane: 'workspace' } };
  const document = { listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; } };
  const node = id => {
    if (!nodes.has(id)) {
      nodes.set(id, {
        id, dataset: {}, attributes: {}, listeners: {}, ownerDocument: document,
        style: { setProperty() {} }, scrollTop: 0, scrollLeft: 0, hidden: false,
        offsetHeight: 8,
        closest() { return null; },
        setAttribute(key, value) { this.attributes[key] = value; },
        getAttribute(key) { return this.attributes[key]; },
        addEventListener(type, listener) { this.listeners[type] = listener; },
        focus() { document.activeElement = this; },
        getBoundingClientRect() { return { height: id === 'scm-split' ? 500 : 30, top: 40 }; },
        setPointerCapture(pointerId) { this.pointerId = pointerId; },
        hasPointerCapture(pointerId) { return this.pointerId === pointerId; },
        releasePointerCapture() { this.pointerId = null; this.listeners.lostpointercapture?.(); },
      });
    }
    return nodes.get(id);
  };
  const bodies = { repositories: 'repository-list', changes: 'changes-body', history: 'history-scroll' };
  const toggles = scopes.map(section => {
    const toggle = node(section + '-toggle');
    toggle.dataset.section = section;
    toggle.setAttribute('aria-controls', bodies[section]);
    node(section + '-section').querySelector = selector => selector === '[data-section]' ? toggle : node(section + '-bar');
    return toggle;
  });
  document.querySelector = () => app;
  document.querySelectorAll = selector => selector === '[data-section]' ? toggles : [];
  const railChildren = [];
  const rail = node('scm-rail');
  rail.contains = target => railChildren.includes(target);
  rail.querySelectorAll = () => railChildren;
  const calls = [];
  const context = {
    document, el: node, scmSplitRatio, scmPrimaryAction,
    setPanelContentVisible, panelMotionEnabled: () => false, animatePanelArrival() {},
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    loadHistory: () => calls.push('history'),
    savePreference: () => calls.push('save'),
    closeWorkbenchOverlays: () => calls.push('close overlays'),
  };
  return { node, app, railChildren, document, context, calls };
}

test('workspace folds sections and resizes the graph with pointer and keyboard events', async () => {
  const fixture = shellFixture();
  const script = await panelSection('panel-workspace.js');
  const { setupWorkspaceShell, restoreWorkspacePreferences } = runInNewContext(
    script + '\n({setupWorkspaceShell, restoreWorkspacePreferences})', fixture.context,
  );
  const { node, calls } = fixture;
  setupWorkspaceShell();
  restoreWorkspacePreferences({ collapsed: ['history'], split: 0.6 });
  assert.equal(node('history-scroll').hidden, true);
  assert.equal(node('scm-divider').hidden, true);
  assert.equal(node('history-toggle').getAttribute('aria-expanded'), 'false');
  node('history-toggle').onclick();
  assert.equal(node('history-scroll').hidden, false);
  assert.equal(node('scm-divider').hidden, false);
  assert.deepEqual(calls, ['history', 'save']);
  const divider = node('scm-divider');
  divider.listeners.keydown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(divider.getAttribute('aria-valuenow'), '65');
  divider.listeners.pointerdown({ button: 0, pointerId: 7, preventDefault() {} });
  divider.listeners.pointermove({ pointerId: 7, clientY: 290 });
  assert.equal(divider.getAttribute('aria-valuenow'), '50');
  divider.listeners.pointerup({ pointerId: 7, clientY: 600 });
  assert.equal(divider.getAttribute('aria-valuenow'), '80');
  assert.deepEqual(calls, ['history', 'save', 'save', 'save']);
});

test('narrow preview restores the original rail row and independent scroll positions', async () => {
  const fixture = shellFixture();
  const { node, app, document, railChildren, calls } = fixture;
  const script = await panelSection('panel-workspace.js');
  const { setupWorkspaceShell, showPreview } = runInNewContext(
    script + '\n({setupWorkspaceShell, showPreview})', fixture.context,
  );
  setupWorkspaceShell();
  const trigger = node('commit-file');
  trigger.dataset.focusKey = 'history-file:commit:test.txt';
  railChildren.push(trigger);
  trigger.focus();
  node('repository-list').scrollTop = 12;
  node('changes-body').scrollTop = 37;
  node('history-scroll').scrollTop = 132;
  node('history-scroll').scrollLeft = 9;
  showPreview();
  assert.equal(app.dataset.pane, 'preview');
  assert.equal(document.activeElement.id, 'preview-back');
  assert.deepEqual(calls, ['close overlays']);
  const replacement = node('rerendered-commit-file');
  replacement.dataset.focusKey = trigger.dataset.focusKey;
  railChildren[0] = replacement;
  node('history-scroll').scrollTop = 0;
  node('history-scroll').scrollLeft = 0;
  node('preview-back').onclick();
  assert.equal(app.dataset.pane, 'workspace');
  assert.equal(document.activeElement, replacement);
  assert.equal(node('repository-list').scrollTop, 12);
  assert.equal(node('changes-body').scrollTop, 37);
  assert.equal(node('history-scroll').scrollTop, 132);
  assert.equal(node('history-scroll').scrollLeft, 9);
});

test('commit shortcut routes only to commit while the main button follows sync status', async () => {
  const fixture = shellFixture();
  const calls = [];
  const status = { head: 'tip', branch: 'main', ahead: 1, behind: 0, hasRemote: true, upstream: 'origin/main',
    staged: [], untracked: [], unstaged: [], conflicts: [] };
  const state = { status };
  Object.assign(fixture.context, {
    state,
    initializeHistory() {}, setupWorkspaceShell() {},
    showCommands() {}, showChangesActions() {}, showCommitOptions() {},
    submitCommit: () => calls.push('commit'),
    runPrimaryAction: () => calls.push('primary'),
  });
  runInNewContext(await panelSection('panel-workbench.js') + '\ninitializeWorkbench();', fixture.context);
  const key = { key: 'Enter', metaKey: true, preventDefault() {} };
  fixture.node('commit-message').onkeydown(key);
  assert.deepEqual(calls, []);
  fixture.node('commit-form').onsubmit({ preventDefault() {} });
  assert.deepEqual(calls, ['primary']);
  status.staged.push({ path: 'changed' });
  fixture.node('commit-message').onkeydown(key);
  assert.deepEqual(calls, ['primary', 'commit']);
});
