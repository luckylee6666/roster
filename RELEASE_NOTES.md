Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.6.1 / 本版更新

**English**

- **Project shared memory now carries its own convention to the assistant.** Every injected reference block states which store is authoritative (`.memory/`, a link to the Claude project memory), that "update memory" means editing the topic files there, that ordinary conclusions go to `inbox/`, and that the assistant must not fall back to its own CLI's memory (Grok's `memory`, Command Code's `/memory`, Codex's `~/.codex/memories/`). Until now that convention only reached models that happened to read `CLAUDE.md` / `AGENTS.md` themselves, which is why a Command Code session could try to update its own memory instead of the project's.
- The pointer block written into `CLAUDE.md` / `AGENTS.md` is refreshed with the same rule the next time a project's memory is mounted (existing blocks are replaced, not skipped), and the index template used for new projects carries it too — so new and older projects behave the same.
- The shared-memory panel wording now says plainly that the assistant writes those files rather than its own CLI memory.

**中文**

- **项目共享记忆现在把约定直接交给助手**：每次注入的参考资料都会说明正本是 `.memory/`（指向 Claude 项目记忆的链接）、「更新记忆」指改那里的专题文件、平时的结论写 `inbox/`，并明确不允许改用助手自己 CLI 的记忆（Grok 的 `memory`、Command Code 的 `/memory`、Codex 的 `~/.codex/memories/`）。此前这条约定只能靠模型自己去读 `CLAUDE.md` / `AGENTS.md`，所以才会有 Command Code 会话想着去更新它自己的记忆。
- 写进 `CLAUDE.md` / `AGENTS.md` 的指针块会在该项目下次挂载记忆时被替换成同一套规则（原有块是替换而非跳过），新建项目的索引模板也带这条——新老项目行为一致。
- 面板文案同步说清：助手写的是那些文件，而不是它自己 CLI 的记忆。


## Upgrade / 升级

Quit all older Roster instances before opening this version, including Debug builds. Older versions do not participate in the new lock. This release requires no data migration.
启动新版前请退出所有旧版 Roster，包括 Debug 版。旧版本尚未参与实例锁保护。本版无需数据迁移。

## Install / 安装

**macOS** — ad-hoc signed, not notarized / adhoc 签名，未公证：

1. Open the `.dmg`, drag the app into Applications / 打开 `.dmg`，把应用拖入「应用程序」
2. If first launch is blocked: **System Settings → Privacy & Security → Open Anyway** / 首次打开被拦：**系统设置 → 隐私与安全性 → 仍要打开**

**Windows** — unsigned, SmartScreen may warn / 未签名，可能出现 SmartScreen 提示：

1. Download the `*-setup.exe` for your architecture and run it / 下载对应架构的 `*-setup.exe` 安装
2. On the SmartScreen prompt: **More info → Run anyway** / SmartScreen 提示：**更多信息 → 仍要运行**
3. Pick **x64** for Intel/AMD, **arm64** for Snapdragon/Surface-ARM / Intel/AMD 选 **x64**，骁龙/ARM Surface 选 **arm64**
