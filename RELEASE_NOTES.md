Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.2.15 / 本版更新

**English**
- **Flexible terminal layouts** — arrange sessions as one pane, side-by-side, stacked, or a four-pane grid; resize panes and move sessions without stopping background work.
- **Pane-aware drag and drop** — files and folders are inserted into the terminal pane under the pointer.
- **File line numbers** — previews and the built-in editor now keep line numbers synchronized across common line-ending formats.
- **Quick `.sh` commands** — insert a safely quoted shell-script command from the file-tree context menu after Bash availability is checked.
- **More reliable session cleanup** — concurrent close actions are deduplicated so tabs, panes, and backend sessions stay in sync.

**中文**
- **灵活终端布局**：支持单窗、左右、上下和四宫格；可调整窗格大小、移动会话，后台任务持续运行。
- **分屏感知拖放**：文件与文件夹会填入指针所在的终端窗格。
- **文件行号**：文件预览和内置编辑器新增同步行号，兼容常见换行格式。
- **`.sh` 快捷命令**：从文件树右键菜单安全填入 Shell 脚本运行命令，并预先检查 Bash 可用性。
- **更可靠的会话清理**：并发关闭操作会自动去重，保证标签、窗格与后端会话状态一致。

## Install / 安装

**macOS** — the app is unsigned / 应用未签名：
1. Open the `.dmg`, drag the app into Applications / 打开 `.dmg`，把应用拖入「应用程序」
2. First launch is blocked → **System Settings → Privacy & Security** → scroll down → **Open Anyway** / 首次打开被拦 → **系统设置 → 隐私与安全性** → 滚到底 → **仍要打开**

**Windows** — unsigned, SmartScreen will warn / 未签名，会弹 SmartScreen：
1. Download the `*-setup.exe` for your architecture and run it / 下载对应架构的 `*-setup.exe` 安装
2. On the SmartScreen prompt → **More info → Run anyway** / SmartScreen 提示 → **更多信息 → 仍要运行**
3. Pick **x64** for Intel/AMD, **arm64** for Snapdragon/Surface-ARM machines / Intel/AMD 选 **x64**，骁龙/ARM Surface 选 **arm64**
