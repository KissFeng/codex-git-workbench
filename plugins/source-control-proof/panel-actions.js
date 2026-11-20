function copyText(value) {
  const showCopyField = () => {
    const text = element('textarea', 'sc-input');
    text.value = value;
    text.readOnly = true;
    openAction('Copy text', text);
    text.focus();
    text.select();
  };
  if (!navigator.clipboard) {
    showCopyField();
    return;
  }
  return navigator.clipboard.writeText(value)
    .then(() => uiText(el('staging-message'), msg('Copied')))
    .catch(showCopyField);
}

function openAction(title, content) {
  closeWorkbenchOverlays();
  const dialog = el('action-dialog');
  uiText(el('action-title'), msg(title));
  el('action-body').replaceChildren(content);
  if (!dialog.open) dialog.showModal();
  el('action-body').querySelector('input,select,button')?.focus();
}

const field = (key, label, options = {}) => ({ key, label, ...options });

function actionForm(title, fields, onSubmit, { confirmation, submitLabel = title } = {}) {
  const epoch = state.epoch;
  const form = element('form', 'sc-action-form');
  const controls = new Map();
  for (const definition of fields) {
    const { key, label, value, optional, checkbox, multiline, choices, placeholder } = definition;
    const wrapper = element('label', checkbox ? 'sc-check-field' : 'sc-form-field');
    let input;
    if (choices?.length) {
      input = element('select', 'sc-input');
      input.append(element('option', '', msg(optional ? 'Use Git default' : 'Choose…')));
      input.firstChild.value = '';
      for (const choice of choices) {
        const option = element('option', '', typeof choice === 'string' ? choice : choice.label);
        option.value = typeof choice === 'string' ? choice : choice.value;
        input.append(option);
      }
    } else {
      input = element(multiline ? 'textarea' : 'input', checkbox ? '' : 'sc-input');
      if (multiline) input.rows = 3;
      else input.type = checkbox ? 'checkbox' : 'text';
      input.autocomplete = 'off';
      input.spellcheck = false;
      if (placeholder) uiAttr(input, 'placeholder', msg(placeholder));
    }
    if (checkbox) input.checked = !!value;
    else {
      input.required = !optional;
      if (value !== undefined) input.value = value;
    }
    const caption = element('span', '', msg(label));
    wrapper.append(...(checkbox ? [input, caption] : [caption, input]));
    form.append(wrapper);
    controls.set(key, input);
  }
  if (confirmation) form.append(element('p', 'sc-confirm-copy', msg(confirmation)));
  const actions = element('div', 'sc-actions sc-dialog-buttons');
  const submit = element('button', 'sc-primary', msg(submitLabel));
  submit.type = 'submit';
  actions.append(control(msg('Cancel'), () => el('action-dialog').close()), submit);
  form.append(actions);
  form.onsubmit = event => {
    event.preventDefault();
    const values = {};
    for (const [key, input] of controls) {
      if (input.type === 'checkbox') { if (input.checked) values[key] = true; }
      else if (input.value.trim()) values[key] = input.value.trim();
    }
    el('action-dialog').close();
    if (epoch === state.epoch) onSubmit(values, !!confirmation);
  };
  openAction(title, form);
}

function commandList(title, choices) {
  const list = element('div', 'sc-command-list');
  for (const choice of choices) {
    if (choice.separator) continue;
    const button = control(choice.rawLabel ? choice.label : msg(choice.label), () => {
      el('action-dialog').close();
      choice.run();
    }, 'sc-command-entry');
    button.disabled = choice.disabled === true;
    list.append(button);
  }
  openAction(title, list);
}

function actionAnchor(trigger) {
  return trigger?.currentTarget ?? (trigger?.isConnected ? trigger : null);
}

async function readReferences() {
  if (!state.checkout) return null;
  const epoch = state.epoch;
  try {
    const refs = await callTool('git_references', { repoPath: state.checkout });
    return epoch === state.epoch ? refs : null;
  } catch (error) {
    if (epoch === state.epoch) showError(error.message);
    return null;
  }
}

