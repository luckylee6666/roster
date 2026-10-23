Cross-platform desktop app: macOS (Apple Silicon / Intel) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon / Intel) + Windows (x64 / ARM64)

## What's new in v1.9.6 / 本版更新

**English**

- **Older macOS compatibility.** Fixes startup and terminal initialization on older system WebKit, including missing runtime APIs. Conversation replies fall back to safe plain text if Markdown rendering fails, allowing the send state to finish normally.
- **Codex generated images.** Fixes “single message too large” failures when image-generation results exceed the ordinary text limit. Validated raster images display in desktop conversations and are restored from history, with duplicate completion snapshots removed. The same implementation serves Intel and Apple Silicon; ordinary protocol limits and HTML sanitization remain in place.
- **Clickable screenshot and video links.** Local media links now open an image/video preview within the conversation workspace instead of being rejected by the text-only preview. Media is limited to 16 MiB, with the existing project/memory path boundaries; videos do not autoplay and stop when the preview closes.
- **History and release reliability.** Codex metadata validation and content reads share one safely opened file handle, with bounded headers and symbolic-link entry rejection. Every desktop release job uses the dependency lockfile and fails if expected installers are missing.
- **Preview limits.** Generated-image previews are limited to 8 images and 8 MiB decoded per turn. Large image events are not sent to the phone's live control stream. Ordinary generated files still need a file link in the assistant's reply; unsupported document formats do not gain a new embedded viewer.
- **Validation scope.** Intel macOS 11.7.11 was used to verify startup, conversation replies, real Codex image generation and image recovery after restart. ARM macOS was used to verify startup and an embedded-terminal Codex command. The final Intel interactive CLI-launch check and Windows hardware interaction remain manual checks; automated regression tests and package checks do not replace them.

**中文**

- **旧版 macOS 兼容。** 修复旧系统 WebKit 的启动、终端初始化和缺失 API 问题。对话 Markdown 渲染异常时会安全降级成纯文本，已完成的回复能显示，发送状态能正常结束。
- **Codex 生成图片。** 修复生图结果超出普通文本上限后报“单条消息过大”的问题；校验后的图片可在桌面对话里显示，重新打开历史也能恢复，完成快照会去重。Intel 与 Apple Silicon 使用同一实现，保留普通协议上限与 HTML 净化。
- **截图与视频链接。** 点击本地媒体链接会直接在会话工作台打开图片/视频预览，不再被文本预览器当成二进制拒绝。媒体上限 16 MiB，保留现有项目/记忆目录边界；视频不会自动播放，关闭预览时停止。
- **历史与发布可靠性。** Codex 历史在同一安全打开的文件句柄上校验归属并读取内容，限制元数据首行大小、拒绝符号链接文件。所有桌面发布任务统一使用依赖锁文件，预期安装包缺失时明确失败。
- **预览范围。** 单轮最多预览 8 张生成图片、解码后合计 8 MiB，大图片事件不进入手机实时遥控消息流。普通生成文件仍需助手提供文件链接，本版没有新增不支持格式的文档内嵌查看器。
- **验收范围。** 已在 Intel macOS 11.7.11 验证启动、会话回复、真实 Codex 生图及重启后图片恢复；在 ARM macOS 验证启动与内置终端 Codex 命令。Intel 完整交互 CLI 启动的最后一项核对及 Windows 实机交互仍属人工验证项，自动测试和包校验不代替这些验收。

## Phone remote / 手机远程

1. In Roster, click「手机远程」(bottom of the conversation sidebar, or the Developer-mode header) and choose「保持连接，收起面板」/ 在 Roster 里点「手机远程」，选「保持连接，收起面板」
2. Scan the QR code with the phone — same Wi-Fi uses the LAN code, away from home use the Tailscale code / 用手机扫码：同一 WiFi 扫「局域网」码，出门扫「Tailscale」码
3. If macOS asks whether Roster may accept incoming connections, choose Allow / macOS 问是否允许 Roster 接受传入连接时点「允许」

Security: LAN + PIN over plain HTTP, private-network and Tailscale peers only — use a trusted network or Tailscale. / 安全：局域网 + PIN、明文 HTTP，只接受私网与 Tailscale 来源，请在可信网络或 Tailscale 下使用。

## Android app / 安卓 App

`Roster-Remote_1.9.6_android.apk` is our own small Android shell for the phone remote (source in `mobile-android/`, package `com.lucky.roster.remote`). The UI comes from your computer, so updating the desktop app is what brings phone fixes; reinstalling the APK is optional. / `Roster-Remote_1.9.6_android.apk` 是我们自己的安卓外壳 App（源码在 `mobile-android/`，包名 `com.lucky.roster.remote`）。界面由电脑提供，手机端的修复靠更新电脑上的 Roster 生效，APK 不重装也行。

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
