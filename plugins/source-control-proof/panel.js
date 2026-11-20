const el = id => document.getElementById(id);
const groups = [['conflicts', 'Merge Changes'], ['staged', 'Staged Changes'], ['unstaged', 'Changes'], ['untracked', 'Untracked Files']];
const collapsedFileGroups = new Set();
const state = { checkout: null, status: null, selection: null, mode: 'diff', projects: [], homeDirectory: '', epoch: 0, viewRequest: 0, statusRequest: 0, staging: null, refreshEpoch: null, hostContext: {} };
const pending = new Map();
let requestId = 0, pickerSignature = '';
const expandedProjects = new Set();
let imageSignature = '', catalogRequest = null;

function shortPath(path) {
  const home = state.homeDirectory.replace(/[\\/]+$/, '');
  return home && (path.startsWith(home + '/') || path.startsWith(home + '\\')) ? '~' + path.slice(home.length) : path;
}
async function refreshProjects() {
  if (catalogRequest) return catalogRequest;
  catalogRequest = (async () => {
    const catalog = await callTool('git_projects');
    state.projects = catalog.projects; state.homeDirectory = catalog.homeDirectory || '';
    renderPicker();
    renderRepositories();
    if (catalog.discovery?.warning) showError(msg(catalog.discovery.warning));
  })();
  try { await catalogRequest; } finally { catalogRequest = null; }
}

function icon(name, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: className })) svg.setAttribute(key, value);
  const paths = { repo: 'M4 4h13a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2V4Zm0 13h15M8 8h7M8 11h5', file: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Zm0 0v6h6M8 13h8M8 17h5', image: 'M4 4h16v16H4ZM4 16l5-5 4 4 3-3 4 4M14 8h.01', plus: 'M12 5v14M5 12h14', minus: 'M5 12h14', check: 'm5 12 4 4L19 6', chevron: 'm7 10 5 5 5-5', branch: 'M6 3v12M18 9a9 9 0 0 1-9 9' };
  Object.assign(paths, {
    refresh: 'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 11.5-1L20 9M4 15l2.5 3A7 7 0 0 0 18 17',
    search: 'M15 15l5 5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
    back: 'M19 12H5m6-6-6 6 6 6', target: 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
    tree: 'M5 4v14h6M5 10h6m0-2h7v4h-7zm0 8h7v4h-7z', more: 'M4 12h.5m7.25 0h.5m7.25 0h.5',
    fetch: 'M12 3v12m-4-4 4 4 4-4m-11 8h14', pull: 'M12 4v13m-5-5 5 5 5-5M5 20h14',
    push: 'M12 20V7m-5 5 5-5 5 5M5 4h14', diff: 'M9 4H4v16h5m6-16h5v16h-5m-5-8h4',
    warning: 'M12 3 2 20h20ZM12 9v4m0 3h.01', discard: 'M9 7 4 12l5 5M4 12h11a5 5 0 0 0 5-5',
  });
  const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', paths[name] || paths.file); svg.append(path);
  if (name === 'branch') for (const [cx, cy] of [[18,6],[6,18]]) { const circle = document.createElementNS(svg.namespaceURI, 'circle'); circle.setAttribute('cx', cx); circle.setAttribute('cy', cy); circle.setAttribute('r', 3); svg.append(circle); }
  return svg;
}

function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Git request timed out. Refresh to verify the result.')); }, params?.name === 'git_operation' || params?.name === 'git_commit' ? 200000 : 15000);
    pending.set(id, { resolve, reject, timeout });
    window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
  });
}
async function callTool(name, args = {}) {
  const result = await request('tools/call', { name, arguments: args });
  if (result.isError) throw new Error(result.content?.[0]?.text || 'Request failed.');
  return result.structuredContent;
}
function showError(message = '') {
  const display = message === 'Git request timed out. Refresh to verify the result.' ? msg(message) : message;
  uiText(el('error'), display); el('error').hidden = !message; el('status-dot').dataset.error = String(!!message); }
