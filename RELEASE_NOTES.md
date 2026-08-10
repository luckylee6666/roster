Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.2.14 / 本版更新

**English**
- **Reliable macOS quitting** — the red close button and `Cmd+Q` exit correctly while unsaved edits remain protected by confirmation.
- **Reliable file previews** — selected files always replace the terminal, including while the WebGL terminal renderer is actively repainting.
- **Safer data lifecycle** — migration retries after failures, daily snapshots and pre-overwrite backups are active, and failed writes no longer change in-memory data.
- **Reliable terminal startup** — early keystrokes are buffered in order; duplicate IDs and failed child-process setup are cleaned up safely.
- **Bounded local previews** — images, PDFs, and terminal-theme assets cannot bypass memory limits while files change.
- **Hardened remote input** — WebSocket and terminal-input sizes are bounded, and blocking PTY writes no longer occupy async workers.

**中文**
- **macOS 可靠退出**：左上角红色关闭按钮和 `Cmd+Q` 均可正常退出，未保存修改仍需确认后才能放弃。
- **文件预览稳定显示**：即使 WebGL 终端正在持续重绘，选中文件后也会可靠切换到预览，不再被终端画面遮住。
- **更安全的数据生命周期**：迁移失败会重试，每日快照与覆盖前备份正式生效，写入失败不再改变内存数据。
- **可靠的终端启动**：启动期间的键入会按顺序缓存；重复 ID 与子进程创建失败均会安全清理。
- **有界本地预览**：图片、PDF 和终端主题资源即使在读取期间发生变化，也无法绕过内存限制。
- **远程输入加固**：限制 WebSocket 与终端输入大小，阻塞 PTY 写入不再占用异步工作线程。

## Install / 安装

**macOS** — the app is unsigned / 应用未签名：
1. Open the `.dmg`, drag the app into Applications / 打开 `.dmg`，把应用拖入「应用程序」
2. First launch is blocked → **System Settings → Privacy & Security** → scroll down → **Open Anyway** / 首次打开被拦 → **系统设置 → 隐私与安全性** → 滚到底 → **仍要打开**

**Windows** — unsigned, SmartScreen will warn / 未签名，会弹 SmartScreen：
1. Download the `*-setup.exe` for your architecture and run it / 下载对应架构的 `*-setup.exe` 安装
2. On the SmartScreen prompt → **More info → Run anyway** / SmartScreen 提示 → **更多信息 → 仍要运行**
3. Pick **x64** for Intel/AMD, **arm64** for Snapdragon/Surface-ARM machines / Intel/AMD 选 **x64**，骁龙/ARM Surface 选 **arm64**
