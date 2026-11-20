const commitGraph = {
  scope: 'all', refs: [], expanded: new Set(), details: new Map(), rows: new Map(), loading: null,
  stats: new Map(), statsLoading: new Map(),
  error: null, notice: '', locating: null, located: null, referencePicker: null,
};
const historyScopeLabels = {
  all: msg('All references'), current: msg('Current branch and upstream'), selected: msg('Selected references'),
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
      const cursorExpired = error.message === 'Invalid Git history cursor.';
      commitGraph.error = {
        message: cursorExpired ? msg('Invalid Git history cursor.') : error.message,
        more: more && !cursorExpired,
      };
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

function historyScopeLabel() {
  return workbench.historyPath ? msg('File history') : historyScopeLabels[commitGraph.scope];
}

function chooseHistoryReferences() {
  if (!state.status) return;
  const form = element('form', 'sc-history-reference-form');
  const modes = element('fieldset', 'sc-history-reference-modes');
  modes.append(element('legend', '', msg('History scope')));
  const filters = element('div', 'sc-history-reference-filter');
  const search = element('input', 'sc-input');
  search.type = 'search';
  uiAttr(search, 'placeholder', msg('Search branches and tags'));
  uiAttr(search, 'aria-label', msg('Search branches and tags'));
  const results = element('div', 'sc-history-reference-results');
  const selected = new Set(commitGraph.refs);
  const selectionCount = element('span', 'sc-muted');
  const actions = element('div', 'sc-actions sc-dialog-buttons');
  const submit = element('button', 'sc-primary', msg('Apply'));
  submit.type = 'submit';
  let scope = commitGraph.scope;
  let references = null;
  let referenceError = false;
  let referenceLoading = false;

  function updateSelection() {
    submit.disabled = scope === 'selected' && !selected.size;
    selectionCount.hidden = scope !== 'selected';
    uiText(selectionCount, msg('{count} selected', { count: selected.size }));
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
      const message = referenceError ? msg('References could not be loaded.') : msg('Loading references…');
      results.append(element('p', 'sc-muted', message));
      if (referenceError) results.append(control(msg('Retry'), requestReferences));
      return;
    }
    const groups = matchingHistoryReferences(references, search.value);
    if (!groups.length) results.append(element('p', 'sc-muted', msg('No matching references.')));
    for (const { label, items } of groups) {
      const group = element('fieldset', 'sc-history-reference-group');
      group.append(element('legend', '', msg(label)));
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
        if (item.current) option.append(element('span', 'sc-muted', msg('Current')));
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
  actions.append(selectionCount, control(msg('Cancel'), () => el('action-dialog').close()), submit);
  form.append(modes, filters, actions);
  updateSelection();
  commitGraph.referencePicker = form;
  openAction(msg('Graph references'), form);
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
  if (row.comparison) {
    content.append(element('strong', '', label));
    const branch = row.kind === 'outgoing' ? state.status.branch : state.status.upstream;
    const count = msg(row.count === 1 ? '{count} commit' : '{count} commits', { count: row.count });
    content.append(element('span', '', msg('{branch} · {count}', { branch: branch || 'HEAD', count })));
    content.append(element('code', '', `${row.comparison.from.slice(0, 8)} → ${row.comparison.to.slice(0, 8)}`));
  } else {
    const { author, date, id, relation } = row.commit;
    const relationText = relation === 'ahead' ? msg('Outgoing') : relation === 'behind' ? msg('Incoming') : '';
    const details = [author, date ? msg('{date}', { date: new Date(date) }) : '', relationText].filter(Boolean);
    const metadata = element('span', 'sc-history-tooltip-meta');
    for (const [index, detail] of details.entries()) {
      if (index) metadata.append(' · ');
      metadata.append(element('span', '', detail));
    }
    if (details.length) content.append(metadata);
    content.append(element('strong', '', label));
    const body = element('p', 'sc-history-tooltip-body');
    body.hidden = true;
    const stats = element('div', 'sc-history-tooltip-stats', msg('Loading line counts…'));
    content.append(body, stats);
    loadHistoryStats(id, body, stats);
    if (refs.length) {
      const badges = element('div', 'sc-history-tooltip-refs');
      badges.append(...refs.map(ref => element('span', `sc-ref sc-ref-${ref.kind}`, ref.name)));
      content.append(badges);
    }
    const footer = element('div', 'sc-history-tooltip-footer');
    const copy = control('', () => copyText(id), 'sc-history-tooltip-copy');
    uiAttr(copy, 'aria-label', msg('Copy commit hash'));
    copy.append(icon('copy'));
    footer.append(element('code', '', id.slice(0, 8)), copy);
    content.append(footer);
  }
  return content;
}

function readHistoryStats(repoPath, commit) {
  const key = JSON.stringify([repoPath, commit]);
  const { stats, statsLoading } = commitGraph;
  if (stats.has(key)) {
    const cached = stats.get(key);
    stats.delete(key);
    stats.set(key, cached);
    return cached;
  }
  if (!statsLoading.has(key)) {
    const request = callTool('git_history_stats', { repoPath, commit }).then(result => {
      stats.set(key, result);
      if (stats.size > 128) stats.delete(stats.keys().next().value);
      return result;
    }).finally(() => statsLoading.delete(key));
    statsLoading.set(key, request);
  }
  return statsLoading.get(key);
}

async function loadHistoryStats(commit, body, stats) {
  const { checkout, epoch } = state;
  const current = () => stats.isConnected && state.checkout === checkout && state.epoch === epoch;
  try {
    const { additions, deletions, binaryFiles, filesChanged, message } = await readHistoryStats(checkout, commit);
    if (!current()) return;
    if (message?.trim()) {
      body.textContent = message.trim();
      body.hidden = false;
    }
    uiText(stats, '');
    if (filesChanged != null) {
      stats.append(element('span', '', msg(filesChanged === 1 ? '{count} file changed' : '{count} files changed', { count: filesChanged })));
    }
    stats.append(
      element('span', 'sc-history-tooltip-additions', msg(additions === 1 ? '+{count} line added' : '+{count} lines added', { count: additions })),
      element('span', 'sc-history-tooltip-deletions', msg(deletions === 1 ? '−{count} line deleted' : '−{count} lines deleted', { count: deletions })),
    );
    if (binaryFiles) stats.append(element('span', '', msg(binaryFiles === 1 ? '{count} binary file' : '{count} binary files', { count: binaryFiles })));
  } catch {
    if (current()) uiText(stats, msg('Line counts unavailable'));
  }
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
        if (commitGraph.expanded.has(commit)) updateHistoryFiles(commitGraph.rows.get(commit));
      }
    }
  })();
  if (commitGraph.expanded.has(commit)) updateHistoryFiles(commitGraph.rows.get(commit));
  return entry.pending;
}

