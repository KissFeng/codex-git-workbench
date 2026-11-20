export function diffRows(text) {
  const rows = [];
  let oldLine = 0;
  let newLine = 0;
  let inside = false;
  let removed = [];
  let added = [];
  const flush = () => {
    for (let index = 0; index < Math.max(removed.length, added.length); index++) {
      rows.push({ old: removed[index], next: added[index] });
    }
    removed = [];
    added = [];
  };
  for (const line of text.replace(/\n$/, '').split('\n').slice(0, 10000)) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      flush();
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inside = true;
      rows.push({ heading: line });
    } else if (inside && line.startsWith('-')) {
      removed.push({ text: line.slice(1), number: oldLine++, kind: 'removed' });
    } else if (inside && line.startsWith('+')) {
      added.push({ text: line.slice(1), number: newLine++, kind: 'added' });
    } else if (inside && line.startsWith(' ')) {
      flush();
      rows.push({ old: { text: line.slice(1), number: oldLine++ }, next: { text: line.slice(1), number: newLine++ } });
    } else {
      flush();
      if (line.startsWith('diff --git') || line.startsWith('@@@')) inside = false;
      rows.push({ heading: line });
    }
  }
  flush();
  return rows;
}

export function buildFileTree(files) {
  const tree = { children: [], folders: new Map() };
  for (const file of files) {
    const parts = file.path.split('/');
    const name = parts.pop();
    let parent = tree;
    let path = '';
    for (const directory of parts) {
      path += (path ? '/' : '') + directory;
      if (!parent.folders.has(directory)) {
        const folder = { name: directory, path, children: [], folders: new Map() };
        parent.children.push(folder);
        parent.folders.set(directory, folder);
      }
      parent = parent.folders.get(directory);
    }
    parent.children.push({ name, file });
  }
  return tree.children;
}

export function scmPrimaryAction(status) {
  const action = (kind, label, enabled = true) => ({ kind, label, enabled });
  if (!status) return action('none', 'Commit', false);
  if (status.conflicts.length) return action('conflicts', 'Resolve Conflicts');
  const operations = { merge: 'Merge', rebase: 'Rebase', cherryPick: 'Cherry-pick' };
  if (operations[status.operation]) return action('continue', 'Continue ' + operations[status.operation]);
  if (status.staged.length) return action('commit', 'Commit Staged');
  if (status.unstaged.length || status.untracked.length) return action('commitAll', 'Commit');
  if (status.detached || !status.head || !status.hasRemote) return action('none', 'Commit', false);
  if (!status.upstream) return action('publish', 'Publish Branch');
  const counts = [status.behind > 0 ? '↓' + status.behind : '', status.ahead > 0 ? '↑' + status.ahead : ''].filter(Boolean);
  return counts.length
    ? action(status.behind && status.ahead ? 'diverged' : 'sync', 'Sync Changes ' + counts.join(' '))
    : action('none', 'Commit', false);
}

export function scmSplitRatio(value) {
  return Number.isFinite(value) ? Math.max(0.2, Math.min(0.8, value)) : 0.6;
}
