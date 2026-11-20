import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setPanelContentVisible } from '../plugins/source-control-proof/panel-motion.mjs';
import { buildFileTree, scmPrimaryAction, scmSplitRatio } from '../plugins/source-control-proof/panel-model.mjs';

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

function element(tagName) {
  return {
    tagName, dataset: {}, children: [], classList: { add() {} },
    get childElementCount() { return this.children.length; },
    setAttribute() {}, contains: () => false,
    append(...children) { this.children.push(...children); },
    prepend(child) { this.children.unshift(child); },
    replaceChildren(fragment) { this.children = fragment.children; },
  };
}

test('repository sync is visible only when the current branch is ahead or behind', async () => {
  const list = element('div');
  const checkout = '/repo';
  const status = { branch: 'main', upstream: 'origin/main', hasRemote: true, ahead: 0, behind: 0 };
  const textElement = (tagName, _, textContent) => Object.assign(element(tagName), { textContent });
  const context = {
    state: { projects: [], checkout, status }, expandedProjects: new Set(),
    matchMedia: () => ({ matches: false }),
    document: { createDocumentFragment: () => element('fragment') },
    el: () => list, element: textElement, control: label => textElement('button', '', label),
    icon: () => element('svg'), msg: key => key, uiAttr() {},
    bindTooltip() {}, bindContextMenu() {}, restoreRailFocus() {},
  };
  const renderRepositories = runInNewContext(await panelSection('panel-workspace.js') + '\nrenderRepositories', context);
  const syncCount = () => {
    renderRepositories();
    const button = list.children[0].children.find(node => node.dataset.focusKey === 'sync:' + checkout);
    return button?.children.at(-1).textContent;
  };
  assert.equal(syncCount(), undefined);
  status.ahead = 1;
  assert.equal(syncCount(), '0↓ 1↑');
  status.ahead = 0;
  status.behind = 2;
  assert.equal(syncCount(), '2↓ 0↑');
  status.behind = 0;
  assert.equal(syncCount(), undefined);
  status.ahead = status.behind = null;
  assert.equal(syncCount(), undefined);
});

test('tracked and new working files share one changes group and retain their Git operations', async () => {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, element(id));
    return nodes.get(id);
  };
  const actions = [];
  const context = {
    document: {
      createElement: element, createElementNS: (_, tag) => element(tag),
      createDocumentFragment: () => element('fragment'), getElementById: node,
    },
    buildFileTree, msg: key => key,
    uiText: (node, text) => { node.textContent = text; },
    bindTooltip() {}, restoreRailFocus() {}, renderRepositories() {},
    bindContextMenu: (node, entries) => { node.menu = entries; },
    repositoryButton: (label, symbol, onclick) => Object.assign(element('button'), { label, symbol, onclick }),
  };
  const sources = await Promise.all(['panel.js', 'panel-workbench.js'].map(panelSection));
  const [panel] = sources[0].split(/^window.addEventListener\('message'/m);
  const { status, tree } = runInNewContext(sources[1] + '\n' + panel + `
    renderPicker = repositoryStatusChanged = savePreference = () => {};
    ({ status: renderStatus, tree: value => { workbench.tree = value; renderFiles(); } })
  `, context);
  context.performAction = (tool, args) => actions.push([tool, { ...args }]);
  context.actionForm = (_, fields, submit) => submit({}, true);
  const tracked = { path: 'src/a.js', status: 'MM', change: 'M' };
  const untracked = { path: 'src/b.js', status: '??' };
  const snapshot = { checkout: '/repo', unstaged: [tracked], untracked: [untracked], staged: [tracked], conflicts: [] };
  status(snapshot);
  const groups = node('files').children;
  assert.deepEqual(groups.map(group => group.children[0].children[0].children[1].textContent), ['Staged Changes', 'Changes']);
  assert.equal(node('total-count').textContent, 2);
  const [heading, list] = groups[1].children;
  const [trackedRow, untrackedRow] = list.children;
  assert.equal(heading.children[1].children[0].textContent, 2);
  assert.deepEqual([trackedRow, untrackedRow].map(row => [row.children[0].dataset.group, row.children[2].textContent]), [
    ['unstaged', 'M'], ['untracked', 'U'],
  ]);
  heading.children[1].children[1].onclick();
  assert.deepEqual(actions.shift(), ['git_change', { action: 'stage' }]);
  assert.equal(heading.children[1].children.length, 3);
  heading.children[1].children[2].onclick();
  const [tool, discard] = actions.shift();
  assert.equal(tool, 'git_change');
  assert.equal(discard.group, 'unstaged');
  assert.deepEqual([...discard.expectedPaths], [tracked.path]);
  const remove = heading.menu().find(entry => entry.label === 'Remove untracked files');
  remove.run();
  assert.equal(actions[0][1].group, 'untracked');
  assert.deepEqual([...actions[0][1].expectedPaths], [untracked.path]);
  tree(true);
  assert.equal(node('files').children[1].children[1].childElementCount, 1);
  assert.equal(node('files').children[1].children[1].children[0].children[1].childElementCount, 2);
  status({ ...snapshot, untracked: [] });
  assert.equal(node('total-count').textContent, 1);
  assert.equal(node('files').children[1].children[1].children[0].children[1].childElementCount, 1);
  status({ ...snapshot, unstaged: [], staged: [] });
  assert.equal(node('files').childElementCount, 1);
  assert.equal(node('files').children[0].children[0].children[1].children[2].label, 'Remove untracked files');
});
