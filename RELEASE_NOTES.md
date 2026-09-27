Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.9.1 / 本版更新

**English**

- **Fixed: swiping in the phone's Terminal tab typed garbage into the desktop CLI.** With mouse mode on in the running program (Claude Code turns it on), the phone's terminal turned swipes into mouse-wheel reports — with `NaN` coordinates on HarmonyOS — and the CLI's input box filled up with `aN;NaNM…`, sometimes getting submitted together with a real instruction. Swipes now only scroll on the phone, the phone never sends mouse reports, and the desktop strips any that still arrive. Typing, the key row and the conversation tab are unchanged.
- v1.9.0 brought the phone remote for the conversation workspace (pick a project, browse every CLI's history, send instructions and watch replies stream while the desktop does the work) and the optional Android app — see the changelog.

**中文**

- **修复：在手机「终端」标签里滑动会往电脑上的 CLI 输入框灌乱码。** 终端程序开了鼠标模式时（Claude Code 会开），手机终端会把滑动变成鼠标滚轮上报，鸿蒙上坐标还是 `NaN`，CLI 输入框里就出现一串 `aN;NaNM…`，有时还会跟着真指令一起被提交。现在滑动只在手机上滚动，手机不再发送鼠标上报，电脑端也会把漏过来的剥掉。打字、快捷键行和对话标签不受影响。
- v1.9.0 带来了手机遥控对话工作台（选项目、看各家 CLI 历史、发指令并实时看回复，活由电脑来干）和可选的安卓 App，详见更新日志。

## Phone remote / 手机远程

1. In Roster, click「手机远程」(bottom of the conversation sidebar, or the Developer-mode header) and choose「保持连接，收起面板」/ 在 Roster 里点「手机远程」，选「保持连接，收起面板」
2. Scan the QR code with the phone — same Wi-Fi uses the LAN code, away from home use the Tailscale code / 用手机扫码：同一 WiFi 扫「局域网」码，出门扫「Tailscale」码
3. If macOS asks whether Roster may accept incoming connections, choose Allow / macOS 问是否允许 Roster 接受传入连接时点「允许」

Security: LAN + PIN over plain HTTP, private-network and Tailscale peers only — use a trusted network or Tailscale. / 安全：局域网 + PIN、明文 HTTP，只接受私网与 Tailscale 来源，请在可信网络或 Tailscale 下使用。

## Android app / 安卓 App

`Roster-Remote_1.9.1_android.apk` is our own small Android shell for the phone remote (source in `mobile-android/`, package `com.lucky.roster.remote`). The UI comes from your computer, so updating the desktop app is what brings phone fixes; reinstalling the APK is optional. / `Roster-Remote_1.9.1_android.apk` 是我们自己的安卓外壳 App（源码在 `mobile-android/`，包名 `com.lucky.roster.remote`）。界面由电脑提供，手机端的修复靠更新电脑上的 Roster 生效，APK 不重装也行。

1. Download the APK on the phone and allow installing from this source when asked / 手机下载 APK，按提示允许安装未知来源应用
2. It is signed with a debug key for sideloading, so the system may warn that the app is unrecognised — choose to install anyway / 用调试证书签名、供侧载安装，系统可能提示来源未知，选「仍然安装」
3. On HarmonyOS NEXT, install it through 卓易通; use the LAN address at home, and a native HarmonyOS Tailscale client (e.g. MeshArc) when away / 鸿蒙 NEXT 通过卓易通安装；在家用局域网地址，出门用鸿蒙原生 Tailscale 客户端（如 MeshArc）

## Upgrade / 升级

Quit all older Roster instances before opening this version, including Debug builds. Older versions do not participate in the new lock. This release requires no data migration.
启动新版前请退出所有旧版 Roster，包括 Debug 版。旧版本尚未参与实例锁保护。本版无需数据迁移。

## Install / 安装

**macOS** — ad-hoc signed, not notarized / adhoc 签名，未公证：

1. Open the `.dmg`, drag the app into Applications / 打开 `.dmg`，把应用拖入「应用程序」
2. If first launch is blocked: **System Settings → Privacy & Security → Open Anyway** / 首次打开被拦：**系统设置 → 隐私与安全性 → 仍要打开**

**Windows** — unsigned, SmartScreen may warn / 未签名，可能出现 SmartScreen 提示：

1. Download the `*-setup.exe` for your architecture and run it / 下载对应架构的 `*-setup.exe` 安装
2. On the SmartScreen prompt: **More info → Run anyway** / SmartScreen 提示：**更多信息 → 仍要运行**
3. Pick **x64** for Intel/AMD, **arm64** for Snapdragon/Surface-ARM / Intel/AMD 选 **x64**，骁龙/ARM Surface 选 **arm64**