function selectHistoryCommit(commit, path) {
  const previous = workbench.historySelection?.commit;
  if (previous && previous !== commit) commitGraph.rows.get(previous)?.button.setAttribute('aria-pressed', 'false');
  workbench.historySelection = commit ? { commit, path } : null;
  if (commit) commitGraph.rows.get(commit)?.button.setAttribute('aria-pressed', 'true');
}

function setHistoryExpanded(record, expanded) {
  const { row, button, toggle, subject } = record;
  for (const control of [button, toggle]) {
    control.setAttribute('aria-expanded', String(expanded));
    if (expanded) control.setAttribute('aria-controls', 'history-files-' + row.id);
    else control.removeAttribute('aria-controls');
  }
  uiAttr(toggle, 'aria-label', msg(expanded ? 'Collapse changed files for {subject}' : 'Expand changed files for {subject}', { subject }));
}

function toggleHistoryFiles(commit) {
  const record = commitGraph.rows.get(commit);
  if (!record) return;
  const expanded = !commitGraph.expanded.delete(commit);
  if (expanded) {
    commitGraph.expanded.add(commit);
    if (commitGraph.details.has(commit)) updateHistoryFiles(record);
    else void readHistoryCommit(commit);
  } else if (record.files.contains(document.activeElement)) {
    record.button.focus({ preventScroll: true });
  }
  setHistoryExpanded(record, expanded);
  animateHistoryFiles(record, expanded);
}

function animateHistoryFiles(record, expanded) {
  const { files, list } = record;
  files.inert = !expanded;
  const finish = () => {
    record.motion?.cancel();
    record.motion = null;
    if (files.inert) {
      files.remove();
      record.files = null;
    }
  };
  if (!list.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    finish();
    return;
  }
  if (record.motion) {
    record.motion.reverse();
    return;
  }
  const duration = 120;
  const motion = list.animate([
    { opacity: 0, transform: 'translateY(-3px)' },
    { opacity: 1, transform: 'translateY(0)' },
  ], { duration, easing: 'ease-out', fill: 'both' });
  if (!expanded) {
    motion.currentTime = duration;
    motion.reverse();
  }
  motion.onfinish = finish;
  record.motion = motion;
}

