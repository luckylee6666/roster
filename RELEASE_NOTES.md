Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.8.0 / 本版更新

**English**

- **Roster now watches session size.** Every history row shows how big a session has grown (plus an estimated token count), and marks it when it is getting close to — or past — that CLI's context window. Windows are registered per CLI with their source, so the number is stated rather than guessed; sizes are always shown as estimates.
- **A session that has grown past its CLI's window is no longer resumed blindly.** Roster asks first and offers the way out: **continue in a new session of the same CLI carrying a bounded handoff summary** (the same 24-message / 18KB brief used when handing a session to another CLI), leaving the old session untouched. Auto-opening the newest history skips such a session with a hint; Developer mode's tab restore and「Open CLI」move on to the newest session that is not over the line.
- **Only CLIs whose on-disk history really is the next request are blocked** — `cmd` (it replays the whole transcript every turn; a 1.27M-token request was rejected outright) and `mimo` / `opencode` (session load reads every stored part; a 41.9MB session once hung the CLI *and* its compaction). `claude`, `codex`, `grok`, `agy` and `qwen` keep the size badge but are never blocked: their transcripts are append-only logs and the CLI compacts on its own. This was tuned against real history before release — it caught a MiMo window registered 5× too small, and stopped long-lived Claude (22MB) and Codex (210MB) sessions from being blocked at all.

**中文**

- **Roster 现在盯着会话体积。** 历史行会显示这条会话长到多大了（附估算 token），接近或超过这家 CLI 的上下文窗口时会标出来。窗口逐家登记并写明出处，数字是"查到的"而不是猜的；体积一律标明是估算。
- **超过窗口的会话不再闷头续接。** Roster 会先问一句，并给出出路：**同一位助手开新会话 + 有界交接摘要**（沿用把一个会话交给别的 CLI 时那套 24 条 / 18KB），旧会话原样保留。自动打开最近历史时会跳过它并给出提示；开发模式恢复标签与「打开 CLI」顺延到没超线的那条。
- **只有"磁盘上的历史真的就是下一轮请求"的家才会被拦**——`cmd`（每轮回放整条转录，实测 1.27M token 的请求被直接拒掉）与 `mimo` / `opencode`（加载会话要读整份 part 数据，曾有一次 41.9MB 会话把 CLI 与压缩一起卡死）。`claude`、`codex`、`grok`、`agy`、`qwen` 保留体积徽标但**永不拦**：它们的转录是只增日志、由 CLI 自己压缩。这条判据是发版前拿真实历史核对出来的——它揪出 MiMo 窗口登记小了 5 倍，也让本机 22MB 的 Claude、210MB 的 Codex 会话不至于被当成"必死"挡下来。

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
