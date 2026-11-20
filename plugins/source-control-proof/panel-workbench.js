const workbench = {
  pane: 'changes', tree: false, folders: new Set(), drafts: new Map(),
  history: null, historyPath: null, historyRef: null, historyKey: '', historyRequest: 0,
  historySelection: null, preview: 'file', patch: null, busy: null,
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function control(text, onClick, className = 'sc-control') {
  const button = element('button', className, text);
  button.type = 'button';
  button.onclick = onClick;
  return button;
}

function setPane(pane) {
  workbench.pane = pane;
  document.querySelector('.sc-app').dataset.pane = pane;
  for (const button of document.querySelectorAll('[data-pane-button]')) {
    button.setAttribute('aria-pressed', String(button.dataset.paneButton === pane));
  }
  if (pane === 'history') loadHistory();
}

function showPreview() {
  if (matchMedia('(max-width: 740px)').matches) setPane('preview');
}

function resetPreview() {
  workbench.preview = 'file';
  workbench.patch = null;
  workbench.historySelection = null;
  el('patch-controls').hidden = true;
  el('detail').hidden = true;
  el('file-view-modes').hidden = false;
  el('file-actions').disabled = !state.selection;
}

function newCheckout(oldCheckout) {
  if (oldCheckout) workbench.drafts.set(oldCheckout, el('commit-message').value);
  el('commit-message').value = workbench.drafts.get(state.checkout) || '';
  workbench.history = null;
  workbench.historyPath = null;
  workbench.historyRef = null;
  workbench.historyKey = '';
  workbench.output = '';
  workbench.historyRequest++;
  resetPreview();
  setPane('changes');
  renderHistory();
  updateCommitButton();
}

function updateCommitButton() {
  const hasItems = !!state.status?.staged.length;
  el('commit-submit').disabled = !!workbench.busy || !hasItems || !el('commit-message').value.trim();
}

function repositoryStatusChanged(data, previous) {
  const tracking = data.upstream
    ? [(data.behind === null ? '' : '↓' + data.behind), (data.ahead === null ? '' : '↑' + data.ahead)].filter(Boolean).join(' ')
    : '';
  el('tracking').textContent = tracking;
  el('tracking').title = data.upstream ? 'Tracking ' + data.upstream : '';
  el('file-actions').disabled = !state.selection;
  updateCommitButton();
  if (workbench.pane === 'history' && (!previous || data.head !== previous.head || data.ahead !== previous.ahead || data.behind !== previous.behind || data.upstream !== previous.upstream)) {
    loadHistory({ reset: true });
  }
}

async function performAction(tool, args, label) {
  if (workbench.busy || state.staging) return false;
  const checkout = state.checkout;
  const epoch = state.epoch;
  const token = { checkout };
  const submittedDraft = el('commit-message').value;
  workbench.busy = token;
  state.viewRequest++;
  state.statusRequest++;
  state.refreshEpoch = null;
  el('staging-message').textContent = label + '…';
  updateCommitButton();
  renderFiles();
  let success = false;
  try {
    const result = await callTool(tool, { ...(checkout ? { repoPath: checkout } : {}), ...args });
    success = true;
    if (epoch !== state.epoch) {
      if (tool === 'git_commit' && args.action !== 'undoCommit' && workbench.drafts.get(checkout) === submittedDraft) {
        workbench.drafts.delete(checkout);
      }
      return true;
    }
    if (result.checkout && result.checkout !== checkout) {
      await switchCheckout(result.checkout);
    } else {
      const status = result.status?.checkout ? result.status : result.staged ? result : null;
      if (status) renderStatus(status);
      el('staging-message').textContent = result.message || label + ' completed';
      if (result.message || result.output) workbench.output = result.output || result.message;
    }
    if (tool === 'git_commit' && el('commit-message').value === submittedDraft) {
      if (args.action === 'undoCommit') el('commit-message').value = result.undoneMessage || el('commit-message').value;
      else {
        el('commit-message').value = '';
        workbench.drafts.delete(checkout);
      }
    }
    showError();
  } catch (error) {
    if (epoch === state.epoch) {
      workbench.output = error.message;
      showError(error.message);
      el('staging-message').textContent = label + ' failed';
    }
  } finally {
    if (workbench.busy === token) workbench.busy = null;
    updateCommitButton();
    renderFiles();
    if (epoch === state.epoch) {
      if (workbench.preview === 'patch') resetPreview();
      await refresh({ force: true });
      if (workbench.pane === 'history') await loadHistory({ reset: true });
    }
  }
  return success;
}

function selectWorkingFile(file, group) {
  state.selection = { path: file.path, group };
  resetPreview();
  renderFiles();
  clearCode('Loading file…');
  el('code').scrollTop = 0;
  if (group === 'conflicts') openConflict();
  else loadFile();
  showPreview();
}

function fileTreeItems(files, group, makeFileRow) {
  const list = element('ul');
  if (!workbench.tree) {
    for (const file of files) list.append(makeFileRow(file));
    return list;
  }
  function appendItems(parent, items) {
    for (const item of items) {
      if (item.file) {
        parent.append(makeFileRow(item.file));
      } else {
        const key = group + '/' + item.path;
        const entry = element('li', 'sc-folder');
        const open = !workbench.folders.has(key);
        const toggle = control(item.name, () => {
          if (open) workbench.folders.add(key);
          else workbench.folders.delete(key);
          renderFiles();
          [...el('files').querySelectorAll('.sc-folder-toggle')].find(button => button.dataset.folder === key)?.focus({ preventScroll: true });
        }, 'sc-folder-toggle');
        toggle.dataset.folder = key;
        toggle.setAttribute('aria-expanded', String(open));
        toggle.prepend(icon('chevron'));
        entry.append(toggle);
        if (open) {
          const children = element('ul');
          appendItems(children, item.children);
          entry.append(children);
        }
        parent.append(entry);
      }
    }
  }
  appendItems(list, buildFileTree(files));
  return list;
}

function addGroupActions(heading, group, count) {
  if (!count) return;
  const action = group === 'staged' ? 'unstage' : 'stage';
  const title = action === 'stage' ? 'Stage group' : 'Unstage group';
  const button = control(action === 'stage' ? '+' : '−', () => performAction('git_change', { action, group }, title));
  button.title = title;
  button.setAttribute('aria-label', title);
  button.disabled = !!workbench.busy || !!state.staging;
  heading.append(button);
  if (group === 'unstaged' || group === 'untracked') {
    const label = group === 'unstaged' ? 'Discard unstaged changes' : 'Remove untracked files';
    const remove = control('×', () => {
      const expectedPaths = state.status[group].map(file => file.path);
      const total = expectedPaths.length;
      actionForm(label, [], (_, confirmed) =>
        performAction('git_change', { action: 'discard', group, confirmed, expectedPaths }, label),
      { confirmation: label + ' · ' + total + (total === 1 ? ' file' : ' files') + ' · ' + state.checkout });
    });
    remove.title = label;
    remove.setAttribute('aria-label', label);
    remove.disabled = !!workbench.busy || !!state.staging;
    heading.append(remove);
  }
}

function renderSplit(view) {
  const fragment = document.createDocumentFragment();
  const scroller = el('code');
  const oldScroll = { top: scroller.scrollTop, left: scroller.scrollLeft };
  const labels = element('div', 'sc-split-row sc-split-labels');
  labels.append(element('span', '', view.group === 'staged' ? 'HEAD' : 'Before'), element('span', '', view.group === 'staged' ? 'Index' : 'After'));
  fragment.append(labels);
  for (const row of diffRows(view.text)) {
    if (row.heading !== undefined) {
      fragment.append(element('div', 'sc-split-heading', row.heading));
      continue;
    }
    const entry = element('div', 'sc-split-row');
    for (const side of [row.old, row.next]) {
      const cell = element('div', 'sc-split-cell ' + (side?.kind || ''));
      cell.append(element('span', 'sc-number', side?.number ?? ''), element('span', 'sc-line-text', side?.text ?? ''));
      entry.append(cell);
    }
    fragment.append(entry);
  }
  scroller.replaceChildren(fragment);
  scroller.hidden = false;
  scroller.scrollTop = oldScroll.top;
  scroller.scrollLeft = oldScroll.left;
  el('view-message').hidden = true;
}

async function loadHistory({ reset = false, more = false } = {}) {
  if (!state.status) return;
  const data = state.status;
  const key = JSON.stringify([data.checkout, data.head, data.upstream, data.ahead, data.behind, workbench.historyRef, workbench.historyPath]);
  if (!reset && !more && key === workbench.historyKey) return;
  const previous = workbench.history;
  workbench.historyKey = key;
  const token = ++workbench.historyRequest;
  el('history-state').textContent = 'Loading commits…';
  el('history-more').disabled = true;
  try {
    const result = await callTool('git_history', {
      repoPath: data.checkout, limit: 40,
      ...(workbench.historyRef ? { ref: workbench.historyRef } : {}),
      ...(workbench.historyPath ? { path: workbench.historyPath } : {}),
      ...(more ? { offset: previous.nextOffset, cursor: previous.cursor } : {}),
    });
    if (token !== workbench.historyRequest) return;
    workbench.history = { ...result, commits: [...(more ? previous.commits : []), ...result.commits] };
    renderHistory();
  } catch (error) {
    if (token !== workbench.historyRequest) return;
    workbench.historyKey = '';
    el('history-state').textContent = error.message;
    const retry = control('Reload history', () => loadHistory({ reset: true }));
    el('history-state').append(' ', retry);
  } finally {
    if (token === workbench.historyRequest) el('history-more').disabled = false;
  }
}

function graphMark(mark) {
  const make = (tag, attrs) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };
  const width = Math.max(mark.columns, 1) * 11 + 2;
  const x = lane => 6 + lane * 11;
  const svg = make('svg', { class: 'sc-graph-mark', viewBox: '0 0 ' + width + ' 36', width, height: 36, 'aria-hidden': 'true' });
  for (const { from, to, color } of mark.edges) {
    svg.append(make('path', { d: 'M' + x(from) + ' 18C' + x(from) + ' 27 ' + x(to) + ' 25 ' + x(to) + ' 36', class: 'sc-graph-edge sc-lane-' + color }));
    if (from !== mark.lane) svg.append(make('path', { d: 'M' + x(from) + ' 0V18', class: 'sc-graph-edge sc-lane-' + color }));
  }
  if (mark.incoming) svg.append(make('path', { d: 'M' + x(mark.lane) + ' 0V18', class: 'sc-graph-edge sc-lane-' + mark.color }));
  svg.append(make('circle', { cx: x(mark.lane), cy: 18, r: 3.7, class: 'sc-graph-node sc-lane-' + mark.color }));
  return svg;
}