function savePreference() {
  window.openai?.setWidgetState?.({
    checkout: state.checkout, mode: state.mode, tree: workbench.tree,
    split: shellState.ratio, collapsed: [...shellState.collapsed], language: panelLanguage,
  });
}
function renderPicker() {
  const currentProject = state.projects.find(project => project.checkouts.some(checkout => checkout.path === state.checkout));
  const isWorktree = currentProject && state.checkout !== currentProject.path;
  const projectLabel = currentProject ? isWorktree ? msg('{project} · Worktree', { project: currentProject.label }) : currentProject.label
    : state.checkout?.split(/[\\/]/).filter(Boolean).at(-1) || msg('Choose repository');
  const query = el('project-search').value.trim().toLowerCase();
  const signature = JSON.stringify([state.projects, state.checkout, state.homeDirectory, query, [...expandedProjects]]);
  if (signature === pickerSignature) return;
  pickerSignature = signature;
  const list = el('project-list'); list.replaceChildren(); const known = new Set();
  const projects = [...state.projects].sort((a,b) => Number(b === currentProject) - Number(a === currentProject) || a.label.localeCompare(b.label));
  function option(project, checkout, worktree = false) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'sc-picker-option';
    button.dataset.checkout = checkout.path; button.title = checkout.path;
    button.setAttribute('aria-current', String(checkout.path === state.checkout));
    button.append(icon(worktree ? 'branch' : 'repo', 'sc-picker-symbol'));
    const copy = document.createElement('span'); copy.className = 'sc-picker-copy';
    const name = document.createElement('span'); name.className = 'sc-picker-name'; uiText(name, worktree ? checkout.branch : project.label);
    const branch = document.createElement('span'); branch.className = 'sc-picker-branch'; uiText(branch, worktree ? shortPath(checkout.path) : checkout.branch || msg('Custom checkout'));
    copy.append(name, branch); button.append(copy);
    if (checkout.path === state.checkout) button.append(icon('check', 'sc-picker-check'));
    button.onclick = () => { closePicker(); switchCheckout(checkout.path); };
    return button;
  }
  for (const project of projects) {
    if (!project.checkouts.length) continue;
    const checkouts = [];
    for (const checkout of project.checkouts) {
      if (!known.has(checkout.path)) { known.add(checkout.path); checkouts.push(checkout); }
    }
    if (!checkouts.length) continue;
    const matches = checkout => [project.label, checkout.branch, checkout.path].some(text => text.toLowerCase().includes(query));
    if (query && !checkouts.some(matches)) continue;
    const root = checkouts.find(checkout => checkout.path === project.path) || checkouts[0];
    const worktrees = checkouts.filter(checkout => checkout !== root);
    const entry = document.createElement('div'); entry.className = 'sc-picker-entry'; entry.append(option(project, root)); list.append(entry);
    const expanded = expandedProjects.has(project.path) || !!query;
    if (worktrees.length) {
      if (!query) { const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'sc-worktree-toggle';
      toggle.textContent = worktrees.length; toggle.append(icon('chevron')); uiAttr(toggle, 'aria-label', msg('Worktrees for {project}', { project: project.label })); toggle.setAttribute('aria-expanded', String(expanded));
      toggle.onclick = () => { if (expandedProjects.has(project.path)) expandedProjects.delete(project.path); else expandedProjects.add(project.path); renderPicker(); el('project-list').querySelector('[data-worktrees="' + CSS.escape(project.path) + '"]')?.focus(); };
      toggle.dataset.worktrees = project.path; entry.append(toggle); }
      if (expanded) { const children = document.createElement('div'); children.className = 'sc-picker-worktrees'; for (const checkout of worktrees.filter(matches)) children.append(option(project, checkout, true)); list.append(children); }
    }
  }
  if (state.checkout && !known.has(state.checkout)) {
    const checkout = { path: state.checkout, branch: state.status?.branch };
    if (!query || state.checkout.toLowerCase().includes(query)) list.prepend(option({ label: projectLabel }, checkout));
  }
  if (!list.childElementCount) { const empty = document.createElement('div'); empty.className = 'sc-picker-no-results'; uiText(empty, msg(query ? 'No repositories match your search.' : 'No saved repositories.')); list.append(empty); }
}
function openPicker() {
  el('project-popover').hidden = false; el('project').setAttribute('aria-expanded', 'true');
  el('project-search').value = ''; el('custom-form').hidden = true; renderPicker(); el('project-search').focus();
  refreshProjects().catch(error => showError(error.message));
}
function closePicker(restoreFocus = true) {
  el('project-popover').hidden = true; el('project').setAttribute('aria-expanded', 'false');
  if (restoreFocus) el('project').focus();
}
function emptyViewer(message) {
  uiText(el('file-title'), msg('Preview')); uiText(el('file-context'), msg('Select a file or commit'));
  el('code').classList.remove('sc-detail-diff');
  el('code').replaceChildren(); el('code').hidden = true;
  el('images').replaceChildren(); el('images').hidden = true;
  imageSignature = '';
  const title = document.createElement('strong'); uiText(title, msg('Select a file or commit'));
  const detail = document.createElement('span'); uiText(detail, message || msg('Review changes and Git history.'));
  uiText(el('view-message'), '');
  el('view-message').replaceChildren(title, detail); el('view-message').dataset.notice = 'false'; el('view-message').hidden = false;
}
function renderFiles() {
  const scrollContainer = el('changes-body');
  const scrollTop = scrollContainer.scrollTop;
  const focus = el('files').contains(document.activeElement) ? railFocusKey(document.activeElement) : null;
  const rendered = document.createDocumentFragment();
  for (const [key, title] of groups) {
    const rows = state.status?.[key] || [];
    if (!rows.length) continue;
    const open = !collapsedFileGroups.has(key);
    const section = element('section', 'sc-group');
    const heading = element('h3', 'sc-group-heading');
    const toggle = control('', () => {
      if (open) collapsedFileGroups.add(key);
      else collapsedFileGroups.delete(key);
      renderFiles();
    }, 'sc-group-toggle');
    toggle.append(icon('chevron'), element('span', '', msg(title)));
    toggle.setAttribute('aria-expanded', String(open));
    toggle.dataset.focusKey = 'group:' + key;
    const actions = element('div', 'sc-group-actions');
    actions.append(element('span', 'sc-count', rows.length));
    const entries = () => groupMenuEntries(key);
    for (const entry of entries()) {
      const action = repositoryButton(entry.label, entry.symbol, entry.run);
      action.disabled = !!entry.disabled;
      action.dataset.focusKey = 'group-action:' + key + ':' + entry.symbol;
      actions.append(action);
    }
    bindContextMenu(heading, entries, { anchor: toggle });
    heading.append(toggle, actions);
    section.append(heading);
    if (open) section.append(fileTreeItems(rows, key, file => workingFileRow(file, key)));
    rendered.append(section);
  }
  if (!rendered.childElementCount && state.status) rendered.append(element('p', 'sc-empty sc-clean', msg('Working tree clean')));
  el('files').replaceChildren(rendered);
  scrollContainer.scrollTop = scrollTop;
  restoreRailFocus(el('files'), focus);
}

