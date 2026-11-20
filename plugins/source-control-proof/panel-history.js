const commitGraph = {
  scope: 'all', refs: [], expanded: new Set(), details: new Map(), loading: null,
  error: null, notice: '', locating: null, located: null, referencePicker: null,
};
const historyScopeLabels = {
  all: 'All references', current: 'Current branch and upstream', selected: 'Selected references',
};

function resetHistoryCheckout() {
  workbench.historyRequest++;
  workbench.history = null;
  workbench.historyKey = '';
  workbench.historyRef = null;
  workbench.historyPath = null;
  workbench.historySelection = null;
  commitGraph.scope = 'all';
  commitGraph.refs = [];
  commitGraph.expanded.clear();
  commitGraph.details.clear();
  commitGraph.loading = null;
  commitGraph.error = null;
  commitGraph.notice = '';
  commitGraph.locating = null;
  commitGraph.located = null;
  if (commitGraph.referencePicker?.isConnected) el('action-dialog').close();
  commitGraph.referencePicker = null;
  el('history-scroll').scrollTop = 0;
  el('history-scroll').scrollLeft = 0;
  renderHistory();
}

function activeHistoryQuery() {
  return historyQuery(commitGraph.scope, commitGraph.refs, workbench.historyPath, workbench.historyRef);
}

function historyRequestKey(query = activeHistoryQuery()) {
  const { checkout, branch, head, upstream, ahead, behind } = state.status;
  return JSON.stringify([checkout, branch, head, upstream, ahead, behind, query]);
}

function loadHistory({ reset = false, more = false } = {}) {
  if (!state.status || isSectionCollapsed('history')) return;
  const query = activeHistoryQuery();
  const key = historyRequestKey(query);
  const previous = workbench.history;
  if (!reset && commitGraph.loading?.key === key) return commitGraph.loading.promise;
  if (more && (key !== workbench.historyKey || !previous?.cursor || previous.nextOffset == null)) return;
  if (!reset && !more && key === workbench.historyKey) return;

  const token = ++workbench.historyRequest;
  const { checkout } = state.status;
  const { epoch } = state;
  const ownsRequest = () => token === workbench.historyRequest && epoch === state.epoch;
  const current = () => ownsRequest() && state.status && key === historyRequestKey();
  const loading = { key, more };
  commitGraph.loading = loading;
  commitGraph.error = null;
  commitGraph.notice = '';
  renderHistoryStatus();
  loading.promise = (async () => {
    try {
      const result = await callTool('git_history', {
        repoPath: checkout, limit: 40, ...query,
        ...(more ? { offset: previous.nextOffset, cursor: previous.cursor } : {}),
      });
      if (!current()) return;
      if (commitGraph.located !== result.head) commitGraph.located = null;
      workbench.history = { ...result, commits: [...(more ? previous.commits : []), ...result.commits] };
      workbench.historyKey = key;
      renderHistory();
      return true;
    } catch (error) {
      if (!current()) return;
      commitGraph.error = { message: error.message, more: more && error.message !== 'Invalid Git history cursor.' };
      return false;
    } finally {
      if (ownsRequest()) {
        commitGraph.loading = null;
        renderHistoryStatus();
      }
    }
  })();
  return loading.promise;
}

function applyHistoryFilter(scope, refs, path = null, ref = null) {
  commitGraph.scope = scope;
  commitGraph.refs = refs;
  commitGraph.error = null;
  commitGraph.notice = '';
  commitGraph.located = null;
  commitGraph.locating = null;
  commitGraph.loading = null;
  commitGraph.expanded.clear();
  workbench.historyRequest++;
  workbench.historyPath = path;
  workbench.historyRef = ref;
  workbench.history = null;
  workbench.historyKey = '';
  el('history-scroll').scrollTop = 0;
  el('history-scroll').scrollLeft = 0;
  setSectionCollapsed('history', false);
  renderHistory();
  return loadHistory();
}

function filterHistory(ref, path) {
  if (path) return applyHistoryFilter(commitGraph.scope, commitGraph.refs, path, ref);
  return applyHistoryFilter(ref ? 'selected' : 'all', ref ? [ref] : []);
}

