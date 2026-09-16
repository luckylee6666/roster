Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.6.0 / 本版更新

**English**

- **Command Code (`cmd`) joins as the eighth CLI** — the project card can launch it in Developer mode, its on-disk sessions (list / preview / delete) join the history rail and cross-CLI handoff, and the conversation workspace runs it as another assistant. The command name, menu label and tab badge all read `cmd` (`cmdc` on Windows, where `cmd` is the system shell); the earlier `command-code` spelling remains an alias.
- Command Code conversations are **read-only**: that CLI's own print mode blocks file writes and shell commands unless its `--yolo` bypass is passed, and Roster never adds bypass flags, so the mode picker offers only its `plan` mode — use Developer mode when you want it to edit files. Each turn is one `cmd --print=… --output-format json` process (the fourth protocol, NDJSON) and is resumed with `--session <id>`; `/model` and `/effort` are wired to its own catalog.
- The usage panel gains a **cmd tab**: it reads the key from that CLI's own `~/.commandcode/auth.json`, calls the official billing endpoints and shows the 5-hour / weekly windows, the plan and the period's credit balance. A custom `COMMANDCODE_API_URL` is skipped, the key is never stored or logged, and a failed refresh falls back to a clearly labelled cached snapshot.
- Restoring a Command Code terminal no longer appends `--continue` (that flag only resumes interactive conversations, so a headless session made the CLI exit into a dead shell): the newest on-disk session for the project is resumed by exact id, or a fresh session is started when there is none.
- Its session history re-verifies project ownership from each transcript's header `cwd` and only lists files whose name matches the header id, so a stray file can no longer make a delete reach outside the session.

**中文**

- **新增第八家 CLI Command Code（`cmd`）** — 项目卡片可在开发模式直接启动，磁盘会话（列表/预览/删除）并入历史侧栏与跨 CLI 交接，对话工作台也多了一家助手。命令名、菜单显示名与标签徽标统一是 `cmd`（Windows 上用 `cmdc`，`cmd` 是系统 shell）；旧的 `command-code` 写法保留为别名。
- 它的对话是**只读**的：该 CLI 自己的 print 模式会拦下文件写入与 shell 命令，除非传内置 `--yolo` 绕过，而 Roster 从不添加这类参数，所以档位选择器只有 `plan` 一档——需要它改文件请用开发模式。每轮跑一个 `cmd --print=… --output-format json` 进程（第四种协议 NDJSON），续接用 `--session <id>`；`/model` 与 `/effort` 接它自己的目录。
- 用量面板新增 **cmd 档**：读它自己 `~/.commandcode/auth.json` 里的 key，调官方接口显示 5 小时 / 每周窗口、计划档位与本期额度余额。自定义 `COMMANDCODE_API_URL` 直接跳过；key 不落盘、不打印，查询失败会回退到明确标记的缓存快照。
- 恢复 Command Code 终端不再补 `--continue`（该参数只认交互会话，无头会话会让 CLI 直接退出、标签变成死 shell）：改为按磁盘上最新会话的精确 ID 续接，没有会话才新开。
- 它的会话历史一律用文件首行 header 的 `cwd` 复核项目归属，且只列出文件名与 header id 一致的文件——不让一个名字异常的会话把删除操作带出会话目录。


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