function renderHistory() {
  const history = workbench.history;
  const list = el('history-list');
  list.replaceChildren();
  el('history-heading').textContent = workbench.historyPath ? 'File history' : 'Commit graph';
  el('history-more').hidden = history?.nextOffset == null;
  const counts = history ? [history.behind ? history.behind + ' incoming' : '', history.ahead ? history.ahead + ' outgoing' : ''].filter(Boolean) : [];
  const filter = workbench.historyPath || workbench.historyRef;
  el('history-state').textContent = history
    ? [filter, counts.join(' · '), history.commits.length ? '' : 'No commits'].filter(Boolean).join(' · ')
    : 'Choose a repository to view its history.';
  if (filter) el('history-state').append(' ', control('Clear filter', () => filterHistory(null, null)));
  if (!history) return;
  const topology = workbench.historyPath ? history.commits.map((commit, index) => ({
    id: commit.id, parents: index + 1 < history.commits.length ? [history.commits[index + 1].id] : [],
  })) : history.commits;
  graphRows(topology).forEach((mark, index) => {
    const commit = history.commits[index];
    const row = control('', () => openCommit(commit.id, workbench.historyPath), 'sc-history-row');
    row.setAttribute('aria-pressed', String(workbench.historySelection?.commit === commit.id));
    row.title = commit.subject + ' · ' + commit.author + ' · ' + commit.id;
    if (commit.relation === 'ahead') row.title += ' · Outgoing';
    if (commit.relation === 'behind') row.title += ' · Incoming';
    const copy = element('span', 'sc-history-copy');
    copy.append(element('strong', '', commit.subject || '(empty subject)'), element('small', '', commit.author + ' · ' + commit.id.slice(0, 8)));
    row.append(graphMark(mark), copy);
    const refs = element('span', 'sc-history-refs');
    if (['ahead', 'behind'].includes(commit.relation)) {
      const direction = element('span', 'sc-ref sc-ref-direction', commit.relation === 'ahead' ? '↑' : '↓');
      direction.setAttribute('aria-label', commit.relation === 'ahead' ? 'Outgoing' : 'Incoming');
      refs.append(direction);
    }
    for (const ref of commit.refs.slice(0, 2)) refs.append(element('span', 'sc-ref sc-ref-' + ref.kind, ref.name));
    row.append(refs);
    list.append(row);
  });
}

