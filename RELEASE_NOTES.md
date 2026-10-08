Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.9.3 / 本版更新

**English**

- **Project video preview and playback.** In Developer mode, click an MP4, M4V, MOV, WebM or OGV file in the project tree to open it in the existing preview area. Native controls provide play/pause, seeking, volume and fullscreen.
- **On-demand local reading.** Large videos stream in bounded chunks from the selected project instead of loading the entire file into memory. Closing or switching files stops playback and releases the source; hiding the workspace pauses it. Videos do not autoplay.
- Codec support depends on the system WebView; MP4 with H.264/AAC is recommended. Unsupported videos show an explanatory message. Playback/fullscreen has not yet completed manual WebView acceptance testing; automated lifecycle, range-read and file-boundary tests have passed.

**中文**

- **项目视频预览与播放。** 在开发模式的文件树点击 MP4、M4V、MOV、WebM 或 OGV，即可在现有预览区打开，支持播放/暂停、拖动进度、音量和全屏。
- **本机按需读取。** 大视频分段读取，不会一次性加载到内存。关闭预览或切换文件会停止播放并释放资源，隐藏工作台时暂停；打开时不会自动播放。
- 编码支持取决于系统 WebView，推荐 MP4（H.264/AAC），不兼容的视频会显示明确提示。播放及全屏尚未完成 WebView 人工验收；生命周期、分段读取及文件安全边界自动化测试已通过。

## Phone remote / 手机远程

1. In Roster, click「手机远程」(bottom of the conversation sidebar, or the Developer-mode header) and choose「保持连接，收起面板」/ 在 Roster 里点「手机远程」，选「保持连接，收起面板」
2. Scan the QR code with the phone — same Wi-Fi uses the LAN code, away from home use the Tailscale code / 用手机扫码：同一 WiFi 扫「局域网」码，出门扫「Tailscale」码
3. If macOS asks whether Roster may accept incoming connections, choose Allow / macOS 问是否允许 Roster 接受传入连接时点「允许」

Security: LAN + PIN over plain HTTP, private-network and Tailscale peers only — use a trusted network or Tailscale. / 安全：局域网 + PIN、明文 HTTP，只接受私网与 Tailscale 来源，请在可信网络或 Tailscale 下使用。

## Android app / 安卓 App

`Roster-Remote_1.9.3_android.apk` is our own small Android shell for the phone remote (source in `mobile-android/`, package `com.lucky.roster.remote`). The UI comes from your computer, so updating the desktop app is what brings phone fixes; reinstalling the APK is optional. / `Roster-Remote_1.9.3_android.apk` 是我们自己的安卓外壳 App（源码在 `mobile-android/`，包名 `com.lucky.roster.remote`）。界面由电脑提供，手机端的修复靠更新电脑上的 Roster 生效，APK 不重装也行。

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