function chooseHistoryReferences() {
  if (!state.status) return;
  const form = element('form', 'sc-history-reference-form');
  const modes = element('fieldset', 'sc-history-reference-modes');
  modes.append(element('legend', '', 'History scope'));
  const filters = element('div', 'sc-history-reference-filter');
  const search = element('input', 'sc-input');
  search.type = 'search';
  search.placeholder = 'Search branches and tags';
  search.setAttribute('aria-label', search.placeholder);
  const results = element('div', 'sc-history-reference-results');
  const selected = new Set(commitGraph.refs);
  const selectionCount = element('span', 'sc-muted');
  const actions = element('div', 'sc-actions sc-dialog-buttons');
  const submit = element('button', 'sc-primary', 'Apply');
  submit.type = 'submit';
  let scope = commitGraph.scope;
  let references = null;
  let referenceError = false;
  let referenceLoading = false;

  function updateSelection() {
    submit.disabled = scope === 'selected' && !selected.size;
    selectionCount.hidden = scope !== 'selected';
    selectionCount.textContent = selected.size + ' selected';
  }

  for (const [value, label] of Object.entries(historyScopeLabels)) {
    const option = element('label', 'sc-history-reference-choice');
    const input = element('input');
    input.type = 'radio';
    input.name = 'history-scope';
    input.value = value;
    input.checked = value === scope;
    input.onchange = () => {
      scope = value;
      filters.hidden = value !== 'selected';
      updateSelection();
      if (value === 'selected' && !references && !referenceError) requestReferences();
    };
    option.append(input, element('span', '', label));
    modes.append(option);
  }

  function renderMatches() {
    results.replaceChildren();
    if (!references) {
      const message = referenceError ? 'References could not be loaded.' : 'Loading references…';
      results.append(element('p', 'sc-muted', message));
      if (referenceError) results.append(control('Retry', requestReferences));
      return;
    }
    const groups = matchingHistoryReferences(references, search.value);
    if (!groups.length) results.append(element('p', 'sc-muted', 'No matching references.'));
    for (const { label, items } of groups) {
      const group = element('fieldset', 'sc-history-reference-group');
      group.append(element('legend', '', label));
      for (const item of items) {
        const option = element('label', 'sc-history-reference-choice');
        const input = element('input');
        input.type = 'checkbox';
        input.checked = selected.has(item.ref);
        input.onchange = () => {
          if (input.checked) selected.add(item.ref);
          else selected.delete(item.ref);
          updateSelection();
        };
        const name = element('span', '', item.name);
        option.append(input, name);
        if (item.current) option.append(element('span', 'sc-muted', 'Current'));
        group.append(option);
      }
      results.append(group);
    }
    results.scrollTop = 0;
  }

  async function requestReferences() {
    if (referenceLoading) return;
    referenceLoading = true;
    referenceError = false;
    renderMatches();
    references = await readReferences();
    referenceLoading = false;
    if (!form.isConnected || !el('action-dialog').open) return;
    referenceError = !references;
    renderMatches();
  }

  form.onsubmit = event => {
    event.preventDefault();
    if (submit.disabled) return;
    el('action-dialog').close();
    applyHistoryFilter(scope, [...selected]);
  };
  filters.hidden = scope !== 'selected';
  search.oninput = renderMatches;
  filters.append(search, results);
  actions.append(selectionCount, control('Cancel', () => el('action-dialog').close()), submit);
  form.append(modes, filters, actions);
  updateSelection();
  commitGraph.referencePicker = form;
  openAction('Graph references', form);
  (filters.hidden ? modes.querySelector(':checked') : search)?.focus();
  if (!filters.hidden) requestReferences();
}

