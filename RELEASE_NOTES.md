Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.9.2 / 本版更新

**English**

- **Fixed: file-tree drag labels could remain on screen.** Dragging a file or folder now cleans up its blue label when a release event is lost, the drag is cancelled, the window loses focus or the tree changes. Starting another drag also removes orphaned labels, while normal drops still insert the path once.
- **Fixed: stopping a phone conversation during preparation could still start the assistant.** Stop now cancels the request before it starts and reports the stopped state to the phone. A cancelled request finishing later cannot disturb a newer request; desktop and phone preparation share the same concurrency limit.
- This patch also includes the phone Terminal swipe fix from v1.9.1. Update Roster on the computer to receive the phone fixes; the Android shell does not need reinstalling.

**中文**

- **修复：文件树拖拽标签一直残留。** 拖动文件或文件夹后，即使松开事件丢失、取消拖动、窗口失焦或文件树切换，蓝色标签也会清理；新拖动会移除孤立标签，正常拖入终端仍只插入一次路径。
- **修复：手机对话准备期间点停止却仍启动助手。** 停止会在请求启动前生效，并向手机显示已停止；旧取消请求后续结束，不会影响同项目的新请求，桌面与手机准备请求共用并发限制。
- 本版也包含 v1.9.1 的手机终端上滑乱码修复。手机页面由电脑提供，更新电脑上的 Roster 即可生效，已装的安卓外壳无需重装。

## Phone remote / 手机远程

1. In Roster, click「手机远程」(bottom of the conversation sidebar, or the Developer-mode header) and choose「保持连接，收起面板」/ 在 Roster 里点「手机远程」，选「保持连接，收起面板」
2. Scan the QR code with the phone — same Wi-Fi uses the LAN code, away from home use the Tailscale code / 用手机扫码：同一 WiFi 扫「局域网」码，出门扫「Tailscale」码
3. If macOS asks whether Roster may accept incoming connections, choose Allow / macOS 问是否允许 Roster 接受传入连接时点「允许」

Security: LAN + PIN over plain HTTP, private-network and Tailscale peers only — use a trusted network or Tailscale. / 安全：局域网 + PIN、明文 HTTP，只接受私网与 Tailscale 来源，请在可信网络或 Tailscale 下使用。

## Android app / 安卓 App

`Roster-Remote_1.9.2_android.apk` is our own small Android shell for the phone remote (source in `mobile-android/`, package `com.lucky.roster.remote`). The UI comes from your computer, so updating the desktop app is what brings phone fixes; reinstalling the APK is optional. / `Roster-Remote_1.9.2_android.apk` 是我们自己的安卓外壳 App（源码在 `mobile-android/`，包名 `com.lucky.roster.remote`）。界面由电脑提供，手机端的修复靠更新电脑上的 Roster 生效，APK 不重装也行。

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
