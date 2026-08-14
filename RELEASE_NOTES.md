Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.2.19 / 本版更新

**English**
- The app is now **Roster**. First launch copies existing data from `~/.vibe-coding-manage/` into `~/.roster/`.
- Bundle id is `com.lucky.roster`. macOS will treat this as a new app, so screen-recording / keychain prompts may appear again.
- macOS builds remain **ad-hoc signed**.

**中文**
- 产品更名为 **Roster**。首次启动会把 `~/.vibe-coding-manage/` 拷到 `~/.roster/`。
- bundle id 改为 `com.lucky.roster`。macOS 会当成新 App，录屏 / 钥匙串可能要重新授权。
- macOS 包仍使用 **adhoc 签名**。

## Install / 安装

**macOS** — the app is unsigned / 应用未签名：
1. Open the `.dmg`, drag the app into Applications / 打开 `.dmg`，把应用拖入「应用程序」
2. First launch is blocked → **System Settings → Privacy & Security** → scroll down → **Open Anyway** / 首次打开被拦 → **系统设置 → 隐私与安全性** → 滚到底 → **仍要打开**

**Windows** — unsigned, SmartScreen will warn / 未签名，会弹 SmartScreen：
1. Download the `*-setup.exe` for your architecture and run it / 下载对应架构的 `*-setup.exe` 安装
2. On the SmartScreen prompt → **More info → Run anyway** / SmartScreen 提示 → **更多信息 → 仍要运行**
3. Pick **x64** for Intel/AMD, **arm64** for Snapdragon/Surface-ARM machines / Intel/AMD 选 **x64**，骁龙/ARM Surface 选 **arm64**
