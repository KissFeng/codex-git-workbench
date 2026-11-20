import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildHistoryGraph, historyQuery, historyRefTags, matchingHistoryReferences } from '../plugins/source-control-proof/panel-graph.mjs';
import { historyMessages } from '../plugins/source-control-proof/panel-messages-history.mjs';

const commit = (id, parents = [], refs = []) => ({ id, parents, refs, subject: id });
const merge = [commit('M', ['B', 'C', 'D']), commit('D', ['A']), commit('C', ['A']), commit('B', ['A']), commit('A')];

test('graph follows all parents of a merge and joins each incoming lane at their shared root', () => {
  const rows = buildHistoryGraph(merge, { head: 'M' });
  assert.equal(rows[0].kind, 'head');
  assert.deepEqual(rows[0].output.map(lane => lane.id), ['B', 'C', 'D']);
  assert.deepEqual(rows[0].segments.map(segment => segment.to), [[0, 2], [1, 2], [2, 2]]);
  assert.deepEqual(rows.at(-1).input.map(lane => lane.id), ['A', 'A', 'A']);
  assert.ok(rows.at(-1).segments.every(segment => segment.to[0] === rows.at(-1).lane));
  assert.deepEqual(rows.at(-1).output, []);
});

test('unrelated root commits leave pending lanes intact and later pages keep existing lanes', () => {
  const commits = [commit('L', ['A']), commit('island'), commit('R', ['A']), commit('A')];
  const first = buildHistoryGraph(commits.slice(0, 2), { head: 'L', upstream: 'R' });
  const complete = buildHistoryGraph(commits, { head: 'L', upstream: 'R' });
  assert.deepEqual(complete.slice(0, 2), first);
  assert.deepEqual(first[1].output, [{ id: 'A', color: 'current' }]);
  assert.deepEqual(first[1].segments, [{ from: [0, 0], to: [0, 2], color: 'current' }]);
  assert.equal(complete[2].color, 'upstream');
  assert.equal(complete[2].lane, 1);
});

test('divergence nodes connect to their own visible tips and compare merge base to tip', () => {
  const commits = [commit('topic', ['L']), commit('R', ['A']), commit('L', ['A']), commit('A')];
  const rows = buildHistoryGraph(commits, { head: 'L', upstream: 'R', ahead: 2, behind: 1, base: 'A' });
  assert.deepEqual(rows.map(row => row.kind), ['commit', 'incoming', 'upstream', 'outgoing', 'head', 'commit']);
  assert.deepEqual(rows[1].comparison, { from: 'A', to: 'R' });
  assert.deepEqual(rows[3].comparison, { from: 'A', to: 'L' });
  assert.equal(rows[1].count, 1);
  assert.equal(rows[3].count, 2);
  assert.equal(rows[3].lane, rows[4].lane);
  assert.deepEqual(rows[3].output, rows[4].input);
  assert.ok(rows[3].output.some(lane => lane.id === 'L'));
  assert.ok(rows[4].output.every(lane => lane.id !== 'L'));
  assert.equal(buildHistoryGraph(commits.slice(0, 2), { head: 'L', upstream: 'R', ahead: 3, behind: 1, base: 'A' }).some(row => row.kind === 'outgoing'), false);
  assert.equal(buildHistoryGraph(commits, { head: 'L', upstream: 'R', ahead: 2, behind: 1 }).some(row => row.comparison), false);
});

test('file history connects the visible rename-follow results, without synthetic divergence', () => {
  const rows = buildHistoryGraph([commit('D', ['C']), commit('A')], { path: 'file', head: 'D', upstream: 'A', ahead: 1, behind: 0, base: 'A' });
  assert.deepEqual(rows.map(row => row.kind), ['head', 'upstream']);
  assert.deepEqual(rows[0].output.map(lane => lane.id), ['A']);
});

test('graph query distinguishes all refs, current tips, selected full refs and file history', () => {
  assert.deepEqual(historyQuery('all', []), { scope: 'all' });
  assert.deepEqual(historyQuery('current', []), { scope: 'auto' });
  assert.deepEqual(historyQuery('selected', ['refs/tags/main', 'refs/heads/main', 'refs/tags/main']), {
    scope: 'auto', refs: ['refs/heads/main', 'refs/tags/main'],
  });
  assert.deepEqual(historyQuery('all', [], 'new/name', 'refs/heads/main'), {
    scope: 'auto', path: 'new/name', ref: 'refs/heads/main',
  });
});

