Cross-platform desktop app: macOS (Apple Silicon / Intel) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon / Intel) + Windows (x64 / ARM64)

## Unreleased / 未发布

- Developer-terminal text remains selectable by ordinary dragging when a CLI enables mouse interaction. Hold Option/Alt for CLI clicks and drags; wheel scrolling still works normally. This fix is not included in the published v1.9.9 installers.
- 开发终端在 CLI 开启鼠标交互后仍可直接拖动选中文字；按住 Option/Alt 点击或拖动可操作 CLI，滚轮正常使用。此修复尚未包含在已发布的 v1.9.9 安装包中。

## What's new in v1.9.9 / 本版更新

**English**

- **Kilo CLI support.** Kilo joins Developer mode, the conversation workspace and the phone assistant picker. Launch or resume a terminal, browse/delete project-scoped history, continue a conversation or hand it to another CLI. Conversations default to Kilo's native `plan` agent and also offer `code`, with separate model and reasoning-effort settings. Custom configuration changes refresh the resident process. Install and sign in through Kilo first; local Kilo skills/custom slash commands are not discovered yet.
- **All projects remain reachable.** Expanded sidebar groups no longer have a fixed 500px height limit. The sidebar scrolls through the full project list, and long names shrink with an ellipsis.
- **Input-method confirmation.** Confirming a candidate with Enter no longer sends the conversation or selects a completion entry. The fix covers desktop composition events, WebKit's event ordering and the phone's external-keyboard send shortcut; normal Enter and Shift+Enter behavior is preserved.
- **Validation scope.** Frontend and Rust tests and strict Clippy passed. The installed Kilo CLI completed plan-mode reading, code-mode writing and session/process reuse against an isolated localhost test model. Real cloud-model authentication and browser visual acceptance remain unverified; browser-tool access was unavailable. Native Intel/Windows interaction checks are still manual.

**中文**

- **接入 Kilo CLI。** 开发模式、对话工作台和手机助手列表均可使用 Kilo。支持终端启动与续接、按项目隔离的历史浏览/删除、连续对话及跨 CLI 交接。默认使用 Kilo 原生 `plan`，也可选择 `code`，模型与推理强度分别设置；自定义配置变化时重新建立常驻进程。需先在本机安装并登录 Kilo；暂不发现其本地 skill/自定义斜杠命令。
- **项目列表完整可达。** 展开的侧栏分组不再受 500px 固定高度限制，全部项目可随侧栏滚动访问，长项目名正常收缩省略。
- **输入法确认不误发送。** 回车确认候选字时不再发送对话或执行补全选择，覆盖桌面组合输入、WebKit 事件顺序和手机外接键盘发送快捷键；保留正常 Enter 和 Shift+Enter 行为。
- **验收范围。** 前端、Rust 测试与严格 Clippy 通过；真实安装的 Kilo CLI 在隔离配置和本机测试模型下跑通 plan 读取、code 写入、磁盘会话恢复及同进程续聊。真实云模型认证与浏览器视觉验收尚未完成，浏览器工具访问不可用；原生 Intel/Windows 交互仍需人工核对。

## Phone remote / 手机远程

1. In Roster, click「手机远程」(bottom of the conversation sidebar, or the Developer-mode header) and choose「保持连接，收起面板」/ 在 Roster 里点「手机远程」，选「保持连接，收起面板」
2. Scan the QR code with the phone — same Wi-Fi uses the LAN code, away from home use the Tailscale code / 用手机扫码：同一 WiFi 扫「局域网」码，出门扫「Tailscale」码
3. If macOS asks whether Roster may accept incoming connections, choose Allow / macOS 问是否允许 Roster 接受传入连接时点「允许」

Security: LAN + PIN over plain HTTP, private-network and Tailscale peers only — use a trusted network or Tailscale. / 安全：局域网 + PIN、明文 HTTP，只接受私网与 Tailscale 来源，请在可信网络或 Tailscale 下使用。

## Android app / 安卓 App

`Roster-Remote_1.9.9_android.apk` is our own small Android shell for the phone remote (source in `mobile-android/`, package `com.lucky.roster.remote`). The UI comes from your computer, so updating the desktop app is what brings phone fixes; reinstalling the APK is optional. / `Roster-Remote_1.9.9_android.apk` 是我们自己的安卓外壳 App（源码在 `mobile-android/`，包名 `com.lucky.roster.remote`）。界面由电脑提供，手机端的修复靠更新电脑上的 Roster 生效，APK 不重装也行。

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
