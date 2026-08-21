Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.2.24 / 本版更新

**English**
- Added per-project ideas in the terminal: capture, refine, archive, and place a draft into the active project conversation without pressing Enter.
- Added handoff between any two installed registered AI CLIs, using the source tool's latest project conversation plus the current Git workspace context.
- Project cards, Collaborate, and handoff target selection now use live local CLI detection; stale background probes no longer disable the handoff action.
- Hardened idea and handoff persistence with bounded UTF-8 input, project/session validation, safe atomic writes, and symlink/special-file protections.
- macOS builds remain **ad-hoc signed**.

**中文**
- 终端新增按项目隔离的「想法」：可记录、持续完善、归档，并在不自动回车的情况下放入当前项目对话。
- 支持任意两家已安装且已登记的 AI CLI 双向交接，交接稿包含来源工具的最新项目会话与当前 Git 工作区现场。
- 项目卡片、开协作和交接目标统一使用本机 CLI 实时探测；过期的后台探测不再错误禁用交接按钮。
- 想法与交接持久化增加 UTF-8 容量边界、项目/会话校验、安全原子写入及符号链接/特殊文件防护。
- macOS 包仍使用 **adhoc 签名**。

## Install / 安装

**macOS** — the app is unsigned / 应用未签名：
1. Open the `.dmg`, drag the app into Applications / 打开 `.dmg`，把应用拖入「应用程序」
2. First launch is blocked → **System Settings → Privacy & Security** → scroll down → **Open Anyway** / 首次打开被拦 → **系统设置 → 隐私与安全性** → 滚到底 → **仍要打开**

**Windows** — unsigned, SmartScreen will warn / 未签名，会弹 SmartScreen：
1. Download the `*-setup.exe` for your architecture and run it / 下载对应架构的 `*-setup.exe` 安装
2. On the SmartScreen prompt → **More info → Run anyway** / SmartScreen 提示 → **更多信息 → 仍要运行**
3. Pick **x64** for Intel/AMD, **arm64** for Snapdragon/Surface-ARM machines / Intel/AMD 选 **x64**，骁龙/ARM Surface 选 **arm64**
