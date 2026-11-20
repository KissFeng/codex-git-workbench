function copyText(value) {
  if (!navigator.clipboard) {
    const text = element('textarea', 'sc-input');
    text.value = value;
    text.readOnly = true;
    openAction('Copy text', text);
    text.select();
    return;
  }
  navigator.clipboard.writeText(value)
    .then(() => { el('staging-message').textContent = 'Copied'; })
    .catch(error => showError(error.message));
}

function openAction(title, content) {
  const dialog = el('action-dialog');
  el('action-title').textContent = title;
  el('action-body').replaceChildren(content);
  if (!dialog.open) dialog.showModal();
  el('action-body').querySelector('input,select,button')?.focus();
}

const field = (key, label, options = {}) => ({ key, label, ...options });

function actionForm(title, fields, onSubmit, { confirmation, submitLabel = title } = {}) {
  const form = element('form', 'sc-action-form');
  const controls = new Map();
  for (const definition of fields) {
    const { key, label, value, optional, checkbox, multiline, choices, placeholder } = definition;
    const wrapper = element('label', checkbox ? 'sc-check-field' : 'sc-form-field');
    let input;
    if (choices?.length) {
      input = element('select', 'sc-input');
      if (optional) input.append(element('option', '', 'Use Git default'));
      else input.append(element('option', '', 'Choose…'));
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
      if (placeholder) input.placeholder = placeholder;
    }
    if (checkbox) input.checked = !!value;
    else {
      input.required = !optional;
      if (value !== undefined) input.value = value;
    }
    const caption = element('span', '', label);
    wrapper.append(...(checkbox ? [input, caption] : [caption, input]));
    form.append(wrapper);
    controls.set(key, input);
  }
  if (confirmation) form.append(element('p', 'sc-confirm-copy', confirmation));
  const actions = element('div', 'sc-actions sc-dialog-buttons');
  const submit = element('button', 'sc-primary', submitLabel);
  submit.type = 'submit';
  actions.append(control('Cancel', () => el('action-dialog').close()), submit);
  form.append(actions);
  form.onsubmit = event => {
    event.preventDefault();
    const values = {};
    for (const [key, input] of controls) {
      if (input.type === 'checkbox') { if (input.checked) values[key] = true; }
      else if (input.value.trim()) values[key] = input.value.trim();
    }
    el('action-dialog').close();
    onSubmit(values, !!confirmation);
  };
  openAction(title, form);
}

function commandList(title, choices) {
  const list = element('div', 'sc-command-list');
  for (const choice of choices) {
    const button = control(choice.label, () => {
      el('action-dialog').close();
      choice.run();
    }, 'sc-command-entry');
    button.disabled = choice.disabled === true;
    list.append(button);
  }
  openAction(title, list);
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
  const confirmation = confirmActions.has(action) ? [label, target, state.checkout].filter(Boolean).join(' · ') : '';
  actionForm(label, fields, submit, { confirmation });
}

function showCommitOptions() {
  const selected = [
    { action: 'commit', label: 'Commit staged with options' },
    { action: 'commitAll', label: 'Commit all changes' },
    { action: 'amend', label: 'Amend last commit' },
    { action: 'commitEmpty', label: 'Create empty commit' },
    { action: 'undoCommit', label: 'Undo last commit' },
  ];
  const options = selected.map(({ action, label }) => ({
    label,
    disabled: !state.status || !!workbench.busy,
    run: () => actionForm(label, action === 'undoCommit' ? [] : [
      field('message', 'Commit message', { value: el('commit-message').value, optional: action === 'amend', multiline: true }),
      field('signed', 'Cryptographically sign commit', { checkbox: true }),
      field('signoff', 'Append Signed-off-by trailer', { checkbox: true }),
      ...(action === 'amend' ? [field('all', 'Stage all working-copy changes', { checkbox: true })] : []),
      field('noVerify', 'Skip commit hooks', { checkbox: true }),
    ], (values, confirmed) => performAction('git_commit', { action, ...values, ...(confirmed ? { confirmed } : {}) }, label),
    { confirmation: ['amend', 'undoCommit', 'commitAll'].includes(action) ? label + ' on ' + state.status.branch : '' }),
  }));
  options.push({ label: 'Restore commit template…', disabled: !state.checkout, run: restoreCommitTemplate });
  commandList('Commit options', options);
}

