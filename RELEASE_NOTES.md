Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.4.1 / 本版更新

**English**

- Grok subscription usage now refreshes through the official local CLI's ACP billing interface. No model prompt or conversation is created; local logs are a stale fallback only.
- Opening usage reuses startup CLI detection. Manual refresh bypasses the normal cache for Claude, Codex and Grok and reports success or failure.
- Resumed Codex threads sort by last activity. Every CLI's conversation history opens at its newest message and follows delayed media layout; “Back to latest” restores following without accumulating media listeners.
- Local text and Claude project-memory links open in a read-only overlay in the conversation workspace. Nested links resolve relative to the open document; line links show source and highlight the requested line.
- A data-directory instance lock prevents two copies of Roster from overwriting each other's project lists.

**中文**

- Grok 订阅用量通过官方本机 CLI 的 ACP 接口实时刷新，不创建对话或发送模型请求；本地日志仅作为旧数据兜底。
- 打开用量面板复用启动时的 CLI 探测；手动刷新绕过 Claude、Codex、Grok 的普通缓存，并明确显示成功或失败。
- Codex 续接会话按最后活动时间排序；所有 CLI 历史打开后定位最新消息，支持延迟媒体布局校准与「回到最新」恢复跟随，并消除媒体监听器重复积累。
- 本地文本和 Claude 项目记忆链接直接在会话内只读预览；相对链接按当前文件目录解析，带行号的链接打开源码并定位、高亮目标行。
- 数据目录新增实例锁，避免同时运行两份 Roster 导致项目表互相覆盖。

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
