const workspaceSections = ['repositories', 'changes', 'history'];
const workspaceDividers = ['repository-divider', 'scm-divider'];
const narrowWorkspace = matchMedia('(max-width: 740px)');
const railScrollIds = ['repository-list', 'changes-body', 'history-scroll'];
const shellState = { collapsed: new Set(), sizes: null, legacyRatio: 0.6, railFocus: null, previewReturn: null, repoSignature: '' };

function isSectionCollapsed(section) {
  return shellState.collapsed.has(section);
}

function setSectionCollapsed(section, collapsed, { persist = true, load = true, motion = persist } = {}) {
  if (!workspaceSections.includes(section)) return;
  if (collapsed) shellState.collapsed.add(section);
  else shellState.collapsed.delete(section);
  const node = el(section + '-section');
  const toggle = node.querySelector('[data-section]');
  toggle.setAttribute('aria-expanded', String(!collapsed));
  if (!collapsed) node.dataset.collapsed = 'false';
  setPanelContentVisible(el(toggle.getAttribute('aria-controls')), !collapsed, {
    motion: motion && panelMotionEnabled(),
    onHidden: () => { node.dataset.collapsed = 'true'; },
  });
  workspaceDividers.forEach((id, index) => {
    el(id).hidden = workspaceSections.slice(index, index + 2).some(isSectionCollapsed);
  });
  if (section === 'history' && !collapsed && load) loadHistory();
  if (persist) savePreference();
}

function workspaceSection(index) {
  return el(workspaceSections[index] + '-section');
}

function workspaceHeights() {
  return workspaceSections.map((_, index) => workspaceSection(index).getBoundingClientRect().height);
}

function dividerBounds(index, heights) {
  const total = heights[index] + heights[index + 1];
  const headerHeight = offset => workspaceSection(index + offset).querySelector('.sc-region-bar').getBoundingClientRect().height;
  const beforeHeader = headerHeight(0), afterHeader = headerHeight(1);
  if (total <= beforeHeader + afterHeader) return null;
  const bodyMinimum = Math.min(28, (total - beforeHeader - afterHeader) / 2);
  return { total, min: beforeHeader + bodyMinimum, max: total - afterHeader - bodyMinimum };
}

function updateDividerValues(heights = workspaceHeights()) {
  workspaceDividers.forEach((id, index) => {
    const divider = el(id);
    if (divider.hidden) return;
    const bounds = dividerBounds(index, heights);
    if (!bounds) return;
    const percent = value => String(Math.round(value * 100 / bounds.total));
    divider.setAttribute('aria-valuemin', percent(bounds.min));
    divider.setAttribute('aria-valuemax', percent(bounds.max));
    divider.setAttribute('aria-valuenow', percent(Math.min(bounds.max, Math.max(bounds.min, heights[index]))));
  });
}

function applyWorkspaceSizes(sizes, legacyRatio = 0.6) {
  shellState.sizes = sizes;
  const split = el('scm-split');
  if (sizes) split.dataset.resized = '';
  else delete split.dataset.resized;
  workspaceSections.forEach((section, index) => {
    split.style.setProperty(`--${section}-share`, (sizes || [0, legacyRatio, 1 - legacyRatio])[index]);
  });
}

function restoreWorkspacePreferences(preferences) {
  const sizes = preferences?.sectionSizes;
  const validSizes = Array.isArray(sizes) && sizes.length === workspaceSections.length && sizes.every(size => Number.isFinite(size) && size > 0);
  shellState.legacyRatio = scmSplitRatio(preferences?.split);
  applyWorkspaceSizes(validSizes ? [...sizes] : null, shellState.legacyRatio);
  for (const section of workspaceSections) {
    setSectionCollapsed(section, Array.isArray(preferences?.collapsed) && preferences.collapsed.includes(section), { persist: false, load: false });
  }
}