const actionNames = {
  init: 'Initialize repository', clone: 'Clone repository', createBranch: 'Create branch',
  switchBranch: 'Switch branch', checkoutDetached: 'Checkout detached', renameBranch: 'Rename branch',
  deleteBranch: 'Delete branch', createTag: 'Create tag', deleteTag: 'Delete tag',
  deleteRemoteBranch: 'Delete remote branch', deleteRemoteTag: 'Delete remote tag',
  fetchRef: 'Fetch branch or tag', pushRef: 'Push branch or tag', pushTags: 'Push all tags',
  fetch: 'Fetch', pull: 'Pull (fast-forward)', pullMerge: 'Pull and merge', pullRebase: 'Pull and rebase',
  push: 'Push', publish: 'Publish branch', sync: 'Sync', syncRebase: 'Sync after rebase', forcePush: 'Force-push with lease',
  addRemote: 'Add remote', removeRemote: 'Remove remote', merge: 'Merge', rebase: 'Rebase',
  cherryPick: 'Cherry-pick', mergeContinue: 'Continue merge', rebaseContinue: 'Continue rebase',
  cherryPickContinue: 'Continue cherry-pick', mergeAbort: 'Abort merge', rebaseAbort: 'Abort rebase',
  cherryPickAbort: 'Abort cherry-pick', stashPush: 'Create stash', stashApply: 'Apply stash',
  stashPop: 'Pop stash', stashDrop: 'Drop stash', stashDropAll: 'Drop all stashes', createWorktree: 'Create worktree',
  removeWorktree: 'Remove worktree', moveWorktreeChanges: 'Move changes to worktree',
};

const confirmActions = new Set([
  'init', 'clone', 'deleteBranch', 'deleteTag', 'deleteRemoteBranch', 'deleteRemoteTag', 'push', 'pushRef', 'pushTags', 'publish', 'sync', 'syncRebase', 'forcePush', 'removeRemote',
  'rebase', 'mergeAbort', 'rebaseAbort', 'cherryPickAbort', 'stashDrop', 'stashDropAll', 'createWorktree',
  'removeWorktree', 'moveWorktreeChanges',
]);

function runCommand(action, preset = {}, fields = []) {
  const label = actionNames[action];
  const submit = (values, confirmed) => performAction('git_operation', { action, ...preset, ...values, ...(confirmed ? { confirmed } : {}) }, label);
  if (!fields.length && !confirmActions.has(action)) return submit({}, false);
  const target = Object.values(preset).filter(value => typeof value === 'string').join(' · ');
  const context = [target, state.checkout].filter(Boolean).join(' · ');
  const confirmation = confirmActions.has(action) && (context
    ? msg('{action} · {target}', { action: msg(label), target: context })
    : msg(label));
  actionForm(label, fields, submit, { confirmation });
}

function showCommitOptions(trigger, event = trigger?.currentTarget ? trigger : null) {
  const anchor = actionAnchor(trigger);
  const selected = [
    { action: 'commit', label: 'Commit staged with options' },
    { action: 'commitAll', label: 'Commit all changes' },
    { action: 'amend', label: 'Amend last commit' },
    { action: 'commitEmpty', label: 'Create empty commit' },
    { action: 'undoCommit', label: 'Undo last commit' },
  ];
  const options = selected.map(({ action, label }) => ({
    label,
    disabled: !state.status || !!workbench.busy || !!state.staging,
    run: () => actionForm(label, action === 'undoCommit' ? [] : [
      field('message', 'Commit message', { value: el('commit-message').value, optional: action === 'amend', multiline: true }),
      field('signed', 'Cryptographically sign commit', { checkbox: true }),
      field('signoff', 'Append Signed-off-by trailer', { checkbox: true }),
      ...(action === 'amend' ? [field('all', 'Stage all working-copy changes', { checkbox: true })] : []),
      field('noVerify', 'Skip commit hooks', { checkbox: true }),
    ], (values, confirmed) => performAction('git_commit', { action, ...values, ...(confirmed ? { confirmed } : {}) }, label),
    { confirmation: ['amend', 'undoCommit', 'commitAll'].includes(action)
      ? msg('{action} on {branch}', {
        action: msg(label),
        branch: state.status.detached && state.status.head
          ? msg('Detached HEAD · {commit}', { commit: state.status.head.slice(0, 7) })
          : state.status.branch,
      }) : '' }),
  }));
  options.push({ label: 'Restore commit template…', disabled: !state.checkout, run: restoreCommitTemplate });
  if (state.status?.hasRemote && !state.status.detached && state.status.head && !state.status.operation) {
    options.push({ separator: true });
    options.push(state.status.upstream
      ? { label: 'Sync Changes…', run: source => showSynchronization(source, state.status) }
      : { label: 'Publish Branch…', run: choosePublishRemote });
  }
  if (anchor) openContextMenu(options, { anchor, event, label: 'Commit and sync options' });
  else commandList('Commit options', options);
}