function workingFileRow(file, group) {
  const selection = { path: file.path, group };
  const row = element('li', 'sc-file-row');
  const current = state.selection?.path === file.path && state.selection?.group === group;
  row.dataset.selected = String(current);
  const button = control('', () => selectWorkingFile(file, group), 'sc-file-button');
  button.dataset.path = file.path;
  button.dataset.group = group;
  button.dataset.focusKey = JSON.stringify(['file', group, file.path]);
  button.setAttribute('aria-pressed', String(current));
  const status = file.change || file.status;
  const badge = element('span', 'sc-file-status', group === 'untracked' ? 'U' : status);
  badge.dataset.status = status;
  const description = file.originalPath ? file.originalPath + ' → ' + file.path : file.path;
  const path = element('span', 'sc-file-path');
  path.append(element('span', 'sc-file-name', file.path.split('/').at(-1)));
  const directory = file.path.includes('/') ? file.path.slice(0,file.path.lastIndexOf('/')) : '';
  if ((!workbench.tree && directory) || file.originalPath) {
    path.append(element('span', 'sc-file-directory', file.originalPath ? description : directory));
  }
  button.setAttribute('aria-label', description);
  const imageFile = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i.test(file.path);
  button.append(icon(imageFile ? 'image' : 'file', 'sc-file-icon'), path);
  bindTooltip(button, description);
  const entries = () => fileMenuEntries(selection);
  const actions = element('div', 'sc-file-actions');
  if (group !== 'conflicts') {
    const diff = repositoryButton('Open Diff', 'diff', () => { setMode('diff'); selectWorkingFile(file, group); });
    diff.dataset.focusKey = JSON.stringify(['diff', group, file.path]);
    actions.append(diff);
  }
  const stage = repositoryButton(group === 'staged' ? 'Unstage' : 'Stage', group === 'staged' ? 'minus' : 'plus', () => changeStaging(file.path, group));
  stage.classList.add('sc-file-stage');
  stage.dataset.path = file.path;
  stage.dataset.group = group;
  stage.dataset.focusKey = JSON.stringify(['stage', group, file.path]);
  stage.disabled = !!state.staging || !!workbench.busy;
  actions.append(stage);
  if (group === 'unstaged' || group === 'untracked') {
    const remove = group === 'untracked';
    const label = remove ? 'Remove untracked file' : 'Discard working-copy changes';
    const discard = repositoryButton(label, 'discard', () => actionForm(label, [], (_, confirmed) =>
      performAction('git_change', { action: 'discard', path: file.path, group, confirmed }, label),
    { confirmation: description + ' · ' + state.checkout, submitLabel: label }));
    discard.disabled = stage.disabled;
    discard.dataset.focusKey = JSON.stringify(['discard', group, file.path]);
    actions.append(discard);
  }
  const menu = repositoryButton('File actions', 'more', event =>
    openContextMenu(entries(), { anchor: event.currentTarget, label: 'File actions' }));
  menu.dataset.focusKey = JSON.stringify(['file-actions', group, file.path]);
  actions.append(menu);
  bindContextMenu(row, entries, { anchor: button });
  row.append(button, actions, badge);
  return row;
}