function bindWorkspaceDivider(id, index) {
  const divider = el(id);
  let drag;
  const resize = (initial, bounds, position) => {
    const heights = [...initial];
    heights[index] = Math.max(bounds.min, Math.min(bounds.max, position));
    heights[index + 1] = bounds.total - heights[index];
    if (heights[index] === initial[index]) return false;
    const sizes = [...heights];
    workspaceSections.forEach((section, offset) => {
      if (!isSectionCollapsed(section)) return;
      sizes[offset] = bounds.collapsedSize;
    });
    applyWorkspaceSizes(sizes);
    updateDividerValues(heights);
    return true;
  };
  const move = event => {
    if (!drag || !divider.hasPointerCapture(event.pointerId) || event.clientY === drag.lastY) return;
    const target = drag.heights[index] + event.clientY - drag.y;
    if (target === drag.heights[index] && drag.changed) {
      applyWorkspaceSizes(drag.originalSizes, shellState.legacyRatio);
      updateDividerValues(drag.heights);
      drag.changed = false;
    } else {
      drag.changed = resize(drag.heights, drag.bounds, target) || drag.changed;
    }
    drag.lastY = event.clientY;
  };
  divider.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    const heights = workspaceHeights();
    const bounds = measureBounds(heights);
    if (!bounds) return;
    event.preventDefault();
    divider.focus({ preventScroll: true });
    divider.setPointerCapture(event.pointerId);
    drag = { y: event.clientY, lastY: event.clientY, heights, bounds, originalSizes: shellState.sizes, changed: false };
  });
  divider.addEventListener('pointermove', move);
  divider.addEventListener('pointerup', event => {
    if (!divider.hasPointerCapture(event.pointerId)) return;
    move(event);
    divider.releasePointerCapture(event.pointerId);
  });
  divider.addEventListener('lostpointercapture', () => {
    if (drag?.changed) savePreference();
    drag = null;
  });
  divider.addEventListener('keydown', event => {
    const heights = workspaceHeights();
    const bounds = measureBounds(heights);
    if (!bounds) return;
    const step = bounds.total * 0.05;
    const targets = { ArrowUp: heights[index] - step, ArrowDown: heights[index] + step, Home: bounds.min, End: bounds.max };
    if (!Object.hasOwn(targets, event.key)) return;
    event.preventDefault();
    if (resize(heights, bounds, targets[event.key])) savePreference();
  });

  function measureBounds(heights) {
    if (divider.hidden) return null;
    const bounds = dividerBounds(index, heights);
    if (!bounds) return null;
    const previous = shellState.sizes;
    const other = index === 0 ? 2 : 0;
    bounds.collapsedSize = previous ? previous[other] * bounds.total / (previous[index] + previous[index + 1]) : bounds.total / 3;
    return bounds;
  }
}

function railFocusKey(node) {
  return node?.dataset.focusKey || node?.id || null;
}

function restoreRailFocus(scope, key) {
  if (!key) return false;
  const match = [...scope.querySelectorAll('[data-focus-key], button[id]')].find(node => railFocusKey(node) === key);
  if (!match || match.disabled || match.closest('[hidden]')) return false;
  match.focus({ preventScroll: true });
  return true;
}

function showPreview() {
  if (!narrowWorkspace.matches || shellState.previewReturn) return;
  const rail = el('scm-rail');
  const focus = rail.contains(document.activeElement) ? railFocusKey(document.activeElement) || shellState.railFocus : shellState.railFocus;
  shellState.previewReturn = {
    focus,
    scroll: railScrollIds.map(id => [el(id).scrollTop, el(id).scrollLeft]),
  };
  closeWorkbenchOverlays();
  document.querySelector('.sc-app').dataset.pane = 'preview';
  animatePanelArrival(document.querySelector('.sc-viewer'));
  el('preview-back').focus({ preventScroll: true });
}

function closePreview({ restore = true } = {}) {
  const previous = shellState.previewReturn;
  shellState.previewReturn = null;
  document.querySelector('.sc-app').dataset.pane = 'workspace';
  if (!previous || !restore) return;
  animatePanelArrival(el('scm-rail'));
  railScrollIds.forEach((id, index) => {
    [el(id).scrollTop, el(id).scrollLeft] = previous.scroll[index];
  });
  if (!restoreRailFocus(el('scm-rail'), previous.focus)) el('project').focus({ preventScroll: true });
}