async function restoreCommitTemplate() {
  const epoch = state.epoch;
  const draft = el('commit-message').value;
  try {
    const result = await callTool('git_commit_template', { repoPath: state.checkout });
    if (epoch !== state.epoch) return;
    if (result.template === null) {
      uiText(el('staging-message'), msg('No commit template is configured.'));
      return;
    }
    const apply = () => {
      el('commit-message').value = result.template;
      updateCommitButton();
      el('commit-message').focus();
    };
    if (draft || el('commit-message').value) {
      actionForm('Restore commit template', [], apply, { confirmation: 'Replace the current commit draft with the configured template.' });
    } else apply();
  } catch (error) {
    if (epoch === state.epoch) showError(error.message);
  }
}

function createBranchFields() {
  return [field('name', 'Branch name'), field('startPoint', 'Start from', { optional: true }),
    field('checkout', 'Switch to this branch', { checkbox: true, value: true })];
}

function branchGroups(refs) {
  return [
    { label: 'Local branches', entries: refs.branches.map(item => ({
      label: item.name, disabled: item.current,
      run: () => runCommand('switchBranch', { name: item.name }),
    })) },
    { label: 'Remote branches', entries: refs.remoteBranches.filter(item => item.remote && item.branch).map(item => ({
      label: item.name, run: () => runCommand('switchBranch', { name: item.branch, remote: item.remote }),
    })) },
    { label: 'Tags', entries: refs.tags.map(item => ({
      label: item.name, run: () => runCommand('checkoutDetached', { ref: item.ref }),
    })) },
  ];
}

function filterBranchGroups(groups, query) {
  const term = query.trim().toLowerCase();
  return groups.map(group => ({
    ...group, entries: group.entries.filter(entry => entry.label.toLowerCase().includes(term)),
  })).filter(group => group.entries.length);
}

async function chooseBranch(trigger) {
  if (!state.checkout || workbench.busy || state.staging) return;
  const epoch = state.epoch;
  const anchor = actionAnchor(trigger);
  const picker = element('div', 'sc-branch-picker');
  const search = element('input');
  uiAttr(search, 'placeholder', msg('Search branches or tags…'));
  uiAttr(search, 'aria-label', msg('Search branches or tags'));
  search.autocomplete = 'off';
  search.spellcheck = false;
  const searchRow = element('div', 'sc-search sc-branch-search');
  searchRow.append(search, element('kbd', '', 'esc'));
  const list = element('div', 'sc-branch-results');
  const pending = element('p', 'sc-branch-result-message', msg('Loading branches…'));
  pending.setAttribute('role', 'status');
  list.append(pending);
  picker.append(searchRow, list);

  if (anchor) {
    picker.setAttribute('role', 'dialog');
    uiAttr(picker, 'aria-label', msg('Switch branch'));
    if (!openWorkbenchPopup(picker, { anchor, initialFocus: search })) return;
  } else openAction('Switch branch', picker);
  const active = () => picker.isConnected && (anchor || el('action-dialog').open);
  const refs = await readReferences();
  if (!active()) return;
  if (!refs) {
    uiText(pending, msg('Unable to load branches.'));
    return;
  }
  const groups = branchGroups(refs);
  const create = { label: msg('Create branch…'), run: () => runCommand('createBranch', {}, createBranchFields()) };
  const render = () => {
    list.replaceChildren();
    const matches = filterBranchGroups(groups, search.value);
    if (!search.value.trim()) matches.unshift({ entries: [create] });
    if (!matches.length) {
      const empty = element('p', 'sc-branch-result-message', msg('No branches or tags match.'));
      empty.setAttribute('role', 'status');
      list.append(empty);
    }
    for (const { label, entries } of matches) {
      const section = element('div', 'sc-branch-group');
      if (label) {
        section.setAttribute('role', 'group');
        uiAttr(section, 'aria-label', msg(label));
        section.append(element('div', 'sc-branch-group-heading', msg(label)));
      }
      for (const entry of entries) {
        const button = control('', () => {
          if (anchor) closeWorkbenchOverlays({ restoreFocus: true });
          else el('action-dialog').close();
          if (epoch === state.epoch && !workbench.busy && !state.staging) entry.run();
        }, 'sc-menu-item sc-branch-entry');
        button.disabled = !!entry.disabled;
        button.append(element('span', '', entry.label));
        if (entry.disabled) {
          button.setAttribute('aria-current', 'true');
          button.append(element('span', 'sc-muted', msg('Current')));
        }
        section.append(button);
      }
      list.append(section);
    }
    if (anchor) positionWorkbenchOverlay(picker, anchor);
  };
  search.oninput = render;
  picker.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(event.key)) return;
    const fromSearch = event.target === search;
    if (fromSearch && ['Home', 'End'].includes(event.key)) return;
    const buttons = [...list.querySelectorAll('button:not(:disabled)')];
    if (fromSearch && event.key === 'Enter' && buttons.length) {
      event.preventDefault();
      buttons[0].click();
      return;
    }
    const target = event.key === 'ArrowUp' && !fromSearch && event.target === buttons[0]
      ? search
      : workbenchMenuTarget(buttons, event.target, event.key);
    if (target) {
      event.preventDefault();
      target.focus();
    }
  });
  render();
}

