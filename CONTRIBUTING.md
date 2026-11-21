# Contributing to Git Workbench

**English** · [简体中文](#参与贡献)

Documentation fixes, translations, compatibility reports, and code changes are welcome. Browse the [good first issues](https://github.com/KissFeng/git-workbench/labels/good%20first%20issue) for a small task. If you want to work on one, leave a comment there.

1. **Choose a change.** Open a PR directly for a small fix. Discuss bigger changes in an [issue](https://github.com/KissFeng/git-workbench/issues) so we can agree on the scope first. For a bug or compatibility report, include your OS, Codex or Antigravity version, plugin tag, and reproduction steps.
2. **Set up a local checkout.** Fork and clone the repository, then create a branch from `main`. Follow the [local development instructions](README.md#development) to install your checkout in Codex.
3. **Check your change.** Run `npm test` with Node.js 24 or later. The panel uses English strings as message keys. When editing panel text, update the English key at its call sites and its Simplified Chinese translation in the corresponding `panel-messages-*.mjs` file. Keep placeholders such as `{count}` consistent. When updating user-facing instructions, check both READMEs.
4. **Open the PR.** Push your branch to your fork and open a PR targeting this repository's `main`. Describe the change and how you verified it. Link a related issue if there is one, and attach a screenshot for visible UI changes.

## 参与贡献

欢迎修订文档、补充翻译、反馈兼容性问题和提交代码。可以从 [good first issue](https://github.com/KissFeng/git-workbench/labels/good%20first%20issue) 挑一项小任务，想认领就在对应 Issue 下留言。

1. **确认改动范围。** 小修可以直接提 PR。较大的改动请先开 [Issue](https://github.com/KissFeng/git-workbench/issues) 对齐范围。反馈 Bug 或兼容性问题时，请附上系统、Codex 或 Antigravity 版本、插件 tag 和复现步骤。
2. **准备本地环境。** Fork 并克隆仓库，从 `main` 创建分支。按[本地开发说明](README.zh-CN.md#本地开发)将本地工作副本安装到 Codex 中。
3. **验证改动。** 使用 Node.js 24 或更高版本运行 `npm test`。面板以英文原文作为文案键。修改面板文案时，请同时更新调用处的英文键和对应 `panel-messages-*.mjs` 文件里的简体中文译文，并保持 `{count}` 等占位符一致。修改用户操作说明时，请同时检查两份 README。
4. **提交 PR。** 将分支推送到你的 Fork，以本仓库的 `main` 为目标创建 PR。说明改了什么、如何验证，有相关 Issue 就附上链接。涉及可见界面改动时，请附截图。
