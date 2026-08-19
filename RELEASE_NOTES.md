Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.2.21 / 本版更新

**English**
- The file tree now has a compact session rail: running AI tabs for the current project first, then recent on-disk sessions. Click to focus or resume. Search, preview, and delete stay on the project card.
- The usage panel dropped OpenCode. Codex now reads official ChatGPT rate-limit windows (`codex app-server` `account/rateLimits/read`) with the same % + reset countdown as Claude.
- macOS builds remain **ad-hoc signed**.

**中文**
- 文件树下方增加细会话条：先列当前项目正在跑的 AI 标签，再列最近磁盘会话。点一下聚焦或续接。搜索、预览、删除仍在项目卡片。
- 用量面板去掉 OpenCode。Codex 改为走官方 ChatGPT 限流窗口（`codex app-server` 的 `account/rateLimits/read`），百分比和重置倒计时与 Claude 一致。
- macOS 包仍使用 **adhoc 签名**。

## Install / 安装

**macOS** — the app is unsigned / 应用未签名：
1. Open the `.dmg`, drag the app into Applications / 打开 `.dmg`，把应用拖入「应用程序」
2. First launch is blocked → **System Settings → Privacy & Security** → scroll down → **Open Anyway** / 首次打开被拦 → **系统设置 → 隐私与安全性** → 滚到底 → **仍要打开**

**Windows** — unsigned, SmartScreen will warn / 未签名，会弹 SmartScreen：
1. Download the `*-setup.exe` for your architecture and run it / 下载对应架构的 `*-setup.exe` 安装
2. On the SmartScreen prompt → **More info → Run anyway** / SmartScreen 提示 → **更多信息 → 仍要运行**
3. Pick **x64** for Intel/AMD, **arm64** for Snapdragon/Surface-ARM machines / Intel/AMD 选 **x64**，骁龙/ARM Surface 选 **arm64**