function setupWorkspaceShell() {
  for (const node of document.querySelectorAll('[data-icon]')) node.prepend(icon(node.dataset.icon));
  for (const toggle of document.querySelectorAll('[data-section]')) {
    toggle.onclick = () => setSectionCollapsed(toggle.dataset.section, !isSectionCollapsed(toggle.dataset.section));
  }
  for (const button of document.querySelectorAll('.sc-icon-button[aria-label]')) {
    bindTooltip(button, () => currentUiAttr(button, 'aria-label'));
  }
  const trackFocus = event => {
    const node = event.target.closest('button');
    if (node) shellState.railFocus = railFocusKey(node) || shellState.railFocus;
  };
  el('scm-rail').addEventListener('focusin', trackFocus);
  el('scm-rail').addEventListener('pointerdown', trackFocus);
  el('preview-back').onclick = () => closePreview();
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented && shellState.previewReturn && !el('action-dialog').open) {
      event.preventDefault();
      closePreview();
    }
  });
  narrowWorkspace.addEventListener('change', () => {
    if (!narrowWorkspace.matches) closePreview({ restore: false });
  });
  workspaceDividers.forEach(bindWorkspaceDivider);
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => updateDividerValues());
    workspaceSections.forEach((_, index) => observer.observe(workspaceSection(index)));
  }
}

function repositoryButton(label, symbol, click) {
  const button = control('', click, 'sc-icon-button');
  uiAttr(button, 'aria-label', msg(label));
  button.append(icon(symbol));
  bindTooltip(button, msg(label));
  return button;
}

function currentCatalogProject() {
  const matches = state.projects.filter(project => project.checkouts.some(checkout => checkout.path === state.checkout));
  const preferred = state.projectId ? matches.filter(project => project.projectId === state.projectId) : [];
  const candidates = preferred.length ? preferred : matches;
  return candidates.find(project => project.path === state.checkout) || candidates[0];
}

function checkoutDirectoryName(path) {
  return path?.split(/[\\/]/).filter(Boolean).at(-1) || path || '';
}

