export function graphRows(commits) {
  let lanes = [];
  let nextColor = 0;
  return commits.map(commit => {
    let lane = lanes.findIndex(item => item.id === commit.id);
    const incoming = lane >= 0;
    if (!incoming) {
      lane = lanes.length;
      lanes.push({ id: commit.id, color: nextColor++ % 6 });
    }
    const color = lanes[lane].color;
    const outgoing = lanes.filter((_, index) => index !== lane);
    let insertion = lane;
    for (const [index, parent] of commit.parents.entries()) {
      if (!outgoing.some(item => item.id === parent)) {
        outgoing.splice(insertion++, 0, { id: parent, color: index === 0 ? color : nextColor++ % 6 });
      }
    }
    const edges = [];
    for (const [from, item] of lanes.entries()) {
      const targets = from === lane ? commit.parents : [item.id];
      for (const target of targets) {
        const to = outgoing.findIndex(candidate => candidate.id === target);
        edges.push({ from, to, color: outgoing[to].color });
      }
    }
    const result = { lane, color, edges, incoming, columns: Math.max(lanes.length, outgoing.length) };
    lanes = outgoing;
    return result;
  });
}

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
