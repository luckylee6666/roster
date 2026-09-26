Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.9.0 / 本版更新

**English**

- **Drive Roster from your phone, like the Codex mobile app.** Open「Phone remote」and scan the QR code: your phone can pick a project, browse the merged history of all eight CLIs, open a session, start or continue a conversation, choose that CLI's own permission mode (full-access modes ask twice), watch the reply stream in, and stop a turn.
- **The desktop stays the only executor.** A phone request goes through exactly the same path as the desktop composer — one turn per project, the concurrency cap, project memory, resume and over-window checks — and the desktop shows it live. The phone can also join a turn that is already running on the desktop, and both sides render the same event stream.
- **Keep it running in the background.** The panel now opens from both workspaces and can stay on after you close it, with a visible indicator on both entry buttons; stopping it revokes the PIN immediately. Tailscale addresses are listed with their own QR code for use away from home.
- **Optional Android app.** A tiny shell (`mobile-android/`, build with `mobile-android/build.sh`) remembers the computer, opens full-screen, and can be picked straight from the camera when scanning the QR code. Any phone browser works too.
- Also includes the unreleased fixes since v1.8.0: startup input barrier, native-argv session rotation and cross-CLI handoff, restore that keeps failed tabs, and more — see the changelog.

**中文**

- **像 Codex 手机端一样用手机遥控 Roster。** 打开「手机远程」扫码，手机就能选项目、看 8 家 CLI 合并的历史、打开会话、开新对话或续接、按这家 CLI 自己的权限档位发指令（不开沙箱的档位要二次确认）、实时看回复、随时停止。
- **电脑是唯一的执行者。** 手机的请求和桌面输入框走完全同一条路——同一项目一轮、并发上限、项目记忆、续接与超窗复核——电脑上同步显示；手机也能中途接上电脑正在跑的一轮，两边看的是同一份事件。
- **可以后台保持连接。** 面板在两个工作台都能打开，关掉面板后可以继续运行，两个入口都会显示「已开启」；停止即作废 PIN。面板还会列出 Tailscale 地址和二维码，出门也能连。
- **可选的安卓 App。** 一个很小的外壳（`mobile-android/`，用 `mobile-android/build.sh` 构建），记住电脑地址、全屏打开，扫码时可直接选它打开；不装 App 用手机浏览器也行。
- 同时包含 v1.8.0 之后未发版的修复：启动输入屏障、原生参数轮换与跨 CLI 交接、恢复时保留失败的标签等，详见更新日志。

## Phone remote / 手机远程

1. In Roster, click「手机远程」(bottom of the conversation sidebar, or the Developer-mode header) and choose「保持连接，收起面板」/ 在 Roster 里点「手机远程」，选「保持连接，收起面板」
2. Scan the QR code with the phone — same Wi-Fi uses the LAN code, away from home use the Tailscale code / 用手机扫码：同一 WiFi 扫「局域网」码，出门扫「Tailscale」码
3. If macOS asks whether Roster may accept incoming connections, choose Allow / macOS 问是否允许 Roster 接受传入连接时点「允许」

Security: LAN + PIN over plain HTTP, private-network and Tailscale peers only — use a trusted network or Tailscale. / 安全：局域网 + PIN、明文 HTTP，只接受私网与 Tailscale 来源，请在可信网络或 Tailscale 下使用。

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
