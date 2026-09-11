Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.5.0 / 本版更新

**English**

- All seven conversation CLIs now reuse resident sessions: Claude/agy/Qwen over bidirectional JSON and Grok/OpenCode/MiMo Code over stdio ACP (Codex already had its resident App Server). Consecutive messages in the same project and thread reuse the loaded CLI session instead of restarting it; a bounded idle pool is cleaned up on cancel, errors, settings changes, switching to Developer mode, history deletion and exit.
- Project shared memory now runs automatically in the conversation workspace: a compact status replaces the management dialog, successful substantive turns record bounded source-labelled progress excerpts, and later requests reuse them. Curated topics are never overwritten; manual editing stays optional in Developer mode.
- A dedicated development build: `pnpm dev` / `pnpm build:dev` launches Roster Dev with its own application id, data directory, backups and WebView preferences, and can run alongside the production app.
- OpenCode Go subscription usage joins the usage panel and the assistant badge: 5-hour / weekly / monthly percentages with reset times, read from OpenCode's own `auth.json` through the official usage endpoint. Custom `opencode-go` gateways are skipped and the key only ever goes to the official host.
- Conversation history now restores pasted images from OpenCode/MiMo Code sessions, and protocol errors show their real message instead of a silent empty reply (MiMo) or a misleading "check the CLI is installed and logged in" hint (OpenCode).
- A saved model or reasoning effort that the CLI no longer lists is dropped on refresh instead of being sent every turn; lists that are only examples never delete manual choices.
- Developer-mode Codex resume can load sessions created by the conversation workspace again (native transport alias), and long-thread resume only requests metadata so it no longer fails before the first new prompt.
- Message hover actions (copy / ask again) keep a 6px gap from the bubble and stay reachable while the pointer travels to them.

**中文**

- 七家对话 CLI 全部接入常驻会话：Claude/agy/Qwen 走双向 JSON，Grok/OpenCode/MiMo Code 走 stdio ACP（Codex 此前已是常驻 App Server）。同项目、同会话的连续消息复用已加载的 CLI 会话，不再每轮重启；有界空闲池在取消/错误、设置变化、切换开发模式、删除历史和退出时清理。
- 对话工作台的项目共享记忆改为后台自动运行：只显示简短状态，正常结束且有实质进度的对话自动记录有来源标记的摘录，后续请求自动复用。人工专题不自动覆盖，编辑/恢复仅作为开发模式的可选高级操作。
- 独立开发版：`pnpm dev` / `pnpm build:dev` 启动 Roster Dev，使用单独应用标识、数据目录、备份和 WebView 偏好，可与正式版并行。
- 用量面板与对话助手徽标新增 OpenCode Go 订阅用量：5 小时 / 周 / 月三档百分比与重置时间，读取 OpenCode 自己 `auth.json` 经官方用量接口获取。配了自定义 `opencode-go` 网关时跳过，key 只发官方地址。
- 会话历史恢复 OpenCode/MiMo Code 的粘贴图片；协议错误带上真实原因，不再静默空回复（MiMo）或误报「请确认已安装并已登录」（OpenCode）。
- CLI 目录里不再提供的模型/推理强度会在刷新时丢掉，而不是每轮原样发出；只是示例的列表不会用来删手打的选择。
- 开发模式续接 Codex 能重新加载会话模式创建的线程（原生传输别名）；长会话续接只请求元数据，不会在第一个新提问前就失败。
- 消息悬停按钮（复制 / 重新提问）与气泡留 6px 间距，且鼠标移过去时保持可点。

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
