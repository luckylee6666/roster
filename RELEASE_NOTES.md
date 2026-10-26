Cross-platform desktop app: macOS (Apple Silicon / Intel) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon / Intel) + Windows (x64 / ARM64)

## What's new in v1.9.8 / 本版更新

**English**

- **Dialogs fit small windows.** Fixes clipped close, cancel and confirmation controls in project/server forms, snippet lists, expanded shared-memory editing and other dialogs. Panels stay within the available height; headers and footer actions remain visible while content scrolls. Actions originally inside an editor remain reachable by scrolling rather than being moved out of their context.
- **Phone-remote panel.** QR codes and connection details scroll independently of the close button and the stop/keep-connected actions. Long addresses can shrink without widening the dialog; short windows use tighter spacing and footer buttons can wrap. Stopping remote access and keeping the connection retain their original behavior.
- **Form and preview compatibility.** The nested website form keeps its native submit behavior. File preview keeps its four-row header/path/content/footer grid, with an independently scrollable body. No data format, CLI permission or backend behavior changes are introduced.
- **Validation scope.** Browser fixtures using production HTML/CSS and synthetic content were checked across 18 dialogs at 900×600 and at 900×450 with 125% CSS zoom. Shared-memory save was reached by keyboard-driven scrolling, and the file-preview grid was checked at 1200×800 with standard text size. Native Intel/Windows WebView controls remain manual checks; source-contract tests and browser fixtures do not replace device verification.

**中文**

- **小屏弹窗适配。** 修复项目/服务器表单、常用指令列表、展开共享记忆编辑等窗口中关闭、取消和确认控件被裁切的问题。弹窗高度不超过可用空间，头部和底部操作固定，中间内容独立滚动；原本位于编辑内容内部的操作保留位置，但可以滚动到达。
- **手机远程面板。** 二维码和连接信息独立滚动，关闭键及停止/保持连接按钮保持可见；长地址不会撑宽弹窗，短窗口间距更紧凑、底部按钮可换行。停止远程与保持连接的原有行为不变。
- **表单与预览兼容。** 嵌套网页表单保留原提交行为；文件预览继续使用标题/路径/内容/操作四行布局，内容区独立滚动。本版不改数据格式、CLI 权限或后端行为。
- **验收范围。** 使用生产 HTML/CSS 和合成内容，在浏览器内逐个检查18个弹窗的900×600布局，以及900×450加125% CSS缩放；验证键盘滚动可到达共享记忆保存按钮，并在1200×800标准字号下检查文件预览四行布局。原生 Intel/Windows WebView 控件仍需人工核对，源码契约测试和浏览器夹具不代替真机验收。

## Phone remote / 手机远程

1. In Roster, click「手机远程」(bottom of the conversation sidebar, or the Developer-mode header) and choose「保持连接，收起面板」/ 在 Roster 里点「手机远程」，选「保持连接，收起面板」
2. Scan the QR code with the phone — same Wi-Fi uses the LAN code, away from home use the Tailscale code / 用手机扫码：同一 WiFi 扫「局域网」码，出门扫「Tailscale」码
3. If macOS asks whether Roster may accept incoming connections, choose Allow / macOS 问是否允许 Roster 接受传入连接时点「允许」

Security: LAN + PIN over plain HTTP, private-network and Tailscale peers only — use a trusted network or Tailscale. / 安全：局域网 + PIN、明文 HTTP，只接受私网与 Tailscale 来源，请在可信网络或 Tailscale 下使用。

## Android app / 安卓 App

`Roster-Remote_1.9.8_android.apk` is our own small Android shell for the phone remote (source in `mobile-android/`, package `com.lucky.roster.remote`). The UI comes from your computer, so updating the desktop app is what brings phone fixes; reinstalling the APK is optional. / `Roster-Remote_1.9.8_android.apk` 是我们自己的安卓外壳 App（源码在 `mobile-android/`，包名 `com.lucky.roster.remote`）。界面由电脑提供，手机端的修复靠更新电脑上的 Roster 生效，APK 不重装也行。

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