test('reference filtering preserves grouped kinds and distinct full names', () => {
  const one = { ref: 'refs/heads/main', name: 'main', current: true, head: '2143f17abcdef' };
  const two = { ref: 'refs/remotes/team/main', name: 'team/main' };
  const three = { ref: 'refs/tags/main', name: 'main' };
  const data = { branches: [one, { ref: 'refs/heads/topic', name: 'topic' }], remoteBranches: [two], tags: [three] };
  assert.deepEqual(matchingHistoryReferences(data, ' MAIN ').map(group => group.items), [[one], [two], [three]]);
  assert.deepEqual(matchingHistoryReferences(data, 'refs/tags').map(group => group.items), [[three]]);
  assert.deepEqual(matchingHistoryReferences(data, '2143F17').map(group => group.items), [[one]]);
  assert.deepEqual(matchingHistoryReferences(data, 'missing'), []);
});

test('visible refs prioritize current branch and upstream and deduplicate tags', () => {
  const refs = [
    { name: 'v1', kind: 'tag' }, { name: 'main', kind: 'branch' }, { name: 'team/main', kind: 'remote' },
    { name: 'HEAD', kind: 'head' }, { name: 'topic', kind: 'branch' }, { name: 'v1', kind: 'tag' },
  ];
  assert.deepEqual(historyRefTags(refs, { branch: 'main', upstream: 'team/main' }).map(ref => ref.name), ['HEAD', 'main', 'team/main', 'topic', 'v1']);
});

const historyPanelSource = readFileSync(new URL('../plugins/source-control-proof/panel-history.js', import.meta.url), 'utf8');

function historyPanel({ renderRows = false } = {}) {
  const nodes = new Map();
  const requests = [];
  const bindings = new Map();
  const copied = [];
  let translate = key => key;
  const text = value => value?.key
    ? translate(value.key).replace(/\{(\w+)\}/g, (_, key) => text(value.params?.[key]))
    : String(value ?? '');
  function bind(node, name, value, write) {
    if (!bindings.has(node)) bindings.set(node, new Map());
    const update = () => write(text(value));
    if (value?.key) bindings.get(node).set(name, update);
    else bindings.get(node).delete(name);
    update();
  }
  function node() {
    return {
      value: '', scrollTop: 0, scrollLeft: 0, attrs: {}, children: [], dataset: {}, style: { setProperty() {} },
      setAttribute(name, value) { this.attrs[name] = String(value); },
      getAttribute(name) { return this.attrs[name] ?? null; },
      removeAttribute(name) { delete this.attrs[name]; },
      get textContent() { return this.children.map(child => child.textContent ?? child).join(''); },
      set textContent(value) { this.replaceChildren(value); },
      get firstChild() { return this.children[0]; },
      get actions() { return this.children.filter(child => child.click); },
      get isConnected() { return this.connected || this.parentNode?.isConnected || false; },
      contains(other) { return !!other && (this === other || this.contains(other.parentNode)); },
      append(...children) {
        for (const child of children) {
          if (child?.fragment) this.append(...child.children);
          else {
            if (typeof child === 'object') { child.remove(); child.parentNode = this; }
            this.children.push(child);
          }
        }
      },
      replaceChildren(...children) {
        for (const child of [...this.children]) child.remove?.();
        this.children = [];
        this.append(...children);
      },
      remove() {
        if (!this.parentNode) return;
        this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        this.parentNode = null;
      },
      addEventListener() {},
      focus() { panel.document.activeElement = this; },
      dispatchClick(target = this) {
        this.onclick?.({ target });
        this.parentNode?.dispatchClick(target);
      },
    };
  }
  const panel = {
    state: { checkout: '/first', epoch: 1, status: { checkout: '/first', head: 'H' } },
    workbench: { history: null, historyRequest: 0 },
    document: { createElementNS: node, createDocumentFragment: () => Object.assign(node(), { fragment: true }) },
    window: { matchMedia: () => ({ matches: true }) },
    buildHistoryGraph, historyQuery, historyRefTags, matchingHistoryReferences,
    collapsed: false,
    isSectionCollapsed: () => panel.collapsed,
    callTool: (name, args) => new Promise((resolve, reject) => requests.push({ name, args, resolve, reject })),
    el: id => {
      if (!nodes.has(id)) nodes.set(id, Object.assign(node(), { connected: true }));
      return nodes.get(id);
    },
    msg: (key, params) => ({ key, params }),
    uiText: (node, value) => bind(node, 'textContent', value, text => { node.textContent = text; }),
    uiAttr: (node, name, value) => bind(node, name, value, text => node.setAttribute(name, text)),
    element: (tagName, className, value) => {
      const element = Object.assign(node(), { tagName, className });
      if (value !== undefined) panel.uiText(element, value);
      return element;
    },
    control: (label, onclick, className = 'sc-control') => Object.assign(panel.element('button', className, label), { onclick, click: onclick }),
    icon: node,
    bindTooltip: (anchor, content, options) => { anchor.tooltip = content; anchor.tooltipOptions = options; },
    bindContextMenu() {},
    copyText: value => copied.push(value),
  };
  runInNewContext(historyPanelSource, panel);
  if (!renderRows) panel.renderHistory = () => panel.renderHistoryStatus();
  function setLanguage(messages) {
    translate = key => messages[key] ?? key;
    for (const properties of bindings.values()) for (const update of properties.values()) update();
  }
  return { panel, requests, setLanguage, copied };
}

