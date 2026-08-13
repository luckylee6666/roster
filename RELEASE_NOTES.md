Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.2.16 / 本版更新

**English**
- **Grok CLI launch** — start Grok from a project card; restored Grok tabs continue the most recent session in that directory with `--continue`.
- **Escape reaches the built-in terminal on macOS** — vim, less, and Claude Code can receive `\x1b`. Open dialogs and menus still consume Escape first.
- macOS builds remain **ad-hoc signed**.

**中文**
- **Grok CLI 启动**：可从项目卡片打开 Grok；恢复 Grok 标签时用 `--continue` 续接该目录最近一次会话。
- **macOS 内置终端可收到 ESC**：vim / less / Claude Code 能收到 `\x1b`。已打开的弹窗和菜单仍优先消费 ESC。
- macOS 包仍使用 **adhoc 签名**。

## Install / 安装

**macOS** — the app is unsigned / 应用未签名：
1. Open the `.dmg`, drag the app into Applications / 打开 `.dmg`，把应用拖入「应用程序」
2. First launch is blocked → **System Settings → Privacy & Security** → scroll down → **Open Anyway** / 首次打开被拦 → **系统设置 → 隐私与安全性** → 滚到底 → **仍要打开**

**Windows** — unsigned, SmartScreen will warn / 未签名，会弹 SmartScreen：
1. Download the `*-setup.exe` for your architecture and run it / 下载对应架构的 `*-setup.exe` 安装
2. On the SmartScreen prompt → **More info → Run anyway** / SmartScreen 提示 → **更多信息 → 仍要运行**
3. Pick **x64** for Intel/AMD, **arm64** for Snapdragon/Surface-ARM machines / Intel/AMD 选 **x64**，骁龙/ARM Surface 选 **arm64**
