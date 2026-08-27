Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.3.0 / 本版更新

**English**
- **New default conversation workspace** for non-developers: pick a project, talk to any of the eight installed AI CLIs (Claude, Grok, Codex, OpenCode, Gemini, agy, Qwen, MiMo Code), and read one merged history timeline with source badges. The full Developer mode — terminal, files, Git, split panes, collaboration, companion web, games — is one click away and unchanged.
- **Projects run in parallel.** Every project keeps its own conversation, draft, and running turn, so a turn started in one project keeps streaming while you read or type in another. The project list marks running projects, and up to four turns run at once.
- **You get told when a turn ends**: live elapsed time while it runs, total duration when it finishes, and a desktop notification when the result lands in a background project, an unfocused window, or while Developer mode is on screen.
- **Dark theme** for the conversation workspace, following the system by default with a system / light / dark switch in the sidebar. Every conversation colour now comes from a palette token, applied before the stylesheet so launching never flashes white.
- **Copy anything**: hover a message to copy it, drop a question of your own back into the composer, or copy a fenced code block on its own.
- **Clearer cross-CLI handoff**: switching the assistant with a session open now states who takes over from whom, that only the last 24 messages travel, and that the source session is left untouched — with one click to switch back.
- Paste images straight into the composer, create projects without leaving the workspace, and reuse prompt snippets and project context in place.
- Long transcripts stream smoothly: only the message being written is re-rendered, so local images and videos no longer flicker.
- Turns default to each CLI's read-only/plan policy; writing to the project needs an explicit per-turn toggle that resets when the turn ends.
- The project-ideas feature was removed from both modes; existing `ideas.json` data is left untouched on disk.
- macOS builds remain **ad-hoc signed**.

**中文**
- **新增面向普通用户的默认对话工作台**：选一个项目，直接和本机已安装的 8 家 AI CLI（Claude、Grok、Codex、OpenCode、Gemini、agy、Qwen、MiMo Code）对话，最近会话合并成一条带来源色标的时间线。原有开发模式（终端、文件、Git、分屏、协作、伴生网页、游戏）一键即回，功能不变。
- **多项目并行**：每个项目保留自己的对话、草稿和运行中的轮次，一个项目在跑时可以自由切到别的项目查看或输入，两边互不覆盖；项目列表标出正在处理的项目，最多 4 个同时跑。
- **跑完会告诉你**：运行中实时显示已用时间，结束显示本轮用时；结果落在后台项目、窗口失焦或人停在开发模式时会发桌面通知。
- **对话工作台支持深色**：默认跟随系统，左下角可在跟随系统 / 浅色 / 深色之间切换。对话区所有颜色改为配色令牌，并在样式表之前生效，启动不会闪白。
- **想复制就复制**：消息 hover 出现复制，自己问过的话可以「重新提问」放回输入框，回答里的代码块各自带复制按钮。
- **跨 CLI 交接说得清楚了**：会话打开时切换助手，输入框上方直接说明谁接手谁、只带最近 24 条正文、来源会话保持不动，并可一键改回。
- 输入框支持直接粘贴图片，工作台内即可新建项目，Prompt 片段与项目现场就地复用。
- 长对话流式更稳：只重建正在书写的那一条消息，项目内图片和视频不再闪烁。
- 每轮默认使用各 CLI 的只读/计划策略；要改项目必须本轮明确勾选，进入终态立即复位。
- 项目想法功能已从两个模式移除，磁盘上已有的 `ideas.json` 原样保留。
- macOS 包仍使用 **adhoc 签名**。

## Install / 安装

**macOS** — the app is unsigned / 应用未签名：
1. Open the `.dmg`, drag the app into Applications / 打开 `.dmg`，把应用拖入「应用程序」
2. First launch is blocked → **System Settings → Privacy & Security** → scroll down → **Open Anyway** / 首次打开被拦 → **系统设置 → 隐私与安全性** → 滚到底 → **仍要打开**

**Windows** — unsigned, SmartScreen will warn / 未签名，会弹 SmartScreen：
1. Download the `*-setup.exe` for your architecture and run it / 下载对应架构的 `*-setup.exe` 安装
2. On the SmartScreen prompt → **More info → Run anyway** / SmartScreen 提示 → **更多信息 → 仍要运行**
3. Pick **x64** for Intel/AMD, **arm64** for Snapdragon/Surface-ARM machines / Intel/AMD 选 **x64**，骁龙/ARM Surface 选 **arm64**