function updateHistoryFiles(record) {
  if (!record) return;
  const { row, entry, button } = record;
  const { id } = row;
  if (!record.files) {
    record.files = element('div', 'sc-history-files');
    record.files.id = 'history-files-' + id;
    record.files.style.setProperty('--history-graph-width', historyGraphWidth(row.columns) + 'px');
    record.list = element('div', 'sc-history-file-list');
    record.files.append(historyGraphThread(row), record.list);
    entry.append(record.files);
  }
  if (record.list.contains(document.activeElement)) button.focus({ preventScroll: true });
  record.list.replaceChildren(renderHistoryFiles(id));
}

function renderHistoryFiles(id) {
  const files = document.createDocumentFragment();
  const detail = commitGraph.details.get(id);
  if (!detail || detail.pending) {
    files.append(element('span', 'sc-muted', msg('Loading changed files…')));
    return files;
  }
  if (detail.error) {
    const retry = control(msg('Retry'), () => void readHistoryCommit(id));
    retry.dataset.focusKey = 'history-retry:' + id;
    files.append(element('span', 'sc-muted', detail.error), retry);
    return files;
  }
  for (const file of detail.result.files) {
    const button = control('', () => openCommit(id, file.path), 'sc-detail-file sc-history-file');
    button.dataset.focusKey = JSON.stringify(['history-file', id, file.path]);
    const status = element('span', 'sc-file-status', file.status);
    status.dataset.status = file.status;
    const path = file.originalPath ? `${file.originalPath} → ${file.path}` : file.path;
    button.append(status, element('span', 'sc-history-file-path', path));
    bindTooltip(button, path);
    bindContextMenu(button, () => [
      { label: msg('Open file diff'), run: () => openCommit(id, file.path) },
      { label: msg('Copy file path'), run: () => copyText(file.path) },
    ]);
    files.append(button);
  }
  if (!detail.result.files.length) files.append(element('span', 'sc-muted', msg('No changed files.')));
  if (detail.result.filesTruncated) files.append(element('span', 'sc-muted', msg('Additional files omitted.')));
  return files;
}

function historyRowActions(row) {
  if (row.comparison) return [{ label: msg('Compare changes'), run: () => openCompare(row.comparison) }];
  const { id, parents } = row.commit;
  const viewing = workbench.historyPath;
  const busy = !!workbench.busy || !!state.staging;
  const head = state.status?.head;
  return [
    { label: msg('Open commit details'), run: () => openCommit(id) },
    { label: msg(commitGraph.expanded.has(id) ? 'Collapse changed files' : 'Expand changed files'), run: () => toggleHistoryFiles(id) },
    { label: msg('Copy commit hash'), run: () => copyText(id) },
    { label: msg('Copy commit message'), run: async () => {
      const result = await readHistoryCommit(id);
      if (result) copyText(result.message);
      else if (commitGraph.details.get(id)?.error) showError(commitGraph.details.get(id).error);
    } },
    { separator: true },
    { label: msg('Compare with parent'), disabled: !parents.length, run: () => openCompare({ from: parents[0], to: id, ...(viewing ? { path: viewing } : {}) }) },
    { label: msg('Compare with HEAD'), disabled: !head || head === id, run: () => openCompare({ from: id, to: head }) },
    { label: msg('Compare with working copy'), run: () => openCompare({ from: id }) },
    { separator: true },
    { label: msg('Create branch here…'), disabled: busy, run: () => runCommand('createBranch', { startPoint: id }, [
      field('name', msg('Branch name')), field('checkout', msg('Switch to this branch'), { checkbox: true, value: true }),
    ]) },
    { label: msg('Create tag here…'), disabled: busy, run: () => runCommand('createTag', { ref: id }, [
      field('name', msg('Tag name')), field('message', msg('Annotation'), { optional: true }),
    ]) },
    { label: msg('Checkout detached'), disabled: busy || (state.status?.detached && head === id), run: () => runCommand('checkoutDetached', { ref: id }) },
    { label: msg('Cherry-pick'), disabled: busy || parents.length > 1, run: () => runCommand('cherryPick', { ref: id }) },
  ];
}

