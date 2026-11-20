const workbench = {
  tree: false, folders: new Set(), drafts: new Map(),
  history: null, historyPath: null, historyRef: null, historyKey: '', historyRequest: 0,
  historySelection: null, preview: 'file', patch: null, busy: null,
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) uiText(node, text);
  return node;
}

function control(text, onClick, className = 'sc-control') {
  const button = element('button', className, text);
  button.type = 'button';
  button.onclick = onClick;
  return button;
}

function resetPreview() {
  workbench.preview = 'file';
  workbench.patch = null;
  selectHistoryCommit(null);
  el('patch-controls').hidden = true;
  el('detail').hidden = true;
  el('file-view-modes').hidden = false;
  el('file-actions').disabled = !state.selection;
}

function newCheckout(oldCheckout) {
  if (oldCheckout) workbench.drafts.set(oldCheckout, el('commit-message').value);
  el('commit-message').value = workbench.drafts.get(state.checkout) || '';
  workbench.output = '';
  resetHistoryCheckout();
  resetPreview();
  closePreview({ restore: false });
  updateCommitButton();
}

function repositoryStatusChanged() {
  el('file-actions').disabled = !state.selection;
  updateCommitButton();
  renderHistoryStatus();
  loadHistory();
}

async function performAction(tool, args, label) {
  if (workbench.busy || state.staging) return false;
  const action = msg(label);
  const checkout = state.checkout;
  const epoch = state.epoch;
  const token = { checkout };
  const submittedDraft = el('commit-message').value;
  workbench.busy = token;
  state.viewRequest++;
  state.statusRequest++;
  state.refreshEpoch = null;
  showActionMessage(msg('{action}…', { action }), { pending: true });
  updateCommitButton();
  renderHistoryStatus();
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
    const completedEpoch = result.checkout && result.checkout !== checkout ? epoch + 1 : epoch;
    if (completedEpoch !== epoch) {
      await switchCheckout(result.checkout);
    } else {
      const status = result.status?.checkout ? result.status : result.staged ? result : null;
      if (status) renderStatus(status);
    }
    if (completedEpoch !== state.epoch) return true;
    showActionMessage(msg('{action} completed', { action }));
    if (result.message || result.output) workbench.output = result.output || result.message;
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
      showActionMessage(msg('{action} failed', { action }));
    }
  } finally {
    if (workbench.busy === token) workbench.busy = null;
    updateCommitButton();
    renderHistoryStatus();
    renderFiles();
    if (epoch === state.epoch) {
      if (workbench.preview === 'patch') resetPreview();
      await refresh({ force: true });
      if (tool !== 'git_change' && tool !== 'git_apply_patch') await loadHistory({ reset: true });
    }
  }
  return success;
}

function selectWorkingFile(file, group, { revealPreview = true } = {}) {
  state.selection = { path: file.path, group };
  resetPreview();
  const files = el('files');
  const previous = files.querySelector('.sc-file-button[aria-pressed=true]');
  previous?.setAttribute('aria-pressed', 'false');
  if (previous) previous.parentElement.dataset.selected = 'false';
  const selected = [...files.querySelectorAll('.sc-file-button')].find(button =>
    button.dataset.path === file.path && button.dataset.group === group);
  selected?.setAttribute('aria-pressed', 'true');
  if (selected) selected.parentElement.dataset.selected = 'true';
  clearCode(msg('Loading file…'));
  el('code').scrollTop = 0;
  if (group === 'conflicts') openConflict({ revealPreview });
  else {
    loadFile();
    if (revealPreview) showPreview();
  }
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
        let open = !workbench.folders.has(key);
        let children;
        const makeChildren = () => {
          children = element('ul');
          appendItems(children, item.children);
          entry.append(children);
        };
        const toggle = control(item.name, () => {
          open = !open;
          if (open) {
            workbench.folders.delete(key);
            if (!children) {
              makeChildren();
              children.hidden = true;
            }
          } else workbench.folders.add(key);
          toggle.setAttribute('aria-expanded', String(open));
          if (children) setPanelContentVisible(children, open);
        }, 'sc-folder-toggle');
        toggle.dataset.folder = key;
        toggle.setAttribute('aria-expanded', String(open));
        toggle.prepend(icon('chevron'));
        entry.append(toggle);
        if (open) makeChildren();
        parent.append(entry);
      }
    }
  }
  appendItems(list, buildFileTree(files));
  return list;
}

