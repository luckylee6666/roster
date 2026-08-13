Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.2.18 / 本版更新

**English**
- **Terminal proxy switch** — turn it on and newly launched Claude / Codex / Grok sessions use `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`. Point it at your Clash or Surge port; TUN is not required.
- Login-shell rc files cannot wipe the app proxy; credentials stay out of the header tooltip.
- macOS builds remain **ad-hoc signed**.

**中文**
- **终端代理开关**：打开后新启动的 Claude / Codex / Grok 会走 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`。填 Clash、Surge 本地端口即可，不必开 TUN。
- 登录壳的 rc 冲不掉应用代理；顶栏不会露出账号密码。
- macOS 包仍使用 **adhoc 签名**。

## Install / 安装

**macOS** — the app is unsigned / 应用未签名：
1. Open the `.dmg`, drag the app into Applications / 打开 `.dmg`，把应用拖入「应用程序」
2. First launch is blocked → **System Settings → Privacy & Security** → scroll down → **Open Anyway** / 首次打开被拦 → **系统设置 → 隐私与安全性** → 滚到底 → **仍要打开**

**Windows** — unsigned, SmartScreen will warn / 未签名，会弹 SmartScreen：
1. Download the `*-setup.exe` for your architecture and run it / 下载对应架构的 `*-setup.exe` 安装
2. On the SmartScreen prompt → **More info → Run anyway** / SmartScreen 提示 → **更多信息 → 仍要运行**
3. Pick **x64** for Intel/AMD, **arm64** for Snapdragon/Surface-ARM machines / Intel/AMD 选 **x64**，骁龙/ARM Surface 选 **arm64**
