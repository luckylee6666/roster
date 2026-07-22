Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.2.10 / 本版更新

**English**
- **Third-party Claude API providers are no longer probed for usage support.** When `ANTHROPIC_BASE_URL` points away from Anthropic's official API, the app skips the usage request before reading credentials or starting `curl` and explains that the provider has not declared usage support. No OAuth token is sent to an unknown provider for capability detection.

**中文**
- **不再探测第三方 Claude API 是否支持用量接口。** 当 `ANTHROPIC_BASE_URL` 指向 Anthropic 官方地址之外时，应用会在读取凭据和启动 `curl` 之前直接跳过用量请求，并提示该服务未声明支持用量查询。不会为了探测能力而把 OAuth token 发给未知第三方。

## Install / 安装

**macOS** — the app is unsigned / 应用未签名：
1. Open the `.dmg`, drag the app into Applications / 打开 `.dmg`，把应用拖入「应用程序」
2. First launch is blocked → **System Settings → Privacy & Security** → scroll down → **Open Anyway** / 首次打开被拦 → **系统设置 → 隐私与安全性** → 滚到底 → **仍要打开**

**Windows** — unsigned, SmartScreen will warn / 未签名，会弹 SmartScreen：
1. Download the `*-setup.exe` for your architecture and run it / 下载对应架构的 `*-setup.exe` 安装
2. On the SmartScreen prompt → **More info → Run anyway** / SmartScreen 提示 → **更多信息 → 仍要运行**
3. Pick **x64** for Intel/AMD, **arm64** for Snapdragon/Surface-ARM machines / Intel/AMD 选 **x64**，骁龙/ARM Surface 选 **arm64**
