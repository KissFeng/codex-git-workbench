import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildHistoryGraph, historyQuery, historyRefTags, matchingHistoryReferences } from '../plugins/source-control-proof/panel-graph.mjs';

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
  const one = { ref: 'refs/heads/main', name: 'main', current: true };
  const two = { ref: 'refs/remotes/team/main', name: 'team/main' };
  const three = { ref: 'refs/tags/main', name: 'main' };
  const data = { branches: [one, { ref: 'refs/heads/topic', name: 'topic' }], remoteBranches: [two], tags: [three] };
  assert.deepEqual(matchingHistoryReferences(data, ' MAIN ').map(group => group.items), [[one], [two], [three]]);
  assert.deepEqual(matchingHistoryReferences(data, 'refs/tags').map(group => group.items), [[three]]);
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

function historyPanel() {
  const nodes = new Map();
  const requests = [];
  const panel = {
    state: { checkout: '/first', epoch: 1, status: { checkout: '/first', head: 'H' } },
    workbench: { history: null, historyRequest: 0 },
    historyQuery,
    collapsed: false,
    isSectionCollapsed: () => panel.collapsed,
    callTool: (name, args) => new Promise((resolve, reject) => requests.push({ name, args, resolve, reject })),
    el: id => {
      if (!nodes.has(id)) {
        nodes.set(id, {
          scrollTop: 0, scrollLeft: 0, actions: [],
          setAttribute() {},
          set textContent(value) { this.message = value; this.actions = []; },
          append(_, action) { this.actions.push(action); },
        });
      }
      return nodes.get(id);
    },
    control: (label, click) => ({ label, click }),
  };
  runInNewContext(historyPanelSource, panel);
  panel.renderHistory = () => panel.renderHistoryStatus();
  return { panel, requests };
}

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
  assert.equal(panel.el('history-state').message, 'Network error.');

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

test('locate current commit requests later pages and focuses the commit within the graph scroller', async () => {
  const { panel, requests } = historyPanel();
  const scroller = panel.el('history-scroll');
  scroller.clientHeight = 100;
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 100 });
  const item = { dataset: {}, getBoundingClientRect: () => ({ top: 120, bottom: 148, height: 28 }) };
  let focused = false;
  panel.el('history-list').querySelector = selector => selector === '[data-focus-key="history:H"]' &&
    panel.workbench.history?.commits.some(commit => commit.id === 'H') ? {
      closest: () => item,
      focus: ({ preventScroll }) => { focused = preventScroll; },
    } : null;

  const locate = panel.locateCurrentHistory();
  requests[0].resolve({ commits: [commit('topic')], nextOffset: 1, cursor: 'first-page' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[1].args.cursor, 'first-page');
  requests[1].resolve({ commits: [commit('H')], nextOffset: null });
  await locate;

  assert.equal(item.dataset.located, 'true');
  assert.equal(focused, true);
  assert.equal(scroller.scrollTop, 84);
});
