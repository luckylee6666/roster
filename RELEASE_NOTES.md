Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.2.9 / 本版更新

**English**
- **Claude usage now follows your Claude Code API configuration.** The usage panel reads `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` from the environment or `~/.claude/settings.json`, including base URLs ending in `/v1`. Without custom configuration, it continues to use Anthropic's official usage endpoint and Claude Code OAuth login.
- **Safer custom-provider authentication.** Claude Code OAuth login tokens are never forwarded to custom API hosts; a custom host must have its own `ANTHROPIC_AUTH_TOKEN`. Usage caches are isolated per API endpoint.
- **Readable terminal tabs at any count.** Tabs size to their content instead of compressing project names under tool, branch, and context badges. Overflow becomes a horizontally scrollable tab strip, mouse-wheel scrolling is supported, and the active tab automatically scrolls into view.

**中文**
- **Claude 用量现会跟随 Claude Code 的 API 配置。** 用量面板会从进程环境或 `~/.claude/settings.json` 读取 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_AUTH_TOKEN`，兼容末尾带 `/v1` 的基址。没有自定义配置时，仍使用 Anthropic 官方用量接口和 Claude Code OAuth 登录。
- **自定义服务认证更安全。** Claude Code OAuth 登录 token 不会被转发给自定义 API 地址；自定义地址必须有配套的 `ANTHROPIC_AUTH_TOKEN`，且用量缓存按 API 地址隔离。
- **终端标签再多也能看清。** 标签按内容自适应宽度，不再让工具、分支和上下文徽标把项目名挤没；超出一屏后改为横向滚动，支持鼠标滚轮，并会自动把激活标签滚入可视区。

## Install / 安装

**macOS** — the app is unsigned / 应用未签名：
1. Open the `.dmg`, drag the app into Applications / 打开 `.dmg`，把应用拖入「应用程序」
2. First launch is blocked → **System Settings → Privacy & Security** → scroll down → **Open Anyway** / 首次打开被拦 → **系统设置 → 隐私与安全性** → 滚到底 → **仍要打开**

**Windows** — unsigned, SmartScreen will warn / 未签名，会弹 SmartScreen：
1. Download the `*-setup.exe` for your architecture and run it / 下载对应架构的 `*-setup.exe` 安装
2. On the SmartScreen prompt → **More info → Run anyway** / SmartScreen 提示 → **更多信息 → 仍要运行**
3. Pick **x64** for Intel/AMD, **arm64** for Snapdragon/Surface-ARM machines / Intel/AMD 选 **x64**，骁龙/ARM Surface 选 **arm64**
