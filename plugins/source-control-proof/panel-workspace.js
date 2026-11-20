const workspaceSections = ['repositories', 'changes', 'history'];
const narrowWorkspace = matchMedia('(max-width: 740px)');
const railScrollIds = ['repository-list', 'changes-body', 'history-scroll'];
const shellState = { collapsed: new Set(), ratio: 0.6, railFocus: null, previewReturn: null, repoSignature: '' };

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
  el('scm-divider').hidden = isSectionCollapsed('changes') || isSectionCollapsed('history');
  if (section === 'history' && !collapsed && load) loadHistory();
  if (persist) savePreference();
}

function updateSplit(ratio, persist = false) {
  shellState.ratio = scmSplitRatio(ratio);
  el('scm-split').style.setProperty('--changes-share', shellState.ratio);
  el('scm-split').style.setProperty('--history-share', 1 - shellState.ratio);
  el('scm-divider').setAttribute('aria-valuenow', String(Math.round(shellState.ratio * 100)));
  if (persist) savePreference();
}

function restoreWorkspacePreferences(preferences) {
  updateSplit(preferences?.split);
  for (const section of workspaceSections) {
    setSectionCollapsed(section, Array.isArray(preferences?.collapsed) && preferences.collapsed.includes(section), { persist: false, load: false });
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
  el('scm-divider').ownerDocument.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented && shellState.previewReturn && !el('action-dialog').open) {
      event.preventDefault();
      closePreview();
    }
  });
  narrowWorkspace.addEventListener('change', () => {
    if (!narrowWorkspace.matches) closePreview({ restore: false });
  });
  const divider = el('scm-divider');
  const resize = event => {
    const bounds = el('scm-split').getBoundingClientRect();
    const fixed = ['changes', 'history'].map(section =>
      el(section + '-section').querySelector('.sc-region-bar').getBoundingClientRect().height);
    const available = bounds.height - fixed[0] - fixed[1] - divider.offsetHeight;
    if (available > 0) updateSplit((event.clientY - bounds.top - fixed[0] - divider.offsetHeight / 2) / available);
  };
  divider.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    divider.focus({ preventScroll: true });
    divider.setPointerCapture(event.pointerId);
  });
  divider.addEventListener('pointermove', event => {
    if (divider.hasPointerCapture(event.pointerId)) resize(event);
  });
  divider.addEventListener('pointerup', event => {
    if (!divider.hasPointerCapture(event.pointerId)) return;
    resize(event);
    divider.releasePointerCapture(event.pointerId);
  });
  divider.addEventListener('lostpointercapture', () => savePreference());
  divider.addEventListener('keydown', event => {
    const targets = { ArrowUp: shellState.ratio - 0.05, ArrowDown: shellState.ratio + 0.05, Home: 0.2, End: 0.8 };
    if (!Object.hasOwn(targets, event.key)) return;
    event.preventDefault();
    updateSplit(targets[event.key], true);
  });
}

function repositoryButton(label, symbol, click) {
  const button = control('', click, 'sc-icon-button');
  uiAttr(button, 'aria-label', msg(label));
  button.append(icon(symbol));
  bindTooltip(button, msg(label));
  return button;
}

function renderRepositories(animatedProject = null) {
  const list = el('repository-list');
  const active = list.contains(document.activeElement) ? railFocusKey(document.activeElement) : null;
  const activeStatus = state.status;
  const signature = JSON.stringify([state.projects, state.checkout, activeStatus?.branch, activeStatus?.ahead, activeStatus?.behind,
    activeStatus?.hasRemote, activeStatus?.upstream, activeStatus?.head, activeStatus?.operation, activeStatus?.detached, [...expandedProjects]]);
  if (signature === shellState.repoSignature) return;
  shellState.repoSignature = signature;
  const scrollTop = list.scrollTop;
  const projects = [...state.projects];
  const knownPaths = new Set(projects.flatMap(project => project.checkouts.map(item => item.path)));
  if (state.checkout && !knownPaths.has(state.checkout)) {
    projects.unshift({ path: state.checkout, label: state.checkout.split(/[\\/]/).filter(Boolean).at(-1) || state.checkout,
      checkouts: [{ path: state.checkout, branch: activeStatus?.branch || '' }] });
  }
  const items = document.createDocumentFragment();
  const emitted = new Set();
  function row(project, checkout, children = [], linked = false) {
    emitted.add(checkout.path);
    const current = state.checkout === checkout.path;
    const status = current ? activeStatus : null;
    const name = linked ? checkout.path.split(/[\\/]/).filter(Boolean).at(-1) || checkout.path : project.label;
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
    if (status?.upstream && status.hasRemote && !status.detached) {
      const sync = repositoryButton(msg('Sync · {behind} incoming, {ahead} outgoing', { behind: status.behind ?? 0, ahead: status.ahead ?? 0 }), 'refresh', event => {
        showSynchronization(event.currentTarget, state.status);
      });
      sync.classList.add('sc-repo-sync');
      sync.dataset.focusKey = 'sync:' + checkout.path;
      sync.disabled = !!status.operation;
      sync.append(element('span', '', (status.behind ?? 0) + '↓ ' + (status.ahead ?? 0) + '↑'));
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
    uiText(el('staging-message'), msg('Enter a commit message.'));
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