function repositoryMenuEntries(checkout, status) {
  const path = typeof checkout === 'string' ? checkout : checkout?.path;
  if (!path) return [];
  const epoch = state.epoch;
  const selected = path === state.checkout;
  const busy = !!workbench.busy || !!state.staging;
  const stillSelected = () => epoch === state.epoch && path === state.checkout && !workbench.busy && !state.staging;
  const guarded = action => anchor => { if (stillSelected()) action(anchor); };
  const copy = { label: 'Copy checkout path', run: () => copyText(path) };
  if (!selected) {
    return [
      { label: 'Switch to checkout', run: () => { if (epoch === state.epoch) switchCheckout(path); } },
      copy,
      { label: 'Git actions…', disabled: busy, run: async () => {
        if (workbench.busy || state.staging || epoch !== state.epoch) return;
        await switchCheckout(path);
        if (path === state.checkout && state.epoch === epoch + 1) await showCommands();
      } },
    ];
  }
  const canContactRemote = !!status && status.hasRemote !== false;
  const attached = canContactRemote && !!status.head && !status.detached && !status.operation;
  const tracking = attached && !!status.upstream;
  return [
    { label: 'Switch branch…', disabled: busy || !status, run: guarded(chooseBranch) },
    { separator: true },
    { label: 'Fetch', disabled: busy || !canContactRemote, run: guarded(() => runCommand('fetch')) },
    { label: 'Pull', disabled: busy || !tracking, run: guarded(() => runCommand('pull')) },
    { label: attached && !tracking ? 'Publish Branch…' : 'Push', disabled: busy || !attached,
      run: guarded(tracking ? () => runCommand('push') : choosePublishRemote) },
    { label: 'Sync Changes', disabled: busy || !tracking, run: guarded(anchor => showSynchronization(anchor, state.status)) },
    { separator: true },
    { label: 'Refresh repository', disabled: busy, run: guarded(() => refresh({ force: true })) },
    copy,
    { label: 'Git actions…', disabled: busy, run: guarded(showCommands) },
  ];
}

async function choosePublishRemote() {
  const refs = await readReferences();
  if (!refs || workbench.busy || state.staging) return;
  const choices = refs.remotes.map(item => item.name);
  if (!choices.length) {
    showError(msg('Add a Git remote before publishing the branch.'));
    return;
  }
  runCommand('publish', {}, [
    field('remote', 'Remote', { choices, value: choices.length === 1 ? choices[0] : undefined }),
    field('branch', 'Remote branch', { optional: true }),
    field('followTags', 'Include reachable annotated tags', { checkbox: true }),
  ]);
}