function renderRepositories(animatedProject = null) {
  const list = el('repository-list');
  const active = list.contains(document.activeElement) ? railFocusKey(document.activeElement) : null;
  const activeStatus = state.status;
  const signature = JSON.stringify([state.projects, state.checkout, state.projectId, activeStatus?.branch, activeStatus?.ahead, activeStatus?.behind,
    activeStatus?.hasRemote, activeStatus?.upstream, activeStatus?.head, activeStatus?.operation, activeStatus?.detached, [...expandedProjects]]);
  if (signature === shellState.repoSignature) return;
  shellState.repoSignature = signature;
  const currentProject = currentCatalogProject();
  const name = currentProject?.projectName || currentProject?.label || checkoutDirectoryName(state.checkout);
  const heading = el('current-project');
  heading.textContent = name;
  heading.title = name;
  heading.hidden = !name;
  const scrollTop = list.scrollTop;
  const projects = [...state.projects];
  const knownPaths = new Set(projects.flatMap(project => project.checkouts.map(item => item.path)));
  if (state.checkout && !knownPaths.has(state.checkout)) {
    projects.unshift({ path: state.checkout, label: checkoutDirectoryName(state.checkout),
      checkouts: [{ path: state.checkout, branch: activeStatus?.branch || '' }] });
  }
  const items = document.createDocumentFragment();
  const emitted = new Set();
  function row(project, checkout, children = [], linked = false) {
    emitted.add(checkout.path);
    const current = state.checkout === checkout.path;
    const status = current ? activeStatus : null;
    const name = linked ? checkoutDirectoryName(checkout.path) : project.label;
    const branchName = status?.branch || checkout.branch;
    const branchLabel = status?.detached ? msg('Detached HEAD · {commit}', { commit: status.head?.slice(0, 7) || 'HEAD' }) : branchName;
    const entry = element('div', 'sc-repo-row' + (linked ? ' sc-repo-linked' : ''));
    entry.dataset.current = String(current);
    if (children.length) {
      const expanded = !collapsedActiveProjects.has(project.path) && (expandedProjects.has(project.path) || children.some(item => item.path === state.checkout));
      const toggle = repositoryButton(expanded ? 'Collapse worktrees' : 'Expand worktrees', 'chevron', () => {
        if (!expanded) expandedProjects.add(project.path);
        else {
          expandedProjects.delete(project.path);
          if (children.some(item => item.path === state.checkout)) collapsedActiveProjects.add(project.path);
        }
        if (!expanded) collapsedActiveProjects.delete(project.path);
        shellState.repoSignature = '';
        renderRepositories(project.path);
      });
      toggle.classList.add('sc-repo-children-toggle');
      toggle.setAttribute('aria-expanded', String(expanded && !collapsedActiveProjects.has(project.path)));
      toggle.dataset.focusKey = 'worktrees:' + project.path;
      entry.append(toggle);
    }
    const button = control('', () => {
      if (!current) switchCheckout(checkout.path, { focusRepository: true });
    }, 'sc-repo-select');
    button.dataset.focusKey = 'repo:' + checkout.path;
    button.setAttribute('aria-current', String(current));
    uiAttr(button, 'aria-label', msg('{name} · {branch}', { name, branch: branchLabel || msg('Checkout') }));
    button.append(icon(linked ? 'branch' : 'repo'), element('span', 'sc-repo-name', name));
    entry.append(button);
    bindTooltip(button, branchLabel ? msg('{path} · {branch}', { path: checkout.path, branch: branchLabel }) : checkout.path);
    if (branchName) {
      const branch = control(branchLabel, async event => {
        if (!current) await switchCheckout(checkout.path);
        if (state.checkout !== checkout.path || !state.status) return;
        const anchor = event.currentTarget || [...list.querySelectorAll('[data-focus-key]')].find(
          candidate => candidate.dataset.focusKey === 'branch:' + checkout.path);
        chooseBranch(anchor);
      }, 'sc-repo-branch');
      branch.dataset.focusKey = 'branch:' + checkout.path;
      uiAttr(branch, 'aria-label', msg('Switch branch · {branch}', { branch: branchLabel }));
      entry.append(branch);
      bindTooltip(branch, branchLabel);
    }
    const behind = status?.behind ?? 0;
    const ahead = status?.ahead ?? 0;
    if (status?.upstream && status.hasRemote && !status.detached && (behind > 0 || ahead > 0)) {
      const sync = repositoryButton(msg('Sync · {behind} incoming, {ahead} outgoing', { behind, ahead }), 'refresh', event => {
        showSynchronization(event.currentTarget, state.status);
      });
      sync.classList.add('sc-repo-sync');
      sync.dataset.focusKey = 'sync:' + checkout.path;
      sync.disabled = !!status.operation;
      sync.append(element('span', '', behind + '↓ ' + ahead + '↑'));
      entry.append(sync);
    }
    const entries = () => repositoryMenuEntries(checkout, state.status);
    const more = repositoryButton('Repository actions', 'more', event => openContextMenu(entries(), { anchor: event.currentTarget }));
    more.classList.add('sc-repo-menu');
    more.dataset.focusKey = 'repo-actions:' + checkout.path;
    entry.append(more);
    bindContextMenu(entry, entries, { anchor: button });
    items.append(entry);
  }
  for (const project of projects) {
    const available = project.checkouts.filter(checkout => !emitted.has(checkout.path));
    if (!available.length) continue;
    const root = available.find(checkout => checkout.path === project.path) || available[0];
    const children = available.filter(checkout => checkout !== root);
    row(project, root, children);
    if (!collapsedActiveProjects.has(project.path) && (expandedProjects.has(project.path) || children.some(item => item.path === state.checkout))) {
      const start = items.childElementCount;
      for (const checkout of children) row(project, checkout, [], true);
      if (project.path === animatedProject) {
        for (const child of [...items.children].slice(start)) child.classList.add('sc-repo-linked-arriving');
      }
    } else {
      for (const checkout of children) emitted.add(checkout.path);
    }
  }
  if (!items.childElementCount) items.append(control(msg('Open a checkout…'), openPicker, 'sc-empty sc-empty-open'));
  list.replaceChildren(items);
  list.scrollTop = scrollTop;
  restoreRailFocus(list, active);
}