function renderStatus(data) {
  state.checkout = data.checkout; state.status = data;
  for (const project of state.projects) for (const checkout of project.checkouts) if (checkout.path === data.checkout) checkout.branch = data.branch;
  const count = new Set(groups.flatMap(([group]) => data[group].map(file => file.path))).size;
  el('total-count').textContent = count;
  el('total-count').hidden = !count;
  uiText(el('context'), msg('Checkout source: {source}', { source: data.contextSource }));
  uiText(el('time'), msg('Checked {time}', { time: new Date(data.checkedAt) }));
  uiText(el('diagnostics'), JSON.stringify({ launchDirectory: data.launchDirectory, contextSource: data.contextSource, hostContextKeys: Object.keys(state.hostContext) }, null, 2));
  if (state.selection && !data[state.selection.group].some(f => f.path === state.selection.path)) {
    state.selection = null;
    if (['file', 'patch', 'conflict'].includes(workbench.preview)) {
      state.viewRequest++;
      resetPreview();
      emptyViewer(msg('The selected file is no longer in this change group.'));
    }
  }
  renderPicker();
  renderRepositories();
  const changes = JSON.stringify(groups.map(([group]) => data[group]));
  if (changes !== workbench.changes) {
    workbench.changes = changes;
    renderFiles();
  }
  repositoryStatusChanged();
  savePreference();
}
async function refresh({ force = false } = {}) {
  if (!state.checkout) return;
  if (state.staging?.checkout === state.checkout || workbench.busy?.checkout === state.checkout) return;
  const epoch = state.epoch, requestedCheckout = state.checkout; if (!force && state.refreshEpoch === epoch) return;
  const requestToken = ++state.statusRequest;
  state.refreshEpoch = epoch; el('refresh').disabled = true;
  try {
    const data = await callTool('git_status', requestedCheckout ? { repoPath: requestedCheckout } : {});
    if (epoch !== state.epoch || requestToken !== state.statusRequest || (state.checkout !== requestedCheckout && state.checkout !== data.checkout)) return;
    renderStatus(data); if (state.selection && workbench.preview === 'file') await loadFile();
  } catch (error) { if (epoch === state.epoch && requestToken === state.statusRequest && state.checkout === requestedCheckout) { showError(error.message); } }
  finally {
    if (epoch === state.epoch && requestToken === state.statusRequest) {
      state.refreshEpoch = null;
      el('refresh').disabled = !!state.staging;
    }
  }
}
async function changeStaging(path, group) {
  if (state.staging || workbench.busy) return;
  const epoch = state.epoch, checkout = state.checkout, action = group === 'staged' ? 'unstage' : 'stage';
  const restoreFocus = document.activeElement?.classList.contains('sc-file-stage'); let failed = false;
  state.staging = { epoch, checkout, path, action }; state.statusRequest++; state.viewRequest++; state.refreshEpoch = null;
  el('refresh').disabled = true; uiText(el('staging-message'), msg(action === 'stage' ? 'Staging {file}…' : 'Unstaging {file}…', { file: path.split('/').at(-1) })); updateCommitButton(); renderHistoryStatus(); renderFiles();
  try {
    const data = await callTool('git_staging', { repoPath: checkout, path, group, action });
    if (epoch !== state.epoch) return;
    if (state.selection?.path === path && state.selection.group === group) {
      const nextGroup = (action === 'stage' ? ['staged'] : ['unstaged', 'untracked', 'conflicts']).find(key => data[key].some(file => file.path === path));
      state.selection = nextGroup ? { path, group: nextGroup } : null;
      resetPreview();
      if (!state.selection) emptyViewer(msg('The file has no remaining changes.'));
    }
    renderStatus(data);
    showError();
    uiText(el('staging-message'), msg(action === 'stage' ? 'Staged {file}' : 'Unstaged {file}', { file: path.split('/').at(-1) }));
    if (state.selection && workbench.preview === 'file') await loadFile();
  } catch (error) { failed = true; if (epoch === state.epoch) { showError(error.message); uiText(el('staging-message'), msg('Unable to confirm the staging result.')); } }
  finally {
    state.staging = null; updateCommitButton(); renderHistoryStatus(); renderFiles(); el('refresh').disabled = state.refreshEpoch !== null;
    if (epoch !== state.epoch || failed) await refresh({ force: true });
    if (epoch === state.epoch && restoreFocus && document.activeElement === document.body) {
      const target = [...el('files').querySelectorAll('.sc-file-stage')].find(button => button.dataset.path === path);
      (target || el('refresh')).focus({ preventScroll: true });
    }
  }
}
async function switchCheckout(checkout, { focusRepository = false } = {}) {
  const previous = state.checkout;
  if (checkout === previous && state.status) return;
  closeWorkbenchOverlays();
  if (el('action-dialog').open) el('action-dialog').close();
  closePicker(false);
  collapsedActiveProjects.clear();
  const epoch = ++state.epoch;
  state.viewRequest++;
  state.checkout = checkout;
  state.selection = null;
  state.status = null;
  newCheckout(previous);
  uiText(el('staging-message'), '');
  uiText(el('context'), '');
  uiText(el('time'), msg('Reading Git status…'));
  el('total-count').hidden = true;
  renderPicker();
  renderRepositories();
  renderFiles();
  emptyViewer();
  showError();
  await refresh();
  if (focusRepository && epoch === state.epoch && (document.activeElement === document.body || el('repository-list').contains(document.activeElement))) {
    restoreRailFocus(el('repository-list'), 'repo:' + state.checkout);
  }
}
function clearCode(message) { el('code').hidden = true; el('images').hidden = true; el('view-message').hidden = false; el('view-message').dataset.notice = 'false'; uiText(el('view-message'), message); }
function formatBytes(size) { if (size < 1024) return size + ' B'; if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB'; return (size / (1024 * 1024)).toFixed(2) + ' MB'; }
function renderImages(view) {
  el('code').hidden = true; el('view-message').hidden = true; el('images').hidden = false;
  const signature = JSON.stringify([view.checkout, view.path, view.group, view.mode, view.images.map(image => [image.label, image.revision, image.message, image.byteSize])]);
  if (signature === imageSignature) return;
  imageSignature = signature; el('images').replaceChildren();
  for (const image of view.images) {
    const figure = document.createElement('figure'); figure.className = 'sc-image-card';
    const label = document.createElement('figcaption'); uiText(label, msg(image.label)); figure.append(label);
    const canvas = document.createElement('div'); canvas.className = 'sc-image-canvas'; figure.append(canvas);
    const dimensions = document.createElement('div'); dimensions.className = 'sc-image-info'; dimensions.textContent = image.byteSize === undefined ? '' : formatBytes(image.byteSize); figure.append(dimensions);
    if (image.dataUrl) {
      const img = document.createElement('img'); uiAttr(img, 'alt', msg('{path} · {snapshot}', { path: view.path, snapshot: msg(image.label) }));
      img.onload = () => { dimensions.textContent = img.naturalWidth + ' × ' + img.naturalHeight + ' px · ' + formatBytes(image.byteSize); };
      img.onerror = () => { uiText(canvas, msg('This image could not be decoded.')); };
      img.src = image.dataUrl;
      canvas.append(img);
    } else uiText(canvas, msg(image.message || 'No image in this snapshot.'));
    el('images').append(figure);
  }
}
function appendCodeLine(fragment, text, oldLine, newLine, style, mode) {
  const row = document.createElement('div'); row.className = 'sc-line ' + style;
  for (const number of mode === 'diff' ? [oldLine, newLine] : [newLine]) { const gutter = document.createElement('span'); gutter.className = 'sc-number'; gutter.textContent = number ?? ''; row.append(gutter); }
  const content = document.createElement('span'); content.className = 'sc-line-text'; content.textContent = text; row.append(content); fragment.append(row);
}
function renderCode(view) {
  const mode = view.displayMode || state.mode;
  uiText(el('file-context'), msg(view.sourceLabel || (view.group === 'staged' ? 'Staged snapshot' : 'Working copy')));
  if (view.kind === 'image') { renderImages(view); return; }
  el('images').hidden = true;
  if (view.message || !view.text) { clearCode(msg(view.message || (mode !== 'source' ? 'No text changes.' : 'Empty file.'))); return; }
  if (mode === 'split') { renderSplit(view); return; }
  const oldScroll = { top: el('code').scrollTop, left: el('code').scrollLeft };
  const lines = view.text.split('\n'); if (lines.at(-1) === '') lines.pop();
  const fragment = document.createDocumentFragment(); let oldLine = 0, newLine = 0, inHunk = false;
  for (const [index, line] of lines.slice(0, 10000).entries()) {
    if (mode === 'source') { appendCodeLine(fragment, line, null, index + 1, '', mode); continue; }
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; appendCodeLine(fragment, line, null, null, 'hunk', mode); }
    else if (line.startsWith('diff --git') || line.startsWith('@@@')) { inHunk = false; appendCodeLine(fragment, line, null, null, 'meta', mode); }
    else if (inHunk && line.startsWith('+')) appendCodeLine(fragment, line, null, newLine++, 'added', mode);
    else if (inHunk && line.startsWith('-')) appendCodeLine(fragment, line, oldLine++, null, 'removed', mode);
    else if (inHunk && line.startsWith(' ')) appendCodeLine(fragment, line, oldLine++, newLine++, '', mode);
    else appendCodeLine(fragment, line, null, null, 'meta', mode);
  }
  el('code').replaceChildren(fragment); el('code').hidden = false; el('code').scrollTop = oldScroll.top; el('code').scrollLeft = oldScroll.left;
  el('view-message').hidden = lines.length <= 10000; el('view-message').dataset.notice = 'true'; uiText(el('view-message'), msg('Showing the first 10,000 lines.'));
}
async function loadFile() {
  if (!state.selection || workbench.preview !== 'file') return;
  const token = ++state.viewRequest;
  el('code').classList.remove('sc-detail-diff');
  const args = { repoPath: state.checkout, ...state.selection, mode: state.mode === 'split' ? 'diff' : state.mode };
  uiText(el('file-title'), args.path);
  uiText(el('file-context'), msg(args.group === 'staged' ? 'Staged Changes' : args.group === 'untracked' ? 'Untracked file' : 'Working copy'));
  try { const view = await callTool('git_file', args); if (token === state.viewRequest) renderCode(view); }
  catch (error) { if (token === state.viewRequest) clearCode(error.message); }
}
function setMode(mode) {
  state.mode = mode;
  for (const item of ['diff', 'split', 'source']) el(item + '-mode').setAttribute('aria-pressed', String(mode === item));
  el('code').scrollTop = 0; el('code').scrollLeft = 0; savePreference();
  if (state.selection) {
    if (state.selection.group === 'conflicts') openConflict();
    else { resetPreview(); clearCode(msg('Loading file…')); loadFile(); }
  }
}
window.addEventListener('message', event => {
  if (event.source !== window.parent || event.data?.jsonrpc !== '2.0') return;
  const message = event.data, waiting = pending.get(message.id);
  if (waiting) { clearTimeout(waiting.timeout); pending.delete(message.id); message.error ? waiting.reject(new Error(message.error.message)) : waiting.resolve(message.result); return; }
  if (message.method === 'ui/notifications/tool-result' && state.epoch === 0 && message.params?.structuredContent?.branch) renderStatus(message.params.structuredContent);
  if (message.method === 'ui/notifications/host-context-changed') {
    state.hostContext = { ...state.hostContext, ...message.params };
    if (state.hostContext.theme) document.documentElement.style.colorScheme = state.hostContext.theme;
  }
});
el('refresh').onclick = async () => {
  showError();
  try { await refreshProjects(); } catch (error) { showError(error.message); }
  await refresh();
  await loadHistory({ reset: true });
};
el('project').onclick = () => { if (el('project-popover').hidden) openPicker(); else closePicker(); };
el('project-search').oninput = renderPicker;
el('open-custom').onclick = () => { el('custom-form').hidden = false; el('custom-path').focus(); };
el('custom-form').onsubmit = event => { event.preventDefault(); const path = el('custom-path').value.trim(); if (path) { closePicker(); switchCheckout(path); } };
document.addEventListener('pointerdown', event => { if (!el('project-popover').hidden && !event.target.closest('.sc-repository, .sc-workbench-overlay')) closePicker(false); });
document.addEventListener('focusin', event => { if (!el('project-popover').hidden && !event.target.closest('.sc-repository, .sc-workbench-overlay')) closePicker(false); });
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || el('project-popover').hidden) return;
  if (event.key === 'Escape') { event.preventDefault(); closePicker(); return; }
  if (event.target === el('custom-path')) return;
  const options = [...el('project-list').querySelectorAll('[data-checkout]')];
  const index = options.indexOf(document.activeElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault(); const next = event.key === 'ArrowDown' ? index + 1 : index <= 0 ? options.length - 1 : index - 1; options[next % options.length]?.focus();
  } else if (event.key === 'Enter' && event.target === el('project-search')) { event.preventDefault(); options[0]?.click(); }
});
for (const mode of ['diff', 'split', 'source']) el(mode + '-mode').onclick = () => setMode(mode);
setPanelMessages({ ...shellMessages, ...actionMessages, ...historyMessages, ...previewMessages });
initializePanelLanguage(el('panel-language'));
initializeWorkbench();
(async () => {
  try {
    const host = await request('ui/initialize', { appInfo: { name: 'Git Workbench', version: '/* APP_VERSION */' }, appCapabilities: {}, protocolVersion: '2026-01-26' });
    state.hostContext = host.hostContext || {}; if (state.hostContext.theme) document.documentElement.style.colorScheme = state.hostContext.theme;
    window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized' }, '*');
    const preferences = window.openai?.widgetState;
    restoreWorkspacePreferences(preferences);
    if (['split', 'source'].includes(preferences?.mode)) setMode(preferences.mode);
    if (preferences?.tree) {
      workbench.tree = true;
      el('tree-toggle').setAttribute('aria-pressed', 'true');
      uiAttr(el('tree-toggle'), 'aria-label', msg('Show file list'));
    }
    await refreshProjects();
    if (!state.checkout && typeof preferences?.checkout === 'string') await switchCheckout(preferences.checkout);
    else if (!state.checkout) {
      uiText(el('time'), msg('Choose a checkout'));
      renderFiles();
      renderHistory();
    }
    setInterval(() => { if (!document.hidden) refresh(); }, 5000);
    setInterval(() => { if (!document.hidden) refreshProjects().catch(error => showError(error.message)); }, 30000);
  } catch (error) { showError(error.message); }
})();
