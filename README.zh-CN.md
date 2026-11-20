# Codex Git 工作台

[English](README.md) · **简体中文**

Codex 桌面端的本地 Git 工作台。查看差异、暂存更改，并管理提交、分支和工作树。

[快速开始](#快速开始) · [功能](#功能) · [更新日志](CHANGELOG.md)

![Codex 桌面端示意图，左侧是项目列表，中间是聊天，右侧是 Git 工作台](docs/workbench-codex.zh-CN.png)

*Git 工作台与 Codex 聊天并排展示。图中的项目、对话和 Git 数据均为虚构示例。*

## 快速开始

需要支持本地 MCP Apps 的 Codex 桌面端、Git 2.35 或更高版本，以及 Node.js 24 或更高版本。请确保 `git` 和 `node` 在 PATH 中。插件无需安装 npm 依赖。

从 GitHub 安装 [v0.8.1](https://github.com/KissFeng/codex-git-workbench/releases/tag/v0.8.1)。

```sh
codex plugin marketplace add KissFeng/codex-git-workbench --ref v0.8.1
codex plugin add codex-git-workbench@kissfeng-git-tools
```

在面板选择器中打开 **Git Workbench**。如果当前 Codex 聊天关联了 Git 工作目录，工作台会自动选中对应的工作副本。也可以从仓库选择器查找已保存的项目和工作树，或打开其他工作副本。如果面板或新版本未出现，重新打开 Codex。

## 功能

| 工作流程 | 支持的操作 |
| --- | --- |
| 仓库 | 查找已保存的 Codex 项目和关联工作树，在 macOS 或 Windows 上选择文件夹，初始化仓库，或在克隆时选择是否拉取子模块。文件夹选择器不可用时可输入绝对路径。 |
| 查看与暂存更改 | 用列表或树形视图浏览更改，查看源文件、统一或并排差异以及图片快照。按文件、分组、差异块或选中行暂存和取消暂存。丢弃已跟踪文件的更改，或在确认后移除未跟踪的文件。也可以忽略、重命名或删除文件。 |
| 提交 | 提交已暂存或全部更改，修订上一次提交，创建空提交，或撤销尚未发布的提交。提交选项包括带上全部文件进行修订、恢复提交模板、签名、添加 Signed-off-by 和跳过钩子。 |
| 提交历史 | 按分支、标签或其他引用筛选提交图。展开提交查看文件，定位 HEAD，比较引用或工作副本，并以共同祖先为基准查看传入和传出更改。查看文件历史和逐行归属。 |
| 分支与远程 | 切换本地分支或跟踪远程分支，检出游离 HEAD，管理分支、标签和远程仓库，执行抓取、拉取、推送、发布或同步。同步默认仅允许快进，也可以选择变基同步或同时推送可达的附注标签。强制推送会校验此前选定的远程分支提交。 |
| 冲突、贮藏与工作树 | 对比冲突文件的基准、本方、对方和工作副本。编辑并暂存支持的结果，或选用其中一个版本。继续或中止合并、变基和拣选提交。创建、查看、应用、弹出或删除贮藏。创建或移除工作树，并在工作树之间转移待处理更改。 |

## 使用面板

- **布局。** 仓库、更改和提交图显示在同一面板。可以折叠各区域，也可以拖动任一分隔线调整相邻区域的高度。在窄面板中，从预览点击**返回**可回到原来的条目和滚动位置。
- **操作。** 悬停在条目上可显示快捷操作，也可右键或按 **Shift+F10** 打开菜单。在 macOS 和 Windows 上，文件菜单可以打开文件或所在文件夹。主按钮会根据当前检出状态提供提交、同步或冲突处理操作。在提交信息框中按 **Cmd/Ctrl+Enter** 可发起提交流程。
- **语言。** 在**源代码管理**标题栏中切换简体中文或英文。面板初始使用简体中文，并记住你的选择。仓库名、路径和 Git 内容保留原文。

### 宽面板

![Git 工作台左侧显示暂存文件和提交图，右侧显示并排差异](docs/workbench-wide.zh-CN.png)

*宽面板的并排差异视图，使用示例仓库数据。*

### 窄侧栏

<p align="center">
  <img src="docs/workbench-sidebar.zh-CN.png" width="400" alt="深色窄栏中的 Git 工作台，依次显示仓库、更改和提交图">
</p>

*深色主题下的窄侧栏，使用示例仓库数据。*

插件使用本机 Git 的钩子、凭据、签名和远程配置。需要确认的写入操作会先在面板中显示目标。同步时如果拉取失败，流程会在推送前停止。

二进制文件、符号链接、重命名和权限变更需要按整个文件操作。文件和图片预览有大小限制。提交信息生成、GitHub 登录和 Pull Request 管理由独立集成提供。

## 本地开发

在仓库根目录注册本地插件市场，然后安装插件。

```sh
codex plugin marketplace add "$PWD"
codex plugin add codex-git-workbench@kissfeng-git-tools
```

使用 Node.js 24 或更高版本运行 `npm test`。测试使用临时本地仓库和裸仓库，覆盖暂存、提交、冲突、远程操作、提交历史、路径处理、Codex 项目发现和打包后的 MCP 资源。CI 在 macOS 和 Linux 上运行。

JavaScript 面板跟随 Codex 的浅色和深色主题，通过标准输入输出与本地 MCP 服务通信。文件、历史和 Git 写入工具仅供面板调用。Git 命令在选中的检出目录中执行，共用 Git 目录的关联工作树共享写入队列。

## 许可证与致谢

项目采用 [MIT 许可证](LICENSE)，基于 [Source Control for Codex v0.5.1](https://github.com/saltnpixels/codex-source-control/tree/v0.5.1)，保留了上游的许可证和 Git 历史。独立的插件市场和插件标识符允许两个版本同时安装。

Git 工作流程参考了 [VS Code 内置 Git 扩展](https://github.com/microsoft/vscode/tree/748f712f3050ae8f29d8af75ad560d7a88ac3322/extensions/git)。改编自 Code - OSS 的提交图逻辑见[第三方声明](plugins/source-control-proof/THIRD_PARTY_NOTICES.md)。