function filterHistory(ref, path) {
  workbench.historyRef = ref;
  workbench.historyPath = path;
  workbench.historyKey = '';
  setPane('history');
}

function openDetail(title, subtitle, type) {
  el('code').classList.remove('sc-detail-diff');
  const token = ++state.viewRequest;
  workbench.preview = type;
  el('patch-controls').hidden = true;
  el('file-view-modes').hidden = true;
  el('file-title').textContent = title;
  el('file-context').textContent = subtitle;
  el('detail').replaceChildren();
  el('detail').hidden = true;
  clearCode('Loading…');
  showPreview();
  return token;
}

function showDetail(...content) {
  el('code').hidden = true;
  el('images').hidden = true;
  el('view-message').hidden = true;
  el('detail').replaceChildren(...content);
  el('detail').hidden = false;
}

function showReadDiff(text, emptyMessage = 'No text changes.') {
  el('detail').hidden = false;
  el('code').classList.add('sc-detail-diff');
  renderCode(text ? { text, sourceLabel: el('file-context').textContent, displayMode: 'diff' } : { message: emptyMessage });
}

async function openCommit(commit, path = null, parent) {
  const token = openDetail('Commit ' + commit.slice(0, 8), 'History', 'history');
  workbench.historySelection = { commit, path };
  renderHistory();
  try {
    const result = await callTool('git_history_detail', { repoPath: state.checkout, commit, ...(path ? { path } : {}), ...(parent ? { parent } : {}) });
    if (token !== state.viewRequest) return;
    if (path && !result.files.some(file => file.path === path || file.originalPath === path)) {
      await openCommit(commit, null, parent);
      return;
    }
    el('file-title').textContent = result.commit.subject || 'Commit ' + commit.slice(0, 8);
    const refs = element('div', 'sc-actions');
    refs.append(control('Copy hash', () => copyText(commit)), control('Copy message', () => copyText(result.message)),
      control('Compare with working copy', () => openCompare({ from: commit })),
      control('Checkout detached', () => runCommand('checkoutDetached', { ref: commit })),
      control('Cherry-pick', () => runCommand('cherryPick', { ref: commit })));
    const message = element('pre', 'sc-commit-text', result.message);
    const info = element('p', 'sc-muted', result.commit.author + ' · ' + commit + ' · ' + new Date(result.commit.date).toLocaleString());
    if (result.commit.parents.length > 1) {
      const select = element('select', 'sc-input');
      select.setAttribute('aria-label', 'Compare to parent');
      result.commit.parents.forEach((id, i) => {
        const option = element('option', '', 'Parent ' + (i + 1) + ' · ' + id.slice(0, 8));
        option.value = id;
        option.selected = (parent || result.commit.parents[0]) === id;
        select.append(option);
      });
      select.onchange = () => openCommit(commit, path, select.value);
      refs.append(select);
    }
    if (path) refs.prepend(control('Back to commit files', () => openCommit(commit, null, parent)));
    showDetail(info, message, refs, changedFileList(result.files, file => openCommit(commit, file.path, parent)));
    if (path) showReadDiff(result.diff, result.diffTruncated ? 'This diff exceeds the preview limit.' : 'No text changes for this file.');
  } catch (error) {
    if (token === state.viewRequest) clearCode(error.message);
  }
}