function groupMenuEntries(group) {
  const action = group === 'staged' ? 'unstage' : 'stage';
  const label = action === 'stage' ? 'Stage group' : 'Unstage group';
  const busy = !!workbench.busy || !!state.staging;
  const epoch = state.epoch;
  const entries = [{ label, symbol: action === 'stage' ? 'plus' : 'minus', disabled: busy,
    run: () => {
      if (epoch === state.epoch) performAction('git_change', group === 'unstaged' ? { action } : { action, group }, label);
    },
  }];
  if (group !== 'unstaged') return entries;
  for (const scope of ['unstaged', 'untracked']) {
    if (!state.status?.[scope].length) continue;
    const discard = scope === 'unstaged' ? 'Discard unstaged changes' : 'Remove untracked files';
    const menuOnly = scope === 'untracked' && state.status.unstaged.length > 0;
    entries.push({ label: discard, symbol: 'discard', disabled: busy, menuOnly, run: () => {
      if (epoch !== state.epoch || !state.status) return;
      const expectedPaths = state.status[scope].map(file => file.path);
      const total = expectedPaths.length;
      actionForm(discard, [], (_, confirmed) =>
        performAction('git_change', { action: 'discard', group: scope, confirmed, expectedPaths }, discard),
      { confirmation: msg(total === 1 ? '{action} · {count} file · {checkout}' : '{action} · {count} files · {checkout}', {
        action: msg(discard), count: total, checkout: state.checkout,
      }) });
    } });
  }
  return entries;
}

