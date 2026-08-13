Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.2.17 / 本版更新

**English**
- **Project history** — expand a project card to search, preview, resume, or delete each CLI's on-disk sessions. A **running** badge only appears for an explicit continue/resume.
- **Open a set / Collaborate** — one click opens Claude + Codex + Grok in a main three-pane layout. Collaborate assigns one brain and two workers that share `.vibe/orchestra/` (not a merged chat).
- **Unify memory to Claude** (opt-in) — a project `.memory` symlink points at Claude's project memory. Off by default; no auto-created `CLAUDE.md` / `AGENTS.md`.
- Terminal **main** layout plus empty-slot collapse.
- macOS builds remain **ad-hoc signed**.

**中文**
- **项目历史**：展开项目卡片即可搜索、预览、续接或删除各家 CLI 的磁盘会话。**运行中**只标明确的续接 / `--continue`。
- **开一套 / 开协作**：一键打开 Claude + Codex + Grok 主从三窗。协作是一个大脑拆活、另外两个动手，共用 `.vibe/orchestra/`，不是合成聊天室。
- **统一记忆到 Claude**（可选）：项目 `.memory` 链到 Claude 项目记忆。默认关闭，不会自动创建 `CLAUDE.md` / `AGENTS.md`。
- 终端新增主从布局，可见会话不足时收拢空位。
- macOS 包仍使用 **adhoc 签名**。

## Install / 安装

**macOS** — the app is unsigned / 应用未签名：
1. Open the `.dmg`, drag the app into Applications / 打开 `.dmg`，把应用拖入「应用程序」
2. First launch is blocked → **System Settings → Privacy & Security** → scroll down → **Open Anyway** / 首次打开被拦 → **系统设置 → 隐私与安全性** → 滚到底 → **仍要打开**

**Windows** — unsigned, SmartScreen will warn / 未签名，会弹 SmartScreen：
1. Download the `*-setup.exe` for your architecture and run it / 下载对应架构的 `*-setup.exe` 安装
2. On the SmartScreen prompt → **More info → Run anyway** / SmartScreen 提示 → **更多信息 → 仍要运行**
3. Pick **x64** for Intel/AMD, **arm64** for Snapdragon/Surface-ARM machines / Intel/AMD 选 **x64**，骁龙/ARM Surface 选 **arm64**
