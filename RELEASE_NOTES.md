Cross-platform desktop app: macOS (Apple Silicon / Intel) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon / Intel) + Windows (x64 / ARM64)

## What's new in v1.9.7 / 本版更新

**English**

- **Codex model and effort selection.** If the local model catalog is empty, missing or unreadable, Roster falls back to a bounded, read-only App Server model-list query. Model names and effort options come from Codex rather than a hard-coded list. Failed discovery leaves a retry entry and preserves saved choices. This is the same implementation on Intel and Apple Silicon.
- **Images on your phone.** Generated image attachments now appear live, in history and after reconnecting. Tap an image to enlarge it. WebSocket events contain small opaque references; media is fetched separately with PIN authentication and project checks.
- **Project file previews on your phone.** Open text/Markdown, raster image and supported small video links without switching to the desktop. The existing project/memory-root and symbolic-link checks remain in place; videos do not autoplay and are released on close. PDF/Office documents do not gain a full embedded viewer.
- **Bounded media access.** Images are limited to 8 MiB each, videos to 16 MiB, and the server cache to 32 MiB / 64 entries / 10 minutes. Only two media reads run at once, with the permit kept for the lifetime of the response data. Stopping remote access revokes the PIN and clears media; stale requests cannot repopulate a new session's cache. Reopen history to recover expired attachments.
- **Validation scope.** Automated frontend/Rust regressions cover request races, cache bounds, safe links and process cleanup. Real local Codex model discovery and Chrome at phone dimensions were tested with synthetic HTTP/WebSocket data, including live/history/reconnect images and text/image file previews. Physical Android/Intel/Windows interaction and video codec playback remain manual checks; browser fixtures do not replace them.

**中文**

- **Codex 模型与思考深度。** 本地模型目录为空、缺失或无法读取时，改用有界、只读的 App Server 模型列表查询；模型名称和强度选项来自 Codex，不写死。查询失败保留重试入口和已有选择，Intel 与 Apple Silicon 共用实现。
- **手机显示图片。** 生成图片附件可实时显示、从历史恢复，并在断线重连后补齐，点击图片可放大。WebSocket 只传小型不透明标识，媒体通过需要 PIN 鉴权、核对项目归属的独立通道读取。
- **手机文件预览。** 文本/Markdown、图片和受支持的小视频链接可直接在手机打开，不必切回电脑。保留项目/对应记忆目录边界和符号链接检查；视频不自动播放，关闭时释放。不提供完整 PDF/Office 查看器。
- **媒体读取边界。** 单张图片最多 8 MiB、视频最多 16 MiB；服务端缓存最多 32 MiB / 64 条 / 10 分钟。最多同时两路媒体读取，限流许可随响应数据生命周期释放。停止远程访问时作废 PIN 并清空媒体，旧请求不能跨重开填回新缓存；过期附件可重新打开历史恢复。
- **验收范围。** 前端/Rust 自动回归覆盖请求竞态、缓存边界、安全链接和进程清理；实际验证本机 Codex 模型查询，并在 Chrome 手机尺寸下用合成 HTTP/WebSocket 数据验证实时/历史/重连图片和文本/图片链接预览。实体安卓、Intel/Windows 交互及视频编码实播仍需人工验收，浏览器夹具不代替真机结论。

## Phone remote / 手机远程

1. In Roster, click「手机远程」(bottom of the conversation sidebar, or the Developer-mode header) and choose「保持连接，收起面板」/ 在 Roster 里点「手机远程」，选「保持连接，收起面板」
2. Scan the QR code with the phone — same Wi-Fi uses the LAN code, away from home use the Tailscale code / 用手机扫码：同一 WiFi 扫「局域网」码，出门扫「Tailscale」码
3. If macOS asks whether Roster may accept incoming connections, choose Allow / macOS 问是否允许 Roster 接受传入连接时点「允许」

Security: LAN + PIN over plain HTTP, private-network and Tailscale peers only — use a trusted network or Tailscale. / 安全：局域网 + PIN、明文 HTTP，只接受私网与 Tailscale 来源，请在可信网络或 Tailscale 下使用。

## Android app / 安卓 App

`Roster-Remote_1.9.7_android.apk` is our own small Android shell for the phone remote (source in `mobile-android/`, package `com.lucky.roster.remote`). The UI comes from your computer, so updating the desktop app is what brings phone fixes; reinstalling the APK is optional. / `Roster-Remote_1.9.7_android.apk` 是我们自己的安卓外壳 App（源码在 `mobile-android/`，包名 `com.lucky.roster.remote`）。界面由电脑提供，手机端的修复靠更新电脑上的 Roster 生效，APK 不重装也行。

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
