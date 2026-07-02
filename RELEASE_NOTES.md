Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.2.7 / 本版更新

**English**
- **Terminal DIY theme customizer**: build your own kawaii terminal themes — swap the background art, adjust the dim overlay/tint, toggle click effects (hearts/petals), save several. The theme menu now shows an illustrated icon per theme.
- **Sakura is now editable & deletable**: the signature kawaii theme ships as a pre-installed custom theme instead of a hard-coded built-in (built-ins are just color palettes now).
- **Git branch badge on terminal tabs** + **scheduled snippet send** (a snippet can auto-send on a fixed interval).
- **Security hardening**: the mobile-remote LAN terminal now locks out PIN brute-forcing and **truly stops** when you close the panel (clears the PIN, disconnects phones, stops listening) — previously it only hid the UI while the listener and PIN stayed live. Also fixed a toast HTML-injection path and made group rename cancelable by clicking away.

**中文**
- **终端 DIY 主题定制器**：自己捏卡哇伊终端主题——换背景立绘、调遮罩浓度/色调、开关点击特效（爱心/花瓣），可存多套。主题菜单每项改用插画图标。
- **樱花主题变得可编辑、可删除**：招牌卡哇伊主题从硬编码内置改为预装的自定义主题（内置只保留纯配色方案）。
- **终端标签 Git 分支徽标** + **片段定时发送**（片段可按固定间隔自动发送）。
- **安全加固**：手机远程的局域网终端现在会锁定 PIN 暴力枚举，并在你关闭面板时**真正停止服务**（清空 PIN、断开手机、停止监听）——此前只是隐藏界面、监听和 PIN 一直活着。另修复一处提示消息 HTML 注入、分组重命名可点击别处取消。

## Install / 安装

**macOS** — the app is unsigned / 应用未签名：
1. Open the `.dmg`, drag the app into Applications / 打开 `.dmg`，把应用拖入「应用程序」
2. First launch is blocked → **System Settings → Privacy & Security** → scroll down → **Open Anyway** / 首次打开被拦 → **系统设置 → 隐私与安全性** → 滚到底 → **仍要打开**

**Windows** — unsigned, SmartScreen will warn / 未签名，会弹 SmartScreen：
1. Download the `*-setup.exe` for your architecture and run it / 下载对应架构的 `*-setup.exe` 安装
2. On the SmartScreen prompt → **More info → Run anyway** / SmartScreen 提示 → **更多信息 → 仍要运行**
3. Pick **x64** for Intel/AMD, **arm64** for Snapdragon/Surface-ARM machines / Intel/AMD 选 **x64**，骁龙/ARM Surface 选 **arm64**