function showHistoryRows(panel) {
  panel.workbench.history = { commits: [commit('H', ['A']), commit('A')], head: 'H' };
  panel.renderHistory();
  return panel.el('history-list').children;
}

test('the history row and chevron toggle changed files without replacing other rows', async () => {
  const { panel, requests } = historyPanel({ renderRows: true });
  const [entry, other] = showHistoryRows(panel);
  const item = entry.firstChild;
  const [chevron, subject] = item.children;
  const scroller = panel.el('history-scroll');
  scroller.scrollTop = 34;
  subject.focus();

  subject.dispatchClick();
  assert.equal(chevron.getAttribute('aria-expanded'), 'true');
  assert.match(entry.textContent, /Loading changed files/);
  assert.equal(requests[0].name, 'git_history_detail');
  assert.equal(panel.el('history-list').children[1], other);

  subject.dispatchClick();
  assert.equal(chevron.getAttribute('aria-expanded'), 'false');
  assert.equal(entry.children.length, 1);
  requests[0].resolve({ files: [{ path: 'README.md', status: 'M' }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entry.children.length, 1);
  assert.equal(panel.document.activeElement, subject);
  assert.equal(scroller.scrollTop, 34);

  chevron.dispatchClick();
  assert.match(entry.textContent, /README\.md/);
  assert.equal(requests.length, 1);
  item.dispatchClick();
  assert.equal(chevron.getAttribute('aria-expanded'), 'false');
  assert.equal(entry.children.length, 1);

  other.firstChild.children[1].dispatchClick();
  assert.equal(subject.getAttribute('aria-pressed'), 'false');
  assert.equal(other.firstChild.children[1].getAttribute('aria-pressed'), 'true');
  requests[1].resolve({ files: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(other.textContent, /No changed files/);
  assert.equal(panel.el('history-list').firstChild, entry);
});

test('commit statistics load on tooltip creation, share a request and localize the counts', async () => {
  const { panel, requests, setLanguage } = historyPanel({ renderRows: true });
  const [entry] = showHistoryRows(panel);
  const [, subject] = entry.firstChild.children;
  assert.equal(requests.length, 0);
  const tooltip = subject.tooltip();
  const active = subject.tooltip();
  panel.el('overlays').append(active);
  assert.deepEqual(requests.map(({ name, args }) => [name, { ...args }]), [
    ['git_history_stats', { repoPath: '/first', commit: 'H' }],
  ]);
  requests[0].resolve({ additions: 15, deletions: 0, binaryFiles: 2 });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(active.textContent, /\+15 lines added.*−0 lines deleted.*2 binary files/);
  assert.doesNotMatch(tooltip.textContent, /\+15/);

  setLanguage(historyMessages);
  assert.match(active.textContent, /\+15 行新增.*−0 行删除.*2 个二进制文件/);
  const cached = subject.tooltip();
  panel.el('overlays').append(cached);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(cached.textContent, /\+15 行新增/);
  assert.equal(requests.length, 1);
});

test('the side card shows the message body and copies the full commit hash', async () => {
  const { panel, requests, setLanguage, copied } = historyPanel({ renderRows: true });
  const id = '0123456789abcdef0123456789abcdef01234567';
  panel.workbench.history = { commits: [commit(id)], head: id };
  panel.renderHistory();
  const [, subject] = panel.el('history-list').firstChild.firstChild.children;
  assert.equal(subject.tooltipOptions.interactive, true);
  assert.equal(subject.tooltipOptions.placement, 'side');
  const tooltip = subject.tooltip();
  panel.el('overlays').append(tooltip);

  requests[0].resolve({ additions: 4, deletions: 1, binaryFiles: 0, filesChanged: 2, message: 'Details\n\n<body text>' });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(tooltip.textContent, /Details\n\n<body text>/);
  assert.match(tooltip.textContent, /2 files changed/);
  const footer = tooltip.children.at(-1);
  assert.equal(footer.firstChild.textContent, '01234567');
  const copy = footer.actions[0];
  assert.equal(copy.getAttribute('aria-label'), 'Copy commit hash');
  setLanguage(historyMessages);
  assert.equal(copy.getAttribute('aria-label'), '复制提交哈希');
  copy.dispatchClick();
  assert.deepEqual(copied, [id]);
});

test('synthetic comparison rows preserve comparison and skip commit statistics', () => {
  const { panel, requests } = historyPanel({ renderRows: true });
  let comparison;
  panel.openCompare = args => { comparison = { ...args }; };
  panel.workbench.history = { commits: [commit('R', ['A']), commit('H', ['A']), commit('A')], head: 'H', upstream: 'R', ahead: 1, behind: 0, base: 'A' };
  panel.renderHistory();
  const outgoing = panel.el('history-list').children[1].firstChild;
  const subject = outgoing.firstChild;
  assert.equal(outgoing.dataset.kind, 'outgoing');
  assert.equal(subject.tooltipOptions, undefined);
  assert.match(subject.tooltip().textContent, /Outgoing changes/);
  subject.dispatchClick();
  assert.deepEqual(comparison, { from: 'A', to: 'H' });
  assert.equal(requests.length, 0);
});

test('tooltip stats ignore an old checkout and let the next hover retry a failed request', async () => {
  const { panel, requests } = historyPanel({ renderRows: true });
  const [entry] = showHistoryRows(panel);
  const outdated = entry.firstChild.children[1].tooltip();
  panel.el('overlays').append(outdated);

  panel.state.epoch++;
  panel.state.checkout = '/second';
  panel.state.status = { checkout: '/second', head: 'H' };
  panel.resetHistoryCheckout();
  const [nextEntry] = showHistoryRows(panel);
  const subject = nextEntry.firstChild.children[1];
  const failed = subject.tooltip();
  panel.el('overlays').append(failed);
  assert.equal(requests[1].args.repoPath, '/second');
  requests[0].resolve({ additions: 20, deletions: 0, binaryFiles: 0 });
  requests[1].reject(new Error('unavailable'));
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(outdated.textContent, /\+20/);
  assert.match(failed.textContent, /Line counts unavailable/);

  const retried = subject.tooltip();
  panel.el('overlays').append(retried);
  requests[2].resolve({ additions: 0, deletions: 1, binaryFiles: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(retried.textContent, /\+0 lines added.*−1 line deleted/);
});

test('history translates loading and reference controls while keeping Git errors verbatim', async () => {
  const { panel, requests, setLanguage } = historyPanel();
  const status = panel.el('history-state');
  const loading = panel.loadHistory();
  assert.equal(status.textContent, 'Loading commits…');

  setLanguage(historyMessages);
  assert.equal(panel.el('history-heading').textContent, '提交图');
  assert.equal(panel.el('history-refs').textContent, '全部');
  assert.equal(panel.el('history-refs').getAttribute('aria-label'), '提交图引用 · 所有引用');
  assert.equal(status.textContent, '正在加载提交…');

  requests[0].reject(new Error('fatal: invalid object name'));
  assert.equal(await loading, false);
  assert.equal(status.firstChild.textContent, 'fatal: invalid object name');
  const retry = status.actions[0];
  assert.equal(retry.textContent, '重试');

  setLanguage({});
  assert.equal(status.firstChild.textContent, 'fatal: invalid object name');
  assert.equal(status.actions[0], retry);
  assert.equal(retry.textContent, 'Retry');
});

test('history only loads while expanded and ignores a page from the previous checkout', async () => {
  const { panel, requests } = historyPanel();
  panel.collapsed = true;
  assert.equal(panel.loadHistory(), undefined);
  assert.equal(requests.length, 0);
  panel.collapsed = false;
  const outdated = panel.loadHistory();
  assert.equal(requests[0].args.scope, 'all');

  panel.state.epoch++;
  panel.state.checkout = '/second';
  panel.state.status = { checkout: '/second', head: 'J' };
  panel.resetHistoryCheckout();
  const fresh = panel.loadHistory();
  requests[1].resolve({ commits: [commit('J')] });
  assert.equal(await fresh, true);
  requests[0].resolve({ commits: [commit('H')] });
  assert.equal(await outdated, undefined);
  assert.equal(panel.workbench.history.commits[0].id, 'J');
});

test('an explicit refresh replaces an in-flight snapshot even when HEAD has not moved', async () => {
  const { panel, requests } = historyPanel();
  const outdated = panel.loadHistory();
  const refreshed = panel.loadHistory({ reset: true });
  assert.equal(requests.length, 2);
  requests[0].resolve({ commits: [commit('before-fetch')] });
  assert.equal(await outdated, undefined);
  requests[1].resolve({ commits: [commit('after-fetch')] });
  assert.equal(await refreshed, true);
  assert.equal(panel.workbench.history.commits[0].id, 'after-fetch');
});

test('paging uses the existing cursor, keeps loaded commits on failure and reloads an expired cursor', async () => {
  const { panel, requests } = historyPanel();
  const first = panel.loadHistory();
  requests[0].resolve({ commits: [commit('H')], nextOffset: 1, cursor: 'first-page' });
  await first;

  const next = panel.loadHistory({ more: true });
  assert.equal(requests[1].args.offset, 1);
  assert.equal(requests[1].args.cursor, 'first-page');
  requests[1].reject(new Error('Network error.'));
  assert.equal(await next, false);
  assert.equal(panel.workbench.history.commits[0].id, 'H');
  assert.equal(panel.el('history-state').firstChild.textContent, 'Network error.');

  const retry = panel.el('history-state').actions[0].click();
  assert.equal(requests[2].args.cursor, 'first-page');
  requests[2].reject(new Error('Invalid Git history cursor.'));
  assert.equal(await retry, false);

  const restart = panel.el('history-state').actions[0].click();
  assert.equal(requests[3].args.cursor, undefined);
  requests[3].resolve({ commits: [commit('J')] });
  await restart;
  assert.equal(panel.workbench.history.commits[0].id, 'J');
});

test('reference picker opens with searchable grouped refs and applies a selection only on confirmation', async () => {
  const { panel, requests } = historyPanel();
  const dialog = panel.el('action-dialog');
  dialog.close = () => { dialog.open = false; };
  panel.openAction = (_, form) => { dialog.replaceChildren(form); dialog.open = true; };
  panel.readReferences = async () => ({
    branches: [{ name: 'main', ref: 'refs/heads/main', head: '2143f17abcdef' }],
    remoteBranches: [{ name: 'origin/HEAD', ref: 'refs/remotes/origin/HEAD', head: '2143f17abcdef' }],
    tags: [{ name: 'v1', ref: 'refs/tags/v1', head: '2143f17abcdef' }],
  });
  panel.setSectionCollapsed = () => {};
  panel.chooseHistoryReferences();
  await new Promise(resolve => setImmediate(resolve));
  const form = dialog.firstChild;
  const [toolbar, modes, results] = form.children;
  const [searchBox, confirm] = toolbar.children;
  const [search, count] = searchBox.children;
  const [, all, automatic] = modes.children;
  assert.equal(panel.document.activeElement, search);
  assert.equal(all.firstChild.checked, true);
  assert.equal(automatic.firstChild.checked, false);
  assert.equal(count.textContent, '1 selected');
  assert.match(results.textContent, /Local branches.*main2143f17.*Remote branches.*origin\/HEAD2143f17.*Tags.*v1/);
  const select = (input, checked = true) => { input.checked = checked; input.onchange(); };
  select(results.children[0].children[1].firstChild);
  assert.equal(all.firstChild.checked, false);
  search.value = 'origin/';
  search.oninput();
  assert.equal(results.children.length, 1);
  select(results.firstChild.children[1].firstChild);
  assert.equal(count.textContent, '2 selected');
  select(automatic.firstChild);
  assert.equal(count.textContent, '1 selected');
  assert.equal(results.firstChild.children[1].firstChild.checked, false);
  select(automatic.firstChild, false);
  assert.equal(confirm.disabled, true);
  select(results.firstChild.children[1].firstChild);
  assert.equal(requests.length, 0);
  form.onsubmit({ preventDefault() {} });
  assert.equal(dialog.open, false);
  assert.deepEqual([...requests[0].args.refs], ['refs/remotes/origin/HEAD']);
  requests[0].resolve({ commits: [] });
});
