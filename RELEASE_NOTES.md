Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.2.8 / 本版更新

**English**
- **Fix: runaway `ccusage` processes could freeze your machine.** Every cache-miss usage query used to spawn its own `ccusage`/`npx`/`node` process tree (each loads the full local logs into memory); rapid refresh clicks or tab switches piled them up until memory ran out. Usage queries now pass a global single-flight gate (at most one `ccusage` process at any moment), failures back off for 30 seconds instead of re-spawning on every click, and the panel ignores repeat clicks while a query is in flight.
- **Claude usage no longer touches `ccusage` at all** — the Claude tab is a single rate-limit API call; the dead ccusage code path was removed. Only Codex / OpenCode weekly stats still use `ccusage`, behind the new guards.

**中文**
- **修复：ccusage 进程堆积可把整台电脑卡死。** 此前缓存未命中的用量查询各自拉起一棵 `ccusage`/`npx`/`node` 进程树（每棵都把全量本地日志读进内存），连点刷新或快速切换标签会成排堆积、直到内存耗尽。现在用量查询过全局单飞锁（任一时刻至多一个 ccusage 进程），失败后退避 30 秒不再反复拉起进程，且面板在查询在途时忽略重复点击。
- **Claude 用量彻底不再碰 `ccusage`**——Claude 标签只走一次限流接口调用，残留的 ccusage 死代码已删除。仅 Codex / OpenCode 周用量仍用 `ccusage`，且已加上述防护。

## Install / 安装

**macOS** — the app is unsigned / 应用未签名：
1. Open the `.dmg`, drag the app into Applications / 打开 `.dmg`，把应用拖入「应用程序」
2. First launch is blocked → **System Settings → Privacy & Security** → scroll down → **Open Anyway** / 首次打开被拦 → **系统设置 → 隐私与安全性** → 滚到底 → **仍要打开**

**Windows** — unsigned, SmartScreen will warn / 未签名，会弹 SmartScreen：
1. Download the `*-setup.exe` for your architecture and run it / 下载对应架构的 `*-setup.exe` 安装
2. On the SmartScreen prompt → **More info → Run anyway** / SmartScreen 提示 → **更多信息 → 仍要运行**
3. Pick **x64** for Intel/AMD, **arm64** for Snapdragon/Surface-ARM machines / Intel/AMD 选 **x64**，骁龙/ARM Surface 选 **arm64**
