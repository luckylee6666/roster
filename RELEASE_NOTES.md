Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.2.22 / 本版更新

**English**
- One-click CLI launch on project cards: installed AI CLIs (Claude / Grok / Codex / OpenCode / Gemini / agy) show as colored chips; clicking focuses the running session for that project or resumes the latest on-disk one.
- Slimmer cards: branch badge next to the name, full adaptive paths, single footer row of CLI chips; tabs opened from cards are named after the project.
- The session rail opens at maximum height by default and remembers dragged heights reliably.
- Removed the floating search-style launch menu; card chips are the single launch entry.
- macOS builds remain **ad-hoc signed**.

**中文**
- 项目卡片底部一键打开 CLI：本机已装的 AI CLI（Claude / Grok / Codex / OpenCode / Gemini / agy）以色标显示，点击先聚焦运行中会话，没有则续接最近一次。
- 卡片收整：分支徽标并入标题行，路径全量自适应宽度，色标底行一行收尾；卡片打开的标签改用项目名。
- 会话条默认最大高度，拖过的高度可靠记住。
- 移除无入口的搜索式启动菜单，卡片色标为唯一入口。
- macOS 包仍使用 **adhoc 签名**。

## Install / 安装

**macOS** — the app is unsigned / 应用未签名：
1. Open the `.dmg`, drag the app into Applications / 打开 `.dmg`，把应用拖入「应用程序」
2. First launch is blocked → **System Settings → Privacy & Security** → scroll down → **Open Anyway** / 首次打开被拦 → **系统设置 → 隐私与安全性** → 滚到底 → **仍要打开**

**Windows** — unsigned, SmartScreen will warn / 未签名，会弹 SmartScreen：
1. Download the `*-setup.exe` for your architecture and run it / 下载对应架构的 `*-setup.exe` 安装
2. On the SmartScreen prompt → **More info → Run anyway** / SmartScreen 提示 → **更多信息 → 仍要运行**
3. Pick **x64** for Intel/AMD, **arm64** for Snapdragon/Surface-ARM machines / Intel/AMD 选 **x64**，骁龙/ARM Surface 选 **arm64**
