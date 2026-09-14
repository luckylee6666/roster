Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.5.1 / 本版更新

**English**

- Terminals no longer garble long or side-by-side WebGL sessions (xterm.js atlas fix), WebGL context loss re-attaches automatically, and returning from background clears the glyph atlas.
- A round of conversation and Developer-view fixes: approval answers stay bound to the run that asked, stopping while a turn is still connecting is queued and replayed, concurrent image paste/drop can no longer exceed the attachment limit, and stale file-tree results no longer overwrite the active tree.
- Session history fixes: OpenCode deletion cascades to messages and parts, transcript image placeholders are removed by their original index, OpenCode/MiMo history falls through to the next database instead of stopping at an empty one, HEIC/HEIF photos are no longer misclassified as video, and transcript/history reads are size-bounded.
- Terminal and system reliability: input no longer blocks the IPC thread, FIFO files no longer hang reads, "Open in terminal" child processes are reaped, and a single unreadable entry no longer aborts the newest-transcript search.
- Usage panel: Claude credentials follow `CLAUDE_CONFIG_DIR`, OAuth usage requests honor the configured proxy, and failed curl runs are cleaned up.
- The phone remote panel releases its port reliably when stopped and quickly reopened.
- Shared-memory backups prune the oldest history instead of blocking saving after 100 backups.
- Security hardening: project-memory writes and internal reads refuse symlinks and special files; file preview editing is confined to saved projects; the file tree no longer lists symlinks; front-end attributes and Markdown previews are escaped/sanitized; `open_url` allows only http/https; the data directory is tightened to 0700/0600; the phone remote server accepts only LAN/Tailscale peers and returns 403 to public sources; highlight.js is updated to 11.12.0 (C/C++ ReDoS fix).

**中文**

- 终端不再花屏（xterm.js 图集修复）；WebGL 上下文丢失会自动重挂；从后台恢复时清空字形图集。
- 一批对话与开发模式修复：审批回答绑定发起运行；连接中停止会排队并在 start 后被补发；并发粘贴/拖放不再超附件上限；过期文件树结果不再覆盖当前树。
- 会话历史修复：OpenCode 删除级联清理消息与部件；图片占位按原始序号删除；OpenCode/MiMo 历史在空库时回退下一个数据库；HEIC/HEIF 照片不再被当成视频；转录/历史读取有界。
- 终端与系统可靠性：输入不再阻塞 IPC 线程；FIFO 不再挂住读取；「打开 CLI」子进程会被回收；单个坏条目不再中止最新转录搜索。
- 用量面板：Claude 凭据跟随 `CLAUDE_CONFIG_DIR`；OAuth 用量查询走已配置代理；curl 失败会清理子进程。
- 手机远程面板停止后立即重开不再残留旧监听，端口正常释放。
- 共享记忆备份满载后淘汰最旧历史，不再拒绝保存。
- 安全加固：项目记忆写出与内部读取拒绝符号链接和特殊文件；预览编辑限定项目内；文件树不列符号链接；前端属性转义、Markdown 预览净化；`open_url` 只放行 http/https；数据目录收紧到 0700/0600；手机远程只接受局域网/Tailscale 来源、公网直接 403；highlight.js 升级到 11.12.0（C/C++ ReDoS 修复）。


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
