Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.3.1 / 本版更新

**English**
- **A conversation belongs to one assistant.** Starting a new conversation asks which installed assistant to use; once it has begun the assistant is locked and shown as a badge in the header. Switching mid-thread was never really a switch — a session's ID, sandbox binding and history file belong to one CLI — so bringing in another one is now an explicit **Handoff** that opens a new conversation over there and leaves the original untouched.
- **The "allow writing" checkbox is gone.** Each assistant now offers its own permission modes (Claude: `plan` / `acceptEdits` / `auto`; Codex: 只读 / 帮我批准), validated against a per-provider allowlist on start. Modes that need a person to answer a prompt are excluded because the workspace runs headless, and modes that bypass the sandbox entirely are never offered.
- **Model, reasoning effort and mode are visible controls**, gathered into one button next to Send that reads out the current setup and opens a two-level menu. They used to be reachable only through `/model` and `/effort`, which is no use to the people this workspace is for.
- **Rate-limit usage moved to the header** beside the assistant it belongs to, stays a quiet grey until it matters, and turns amber past 70% and red past 90% with the reset time. When the quota is spent the composer says so **before** you press Send.
- **Fixed: Grok could not write at all.** Its `--sandbox` takes a profile name from `~/.grok/sandbox.toml`, not Codex's fixed enum, so the value Roster passed made Grok refuse to start; and headless `acceptEdits` emitted approval requests nobody could answer. Write turns now use `auto` with the built-in `workspace` profile, verified end to end.
- **Fixed: Claude history could not be resumed in projects whose path contains non-ASCII characters** — Roster's own project-memory directory was shadowing the one that actually holds the sessions.
- **Fixed: state that belonged to one assistant could show up under another** — the mode list and the quota now carry the assistant they came from and are dropped the moment it no longer matches.
- macOS builds remain **ad-hoc signed**.

**中文**
- **一条对话固定属于一个助手。** 开新对话时先问用哪个已安装的助手；一旦开始，助手就锁定并显示在顶栏。中途"换助手"从来不是换——会话 ID、沙箱绑定和历史文件都属于某一家 CLI，所以请别人接手改成明确的**交接**：在那边新开一条，原会话保持不动。
- **去掉「允许修改项目」复选框。** 每个助手改用自己的权限模式（Claude：`plan` / `acceptEdits` / `auto`；Codex：只读 / 帮我批准），启动时按各自白名单复核。需要人应答的档不收（工作台是无头的），完全绕过沙箱的档一律不提供。
- **模型、推理强度、模式变成看得见的控件**，收进发送按钮旁的同一个入口：收起显示当前配置，点开分两层选。以前只有 `/model`、`/effort` 能进，而这个工作台的用户根本不会去打命令。
- **限流用量移到顶栏**、紧跟它所属的助手，平时是安静的灰字，超过 70% 转暖色、超过 90% 转红并带出重置时间；额度打满时**在按下发送之前**就说清楚。
- **修复：Grok 其实一直写不了。** 它的 `--sandbox` 收的是 `~/.grok/sandbox.toml` 里的 profile 名而不是固定枚举，Roster 传的值会让它拒绝启动；而且无头下 `acceptEdits` 会发出没人能应答的审批请求。写入轮改用 `auto` 配内建 `workspace` profile，已端到端验证。
- **修复：项目路径含中文时 Claude 历史无法续接**——Roster 自己的项目记忆目录遮蔽了真正存放会话的那个目录。
- **修复：属于某一家助手的状态可能显示在另一家名下**——模式表和额度现在都带上它们的归属，一旦对不上立刻作废。
- macOS 包仍使用 **adhoc 签名**。

## Install / 安装

**macOS** — the app is unsigned / 应用未签名：
1. Open the `.dmg`, drag the app into Applications / 打开 `.dmg`，把应用拖入「应用程序」
2. First launch is blocked → **System Settings → Privacy & Security** → scroll down → **Open Anyway** / 首次打开被拦 → **系统设置 → 隐私与安全性** → 滚到底 → **仍要打开**

**Windows** — unsigned, SmartScreen will warn / 未签名，会弹 SmartScreen：
1. Download the `*-setup.exe` for your architecture and run it / 下载对应架构的 `*-setup.exe` 安装
2. On the SmartScreen prompt → **More info → Run anyway** / SmartScreen 提示 → **更多信息 → 仍要运行**
3. Pick **x64** for Intel/AMD, **arm64** for Snapdragon/Surface-ARM machines / Intel/AMD 选 **x64**，骁龙/ARM Surface 选 **arm64**
