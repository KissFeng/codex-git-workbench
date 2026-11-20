# Git Workbench for Codex

Git Workbench manages local Git checkouts from a Codex desktop panel. It is based on [Source Control for Codex v0.5.1](https://github.com/saltnpixels/codex-source-control/tree/v0.5.1). The new marketplace and plugin identifiers allow the original installation to coexist.

## Install

Use Codex desktop with local MCP Apps, Git 2.35 or later and Node.js 24 or later on PATH. The plugin uses the system Git and has no npm dependencies.

From an authenticated checkout of this repository:

```sh
codex plugin marketplace add "$PWD"
codex plugin add codex-git-workbench@kissfeng-git-tools
```

Open **Git Workbench** from the panel picker. Reopen Codex if the new panel or version does not appear. To update or roll back, check out the desired Git tag in the marketplace checkout, rerun the install command and reopen the panel.

## Workflows

| Area | Panel capabilities |
| --- | --- |
| Repositories | Discover saved Codex projects and linked worktrees. Open an absolute checkout path, initialize a repository or clone with optional submodules. |
| Changes | Browse changes as a list or tree. Open source, unified or split Diff, and image snapshots. Stage or unstage individual files, groups, text hunks and selected lines. Discard selected text or tracked changes, remove confirmed untracked files, ignore files, rename or delete files. |
| Commits | Commit staged files with Cmd/Ctrl+Enter, commit all, amend, create empty commits and undo an unpublished commit. The options dialog supports all-file amend, a commit template, cryptographic signing, Git sign-off and explicitly skipping hooks. |
| History | Inspect current and upstream commits, fork and merge edges, reference labels and divergence. View commit messages and changed files, compare refs or the working copy, follow file history and inspect line attribution. |
| Branches and remotes | Switch local or tracked remote branches, check out detached revisions, manage branches and tags, add or remove remotes, fetch, pull, push, publish an upstream and sync. Sync defaults to fast-forward only. Choose rebase sync or include reachable annotated tags when needed. Force-push requires a lease for the previously selected remote tip. |
| Conflicts and worktrees | Inspect base, ours, theirs and working content. Edit and stage eligible results or choose a version. Continue or abort merge, rebase and cherry-pick; create, view, apply, pop and drop stashes; manage worktrees and transfer pending changes. |

Git hooks, credentials, signing and remote configuration come from the local Git installation. A failed sync stops before push. Disk-changing, history-rewriting and remote writes that need confirmation show their target in the panel.

Use whole-file actions for binary files, symbolic links, renames and permission changes. File and image previews have size limits. Editor-specific Git actions such as file history, blame and merge resolution are available inside the panel. Commit message generation, GitHub sign-in and pull-request management are separate integrations.

## Design and development

The Git workflow reference is the [VS Code built-in Git extension](https://github.com/microsoft/vscode/tree/748f712f3050ae8f29d8af75ad560d7a88ac3322/extensions/git). The Codex interface uses the host's light and dark schemes. Its JavaScript frontend talks to a local stdio MCP service. File, history and Git mutation tools are panel-only. Git commands execute in the selected checkout and plugin writes are queued by the common Git directory across linked worktrees.

```sh
npm test
```

The Node test suite creates disposable local repositories and bare remotes. It covers staging and commits, conflicts and remotes, graph and path handling, Codex project discovery, and the packaged MCP resource. CI runs on macOS and Linux.

## License

[MIT](LICENSE). The upstream license and Git history are preserved.
