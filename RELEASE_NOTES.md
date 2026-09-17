Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.7.0 / 本版更新

**English**

- **Command Code (`cmd`) can now be started with full access, as an explicit opt-in.** In the conversation workspace the mode picker offers「完全访问」next to the default read-only mode; that turn runs `cmd --yolo` instead of `--permission-mode plan`, so it can edit files and run commands without asking. In Developer mode, **right-click the `cmd` badge on a project card** to pick a launch mode — the default entry or `--yolo`.
- The bypass is never automatic: the default entry in both places is the plain command, the mode is never the default, it is styled as dangerous, and a terminal started with a bypass keeps a red badge with an explanatory tooltip. Restoring the tab layout keeps the `--yolo` choice instead of silently dropping it.
- Background: Command Code's headless mode blocks file writes and shell commands unless its built-in `--yolo` bypass is passed, and that bypass is not part of the CLI's own Shift+Tab mode ring. Roster normally refuses to add bypass flags on its own; this mode exists because the user asked for it, and is registered with the same rules as Codex's「完全访问权限」and Grok's「始终批准」.

**中文**

- **Command Code（`cmd`）现在可以显式选择「完全访问」启动。** 对话工作台的档位选择器在默认的只读档旁边多出「完全访问」，选中后那一轮跑 `cmd --yolo` 而不是 `--permission-mode plan`，可以改文件、跑命令而不再逐条确认；开发模式下**右键项目卡片上的 `cmd` 色标**即可选择启动档（默认项或 `--yolo`）。
- 绕过权限永远不会自动发生：两处的默认项都是不带绕过参数的裸命令，这一档也绝不是默认档，界面按危险档配色；以绕过参数启动的终端标签保持红色徽标并带说明 title。恢复标签布局时 `--yolo` 会被保留，不会悄悄丢掉。
- 背景：Command Code 的无头模式自己会拦下文件写入与 shell 命令，除非传它内置的 `--yolo`，而这个旗标并不在它自己的 Shift+Tab 模式环里。Roster 平时不会自己补绕过参数，这一档是按用户要求加的，登记规格与 Codex 的「完全访问权限」、Grok 的「始终批准」一致。

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