const collapsedActiveProjects = new Set();

function showSynchronization(anchor, status) {
  if (!status || status.operation || !status.upstream) return;
  if (status.ahead > 0 && status.behind > 0) {
    openContextMenu([
      { label: 'Sync after rebase…', run: () => runCommand('syncRebase') },
      { label: 'Pull and merge…', run: () => runCommand('pullMerge') },
    ], { anchor, label: 'Diverged branch' });
  } else runCommand('sync');
}

function updateCommitButton() {
  const primary = scmPrimaryAction(state.status);
  const button = el('commit-submit');
  const busy = !!workbench.busy || !!state.staging;
  if (button.dataset.kind !== primary.kind || button.dataset.label !== primary.label) {
    button.dataset.kind = primary.kind;
    button.dataset.label = primary.label;
    const label = ['sync', 'diverged'].includes(primary.kind)
      ? msg('Sync Changes {counts}', { counts: primary.label.slice('Sync Changes '.length) })
      : msg(primary.label);
    const commit = ['none', 'commit', 'commitAll'].includes(primary.kind);
    button.replaceChildren(element('span', '', commit ? msg('Commit') : label));
    uiAttr(button, 'aria-label', label);
    uiAttr(button, 'title', label);
  }
  button.disabled = busy || !primary.enabled;
  uiAttr(el('commit-message'), 'placeholder', state.status && !state.status.detached
    ? msg('Message (⌘/Ctrl+Enter to commit on {branch})', { branch: state.status.branch })
    : msg('Commit message'));
}

function submitCommit() {
  if (!state.status || workbench.busy || state.staging) return;
  const { kind } = scmPrimaryAction(state.status);
  if (kind === 'conflicts') {
    setSectionCollapsed('changes', false);
    collapsedFileGroups.delete('conflicts');
    renderFiles();
    el('files').querySelector('[data-group="conflicts"].sc-file-button')?.focus();
    return;
  }
  if (kind === 'continue') {
    runCommand(state.status.operation + 'Continue');
    return;
  }
  if (!['commit', 'commitAll'].includes(kind)) return;
  const message = el('commit-message').value.trim();
  if (!message) {
    el('commit-message').focus();
    showActionMessage(msg('Enter a commit message.'));
    return;
  }
  if (kind === 'commit') return performAction('git_commit', { action: 'commit', message }, 'Commit staged');
  const checkout = state.checkout;
  actionForm('Stage all and commit', [], (_, confirmed) => {
    if (checkout === state.checkout) performAction('git_commit', { action: 'commitAll', message, confirmed }, 'Commit all changes');
  }, { confirmation: msg('Include all tracked and untracked changes in {checkout}', { checkout }), submitLabel: 'Stage all and commit' });
}

function runPrimaryAction(anchor) {
  if (!state.status || workbench.busy || state.staging) return;
  const { kind } = scmPrimaryAction(state.status);
  if (kind === 'publish') choosePublishRemote();
  else if (kind === 'sync' || kind === 'diverged') showSynchronization(anchor, state.status);
  else submitCommit();
}

function showChangesActions(anchor) {
  const unavailable = !state.status || !!state.staging || !!workbench.busy;
  openContextMenu([
    { label: workbench.tree ? 'View as List' : 'View as Tree', run: () => el('tree-toggle').click() },
    { label: 'Expand All Groups', run: () => { collapsedFileGroups.clear(); renderFiles(); } },
    { label: 'Collapse All Groups', run: () => { groups.forEach(([key]) => collapsedFileGroups.add(key)); renderFiles(); } },
    { separator: true },
    { label: 'Stage All Changes', disabled: unavailable || (!state.status.unstaged.length && !state.status.untracked.length),
      run: () => performAction('git_change', { action: 'stage' }, 'Stage all changes') },
    { label: 'Unstage All Changes', disabled: unavailable || !state.status.staged.length,
      run: () => performAction('git_change', { action: 'unstage' }, 'Unstage all changes') },
    { label: 'Commit Options…', disabled: unavailable, run: source => showCommitOptions(source) },
  ], { anchor, label: 'Changes actions' });
}
