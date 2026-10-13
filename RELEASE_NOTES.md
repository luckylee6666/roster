Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.9.4 / 本版更新

**English**

- **Reliable terminal file drops.** Fixes incorrect coordinate scaling on Retina Macs that could miss the terminal or target a different pane. Dropped and inserted paths use xterm's paste handling for cmd and other CLIs, without submitting the input. Invalid paths and unavailable terminals show a clear error; startup paste overflow is rejected without leaving partial input.
- **Files in conversation drafts.** Ordinary files and folders insert quoted paths at the cursor while preserving the draft; supported images remain attachments. Dropping does not send automatically, read ordinary files or grant additional permissions. More than four images now produces an explicit limit message.
- **agy full-access launch option.** Right-click the agy badge on a project card in Developer mode to opt into `--dangerously-skip-permissions`. It is never the default and uses a red danger badge. Conversation-mode permissions are unchanged.
- Automated tests cover platform coordinate conversion, pane routing, paste/startup handling and conversation drops. Native Finder/File Explorer drag-and-drop still needs end-to-end confirmation on real machines; CI builds are not a substitute for that check. Video playback/fullscreen manual acceptance from v1.9.3 also remains outstanding.

**中文**

- **终端拖文件修复。** 修正 Retina Mac 上的坐标重复缩放，避免拖不到终端或落错窗格；cmd 及其他 CLI 的拖入/插入路径统一走 xterm 粘贴处理，不自动回车。非法路径、终端不可用时明确提示；启动缓存不足时整段拒绝，避免留下半截输入。
- **会话草稿支持文件路径。** 普通文件/目录以带引号的路径插入光标处并保留草稿，支持的图片仍作为附件；不自动发送、不读取普通文件内容、不额外授予权限。超过 4 张图片会明确提示上限。
- **agy 完全访问启动项。** 在开发模式右键项目卡片的 agy 色标，可主动选择 `--dangerously-skip-permissions`；非默认、红色危险标记，对话模式权限不变。
- 自动化测试覆盖平台坐标换算、分屏命中、粘贴/启动队列和会话拖入；Finder/资源管理器原生拖放仍需实机端到端确认，不能用 CI 构建替代。v1.9.3 视频播放/全屏人工验收也仍待完成。

## Phone remote / 手机远程

1. In Roster, click「手机远程」(bottom of the conversation sidebar, or the Developer-mode header) and choose「保持连接，收起面板」/ 在 Roster 里点「手机远程」，选「保持连接，收起面板」
2. Scan the QR code with the phone — same Wi-Fi uses the LAN code, away from home use the Tailscale code / 用手机扫码：同一 WiFi 扫「局域网」码，出门扫「Tailscale」码
3. If macOS asks whether Roster may accept incoming connections, choose Allow / macOS 问是否允许 Roster 接受传入连接时点「允许」

Security: LAN + PIN over plain HTTP, private-network and Tailscale peers only — use a trusted network or Tailscale. / 安全：局域网 + PIN、明文 HTTP，只接受私网与 Tailscale 来源，请在可信网络或 Tailscale 下使用。

## Android app / 安卓 App

`Roster-Remote_1.9.4_android.apk` is our own small Android shell for the phone remote (source in `mobile-android/`, package `com.lucky.roster.remote`). The UI comes from your computer, so updating the desktop app is what brings phone fixes; reinstalling the APK is optional. / `Roster-Remote_1.9.4_android.apk` 是我们自己的安卓外壳 App（源码在 `mobile-android/`，包名 `com.lucky.roster.remote`）。界面由电脑提供，手机端的修复靠更新电脑上的 Roster 生效，APK 不重装也行。

1. Download the APK on the phone and allow installing from this source when asked / 手机下载 APK，按提示允许安装未知来源应用
2. It is signed with a debug key for sideloading, so the system may warn that the app is unrecognised — choose to install anyway / 用调试证书签名、供侧载安装，系统可能提示来源未知，选「仍然安装」
3. On HarmonyOS NEXT, install it through 卓易通; use the LAN address at home, and a native HarmonyOS Tailscale client (e.g. MeshArc) when away / 鸿蒙 NEXT 通过卓易通安装；在家用局域网地址，出门用鸿蒙原生 Tailscale 客户端（如 MeshArc）

## Upgrade / 升级

Quit the installed Roster before replacing it, then reopen to load the update. Roster Dev uses a separate data directory and can run alongside production. This release requires no data migration.
替换安装包前先退出当前正式版 Roster，安装后重新打开以加载更新。Roster Dev 使用独立数据目录，可与正式版并行。本版无需数据迁移。

## Install / 安装

**macOS** — ad-hoc signed, not notarized / adhoc 签名，未公证：

1. Open the `.dmg`, drag the app into Applications / 打开 `.dmg`，把应用拖入「应用程序」
2. If first launch is blocked: **System Settings → Privacy & Security → Open Anyway** / 首次打开被拦：**系统设置 → 隐私与安全性 → 仍要打开**

**Windows** — unsigned, SmartScreen may warn / 未签名，可能出现 SmartScreen 提示：

1. Download the `*-setup.exe` for your architecture and run it / 下载对应架构的 `*-setup.exe` 安装
2. On the SmartScreen prompt: **More info → Run anyway** / SmartScreen 提示：**更多信息 → 仍要运行**
3. Pick **x64** for Intel/AMD, **arm64** for Snapdragon/Surface-ARM / Intel/AMD 选 **x64**，骁龙/ARM Surface 选 **arm64**