function renderSplit(view) {
  const fragment = document.createDocumentFragment();
  const scroller = el('code');
  const oldScroll = { top: scroller.scrollTop, left: scroller.scrollLeft };
  const labels = element('div', 'sc-split-row sc-split-labels');
  labels.append(element('span', '', view.group === 'staged' ? 'HEAD' : msg('Before')),
    element('span', '', msg(view.group === 'staged' ? 'Index' : 'After')));
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

function openDetail(title, subtitle, type, { revealPreview = true } = {}) {
  el('code').classList.remove('sc-detail-diff');
  const token = ++state.viewRequest;
  workbench.preview = type;
  el('patch-controls').hidden = true;
  el('file-view-modes').hidden = true;
  uiText(el('file-title'), title);
  uiText(el('file-context'), subtitle);
  el('detail').replaceChildren();
  el('detail').hidden = true;
  clearCode(msg('Loading…'));
  if (revealPreview) showPreview();
  return token;
}

function showDetail(...content) {
  el('code').hidden = true;
  el('images').hidden = true;
  el('view-message').hidden = true;
  el('detail').replaceChildren(...content);
  el('detail').hidden = false;
}

function showReadDiff(text, sourceLabel, truncated) {
  el('detail').hidden = false;
  el('code').classList.add('sc-detail-diff');
  renderCode(text ? { text, sourceLabel, displayMode: 'diff' } : {
    sourceLabel, message: msg(truncated ? 'This diff exceeds the preview limit.' : 'No text changes for this file.'),
  });
}

async function openCommit(commit, path = null, parent) {
  const title = msg('Commit {hash}', { hash: commit.slice(0, 8) });
  const subtitle = msg('History');
  const token = openDetail(title, subtitle, 'history');
  selectHistoryCommit(commit, path);
  try {
    const result = await callTool('git_history_detail', { repoPath: state.checkout, commit, ...(path ? { path } : {}), ...(parent ? { parent } : {}) });
    if (token !== state.viewRequest) return;
    if (path && !result.files.some(file => file.path === path || file.originalPath === path)) {
      await openCommit(commit, null, parent);
      return;
    }
    uiText(el('file-title'), result.commit.subject || title);
    const refs = element('div', 'sc-actions');
    refs.append(control(msg('Copy hash'), () => copyText(commit)), control(msg('Copy message'), () => copyText(result.message)),
      control(msg('Compare with working copy'), () => openCompare({ from: commit })),
      control(msg('Checkout detached'), () => runCommand('checkoutDetached', { ref: commit })),
      control(msg('Cherry-pick'), () => runCommand('cherryPick', { ref: commit })));
    const message = element('pre', 'sc-commit-text', result.message);
    const info = element('p', 'sc-muted', result.commit.author + ' · ' + commit + ' · ' + new Date(result.commit.date).toLocaleString());
    if (result.commit.parents.length > 1) {
      const select = element('select', 'sc-input');
      uiAttr(select, 'aria-label', msg('Compare to parent'));
      result.commit.parents.forEach((id, i) => {
        const option = element('option', '', msg('Parent {number} · {hash}', { number: i + 1, hash: id.slice(0, 8) }));
        option.value = id;
        option.selected = (parent || result.commit.parents[0]) === id;
        select.append(option);
      });
      select.onchange = () => openCommit(commit, path, select.value);
      refs.append(select);
    }
    if (path) refs.prepend(control(msg('Back to commit files'), () => openCommit(commit, null, parent)));
    showDetail(info, message, refs, changedFileList(result.files, file => openCommit(commit, file.path, parent)));
    if (path) showReadDiff(result.diff, subtitle, result.diffTruncated);
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
  const subtitle = args.to ? args.from + ' → ' + args.to : msg('{from} → working copy', { from: args.from });
  const token = openDetail(msg('Compare changes'), subtitle, 'compare');
  try {
    const result = await callTool('git_compare', { repoPath: state.checkout, ...args });
    if (token !== state.viewRequest) return;
    const files = result.files.length
      ? changedFileList(result.files, file => openCompare({ ...args, path: file.path }))
      : element('p', 'sc-muted', msg('No changed files.'));
    if (args.path) {
      const { path, ...comparison } = args;
      showDetail(control(msg('Back to changed files'), () => openCompare(comparison)), files);
    } else showDetail(files);
    if (args.path) showReadDiff(result.diff, subtitle, result.diffTruncated);
  } catch (error) {
    if (token === state.viewRequest) clearCode(error.message);
  }
}

async function openBlame(path) {
  const token = openDetail(path, msg('Line attribution'), 'blame');
  try {
    const result = await callTool('git_blame', { repoPath: state.checkout, path });
    if (token !== state.viewRequest) return;
    const list = element('div', 'sc-detail-files');
    for (const entry of result.lines) {
      const summary = entry.summary || entry.commit?.slice(0, 8);
      const caption = summary ? entry.line + ' · ' + entry.author + ' · ' + summary
        : msg('{line} · {author} · Working copy', { line: entry.line, author: entry.author });
      const button = control(caption, () => openCommit(entry.commit, path), 'sc-detail-file');
      button.disabled = !entry.commit;
      list.append(button);
    }
    showDetail(list);
  } catch (error) {
    if (token === state.viewRequest) clearCode(error.message);
  }
}

async function openWorkingItem(path, action) {
  const epoch = state.epoch;
  try {
    await callTool('desktop_file_action', { repoPath: state.checkout, path, action });
    if (epoch === state.epoch) showError();
  } catch (error) {
    if (epoch === state.epoch) showError(error.message);
  }
}

function fileMenuEntries(selection) {
  if (!selection) return [];
  const epoch = state.epoch;
  const { path, group } = selection;
  const file = state.status?.[group].find(item => item.path === path);
  const historyPath = file?.originalPath || path;
  const staging = group === 'staged' ? 'Unstage' : 'Stage';
  const actions = [
    { label: 'Open Diff', run: () => { setMode('diff'); selectWorkingFile({ path }, group); } },
    { label: 'Open file', run: () => openWorkingItem(path, 'open') },
    { label: 'Open containing folder', run: () => openWorkingItem(path, 'folder') },
    { label: staging, disabled: !!state.staging || !!workbench.busy, run: () => changeStaging(path, group) },
    { separator: true },
    { label: 'File history', disabled: group === 'untracked', run: () => filterHistory(null, historyPath) },
    { label: 'Line attribution', disabled: group === 'untracked', run: () => openBlame(path) },
    { label: 'Copy path', run: () => copyText(path) },
  ];
  if (['staged', 'unstaged', 'untracked'].includes(group)) {
    actions.unshift({ label: 'Select lines or hunks…', run: () => { selectWorkingFile({ path }, group); openPatch(path, group); } });
  }
  if (group === 'unstaged') {
    actions.push({ label: 'Discard working-copy changes…', run: () => actionForm('Discard changes', [], (_, confirmed) =>
      performAction('git_change', { action: 'discard', path, group, confirmed }, 'Discard changes'),
    { confirmation: msg('{path} · Restore from index', { path }), submitLabel: 'Discard changes' }) });
  }
  if (group === 'untracked') {
    actions.push({ label: 'Ignore file…', run: () => actionForm('Ignore file', [], (_, confirmed) =>
      performAction('git_change', { action: 'ignore', path, group, confirmed }, 'Ignore file'),
    { confirmation: msg('{path} · Add to .gitignore', { path }), submitLabel: 'Ignore' }) });
  }
  if (group !== 'conflicts') {
    actions.push(
      { label: 'Rename file…', run: () => actionForm('Rename file', [field('newPath', 'New repository-relative path', { value: path })], (values, confirmed) =>
        performAction('git_change', { action: 'rename', path, group, ...values, confirmed }, 'Rename file'),
      { confirmation: msg('{path} · Rename in working copy', { path }) }) },
      { label: 'Delete file…', run: () => actionForm('Delete file', [], (_, confirmed) =>
        performAction('git_change', { action: 'delete', path, group, confirmed }, 'Delete file'),
      { confirmation: msg('{path} · Delete from working copy', { path }), submitLabel: 'Delete file' }) },
    );
  } else {
    actions.unshift({ label: 'Resolve conflict…', run: () => selectWorkingFile({ path }, group) });
  }
  if (workbench.preview === 'patch') actions.unshift({ label: 'Back to file preview', run: () => selectWorkingFile({ path }, group) });
  return actions.map(entry => entry.run ? {
    ...entry, run: (...args) => {
      if (epoch === state.epoch && state.status?.[group].some(item => item.path === path)) return entry.run(...args);
    },
  } : entry);
}

function openFileActions(event) {
  openContextMenu(fileMenuEntries(state.selection), { anchor: event.currentTarget, label: 'File actions' });
}

async function openPatch(path, group) {
  const token = ++state.viewRequest;
  workbench.preview = 'patch';
  workbench.patch = null;
  el('detail').hidden = true;
  el('patch-controls').hidden = true;
  clearCode(msg('Loading selectable changes…'));
  showPreview();
  try {
    const patch = await callTool('git_patch', { repoPath: state.checkout, path, group });
    if (token !== state.viewRequest) return;
    if (patch.disabledReason || !patch.hunks.length) {
      showDetail(element('p', 'sc-muted', msg(patch.disabledReason || 'No selectable changes.')));
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
    const applyButton = control(msg(label), () => apply(action), 'sc-primary');
    const discard = control(msg('Discard selection…'), () => actionForm('Discard selected changes', [], (_, confirmed) => apply('discard', confirmed),
      { confirmation: msg('{path} · Restore the selected changes from the index', { path }), submitLabel: 'Discard selection' }));
    const update = () => { applyButton.disabled = discard.disabled = !selectedHunks.size && !selectedLines.size; };
    bar.replaceChildren(control(msg('Back to diff'), () => selectWorkingFile({ path }, group)), applyButton);
    if (group === 'unstaged') bar.append(discard);
    bar.hidden = false;
    for (const hunk of patch.hunks) {
      const section = element('div', 'sc-patch-hunk');
      const header = element('label', 'sc-patch-line sc-patch-header');
      const input = element('input');
      input.type = 'checkbox';
      uiAttr(input, 'aria-label', msg('Select entire hunk {header}', { header: hunk.header }));
      header.append(input, element('span', '', hunk.header));
      section.append(header);
      const hunkInputs = [];
      for (const line of hunk.lines) {
        const changed = line.kind === 'addition' || line.kind === 'deletion';
        const row = element(changed ? 'label' : 'div', 'sc-patch-line ' + line.kind);
        if (changed) {
          const choice = element('input');
          choice.type = 'checkbox';
          uiAttr(choice, 'aria-label', msg(line.kind === 'addition' ? 'Added: {line}' : 'Removed: {line}', { line: line.text }));
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

async function openConflict({ revealPreview = true } = {}) {
  const path = state.selection?.path;
  if (!path) return;
  const token = openDetail(path, msg('Resolve conflict'), 'conflict', { revealPreview });
  el('file-view-modes').hidden = false;
  try {
    const versions = await callTool('git_conflict', { repoPath: state.checkout, path });
    if (token !== state.viewRequest) return;
    const columns = element('div', 'sc-conflict-columns');
    for (const [key, label] of [['ours', 'Ours'], ['base', 'Base'], ['theirs', 'Theirs']]) {
      const column = element('section', 'sc-conflict-version');
      column.append(element('strong', '', msg(label)), element('pre', '', versions[key] ?? msg('No text for this version')));
      columns.append(column);
    }
    const result = element('textarea', 'sc-input sc-merge-result');
    result.value = versions.current ?? '';
    result.rows = 8;
    result.disabled = !versions.expected;
    uiAttr(result, 'aria-label', msg('Resolved file content'));
    result.spellcheck = false;
    const actions = element('div', 'sc-actions');
    const resolve = (choice, args = {}) => actionForm('Resolve conflict', [], (_, confirmed) =>
      performAction('git_operation', { action: 'conflictResolve', path, choice, ...args, confirmed }, 'Resolve conflict'),
    { confirmation: msg('{path} · Stage resolved version', { path }), submitLabel: 'Confirm resolution' });
    if (versions.expected) actions.append(control(msg('Save and stage'), () => resolve('edit', { content: result.value, expected: versions.expected }), 'sc-primary'));
    for (const [choice, label] of [['ours', 'Use ours'], ['theirs', 'Use theirs'], ['base', 'Use base'], ['current', 'Stage working file'], ['delete', 'Resolve by deleting']]) {
      actions.append(control(msg(label), () => resolve(choice)));
    }
    const note = element('p', 'sc-muted', msg(versions.message || 'Edit the result or select a version to stage.'));
    showDetail(columns, note, result, actions);
  } catch (error) {
    if (token === state.viewRequest) clearCode(error.message);
  }
}

function initializeWorkbench() {
  setupWorkspaceShell();
  initializeHistory();
  el('tree-toggle').onclick = () => {
    workbench.tree = !workbench.tree;
    el('tree-toggle').setAttribute('aria-pressed', String(workbench.tree));
    uiAttr(el('tree-toggle'), 'aria-label', msg(workbench.tree ? 'Show file list' : 'Show file tree'));
    renderFiles();
    savePreference();
  };
  el('action-close').onclick = () => el('action-dialog').close();
  el('commands').onclick = event => showCommands(event.currentTarget, event);
  el('changes-actions').onclick = event => showChangesActions(event.currentTarget);
  el('file-actions').onclick = openFileActions;
  el('commit-form').onsubmit = event => {
    event.preventDefault();
    runPrimaryAction(el('commit-submit'));
  };
  el('commit-message').onkeydown = event => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      const { kind } = scmPrimaryAction(state.status);
      if (kind === 'commit' || kind === 'commitAll') submitCommit();
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
