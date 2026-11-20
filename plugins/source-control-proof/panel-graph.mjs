/*
 * The swimlane construction adapts Code - OSS's scmHistory.ts.
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See THIRD_PARTY_NOTICES.md for the license and pinned source.
 */

const branchColors = ['branch-0', 'branch-1', 'branch-2', 'branch-3', 'branch-4', 'branch-5'];

export function buildHistoryGraph(commits, { head, upstream, base, ahead, behind, path } = {}) {
  let lastBranchColor = -1;
  const rows = [];
  const nextColor = () => branchColors[++lastBranchColor % branchColors.length];
  const tipColor = id => id === head ? 'current' : id === upstream ? 'upstream' : undefined;

  function append(row, parents, matchId = row.id) {
    const input = rows.at(-1)?.output ?? [];
    const inputIndex = input.findIndex(node => node.id === matchId);
    const lane = inputIndex < 0 ? input.length : inputIndex;
    const color = tipColor(matchId) ?? input[inputIndex]?.color ?? nextColor();
    const output = [];
    const segments = [];
    const connect = (fromLane, fromLevel, toLane, toLevel, color) => {
      segments.push({ from: [fromLane, fromLevel], to: [toLane, toLevel], color });
    };
    const addParent = (id, parentColor) => {
      connect(lane, 1, output.length, 2, parentColor);
      output.push({ id, color: parentColor });
    };

    // Continue every unrelated lane. Substitute only the first matching lane
    // with the first parent and join all other matching lanes at this commit.
    for (const [index, node] of input.entries()) {
      if (node.id === matchId) {
        connect(index, 0, lane, 1, node.color);
        if (index === inputIndex && parents.length) addParent(parents[0], color);
      } else {
        connect(index, 0, output.length, 2, node.color);
        output.push(node);
      }
    }
    for (let index = inputIndex < 0 ? 0 : 1; index < parents.length; index++) {
      addParent(parents[index], index === 0 ? color : tipColor(parents[index]) ?? nextColor());
    }

    rows.push({ ...row, input, output, lane, color, segments, columns: Math.max(input.length, output.length, lane + 1) });
  }

  for (const [index, commit] of commits.entries()) {
    const { id } = commit;
    const kind = id === head ? 'head' : id === upstream ? 'upstream' : 'commit';
    const direction = kind === 'head' ? 'outgoing' : 'incoming';
    const count = kind === 'head' ? ahead : behind;
    if (!path && base && base !== id && head && upstream && head !== upstream && kind !== 'commit' && count > 0) {
      // Anchor the synthetic row at its tip. Existing lanes to that tip run
      // through the synthetic row, so unrelated branches retain their lanes.
      append({ id: direction, kind: direction, comparison: { from: base, to: id }, count }, [id], id);
    }
    // Git's rename-follow walk can omit intermediate commits from file history.
    const next = commits[index + 1];
    const parents = path ? (next ? [next.id] : []) : commit.parents;
    append({ id, kind, commit }, parents);
  }
  return rows;
}

export function historyQuery(scope, refs, path, ref) {
  if (path) return { scope: 'auto', path, ...(ref ? { ref } : {}) };
  if (scope === 'selected') return { scope: 'auto', refs: [...new Set(refs)].sort() };
  return { scope: scope === 'all' ? 'all' : 'auto' };
}

export function matchingHistoryReferences(refs, search) {
  const query = search.trim().toLowerCase();
  return [
    { label: 'Local branches', items: refs.branches },
    { label: 'Remote branches', items: refs.remoteBranches },
    { label: 'Tags', items: refs.tags },
  ].map(({ label, items }) => ({ label, items: items.filter(item =>
    item.name.toLowerCase().includes(query) || item.ref.toLowerCase().includes(query) ||
    item.head?.toLowerCase().startsWith(query)) }))
    .filter(group => group.items.length);
}

export function historyRefTags(refs, { branch, upstream } = {}) {
  const visible = new Map(refs.map(ref => [ref.kind + ':' + ref.name, ref]));
  const order = ref => {
    if (ref.kind === 'head') return 0;
    if (ref.kind === 'branch' && ref.name === branch) return 1;
    if (['branch', 'remote'].includes(ref.kind) && ref.name === upstream) return 2;
    return { branch: 3, remote: 4, tag: 5 }[ref.kind] ?? 6;
  };
  return [...visible.values()].sort((a, b) => order(a) - order(b));
}
