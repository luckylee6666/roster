Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.2.23 / 本版更新

**English**
- Qwen and MiMo Code history now supports search, preview, project-scoped deletion, recent restore, and explicit session resume.
- Collaborate now supports one selectable brain and multiple selectable workers from installed CLIs, while remembering the last successful setup.
- Collaboration startup is transactional and precisely binds fresh terminals; failures restore prior files and layout.
- Shared `.vibe/orchestra` files are hardened against symlink and hard-link traversal.
- macOS builds remain **ad-hoc signed**.

**中文**
- Qwen 与 MiMo Code 历史支持搜索、预览、按项目隔离删除、续接最近会话及指定会话续接。
- 协作支持从已安装 CLI 中单选一个大脑、多选多个干活终端，并记住上次成功组合。
- 协作启动改为事务流程并精确绑定新终端；失败时恢复上一场文件与布局。
- `.vibe/orchestra` 共享文件增加符号链接和多硬链接防护。
- macOS 包仍使用 **adhoc 签名**。

## Install / 安装

**macOS** — the app is unsigned / 应用未签名：
1. Open the `.dmg`, drag the app into Applications / 打开 `.dmg`，把应用拖入「应用程序」
2. First launch is blocked → **System Settings → Privacy & Security** → scroll down → **Open Anyway** / 首次打开被拦 → **系统设置 → 隐私与安全性** → 滚到底 → **仍要打开**

**Windows** — unsigned, SmartScreen will warn / 未签名，会弹 SmartScreen：
1. Download the `*-setup.exe` for your architecture and run it / 下载对应架构的 `*-setup.exe` 安装
2. On the SmartScreen prompt → **More info → Run anyway** / SmartScreen 提示 → **更多信息 → 仍要运行**
3. Pick **x64** for Intel/AMD, **arm64** for Snapdragon/Surface-ARM machines / Intel/AMD 选 **x64**，骁龙/ARM Surface 选 **arm64**
