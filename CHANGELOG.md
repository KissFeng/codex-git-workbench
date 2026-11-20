# Changelog

## 0.7.0

- Show Repositories, Changes and Graph together, with a resizable divider and independent scroll areas.
- Add checkout, file and commit row actions, hover details, searchable branches and context menus that work from the keyboard.
- Show the appropriate commit, sync, publish or conflict action. Return from narrow previews to the originating row.
- Add all-reference history, grouped reference filters, incoming and outgoing comparisons, and inline commit file lists.

## 0.6.0

- Add Git sign-off trailers, all-file amend and restoring the configured commit template.
- Add explicit rebase sync and pushing reachable annotated tags with a branch.

## 0.6.0-preview.1

- Add the Git Workbench panel with repository and worktree selection, compact file and tree views, split Diff, commit controls and an interactive commit graph.
- Support staged-only, all-file, amended and empty commits plus undo, and stage or revert exact text selections.
- Add branch, remote, stash, worktree and conflict workflows with temporary-repository and MCP tests.

## 0.5.1 beta — 2026-10-13

- Show one clickable repository picker before selection; branch details appear after a repository loads.
- Add a real Codex screenshot to the README.

## 0.5.0 beta — 2026-10-13

Initial public beta for Codex desktop.

- Live discovery of Codex projects, including every root of multi-repository projects.
- Current checkout branch, searchable repositories, and expandable Git worktrees.
- Staged, unstaged, untracked, and conflicted file lists.
- Source and unified diff views, with staged and working snapshots kept distinct.
- Image previews with dimensions, byte size, and before/after snapshots.
- Per-file staging and unstaging that preserves working-copy contents.
- Relative plugin launch paths and temporary Git fixture tests.

Project discovery reads Codex's internal local catalog; future storage changes may require an adapter update. An explicit checkout path remains available.
