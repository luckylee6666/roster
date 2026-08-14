Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.2.20 / 本版更新

**English**
- The app icon is a name-tag **R**, replacing the old `<>` mark.
- Chrome type is larger by default. Open the terminal toolbar **Aa** menu to switch **Standard / Large** or change the terminal size (`⌘+/-` still works).
- Removed the redundant project-list header title and breadcrumb. Search sits on the left; action buttons stay on the right.
- macOS builds remain **ad-hoc signed**.

**中文**
- 应用图标改为名牌 **R**，替换原来的 `<>`。
- 工作台默认字号加大。终端顶栏 **Aa** 可切换「标准 / 偏大」并调整终端字号（`⌘+/-` 仍可用）。
- 去掉顶栏重复的「项目管理」标题和面包屑。搜索靠左，操作按钮仍在右侧。
- macOS 包仍使用 **adhoc 签名**。

## Install / 安装

**macOS** — the app is unsigned / 应用未签名：
1. Open the `.dmg`, drag the app into Applications / 打开 `.dmg`，把应用拖入「应用程序」
2. First launch is blocked → **System Settings → Privacy & Security** → scroll down → **Open Anyway** / 首次打开被拦 → **系统设置 → 隐私与安全性** → 滚到底 → **仍要打开**

**Windows** — unsigned, SmartScreen will warn / 未签名，会弹 SmartScreen：
1. Download the `*-setup.exe` for your architecture and run it / 下载对应架构的 `*-setup.exe` 安装
2. On the SmartScreen prompt → **More info → Run anyway** / SmartScreen 提示 → **更多信息 → 仍要运行**
3. Pick **x64** for Intel/AMD, **arm64** for Snapdragon/Surface-ARM machines / Intel/AMD 选 **x64**，骁龙/ARM Surface 选 **arm64**