function changedFileList(files, onClick) {
  const list = element('div', 'sc-detail-files');
  for (const file of files) {
    const button = control('', () => onClick(file), 'sc-detail-file');
    button.append(element('span', 'sc-file-status', file.status), element('span', '', file.originalPath ? file.originalPath + ' → ' + file.path : file.path));
    list.append(button);
  }
  return list;
}

async function openCompare(args) {
  const token = openDetail('Compare changes', args.from + ' → ' + (args.to || 'working copy'), 'compare');
  try {
    const result = await callTool('git_compare', { repoPath: state.checkout, ...args });
    if (token !== state.viewRequest) return;
    const files = result.files.length ? changedFileList(result.files, file => openCompare({ ...args, path: file.path })) : element('p', 'sc-muted', 'No changed files.');
    if (args.path) {
      const { path, ...comparison } = args;
      showDetail(control('Back to changed files', () => openCompare(comparison)), files);
    } else showDetail(files);
    if (args.path) showReadDiff(result.diff, result.diffTruncated ? 'This diff exceeds the preview limit.' : 'No text changes for this file.');
  } catch (error) {
    if (token === state.viewRequest) clearCode(error.message);
  }
}

async function openBlame(path) {
  const token = openDetail(path, 'Line attribution', 'blame');
  try {
    const result = await callTool('git_blame', { repoPath: state.checkout, path });
    if (token !== state.viewRequest) return;
    const list = element('div', 'sc-detail-files');
    for (const entry of result.lines) {
      const button = control(entry.line + ' · ' + entry.author + ' · ' + (entry.summary || entry.commit?.slice(0, 8) || 'Working copy'), () => openCommit(entry.commit, path), 'sc-detail-file');
      button.disabled = !entry.commit;
      list.append(button);
    }
    showDetail(list);
  } catch (error) {
    if (token === state.viewRequest) clearCode(error.message);
  }
}

