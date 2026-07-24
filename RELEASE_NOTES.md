Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.2.11 / 本版更新

**English**
- **New Neon Rain terminal theme** — an editable Image 2 preset with cool cyan/purple colors, a right-aligned character, and a dark code-safe workspace.
- **Sakura Twilight redesign** — new mature artwork, deep-plum palette, improved text contrast, and a new icon; the wand cursor and petal/heart effects remain.
- **Accurate Claude context percentage** — detects configured and displayed `353k`, `1M`, and `/context` window sizes instead of assuming 200k.
- **Safer theme management** — legacy Sakura references migrate automatically, failed saves do not corrupt in-memory state, missing themes fall back safely, and deletion asks for confirmation.
- **Cleanup** — removed obsolete Sakura assets and unused starter files; image-theme UI styles are isolated so custom backgrounds no longer inherit Sakura styling.

**中文**
- **新增「霓虹雨夜」终端主题**：可编辑的 Image 2 预装主题，采用青紫冷色、人物右置和适合代码显示的深色留白。
- **「樱花暮色」重设计**：更新成熟风格插画、深梅紫配色、文字对比和主题图标，同时保留魔法棒光标及花瓣/爱心特效。
- **Claude 上下文占比更准确**：识别配置和界面显示的 `353k`、`1M`、`/context` 窗口长度，不再固定按 200k 估算。
- **主题管理更安全**：旧樱花引用自动迁移；保存失败不会污染内存状态；主题缺失时安全回退；删除前增加确认。
- **清理遗留内容**：移除旧樱花素材和无用模板文件；不同图片主题的界面样式彻底隔离，自定义背景不再继承樱花样式。

## Install / 安装

**macOS** — the app is unsigned / 应用未签名：
1. Open the `.dmg`, drag the app into Applications / 打开 `.dmg`，把应用拖入「应用程序」
2. First launch is blocked → **System Settings → Privacy & Security** → scroll down → **Open Anyway** / 首次打开被拦 → **系统设置 → 隐私与安全性** → 滚到底 → **仍要打开**

**Windows** — unsigned, SmartScreen will warn / 未签名，会弹 SmartScreen：
1. Download the `*-setup.exe` for your architecture and run it / 下载对应架构的 `*-setup.exe` 安装
2. On the SmartScreen prompt → **More info → Run anyway** / SmartScreen 提示 → **更多信息 → 仍要运行**
3. Pick **x64** for Intel/AMD, **arm64** for Snapdragon/Surface-ARM machines / Intel/AMD 选 **x64**，骁龙/ARM Surface 选 **arm64**