function graphSvg(tag, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

const historyNodeX = lane => 7 + lane * 11;
const historyGraphWidth = columns => columns * 11 + 3;

function historyGraphMark(row) {
  const width = historyGraphWidth(row.columns);
  const svg = graphSvg('svg', { class: 'sc-history-graph', viewBox: `0 0 ${width} 28`, width, height: 28, 'aria-hidden': 'true' });
  for (const { from, to, color } of row.segments) {
    const [x1, y1, x2, y2] = [historyNodeX(from[0]), from[1] * 14, historyNodeX(to[0]), to[1] * 14];
    const middle = (y1 + y2) / 2;
    const d = x1 === x2 ? `M ${x1} ${y1} V ${y2}` : `M ${x1} ${y1} C ${x1} ${middle} ${x2} ${middle} ${x2} ${y2}`;
    svg.append(graphSvg('path', { d, class: `sc-history-graph-edge sc-history-color-${color}` }));
  }
  const cx = historyNodeX(row.lane);
  const isTip = row.kind === 'head' || row.kind === 'upstream';
  const radius = row.comparison || isTip ? 5 : row.commit.parents.length > 1 ? 4 : 3;
  svg.append(graphSvg('circle', { cx, cy: 14, r: radius, class: `sc-history-graph-node sc-history-color-${row.color}`, 'data-kind': row.kind }));
  if (isTip) svg.append(graphSvg('circle', { cx, cy: 14, r: 1.8, class: `sc-history-graph-center sc-history-color-${row.color}` }));
  return svg;
}

function historyGraphThread(row) {
  const svg = graphSvg('svg', {
    class: 'sc-history-thread', viewBox: `0 0 ${historyGraphWidth(row.columns)} 1`, preserveAspectRatio: 'none', 'aria-hidden': 'true',
  });
  for (const [index, lane] of row.output.entries()) {
    const x = historyNodeX(index);
    svg.append(graphSvg('path', { d: `M ${x} 0 V 1`, class: `sc-history-graph-edge sc-history-color-${lane.color}`, 'vector-effect': 'non-scaling-stroke' }));
  }
  return svg;
}

function historyRowDetails(row, refs, label) {
  const content = element('div', 'sc-history-tooltip');
  content.append(element('strong', '', label));
  if (row.comparison) {
    const branch = row.kind === 'outgoing' ? state.status.branch : state.status.upstream;
    content.append(element('span', '', (branch || 'HEAD') + ' · ' + row.count + (row.count === 1 ? ' commit' : ' commits')));
    content.append(element('code', '', `${row.comparison.from.slice(0, 8)} → ${row.comparison.to.slice(0, 8)}`));
  } else {
    const { author, date, id, relation } = row.commit;
    const relationText = relation === 'ahead' ? 'Outgoing' : relation === 'behind' ? 'Incoming' : '';
    content.append(element('span', '', [author, date ? new Date(date).toLocaleString() : '', relationText].filter(Boolean).join(' · ')));
    content.append(element('code', '', id));
    if (refs.length) {
      const badges = element('div', 'sc-history-tooltip-refs');
      badges.append(...refs.map(ref => element('span', `sc-ref sc-ref-${ref.kind}`, ref.name)));
      content.append(badges);
    }
  }
  return content;
}

async function readHistoryCommit(commit) {
  let entry = commitGraph.details.get(commit);
  if (entry?.pending || entry?.result) return entry.pending || entry.result;
  const { epoch, checkout } = state;
  entry = {};
  commitGraph.details.set(commit, entry);
  entry.pending = (async () => {
    try {
      const result = await callTool('git_history_detail', { repoPath: checkout, commit });
      if (epoch !== state.epoch) return;
      entry.result = result;
      return result;
    } catch (error) {
      if (epoch === state.epoch) entry.error = error.message;
    } finally {
      if (epoch === state.epoch) {
        delete entry.pending;
        if (commitGraph.expanded.has(commit)) renderHistory();
      }
    }
  })();
  if (commitGraph.expanded.has(commit)) renderHistory();
  return entry.pending;
}

function toggleHistoryFiles(commit) {
  if (commitGraph.expanded.delete(commit)) {
    renderHistory();
    return;
  }
  commitGraph.expanded.add(commit);
  if (commitGraph.details.has(commit)) renderHistory();
  else readHistoryCommit(commit);
}

function renderHistoryFiles(row) {
  const { id } = row;
  const files = element('div', 'sc-history-files');
  files.id = 'history-files-' + id;
  files.append(historyGraphThread(row));
  const entry = commitGraph.details.get(id);
  if (!entry || entry.pending) {
    files.append(element('span', 'sc-muted', 'Loading changed files…'));
    return files;
  }
  if (entry.error) {
    const retry = control('Retry', () => void readHistoryCommit(id));
    retry.dataset.focusKey = 'history-retry:' + id;
    files.append(element('span', 'sc-muted', entry.error), retry);
    return files;
  }
  for (const file of entry.result.files) {
    const button = control('', () => openCommit(id, file.path), 'sc-detail-file sc-history-file');
    button.dataset.focusKey = JSON.stringify(['history-file', id, file.path]);
    const status = element('span', 'sc-file-status', file.status);
    status.dataset.status = file.status;
    const path = file.originalPath ? `${file.originalPath} → ${file.path}` : file.path;
    button.append(status, element('span', 'sc-history-file-path', path));
    bindTooltip(button, path);
    bindContextMenu(button, () => [
      { label: 'Open file diff', run: () => openCommit(id, file.path) },
      { label: 'Copy file path', run: () => copyText(file.path) },
    ]);
    files.append(button);
  }
  if (!entry.result.files.length) files.append(element('span', 'sc-muted', 'No changed files.'));
  if (entry.result.filesTruncated) files.append(element('span', 'sc-muted', 'Additional files omitted.'));
  return files;
}

function historyRowActions(row) {
  if (row.comparison) return [{ label: 'Compare changes', run: () => openCompare(row.comparison) }];
  const { id, parents } = row.commit;
  const viewing = workbench.historyPath;
  const busy = !!workbench.busy || !!state.staging;
  const head = state.status?.head;
  return [
    { label: 'Open commit details', run: () => openCommit(id) },
    { label: commitGraph.expanded.has(id) ? 'Collapse changed files' : 'Expand changed files', run: () => toggleHistoryFiles(id) },
    { label: 'Copy commit hash', run: () => copyText(id) },
    { label: 'Copy commit message', run: async () => {
      const result = await readHistoryCommit(id);
      if (result) copyText(result.message);
      else if (commitGraph.details.get(id)?.error) showError(commitGraph.details.get(id).error);
    } },
    { separator: true },
    { label: 'Compare with parent', disabled: !parents.length, run: () => openCompare({ from: parents[0], to: id, ...(viewing ? { path: viewing } : {}) }) },
    { label: 'Compare with HEAD', disabled: !head || head === id, run: () => openCompare({ from: id, to: head }) },
    { label: 'Compare with working copy', run: () => openCompare({ from: id }) },
    { separator: true },
    { label: 'Create branch here…', disabled: busy, run: () => runCommand('createBranch', { startPoint: id }, [
      field('name', 'Branch name'), field('checkout', 'Switch to this branch', { checkbox: true, value: true }),
    ]) },
    { label: 'Create tag here…', disabled: busy, run: () => runCommand('createTag', { ref: id }, [
      field('name', 'Tag name'), field('message', 'Annotation', { optional: true }),
    ]) },
    { label: 'Checkout detached', disabled: busy || (state.status?.detached && head === id), run: () => runCommand('checkoutDetached', { ref: id }) },
    { label: 'Cherry-pick', disabled: busy || parents.length > 1, run: () => runCommand('cherryPick', { ref: id }) },
  ];
}

function historyRow(row) {
  const { id, commit, comparison, kind } = row;
  const expanded = commitGraph.expanded.has(id);
  const label = comparison ? (kind === 'incoming' ? 'Incoming changes' : 'Outgoing changes') : commit.subject || '(empty subject)';
  const entry = element('div', 'sc-history-entry');
  const item = element('div', 'sc-history-item');
  item.dataset.kind = kind;
  item.dataset.located = String(commitGraph.located === id);
  item.style.setProperty('--history-graph-width', historyGraphWidth(row.columns) + 'px');
  const button = control('', () => {
    if (comparison) return openCompare(comparison);
    workbench.historySelection = { commit: id, path: workbench.historyPath };
    if (!commitGraph.expanded.has(id)) toggleHistoryFiles(id);
    else renderHistory();
  }, 'sc-history-commit');
  button.dataset.focusKey = 'history:' + id;
  if (!comparison) {
    button.setAttribute('aria-pressed', String(workbench.historySelection?.commit === id));
    const toggle = control('', () => toggleHistoryFiles(id), 'sc-history-expand');
    toggle.dataset.focusKey = 'history-expand:' + id;
    toggle.setAttribute('aria-expanded', String(expanded));
    if (expanded) toggle.setAttribute('aria-controls', 'history-files-' + id);
    toggle.setAttribute('aria-label', (expanded ? 'Collapse' : 'Expand') + ' changed files for ' + label.slice(0, 100));
    toggle.append(icon('chevron'));
    item.append(toggle);
  }
  button.append(historyGraphMark(row), element('span', 'sc-history-subject', label));
  if (commit?.author) button.append(element('span', 'sc-history-author', commit.author));
  const refs = commit ? historyRefTags(commit.refs, state.status) : [];
  const attachedHead = !state.status?.detached && refs.some(ref => ref.kind === 'branch' && ref.name === state.status?.branch);
  const badgesToShow = attachedHead ? refs.filter(ref => ref.kind !== 'head') : refs;
  if (comparison) button.append(element('span', 'sc-history-ref-count', String(row.count)));
  else if (badgesToShow.length) {
    const badges = element('span', 'sc-history-badges');
    for (const ref of badgesToShow.slice(0, 2)) {
      const kind = ref.kind === 'branch' && ref.name === state.status?.branch ? 'head' : ref.kind;
      badges.append(element('span', `sc-ref sc-ref-${kind}`, ref.name));
    }
    if (badgesToShow.length > 2) badges.append(element('span', 'sc-history-ref-count', '+' + (badgesToShow.length - 2)));
    button.append(badges);
  }
  bindTooltip(button, () => historyRowDetails(row, refs, label));
  bindContextMenu(button, () => historyRowActions(row));
  item.addEventListener('contextmenu', event => {
    event.preventDefault();
    openContextMenu(historyRowActions(row), { anchor: button, event });
  });
  item.append(button);
  entry.append(item);
  if (expanded) {
    const files = renderHistoryFiles(row);
    files.style.setProperty('--history-graph-width', historyGraphWidth(row.columns) + 'px');
    entry.append(files);
  }
  return entry;
}

function renderHistoryStatus() {
  const history = workbench.history;
  const status = el('history-state');
  const refs = el('history-refs');
  const path = workbench.historyPath;
  const scopeLabel = path ? 'File history' : historyScopeLabels[commitGraph.scope];
  const selectedStatus = commitGraph.refs.length + (commitGraph.refs.length === 1 ? ' selected reference' : ' selected references');
  const scopeStatus = path || (commitGraph.scope === 'selected' ? selectedStatus : commitGraph.scope === 'current' ? scopeLabel : '');
  const message = commitGraph.error?.message || (commitGraph.locating ? 'Locating current commit…' : '') ||
    (commitGraph.loading ? (commitGraph.loading.more ? 'Loading more commits…' : 'Loading commits…') : '') ||
    commitGraph.notice || (history && !history.commits.length ? 'No commits.' : '') || (!state.status ? 'Choose a repository to view its history.' : '');
  const statusKey = JSON.stringify([scopeStatus, message, commitGraph.error?.more]);
  if (commitGraph.statusKey !== statusKey) {
    commitGraph.statusKey = statusKey;
    status.textContent = [scopeStatus, message].filter(Boolean).join(' · ');
    if (commitGraph.error) {
      const { more } = commitGraph.error;
      status.append(' ', control('Retry', () => loadHistory({ more, reset: !more })));
    }
    if (scopeStatus) status.append(' ', control('Clear filter', () => filterHistory(null, null)));
  }
  el('history-heading').textContent = path ? 'File history' : 'Graph';
  refs.textContent = path ? 'File' : commitGraph.scope === 'selected' ? commitGraph.refs.length + ' refs' : commitGraph.scope === 'current' ? 'Current' : 'All';
  refs.setAttribute('aria-label', 'Graph references · ' + scopeLabel);
  const paging = el('history-more');
  paging.hidden = history?.nextOffset == null || !!commitGraph.error;
  paging.disabled = !!commitGraph.loading || !!commitGraph.locating;
  el('history-current').disabled = !state.status?.head || !!commitGraph.locating;
  const busy = !!(workbench.busy || state.staging);
  const canFetch = !!state.status?.hasRemote && !busy;
  const canSync = canFetch && !!state.status.upstream && !state.status.detached && !state.status.operation;
  el('history-fetch').disabled = !canFetch;
  el('history-pull').disabled = !canSync;
  el('history-push').disabled = !canSync;
  el('history-refresh').disabled = !state.status || !!commitGraph.loading || busy;
  el('history-actions').disabled = !state.status;
  el('history-compare').disabled = !state.status?.head;
  refs.disabled = !state.status;
}

function renderHistory() {
  const list = el('history-list');
  const scroller = el('history-scroll');
  const active = document.activeElement;
  const focusKey = list.contains(active) ? active.dataset.focusKey : null;
  const commitFocusKey = focusKey ? active.closest('.sc-history-entry')?.querySelector('.sc-history-commit')?.dataset.focusKey : null;
  const top = scroller.scrollTop;
  const left = scroller.scrollLeft;
  const history = workbench.history;
  const fragment = document.createDocumentFragment();
  if (history) {
    for (const row of buildHistoryGraph(history.commits, { ...history, path: workbench.historyPath })) {
      fragment.append(historyRow(row));
    }
  }
  list.replaceChildren(fragment);
  scroller.scrollTop = top;
  scroller.scrollLeft = left;
  if (focusKey) {
    const actions = [...list.querySelectorAll('[data-focus-key]')];
    const next = actions.find(button => button.dataset.focusKey === focusKey) || actions.find(button => button.dataset.focusKey === commitFocusKey);
    next?.focus({ preventScroll: true });
  }
  renderHistoryStatus();
}

async function locateCurrentHistory() {
  if (!state.status?.head || commitGraph.locating) return;
  const { head } = state.status;
  const locator = { key: historyRequestKey() };
  commitGraph.locating = locator;
  commitGraph.notice = '';
  renderHistoryStatus();
  try {
    await loadHistory();
    while (commitGraph.locating === locator && state.status && locator.key === historyRequestKey() && !isSectionCollapsed('history')) {
      const node = el('history-list').querySelector('[data-focus-key="history:' + head + '"]');
      if (node) {
        commitGraph.located = head;
        const item = node.closest('.sc-history-item');
        const scroller = el('history-scroll');
        el('history-list').querySelector('[data-located=true]')?.setAttribute('data-located', 'false');
        item.dataset.located = 'true';
        const row = item.getBoundingClientRect();
        const bounds = scroller.getBoundingClientRect();
        if (row.top < bounds.top || row.bottom > bounds.bottom) {
          scroller.scrollTop += row.top - bounds.top - (scroller.clientHeight - row.height) / 2;
        }
        node.focus({ preventScroll: true });
        return;
      }
      if (commitGraph.error) return;
      if (workbench.history?.nextOffset == null) {
        commitGraph.notice = 'Current commit is outside this history view.';
        return;
      }
      if (!await loadHistory({ more: true })) return;
    }
  } finally {
    if (commitGraph.locating === locator) {
      commitGraph.locating = null;
      renderHistoryStatus();
    }
  }
}

function initializeHistory() {
  const compare = () => compareForm();
  const fetch = () => runCommand('fetch');
  const pull = () => runCommand('pull');
  const push = () => runCommand('push');
  const refreshGraph = async () => {
    const epoch = state.epoch;
    await refresh({ force: true });
    if (epoch === state.epoch) await loadHistory({ reset: true });
  };
  el('history-refs').onclick = chooseHistoryReferences;
  bindTooltip(el('history-refs'), () => el('history-refs').getAttribute('aria-label'));
  el('history-compare').onclick = compare;
  el('history-current').onclick = locateCurrentHistory;
  el('history-fetch').onclick = fetch;
  el('history-pull').onclick = pull;
  el('history-push').onclick = push;
  el('history-refresh').onclick = refreshGraph;
  el('history-more').onclick = () => loadHistory({ more: true });
  el('history-actions').onclick = () => {
    const anchor = el('history-actions');
    openContextMenu([
      { label: 'Choose references…', run: chooseHistoryReferences },
      { label: 'Locate current commit', disabled: el('history-current').disabled, run: locateCurrentHistory },
      { label: 'Compare changes…', disabled: el('history-compare').disabled, run: compare },
      { separator: true },
      { label: 'Fetch', disabled: el('history-fetch').disabled, run: fetch },
      { label: 'Pull (fast-forward)', disabled: el('history-pull').disabled, run: pull },
      { label: 'Push…', disabled: el('history-push').disabled, run: push },
      { label: 'Refresh history', disabled: el('history-refresh').disabled, run: refreshGraph },
    ], { anchor, label: 'Graph actions' });
  };
  const scroller = el('history-scroll');
  scroller.addEventListener('scroll', () => {
    if (commitGraph.loading || commitGraph.error || commitGraph.locating) return;
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 120) loadHistory({ more: true });
  }, { passive: true });
  renderHistoryStatus();
}