function openFileActions() {
  const selection = state.selection;
  if (!selection) return;
  const { path, group } = selection;
  const file = state.status?.[group].find(item => item.path === path);
  const historyPath = file?.originalPath || path;
  const actions = [
    { label: 'File history', disabled: group === 'untracked', run: () => filterHistory(null, historyPath) },
    { label: 'Line attribution', disabled: group === 'untracked', run: () => openBlame(path) },
    { label: 'Copy path', run: () => copyText(path) },
  ];
  if (['staged', 'unstaged', 'untracked'].includes(group)) {
    actions.unshift({ label: 'Select lines or hunks…', run: () => openPatch(path, group) });
  }
  if (group === 'unstaged') {
    actions.push({ label: 'Discard working-copy changes…', run: () => actionForm('Discard changes', [], (_, confirmed) =>
      performAction('git_change', { action: 'discard', path, group, confirmed }, 'Discard changes'),
    { confirmation: path + ' · Restore from index', submitLabel: 'Discard changes' }) });
  }
  if (group === 'untracked') {
    actions.push({ label: 'Ignore file…', run: () => actionForm('Ignore file', [], (_, confirmed) =>
      performAction('git_change', { action: 'ignore', path, group, confirmed }, 'Ignore file'),
    { confirmation: path + ' · Add to .gitignore', submitLabel: 'Ignore' }) });
  }
  if (group !== 'conflicts') {
    actions.push(
      { label: 'Rename file…', run: () => actionForm('Rename file', [field('newPath', 'New repository-relative path', { value: path })], (values, confirmed) =>
        performAction('git_change', { action: 'rename', path, group, ...values, confirmed }, 'Rename file'),
      { confirmation: path + ' · Rename in working copy' }) },
      { label: 'Delete file…', run: () => actionForm('Delete file', [], (_, confirmed) =>
        performAction('git_change', { action: 'delete', path, group, confirmed }, 'Delete file'),
      { confirmation: path + ' · Delete from working copy', submitLabel: 'Delete file' }) },
    );
  } else {
    actions.unshift({ label: 'Resolve conflict…', run: openConflict });
  }
  if (workbench.preview !== 'file') actions.unshift({ label: 'Back to file preview', run: () => selectWorkingFile({ path }, group) });
  commandList('File actions', actions);
}

