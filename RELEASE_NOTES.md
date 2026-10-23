Cross-platform desktop app: macOS (Apple Silicon / Intel) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon / Intel) + Windows (x64 / ARM64)

## What's new in v1.9.5 / 本版更新

**English**

- **Intel Mac installer.** Adds `Roster_1.9.5_x64.dmg` for Intel processors alongside `Roster_1.9.5_aarch64.dmg` for Apple Silicon. The Intel release job verifies the app architecture, ad-hoc signature and DMG integrity before upload. Older releases and tags are unchanged.
- **Pi CLI integration.** Pi is the ninth registered assistant, with Developer-mode launch, project-scoped history preview/deletion, exact-ID resume and cross-CLI handoff. Conversation mode reuses Pi RPC sessions and offers `/model` and `/effort`.
- **Pi's read-only tool configuration.** Only `read`, `grep`, `find` and `ls` are enabled; extensions, MCP, skills and prompt templates are disabled. This is not an OS sandbox or a native Pi approval mode. No writable configuration or subscription-quota panel is added. Pi still requires its own installation and login; Windows native initial-prompt launch requires an `.exe` and rejects npm `.cmd` wrappers.
- **Repository cleanup.** Removes retired design documents and offline asset builders; the prebuilt production theme images and runtime checks remain intact.
- **Validation scope.** Local cross-compilation validates the Intel binary/package, not real Intel hardware interaction. Pi was tested with the installed CLI against a local synthetic provider, not a real cloud-model task. Windows interactive validation, native file drag-and-drop and video playback/fullscreen checks remain manual follow-ups.

**中文**

- **Intel Mac 安装包。** 新增适配 Intel 芯片的 `Roster_1.9.5_x64.dmg`，同时保留 Apple Silicon 的 `Roster_1.9.5_aarch64.dmg`；Intel 构建上传前检查架构、adhoc 签名和 DMG 完整性，不改旧版本及标签。
- **接入 Pi CLI。** Pi 成为第九家助手，支持开发模式启动、按项目隔离的历史预览/删除、完整 ID 精确续接和跨 CLI 交接。会话模式复用 Pi RPC 常驻进程，支持 `/model` 与 `/effort`。
- **Pi 仅读取工具配置。** 仅开放 `read`、`grep`、`find`、`ls`，关闭扩展、MCP、skills 和提示模板。这不是 OS 沙箱，也不是 Pi 原生审批档位；本版不开放可写配置或订阅用量面板。需用户自行安装和登录 Pi；Windows 原生初始提示启动只接受 `.exe`，拒绝 npm `.cmd` 包装器。
- **仓库清理。** 移除退役设计文档和离线素材构建器，保留已生成的生产主题图片与运行时回归检查。
- **验收边界。** 本地交叉编译验证 Intel 二进制和安装包，不代表已验收 Intel 实机交互。Pi 使用已安装 CLI 和本地合成服务验证，未进行真实云端模型任务验收。Windows 实机交互、原生拖放、视频播放/全屏仍待人工复核。

## Phone remote / 手机远程

1. In Roster, click「手机远程」(bottom of the conversation sidebar, or the Developer-mode header) and choose「保持连接，收起面板」/ 在 Roster 里点「手机远程」，选「保持连接，收起面板」
2. Scan the QR code with the phone — same Wi-Fi uses the LAN code, away from home use the Tailscale code / 用手机扫码：同一 WiFi 扫「局域网」码，出门扫「Tailscale」码
3. If macOS asks whether Roster may accept incoming connections, choose Allow / macOS 问是否允许 Roster 接受传入连接时点「允许」

Security: LAN + PIN over plain HTTP, private-network and Tailscale peers only — use a trusted network or Tailscale. / 安全：局域网 + PIN、明文 HTTP，只接受私网与 Tailscale 来源，请在可信网络或 Tailscale 下使用。

## Android app / 安卓 App

`Roster-Remote_1.9.5_android.apk` is our own small Android shell for the phone remote (source in `mobile-android/`, package `com.lucky.roster.remote`). The UI comes from your computer, so updating the desktop app is what brings phone fixes; reinstalling the APK is optional. / `Roster-Remote_1.9.5_android.apk` 是我们自己的安卓外壳 App（源码在 `mobile-android/`，包名 `com.lucky.roster.remote`）。界面由电脑提供，手机端的修复靠更新电脑上的 Roster 生效，APK 不重装也行。

1. Download the APK on the phone and allow installing from this source when asked / 手机下载 APK，按提示允许安装未知来源应用
2. It is signed with a debug key for sideloading, so the system may warn that the app is unrecognised — choose to install anyway / 用调试证书签名、供侧载安装，系统可能提示来源未知，选「仍然安装」
3. On HarmonyOS NEXT, install it through 卓易通; use the LAN address at home, and a native HarmonyOS Tailscale client (e.g. MeshArc) when away / 鸿蒙 NEXT 通过卓易通安装；在家用局域网地址，出门用鸿蒙原生 Tailscale 客户端（如 MeshArc）

## Upgrade / 升级

Quit the installed Roster before replacing it, then reopen to load the update. Roster Dev uses a separate data directory and can run alongside production. This release requires no data migration.
替换安装包前先退出当前正式版 Roster，安装后重新打开以加载更新。Roster Dev 使用独立数据目录，可与正式版并行。本版无需数据迁移。

## Install / 安装

**macOS** — ad-hoc signed, not notarized / adhoc 签名，未公证：

1. Choose `aarch64.dmg` for Apple M-series or `x64.dmg` for Intel, then drag the app into Applications / 苹果 M 系列选 `aarch64.dmg`，Intel 选 `x64.dmg`，打开后把应用拖入「应用程序」
2. If first launch is blocked: **System Settings → Privacy & Security → Open Anyway** / 首次打开被拦：**系统设置 → 隐私与安全性 → 仍要打开**

**Windows** — unsigned, SmartScreen may warn / 未签名，可能出现 SmartScreen 提示：

1. Download the `*-setup.exe` for your architecture and run it / 下载对应架构的 `*-setup.exe` 安装
2. On the SmartScreen prompt: **More info → Run anyway** / SmartScreen 提示：**更多信息 → 仍要运行**
3. Pick **x64** for Intel/AMD, **arm64** for Snapdragon/Surface-ARM / Intel/AMD 选 **x64**，骁龙/ARM Surface 选 **arm64**
