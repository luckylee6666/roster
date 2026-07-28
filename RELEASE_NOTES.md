Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.2.12 / 本版更新

**English**
- **Edit code and configuration files in place** — open a file from the terminal tree, click the pencil, edit with Tab/Shift+Tab indentation, and save with `⌘/Ctrl + S`.
- **Format-safe saving** — preserves UTF-8 BOM, line endings, permissions, ACLs, extended attributes, and supported platform metadata.
- **Unsaved-change protection** — newer typing during an active save remains in the editor; file/session switches, window close, system quit, and tray quit require confirmation.
- **Safer file boundaries** — binary, invalid UTF-8, read-only, mixed-line-ending, and files over 1 MB remain preview-only; reads are bounded and fully checked for NUL bytes.
- **Atomic writes and conflict checks** — same-directory replacement prevents half-written files, while best-effort external-change detection stops detected overwrites.

**中文**
- **直接编辑代码和配置文件**：从终端文件树打开文件，点击铅笔进入编辑；支持 Tab/Shift+Tab 缩进及 `⌘/Ctrl + S` 保存。
- **安全保留原格式**：保存时保留 UTF-8 BOM、换行符、权限、ACL、扩展属性和平台支持的元数据。
- **未保存修改保护**：保存期间继续输入仍保留在编辑器；切换文件/会话、关闭窗口、系统退出和托盘退出均需确认。
- **更安全的文件边界**：二进制、无效 UTF-8、只读、混合换行及超过 1MB 的文件保持只读预览；读取有界并完整检测 NUL。
- **原子写入与冲突检查**：同目录替换避免半截文件，尽力检测到的外部修改会停止保存。

## Install / 安装

**macOS** — the app is unsigned / 应用未签名：
1. Open the `.dmg`, drag the app into Applications / 打开 `.dmg`，把应用拖入「应用程序」
2. First launch is blocked → **System Settings → Privacy & Security** → scroll down → **Open Anyway** / 首次打开被拦 → **系统设置 → 隐私与安全性** → 滚到底 → **仍要打开**

**Windows** — unsigned, SmartScreen will warn / 未签名，会弹 SmartScreen：
1. Download the `*-setup.exe` for your architecture and run it / 下载对应架构的 `*-setup.exe` 安装
2. On the SmartScreen prompt → **More info → Run anyway** / SmartScreen 提示 → **更多信息 → 仍要运行**
3. Pick **x64** for Intel/AMD, **arm64** for Snapdragon/Surface-ARM machines / Intel/AMD 选 **x64**，骁龙/ARM Surface 选 **arm64**