async function openPatch(path, group) {
  const token = ++state.viewRequest;
  workbench.preview = 'patch';
  workbench.patch = null;
  el('detail').hidden = true;
  el('patch-controls').hidden = true;
  clearCode('Loading selectable changes…');
  showPreview();
  try {
    const patch = await callTool('git_patch', { repoPath: state.checkout, path, group });
    if (token !== state.viewRequest) return;
    if (patch.disabledReason || !patch.hunks.length) {
      showDetail(element('p', 'sc-muted', patch.disabledReason || 'No selectable changes.'));
      return;
    }
    workbench.patch = patch;
    const content = element('div', 'sc-patch-list');
    const selectedHunks = new Set(), selectedLines = new Set();
    const bar = el('patch-controls');
    const action = group === 'staged' ? 'unstage' : 'stage';
    const label = action === 'stage' ? 'Stage selection' : 'Unstage selection';
    const apply = (selectedAction, confirmed = false) => performAction('git_apply_patch', {
      action: selectedAction, token: patch.token, path, group, hunkIds: [...selectedHunks], lineIds: [...selectedLines], ...(confirmed ? { confirmed } : {}),
    }, selectedAction === 'discard' ? 'Discard selection' : label);
    const applyButton = control(label, () => apply(action), 'sc-primary');
    const discard = control('Discard selection…', () => actionForm('Discard selected changes', [], (_, confirmed) => apply('discard', confirmed),
      { confirmation: path + ' · Restore the selected changes from the index', submitLabel: 'Discard selection' }));
    const update = () => { applyButton.disabled = discard.disabled = !selectedHunks.size && !selectedLines.size; };
    bar.replaceChildren(control('Back to diff', () => selectWorkingFile({ path }, group)), applyButton);
    if (group === 'unstaged') bar.append(discard);
    bar.hidden = false;
    for (const hunk of patch.hunks) {
      const section = element('div', 'sc-patch-hunk');
      const header = element('label', 'sc-patch-line sc-patch-header');
      const input = element('input');
      input.type = 'checkbox';
      input.setAttribute('aria-label', 'Select entire hunk ' + hunk.header);
      header.append(input, element('span', '', hunk.header));
      section.append(header);
      const hunkInputs = [];
      for (const line of hunk.lines) {
        const changed = line.kind === 'addition' || line.kind === 'deletion';
        const row = element(changed ? 'label' : 'div', 'sc-patch-line ' + line.kind);
        if (changed) {
          const choice = element('input');
          choice.type = 'checkbox';
          const prefix = line.kind === 'addition' ? 'Added: ' : 'Removed: ';
          choice.setAttribute('aria-label', prefix + line.text);
          choice.onchange = () => {
            if (choice.checked) selectedLines.add(line.id);
            else selectedLines.delete(line.id);
            update();
          };
          hunkInputs.push({ choice, id: line.id });
          row.append(choice);
        } else row.append(element('span', 'sc-patch-indent'));
        row.append(element('span', '', line.text));
        section.append(row);
      }
      input.onchange = () => {
        if (input.checked) selectedHunks.add(hunk.id);
        else selectedHunks.delete(hunk.id);
        for (const item of hunkInputs) {
          item.choice.checked = input.checked;
          item.choice.disabled = input.checked;
          selectedLines.delete(item.id);
        }
        update();
      };
      content.append(section);
    }
    update();
    showDetail(content);
  } catch (error) {
    if (token === state.viewRequest) clearCode(error.message);
  }
}