function compareForm() {
  if (!state.status?.head) return;
  actionForm('Compare changes', [
    field('from', 'From reference', { value: 'HEAD' }),
    field('to', 'To reference', { optional: true, placeholder: 'Working copy if blank' }),
    field('mergeBase', 'Compare from common ancestor', { checkbox: true }),
  ], args => openCompare(args), { submitLabel: 'Compare' });
}

async function showCommands(trigger, event = trigger?.currentTarget ? trigger : null) {
  if (workbench.busy || state.staging) return;
  const anchor = actionAnchor(trigger);
  let loading;
  const destination = () => field('destination', 'Absolute checkout path');
  const commands = [
    { label: actionNames.init, run: () => runCommand('init', {}, [destination()]) },
    { label: actionNames.clone, run: () => runCommand('clone', {}, [field('url', 'Repository URL'), destination(), field('recursive', 'Initialize submodules', { checkbox: true })]) },
  ];
  if (state.status) {
    if (anchor) loading = openContextMenu([{ label: 'Loading Git actions…', disabled: true }],
      { anchor, event, label: 'Git actions' });
    const refs = await readReferences();
    if (!refs || workbench.busy || state.staging) {
      if (loading?.isConnected) closeWorkbenchOverlays({ restoreFocus: true });
      return;
    }
    if (anchor && !loading?.isConnected) return;
    const remoteNames = refs.remotes.map(item => item.name);
    const branches = refs.branches.map(item => item.name);
    const localTags = refs.tags.map(item => item.name);
    const remote = (optional = true) => field('remote', 'Remote', { choices: remoteNames, optional });
    const branch = () => field('branch', 'Remote branch', { optional: true });
    const revision = () => field('ref', 'Branch, tag or commit');
    const name = (label, choices) => field('name', label, { choices });
    const worktree = (trees, label = 'Worktree') => field('destination', label, {
      choices: trees.map(item => ({ value: item.path, label: (item.branch ? item.branch + ' · ' : '') + shortPath(item.path) })),
    });
    const destinations = refs.worktrees.filter(item => item.path !== state.checkout && !item.prunable && !item.bare);
    const add = (action, fields = [], preset = {}, disabled = false) => commands.push({
      label: actionNames[action], disabled, run: () => runCommand(action, preset, fields),
    });
    const addRemoteAction = action => add(action, [remote(), branch(),
      ...(['push', 'publish'].includes(action) ? [field('followTags', 'Include reachable annotated tags', { checkbox: true })] : []),
    ], {}, !remoteNames.length);
    commands.push({ label: 'Switch branch…', run: chooseBranch }, { label: 'Compare changes…', run: compareForm });
    add('createBranch', createBranchFields());
    add('checkoutDetached', [revision()]);
    add('renameBranch', [name('Branch', branches), field('newName', 'New name')], {}, !branches.length);
    add('deleteBranch', [name('Branch', branches), field('force', 'Allow deleting an unmerged branch', { checkbox: true })], {}, !branches.length);
    add('createTag', [name('Tag name'), field('ref', 'Reference', { optional: true }), field('message', 'Annotation', { optional: true })]);
    add('deleteTag', [name('Tag', localTags)], {}, !localTags.length);
    add('addRemote', [name('Remote name'), field('url', 'Remote URL')]);
    add('removeRemote', [name('Remote', remoteNames)], {}, !remoteNames.length);
    add('fetch', [remote(), field('prune', 'Prune stale references', { checkbox: true })], {}, !remoteNames.length);
    for (const action of ['pull', 'pullMerge', 'pullRebase', 'push', 'publish', 'sync', 'syncRebase']) addRemoteAction(action);
    const kinds = [{ value: 'branch', label: msg('Branch') }, { value: 'tag', label: msg('Tag') }];
    add('fetchRef', [remote(false), field('kind', 'Reference type', { choices: kinds }), name('Remote reference name')], {}, !remoteNames.length);
    add('pushRef', [remote(false), field('ref', 'Local reference', { choices: [...refs.branches, ...refs.tags].map(item => item.ref) })], {}, !remoteNames.length || (!branches.length && !localTags.length));
    add('pushTags', [remote(false)], {}, !remoteNames.length || !localTags.length);
    add('deleteRemoteTag', [remote(false), name('Remote tag name')], {}, !remoteNames.length);
    const remoteBranches = refs.remoteBranches.filter(item => item.remote && item.branch);
    commands.push({ label: actionNames.deleteRemoteBranch, disabled: !remoteBranches.length, run: () => commandList('Choose a remote branch to delete',
      remoteBranches.map(item => ({ label: item.name, rawLabel: true, run: () => runCommand('deleteRemoteBranch', { remote: item.remote, name: item.branch, expected: item.head }) }))) });
    if (refs.remoteBranches.some(item => item.remote && item.branch)) {
      commands.push({ label: actionNames.forcePush, run: () => commandList('Choose the remote branch to update',
        refs.remoteBranches.filter(item => item.remote && item.branch).map(item => ({
          label: item.name + ' · ' + item.head.slice(0, 8), rawLabel: true,
          run: () => runCommand('forcePush', { remote: item.remote, branch: item.branch, expected: item.head }),
        }))) });
    }
    for (const action of ['merge', 'rebase', 'cherryPick']) add(action, [revision()]);
    if (refs.operation) {
      const operation = { 'cherry-pick': 'cherryPick', cherryPick: 'cherryPick', merge: 'merge', rebase: 'rebase' }[refs.operation.type];
      if (operation) {
        add(operation + 'Continue', [], {}, !!refs.operation.conflicts.length);
        add(operation + 'Abort');
      }
    }
    add('stashPush', [field('message', 'Stash message', { optional: true }), field('includeUntracked', 'Include untracked files', { checkbox: true }), field('staged', 'Staged changes only', { checkbox: true })]);
    commands.push({ label: 'View stash…', disabled: !refs.stashes.length, run: () => commandList('Choose a stash to view',
      refs.stashes.map(item => ({ label: item.name + ' · ' + item.subject, rawLabel: true, run: () => openCommit(item.head) }))) });
    for (const action of ['stashApply', 'stashPop', 'stashDrop']) {
      commands.push({ label: actionNames[action], disabled: !refs.stashes.length, run: () => commandList('Choose stash',
        refs.stashes.map(item => ({
          label: item.name + ' · ' + item.subject, rawLabel: true,
          run: () => runCommand(action, { ref: item.ref, expected: item.head },
            action === 'stashDrop' ? [] : [field('restoreIndex', 'Restore staging state', { checkbox: true })]),
        }))) });
    }
    commands.push({ label: actionNames.stashDropAll, disabled: !refs.stashes.length, run: () =>
      actionForm(actionNames.stashDropAll, [], (_, confirmed) => performAction('git_operation', {
        action: 'stashDropAll', expectedStashes: refs.stashes.map(item => item.head), confirmed,
      }, actionNames.stashDropAll), { confirmation: msg(refs.stashes.length === 1 ? '{count} stash · {checkout}' : '{count} stashes · {checkout}', {
        count: refs.stashes.length, checkout: state.checkout,
      }) }) });
    add('createWorktree', [destination(), field('branch', 'Existing branch', { choices: branches, optional: true }), field('newBranch', 'New branch name', { optional: true }), field('ref', 'Start from', { optional: true })]);
    const removable = destinations.filter(item => !item.main && !item.locked);
    add('removeWorktree', [worktree(removable)], {}, !removable.length);
    add('moveWorktreeChanges', [worktree(destinations, 'Destination worktree')], {}, !destinations.length);
    commands.push({ label: 'Open worktree…', disabled: !destinations.length, run: () => commandList('Open worktree',
      destinations.map(item => ({ label: shortPath(item.path), rawLabel: true, run: () => switchCheckout(item.path) }))) });
    commands.push({ label: 'Git output', run: () => {
      openDetail(msg('Git output'), msg('Checkout diagnostics'), 'output');
      showDetail(element('pre', 'sc-commit-text', workbench.output || el('diagnostics').textContent));
    } });
  }
  if (anchor) openContextMenu(commands, { anchor, event, label: 'Git actions' });
  else commandList('Git actions', commands);
}
