Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.4.0 / 本版更新

**English**
- **Grok subscription usage joins Claude and Codex.** On macOS/Linux, Roster reads only the bounded structured billing snapshot written by the official Grok CLI. It shows the weekly/monthly percentage, reset time, plan, data age, and an explicit stale warning without reading credentials or calling a private billing endpoint.
- **Usage sources now match the machine.** The panel rechecks installed CLIs when opened or refreshed and intersects them with backend capabilities. Missing CLIs stay hidden; Windows also hides Grok usage until an equivalent reparse-point-safe reader is available, while Grok conversation support remains available.
- **Claude context percentages now follow the real model window.** Explicit limits remain authoritative, current 1M models—including canonical Opus 4.8 ids without a suffix—are recognized, and observed token counts can correct a stale model guess.
- **Fixed: successful cross-CLI handoff could recursively re-enter its close-state synchronization** and fail with `Maximum call stack size exceeded`.
- macOS builds remain **ad-hoc signed**.

**中文**
- **Claude、Codex 之外新增 Grok 订阅用量。** macOS/Linux 上，Roster 只会有界读取 Grok 官方 CLI 写下的结构化 billing 快照，显示周/月百分比、重置时间、订阅档位、数据年龄和明确的旧数据提示；不会读取凭据，也不会直接调用私有账单接口。
- **用量来源与白名单现在同时核对本机安装与平台能力。** 打开面板或刷新时重新探测，没安装的 CLI 不显示；Windows 在具备等价的 reparse-point 安全读取前隐藏 Grok 用量，但 Grok 对话功能不受影响。
- **Claude 上下文占比现在跟随真实模型窗口。** 显式上限仍然优先，当前 1M 模型会正确识别，其中包括不带后缀的 Opus 4.8 canonical model id；实际 token 数也能纠正落后的模型猜测。
- **修复：成功完成跨 CLI 交接后，关闭状态会递归进入自身同步**，最终报 `Maximum call stack size exceeded`。
- macOS 包仍使用 **adhoc 签名**。

## Install / 安装

**macOS** — the app is unsigned / 应用未签名：
1. Open the `.dmg`, drag the app into Applications / 打开 `.dmg`，把应用拖入「应用程序」
2. First launch is blocked → **System Settings → Privacy & Security** → scroll down → **Open Anyway** / 首次打开被拦 → **系统设置 → 隐私与安全性** → 滚到底 → **仍要打开**

**Windows** — unsigned, SmartScreen will warn / 未签名，会弹 SmartScreen：
1. Download the `*-setup.exe` for your architecture and run it / 下载对应架构的 `*-setup.exe` 安装
2. On the SmartScreen prompt → **More info → Run anyway** / SmartScreen 提示 → **更多信息 → 仍要运行**
3. Pick **x64** for Intel/AMD, **arm64** for Snapdragon/Surface-ARM machines / Intel/AMD 选 **x64**，骁龙/ARM Surface 选 **arm64**