async function openConflict() {
  const path = state.selection?.path;
  if (!path) return;
  const token = openDetail(path, 'Resolve conflict', 'conflict');
  el('file-view-modes').hidden = false;
  try {
    const versions = await callTool('git_conflict', { repoPath: state.checkout, path });
    if (token !== state.viewRequest) return;
    const columns = element('div', 'sc-conflict-columns');
    for (const [key, label] of [['ours', 'Ours'], ['base', 'Base'], ['theirs', 'Theirs']]) {
      const column = element('section', 'sc-conflict-version');
      column.append(element('strong', '', label), element('pre', '', versions[key] ?? 'No text for this version'));
      columns.append(column);
    }
    const result = element('textarea', 'sc-input sc-merge-result');
    result.value = versions.current ?? '';
    result.rows = 8;
    result.disabled = !versions.expected;
    result.setAttribute('aria-label', 'Resolved file content');
    result.spellcheck = false;
    const actions = element('div', 'sc-actions');
    const resolve = (choice, args = {}) => actionForm('Resolve conflict', [], (_, confirmed) =>
      performAction('git_operation', { action: 'conflictResolve', path, choice, ...args, confirmed }, 'Resolve conflict'),
    { confirmation: path + ' · Stage resolved version', submitLabel: 'Confirm resolution' });
    if (versions.expected) actions.append(control('Save and stage', () => resolve('edit', { content: result.value, expected: versions.expected }), 'sc-primary'));
    for (const [choice, label] of [['ours', 'Use ours'], ['theirs', 'Use theirs'], ['base', 'Use base'], ['current', 'Stage working file'], ['delete', 'Resolve by deleting']]) {
      actions.append(control(label, () => resolve(choice)));
    }
    const note = element('p', 'sc-muted', versions.message || 'Edit the result or select a version to stage.');
    showDetail(columns, note, result, actions);
  } catch (error) {
    if (token === state.viewRequest) clearCode(error.message);
  }
}

function initializeWorkbench() {
  for (const button of document.querySelectorAll('[data-pane-button]')) {
    button.onclick = () => setPane(button.dataset.paneButton);
  }
  el('tree-toggle').onclick = () => {
    workbench.tree = !workbench.tree;
    el('tree-toggle').setAttribute('aria-pressed', String(workbench.tree));
    renderFiles();
    savePreference();
  };
  el('action-close').onclick = () => el('action-dialog').close();
  el('commands').onclick = showCommands;
  el('branch-button').onclick = chooseBranch;
  el('history-refs').onclick = chooseReference;
  el('history-compare').onclick = compareForm;
  el('history-more').onclick = () => loadHistory({ more: true });
  el('commit-options').onclick = showCommitOptions;
  el('file-actions').onclick = openFileActions;
  el('commit-message').oninput = updateCommitButton;
  el('commit-form').onsubmit = event => {
    event.preventDefault();
    const message = el('commit-message').value.trim();
    if (message && !el('commit-submit').disabled) performAction('git_commit', { action: 'commit', message }, 'Commit staged');
  };
  el('commit-message').onkeydown = event => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      el('commit-form').requestSubmit();
    }
  };
  el('files').addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !event.target.matches('.sc-file-button')) return;
    const buttons = [...el('files').querySelectorAll('.sc-file-button')];
    const position = buttons.indexOf(event.target);
    const next = { ArrowDown: position + 1, ArrowUp: position - 1, Home: 0, End: buttons.length - 1 }[event.key];
    event.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
  });
}