function historyRow(row) {
  const { id, commit, comparison, kind } = row;
  const expanded = commitGraph.expanded.has(id);
  const label = comparison ? msg(kind === 'incoming' ? 'Incoming changes' : 'Outgoing changes') : commit.subject || msg('(empty subject)');
  const entry = element('div', 'sc-history-entry');
  const item = element('div', 'sc-history-item');
  item.dataset.kind = kind;
  item.dataset.located = String(commitGraph.located === id);
  item.style.setProperty('--history-graph-width', historyGraphWidth(row.columns) + 'px');
  const activate = () => {
    if (comparison) return openCompare(comparison);
    selectHistoryCommit(id, workbench.historyPath);
    toggleHistoryFiles(id);
  };
  const button = control('', activate, 'sc-history-commit');
  button.dataset.focusKey = 'history:' + id;
  if (!comparison) {
    button.setAttribute('aria-pressed', String(workbench.historySelection?.commit === id));
    const toggle = control('', () => toggleHistoryFiles(id), 'sc-history-expand');
    toggle.dataset.focusKey = 'history-expand:' + id;
    const subject = commit.subject?.slice(0, 100) || label;
    const record = { row, entry, button, toggle, subject };
    commitGraph.rows.set(id, record);
    setHistoryExpanded(record, expanded);
    item.onclick = event => {
      if (event.target !== item) return;
      button.focus({ preventScroll: true });
      activate();
    };
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
  bindTooltip(button, () => historyRowDetails(row, refs, label), comparison ? undefined : { interactive: true, placement: 'side' });
  bindContextMenu(button, () => historyRowActions(row));
  item.addEventListener('contextmenu', event => {
    event.preventDefault();
    openContextMenu(historyRowActions(row), { anchor: button, event });
  });
  item.append(button);
  entry.append(item);
  if (expanded) updateHistoryFiles(commitGraph.rows.get(id));
  return entry;
}

function renderHistoryStatus() {
  const history = workbench.history;
  const status = el('history-state');
  const refs = el('history-refs');
  const path = workbench.historyPath;
  const count = commitGraph.refs.length;
  const scopeLabel = historyScopeLabel();
  const selectedStatus = msg(count === 1 ? '{count} selected reference' : '{count} selected references', { count });
  const scopeStatus = path || (commitGraph.scope === 'selected' ? selectedStatus : commitGraph.scope === 'current' ? scopeLabel : '');
  const message = commitGraph.error?.message || (commitGraph.locating ? msg('Locating current commit…') : '') ||
    (commitGraph.loading ? msg(commitGraph.loading.more ? 'Loading more commits…' : 'Loading commits…') : '') ||
    commitGraph.notice || (history && !history.commits.length ? msg('No commits.') : '') ||
    (!state.status ? msg('Choose a repository to view its history.') : '');
  const statusKey = JSON.stringify([scopeStatus, message, commitGraph.error?.more]);
  if (commitGraph.statusKey !== statusKey) {
    commitGraph.statusKey = statusKey;
    status.replaceChildren();
    if (scopeStatus || message) {
      const summary = scopeStatus && message ? msg('{scope} · {message}', { scope: scopeStatus, message }) : scopeStatus || message;
      status.append(element('span', '', summary));
    }
    if (commitGraph.error) {
      const { more } = commitGraph.error;
      status.append(' ', control(msg('Retry'), () => loadHistory({ more, reset: !more })));
    }
    if (scopeStatus) status.append(' ', control(msg('Clear filter'), () => filterHistory(null, null)));
  }
  uiText(el('history-heading'), path ? msg('File history') : msg('Graph'));
  const refsLabel = msg(count === 1 ? '{count} ref' : '{count} refs', { count });
  uiText(refs, path ? msg('File') : commitGraph.scope === 'selected' ? refsLabel : msg(commitGraph.scope === 'current' ? 'Current' : 'All'));
  uiAttr(refs, 'aria-label', msg('Graph references · {scope}', { scope: scopeLabel }));
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
  commitGraph.rows.clear();
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
        commitGraph.notice = msg('Current commit is outside this history view.');
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
  bindTooltip(el('history-refs'), () => msg('Graph references · {scope}', { scope: historyScopeLabel() }));
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
      { label: msg('Choose references…'), run: chooseHistoryReferences },
      { label: msg('Locate current commit'), disabled: el('history-current').disabled, run: locateCurrentHistory },
      { label: msg('Compare changes…'), disabled: el('history-compare').disabled, run: compare },
      { separator: true },
      { label: msg('Fetch'), disabled: el('history-fetch').disabled, run: fetch },
      { label: msg('Pull (fast-forward)'), disabled: el('history-pull').disabled, run: pull },
      { label: msg('Push…'), disabled: el('history-push').disabled, run: push },
      { label: msg('Refresh history'), disabled: el('history-refresh').disabled, run: refreshGraph },
    ], { anchor, label: msg('Graph actions') });
  };
  const scroller = el('history-scroll');
  scroller.addEventListener('scroll', () => {
    if (commitGraph.loading || commitGraph.error || commitGraph.locating) return;
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 120) loadHistory({ more: true });
  }, { passive: true });
  renderHistoryStatus();
}