async function restoreCommitTemplate() {
  const epoch = state.epoch;
  const draft = el('commit-message').value;
  try {
    const result = await callTool('git_commit_template', { repoPath: state.checkout });
    if (epoch !== state.epoch) return;
    if (result.template === null) {
      el('staging-message').textContent = 'No commit template is configured.';
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

async function chooseBranch() {
  const refs = await readReferences();
  if (!refs) return;
  const choices = [
    ...refs.branches.map(item => ({
      label: item.name + (item.current ? ' · current' : ''),
      disabled: item.current,
      run: () => runCommand('switchBranch', { name: item.name }),
    })),
    ...refs.remoteBranches.filter(item => item.remote && item.branch).map(item => ({
      label: item.name + ' · remote',
      run: () => runCommand('switchBranch', { name: item.branch, remote: item.remote }),
    })),
    ...refs.tags.map(item => ({ label: item.name + ' · tag', run: () => runCommand('checkoutDetached', { ref: item.ref }) })),
  ];
  choices.unshift({ label: 'Create branch…', run: () => runCommand('createBranch', {}, [field('name', 'Branch name'), field('startPoint', 'Start from', { optional: true }), field('checkout', 'Switch to this branch', { checkbox: true, value: true })]) });
  commandList('Switch branch', choices);
}

async function chooseReference() {
  const refs = await readReferences();
  if (!refs) return;
  commandList('History references', [
    { label: 'Current branch and upstream', run: () => filterHistory(null, null) },
    ...[...refs.branches, ...refs.remoteBranches, ...refs.tags].map(item => ({
      label: item.name, run: () => filterHistory(item.ref, null),
    })),
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

async function showCommands() {
  if (workbench.busy || state.staging) return;
  const destination = () => field('destination', 'Absolute checkout path');
  const commands = [
    { label: actionNames.init, run: () => runCommand('init', {}, [destination()]) },
    { label: actionNames.clone, run: () => runCommand('clone', {}, [field('url', 'Repository URL'), destination(), field('recursive', 'Initialize submodules', { checkbox: true })]) },
  ];
  if (state.status) {
    const refs = await readReferences();
    if (!refs) return;
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
    add('createBranch', [name('Branch name'), field('startPoint', 'Start from', { optional: true }), field('checkout', 'Switch to this branch', { checkbox: true, value: true })]);
    add('checkoutDetached', [revision()]);
    add('renameBranch', [name('Branch', branches), field('newName', 'New name')], {}, !branches.length);
    add('deleteBranch', [name('Branch', branches), field('force', 'Allow deleting an unmerged branch', { checkbox: true })], {}, !branches.length);
    add('createTag', [name('Tag name'), field('ref', 'Reference', { optional: true }), field('message', 'Annotation', { optional: true })]);
    add('deleteTag', [name('Tag', localTags)], {}, !localTags.length);
    add('addRemote', [name('Remote name'), field('url', 'Remote URL')]);
    add('removeRemote', [name('Remote', remoteNames)], {}, !remoteNames.length);
    add('fetch', [remote(), field('prune', 'Prune stale references', { checkbox: true })], {}, !remoteNames.length);
    for (const action of ['pull', 'pullMerge', 'pullRebase', 'push', 'publish', 'sync', 'syncRebase']) addRemoteAction(action);
    const kinds = [{ value: 'branch', label: 'Branch' }, { value: 'tag', label: 'Tag' }];
    add('fetchRef', [remote(false), field('kind', 'Reference type', { choices: kinds }), name('Remote reference name')], {}, !remoteNames.length);
    add('pushRef', [remote(false), field('ref', 'Local reference', { choices: [...refs.branches, ...refs.tags].map(item => item.ref) })], {}, !remoteNames.length || (!branches.length && !localTags.length));
    add('pushTags', [remote(false)], {}, !remoteNames.length || !localTags.length);
    add('deleteRemoteTag', [remote(false), name('Remote tag name')], {}, !remoteNames.length);
    const remoteBranches = refs.remoteBranches.filter(item => item.remote && item.branch);
    commands.push({ label: actionNames.deleteRemoteBranch, disabled: !remoteBranches.length, run: () => commandList('Choose a remote branch to delete',
      remoteBranches.map(item => ({ label: item.name, run: () => runCommand('deleteRemoteBranch', { remote: item.remote, name: item.branch, expected: item.head }) }))) });
    if (refs.remoteBranches.some(item => item.remote && item.branch)) {
      commands.push({ label: actionNames.forcePush, run: () => commandList('Choose the remote branch to update',
        refs.remoteBranches.filter(item => item.remote && item.branch).map(item => ({
          label: item.name + ' · ' + item.head.slice(0, 8),
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
      refs.stashes.map(item => ({ label: item.name + ' · ' + item.subject, run: () => openCommit(item.head) }))) });
    for (const action of ['stashApply', 'stashPop', 'stashDrop']) {
      commands.push({ label: actionNames[action], disabled: !refs.stashes.length, run: () => commandList('Choose stash',
        refs.stashes.map(item => ({
          label: item.name + ' · ' + item.subject,
          run: () => runCommand(action, { ref: item.ref, expected: item.head },
            action === 'stashDrop' ? [] : [field('restoreIndex', 'Restore staging state', { checkbox: true })]),
        }))) });
    }
    commands.push({ label: actionNames.stashDropAll, disabled: !refs.stashes.length, run: () =>
      actionForm(actionNames.stashDropAll, [], (_, confirmed) => performAction('git_operation', {
        action: 'stashDropAll', expectedStashes: refs.stashes.map(item => item.head), confirmed,
      }, actionNames.stashDropAll), { confirmation: refs.stashes.length + (refs.stashes.length === 1 ? ' stash' : ' stashes') + ' · ' + state.checkout }) });
    add('createWorktree', [destination(), field('branch', 'Existing branch', { choices: branches, optional: true }), field('newBranch', 'New branch name', { optional: true }), field('ref', 'Start from', { optional: true })]);
    const removable = destinations.filter(item => !item.main && !item.locked);
    add('removeWorktree', [worktree(removable)], {}, !removable.length);
    add('moveWorktreeChanges', [worktree(destinations, 'Destination worktree')], {}, !destinations.length);
    commands.push({ label: 'Open worktree…', disabled: !destinations.length, run: () => commandList('Open worktree',
      destinations.map(item => ({ label: shortPath(item.path), run: () => switchCheckout(item.path) }))) });
    commands.push({ label: 'Git output', run: () => {
      openDetail('Git output', 'Checkout diagnostics', 'output');
      showDetail(element('pre', 'sc-commit-text', workbench.output || el('diagnostics').textContent));
    } });
  }
  commandList('Git actions', commands);
}
