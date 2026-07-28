# Changelog

All notable changes to this project are documented here. 本项目的更新记录如下。

## v1.2.12

### English

**Added**
- **Built-in file editing**: code, configuration, Markdown, CSV, and ordinary UTF-8 text files can now be edited directly from the terminal file preview. The editor includes syntax-aware preview, Tab/Shift+Tab indentation, position and encoding metadata, and `⌘/Ctrl + S` saving.

**Changed**
- Saves preserve UTF-8 BOM, LF/CRLF/CR line endings, permissions, ACLs, extended attributes, and supported platform metadata. Mixed-line-ending files remain preview-only to avoid rewriting their format.

**Fixed / Hardened**
- Typing while a save is in flight no longer loses newer edits. Unsaved changes now block file/session switches, window close, system quit, and tray quit until explicitly discarded.
- Text reads are bounded to 1 MB and scan the full loaded content for NUL bytes. Binary, invalid UTF-8, read-only, mixed-line-ending, and oversized files are handled safely.
- Same-directory atomic replacement and best-effort external-change checks reduce partial writes and accidental overwrites; the limitation of the unavoidable final concurrent-write window is documented.

**Tests**
- Added frontend save-state/line-ending tests and backend coverage for BOM/line endings, conflicts, late NUL bytes, oversized and invalid UTF-8 files, and extended-attribute preservation.

### 中文

**新增**
- **内置文件编辑**：终端文件预览现可直接编辑代码、配置、Markdown、CSV 和普通 UTF-8 文本；支持语法高亮预览、Tab/Shift+Tab 缩进、位置与编码状态，以及 `⌘/Ctrl + S` 保存。

**变更**
- 保存时保留 UTF-8 BOM、LF/CRLF/CR 换行、文件权限、ACL、扩展属性及平台支持的元数据。混合换行文件保持只读预览，避免整文件格式被重写。

**修复 / 加固**
- 保存请求进行中继续输入不再丢失新修改；未保存内容会拦截文件/会话切换、窗口关闭、系统退出和托盘退出，直到用户明确放弃。
- 文本读取限制为 1MB，并对已加载内容完整检测 NUL 字节；二进制、无效 UTF-8、只读、混合换行和超大文件均安全处理。
- 同目录原子替换与尽力外部冲突检测减少半截写入和误覆盖，并在文档中明确最终并发写入窗口无法完全消除。

**测试**
- 新增前端保存状态/换行测试，以及后端 BOM/换行、冲突、后置 NUL、超大文件、无效 UTF-8 和扩展属性保留测试。

## v1.2.11

### English

**Added**
- **Neon Rain terminal theme**: a new Image 2 background and icon with cool cyan/purple terminal colors, a right-aligned character, and a code-safe dark area. It ships as an editable/deletable preset and is also available in DIY themes.

**Changed**
- **Sakura is redesigned as Sakura Twilight**: a mature twilight illustration, deeper plum palette, improved text contrast, and a new icon replace the old bright-pink artwork while keeping the wand cursor and petal/heart click effects.
- Image-theme chrome now uses isolated Sakura, Neon, and neutral DIY styles instead of making every custom background inherit Sakura's pink UI.

**Fixed**
- **Claude context percentage uses the real context window**: the app resolves `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, startup banners, `353k`/`1M` labels, and `/context` denominators before falling back to 200k.
- Legacy Sakura references migrate to the new assets without overwriting custom names or overlay settings. Failed DIY saves no longer mutate in-memory state, missing themes fall back to Default Dark, and theme deletion now asks for confirmation.

**Removed / Cleaned**
- Removed the obsolete Sakura background/icon and three unreferenced Vite starter SVGs. Full Rust Clippy now passes with warnings denied.

### 中文

**新增**
- **霓虹雨夜终端主题**：新增 Image 2 背景与图标，采用青紫冷色终端配色、人物右置和代码区深色留白；作为可编辑、可删除的预装主题提供，也可在 DIY 中选用。

**变更**
- **樱花主题重设计为「樱花暮色」**：用更成熟的暮色插画、深梅紫配色、更清晰的文字对比和新版图标替换旧高亮粉色素材，同时保留魔法棒光标及花瓣/爱心点击特效。
- 图片主题界面样式拆分为樱花、霓虹和中性 DIY 三套，不再让所有自定义背景继承樱花粉色界面。

**修复**
- **Claude 上下文占比使用真实窗口长度**：依次解析 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`、启动横幅、`353k`/`1M` 标记和 `/context` 分母，最后才回退 200k。
- 旧樱花引用会迁移到新版素材且不覆盖自定义名称或遮罩设置；DIY 保存失败不再提前改坏内存状态；主题记录丢失时回退默认深色；删除主题增加二次确认。

**移除 / 清理**
- 删除旧樱花背景/图标和三个无引用的 Vite 模板 SVG；Rust 全量 Clippy 已可在拒绝警告模式下通过。

## v1.2.10

### English

**Fixed**
- **Third-party Claude API providers are no longer probed for usage support**: when `ANTHROPIC_BASE_URL` points away from Anthropic's official API, the app skips the usage request before reading credentials or starting `curl` and explains that the provider has not declared usage support.

### 中文

**修复**
- **不再探测第三方 Claude API 是否支持用量接口**：当 `ANTHROPIC_BASE_URL` 指向 Anthropic 官方地址之外时，应用会在读取凭据和启动 `curl` 之前直接跳过用量请求，并提示该服务未声明支持用量查询。

## v1.2.9

### English

**Fixed**
- **Claude rate-limit usage now follows the active Claude Code API configuration**: the app resolves `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` from the process environment first, then from `~/.claude/settings.json`. Custom base URLs correctly map to `/api/oauth/usage` (including configurations ending in `/v1`), while an unconfigured installation still uses Anthropic's official endpoint and Claude Code OAuth login.
- **Terminal tab names no longer collapse under status badges**: tabs size to their content instead of shrinking into unreadable labels. When they exceed the available width, the tab strip scrolls horizontally via trackpad or mouse wheel, and the active tab automatically scrolls into view.

**Security / Hardened**
- Claude Code OAuth login tokens are restricted to Anthropic's official endpoint. Custom API hosts must provide their own `ANTHROPIC_AUTH_TOKEN`, and usage caches are isolated per endpoint so switching providers cannot surface data from the previous source.

### 中文

**修复**
- **Claude 限流用量现会跟随 Claude Code 当前生效的 API 配置**：应用优先读取进程环境中的 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_AUTH_TOKEN`，再读取 `~/.claude/settings.json`。自定义基址会正确拼接 `/api/oauth/usage`（兼容末尾带 `/v1` 的配置）；未配置时仍使用 Anthropic 官方地址和 Claude Code OAuth 登录。
- **终端标签名不再被状态徽标挤没**：标签按内容自适应宽度，不再缩成无法辨认的短标签。一屏放不下时可通过触控板或鼠标滚轮横向滚动，激活标签会自动滚入可视区。

**安全 / 加固**
- Claude Code OAuth 登录 token 只允许发往 Anthropic 官方地址；自定义 API 地址必须提供配套的 `ANTHROPIC_AUTH_TOKEN`。用量缓存也按 API 地址隔离，切换服务源后不会误显示上一地址的数据。

## v1.2.8

### English

**Fixed**
- **Runaway `ccusage` processes could exhaust memory and freeze the whole machine**: every cache-miss usage query spawned its own `ccusage`/`npx`/`node` process tree, and each one loads the full local JSONL logs into memory — rapid refresh clicks or quick tab switches piled up half a dozen of them within the 90-second timeout. Usage queries now go through a global single-flight gate (at most one `ccusage` process tree at any moment; queued callers re-check the cache once the running one finishes), failures enter a 30-second cooldown instead of re-spawning on every click, and the panel ignores repeat clicks while a query is already in flight.

**Removed**
- The dead `claude_usage` backend command (the old ccusage 5-hour-window path; the panel stopped calling it in v1.2.7). Claude usage no longer touches `ccusage` at all — the Claude tab is a single rate-limit API call. Only the Codex / OpenCode weekly stats still use `ccusage`, now behind the guards above.

### 中文

**修复**
- **ccusage 进程堆积可致内存爆满、整机卡死**：此前缓存未命中的用量查询各自拉起一棵 `ccusage`/`npx`/`node` 进程树，每棵都把全量本地 JSONL 日志读进内存——连点刷新或快速切换标签，90 秒超时内能堆出成排进程。现在用量查询过全局单飞锁（任一时刻至多一棵 ccusage 进程树；排队的调用等它跑完后先重查缓存），失败进入 30 秒冷却期、不再每次点击都重新拉起进程，且面板在查询在途时忽略重复点击。

**移除**
- 后端残留的 `claude_usage` 命令（旧的 ccusage 5 小时窗口路径；面板自 v1.2.7 起已不再调用）。Claude 用量彻底不再碰 `ccusage`——Claude 标签只走一次限流接口调用。仅 Codex / OpenCode 周用量仍用 `ccusage`，且已加上述防护。

## v1.2.7

### English

**Added**
- **Terminal DIY theme customizer**: build your own kawaii terminal themes — swap the background art, adjust the dim overlay and tint, toggle click effects (hearts/petals), and save several. The theme menu now shows an illustrated icon per theme (custom themes preview their own background). Stored in `term-themes.json`.
- **Git branch badge on terminal tabs**: each terminal tab shows the current git branch of its working directory.
- **Scheduled snippet send**: a snippet can auto-send on a fixed interval.

**Changed**
- The signature **Sakura** theme is no longer a hard-coded built-in — it now ships as a pre-installed **editable and deletable** custom theme (built-ins are just color palettes now). Delete it and it stays gone.
- The usage countdown is aligned to the OAuth rate-limit window; the automatic "hello" on window reset was removed.

**Security / Hardened**
- **Mobile-remote**: the LAN terminal mirror now locks out PIN brute-forcing (exponential backoff after repeated wrong PINs) and compares the PIN in constant time. Closing the panel now **actually stops the server** — it clears the PIN, disconnects connected phones, and stops listening — instead of only hiding the UI while the listener and PIN stayed live for the app's whole lifetime.
- Fixed a toast-notification HTML-injection path (user-controlled snippet titles are now escaped).
- Group rename can be abandoned by clicking away (blur cancels instead of committing), since macOS swallows the Esc key.
- Terminal-theme saves are serialized so concurrent writes can't corrupt `term-themes.json`.

### 中文

**新增**
- **终端 DIY 主题定制器**：自己捏卡哇伊终端主题——换背景立绘、调遮罩浓度与色调、开关点击特效（爱心/花瓣），可存多套。主题菜单每项改用插画图标（自定义主题预览自己的背景）。数据存 `term-themes.json`。
- **终端标签 Git 分支徽标**：每个终端标签显示其工作目录当前的 git 分支。
- **片段定时发送**：片段可按固定间隔自动发送。

**变更**
- 招牌 **樱花** 主题不再硬编码为内置——改为**预装的可编辑、可删除**自定义主题（内置只保留纯配色方案）。删掉后不会再被种回来。
- 用量倒计时对齐 OAuth 限流窗口；移除窗口重置后的自动 hello。

**安全 / 加固**
- **手机远程**：局域网终端镜像现在会对 PIN 暴力枚举做锁定（连续错误后指数退避）并用定长比较。关闭面板现在**真正停止服务**——清空 PIN、断开已连接的手机、停止监听——而非只隐藏界面、让监听端口和 PIN 一直活到应用退出。
- 修复一处提示消息的 HTML 注入路径（用户可控的片段标题现已转义）。
- 分组重命名可点击别处放弃（失焦=取消而非提交），因为 macOS 会吞掉 Esc 键。
- 终端主题保存串行化，并发写入不会损坏 `term-themes.json`。

## v1.2.6

### English

**Added**
- **Requirements list**: a lightweight inbox for the stray feature ideas you jot down while coding. A "Requirements" entry in the sidebar (with an open-count badge) opens a quick-capture box — type and press Enter to save — plus To-do / Doing / Done filters, inline editing, priority, and optional project tagging. Stored in `requirements.json`.
- **Floating snippet quick-panel**: a collapsible card panel in the bottom-right of the terminal lists your snippets; a single click injects one **and presses Enter** (one-click send — no dropdown step, no manual Enter). Collapses to a small button; the state is remembered.
- **Global app log**: a built-in file log (`logs/app.log`, ~1 MB rotation) records startup, usage refreshes, ccusage/auto-hello, data writes, terminal/remote-server lifecycle, and uncaught front-end errors — never tokens or PINs. A tray **"Open log"** item opens it.

**Fixed**
- **Rate-limit usage froze / showed a stale value**: when the periodic refresh failed, the app silently kept showing an hours-old cached number as if it were current. Now the tray marks stale data (`⚠`), the panel shows "updated X min ago" plus the real failure reason, the usage request no longer swallows its error (it captures curl stderr + HTTP status), and `curl` is invoked by absolute path so a minimal launch PATH can't break it.

**Hardened**
- **Atomic data writes**: all data files (projects / servers / snippets / requirements) are now written via temp-file + rename, so a crash mid-write can no longer corrupt the whole file. A file that fails to parse on load is backed up to `*.bad` before falling back, instead of being silently overwritten.
- **Serialized saves**: rapid successive edits to snippets/requirements can no longer drop a just-added item due to out-of-order save responses.

### 中文

**新增**
- **需求清单**：写代码时随口冒出的碎片需求/想法，有个轻量收集箱。侧栏「需求清单」入口（带未完成角标）打开速记框——输入回车即存——外加 待办/进行中/已完成 过滤、行内编辑、优先级、可选关联项目。数据存 `requirements.json`。
- **片段快捷悬浮面板**：终端右下角可收起的卡片浮层列出你的片段；**单击一条 = 注入并自动回车**（一次点击直接发送，免开下拉、免手按回车）。可收成小按钮，状态记住。
- **全局应用日志**：内置文件日志（`logs/app.log`，约 1MB 滚动），记录启动、用量刷新、ccusage/自动 hello、数据写入、终端/手机服务生命周期、前端未捕获异常——绝不记 token/PIN。托盘新增**「打开日志」**。

**修复**
- **限流用量冻住 / 显示旧值**：之前定时刷新一旦失败，会静默地继续把几小时前的缓存当现值显示。现在：托盘对过期数据加 `⚠`、面板显示「X 分钟前更新」+ 真实失败原因、用量请求不再吞错误（抓 curl stderr + HTTP 状态码）、`curl` 用绝对路径调用以免精简 PATH 下找不到。

**加固**
- **数据原子写**：所有数据文件（项目/服务器/片段/需求）改为临时文件 + rename 写入，写入中途崩溃不会损坏整个文件。加载时解析失败的文件会先备份成 `*.bad` 再回退，而非静默覆盖。
- **保存串行化**：连续快速增改片段/需求时，不再因保存响应乱序而把刚加的项挤掉。

## v1.2.5

### English

**Added**
- **Session attention awareness**: the built-in terminal now detects when a session has been actively producing output and then goes quiet — i.e. an AI CLI (Claude/Codex/…) likely finished or is waiting for your input — and pings you. The tab shows an amber pulsing dot; if the window is unfocused or you're on another tab, you get a native desktop notification plus a chime. A bell icon in the terminal toolbar toggles notifications (on by default; the choice is remembered). One-shot prompt prints (a plain shell sitting idle) are filtered out so you only get pinged for real work. Exiting sessions notify too.
- **Git status badges on project cards**: each local project card now shows its current branch, working-tree changes (● tracked / + untracked), and ahead/behind counts vs upstream (↑/↓), or a green ✓ when clean and in sync. Scanned in the background (parallel `git status`), refreshed on launch and whenever the window regains focus.
- **Session restore**: the built-in terminal remembers your open tab layout (working dir + which CLI per tab). On the next launch it offers to restore them — re-launching each CLI in the same directory; Claude tabs come back with `--continue` to pick up the previous conversation.
- **Prompt/snippet library**: a new bookmark icon in the terminal toolbar opens a library of reusable prompts/commands; click one to inject it into the current terminal (text only, no auto-Enter, so you can review before sending — a blank terminal is opened first if none is active). A management dialog lets you add/edit/delete snippets, stored in `snippets.json` alongside your other data.
- **"Restore context" card**: each project card gets a history icon that opens a one-glance snapshot to help you pick up where you left off — git overview (branch / changes / ahead-behind), the 5 most recent commits, the changed-files list, the project's CLAUDE.md summary, and when you last launched a CLI there. Footer buttons jump straight back in (open terminal / open Claude).
- **Rate-limit usage (Claude)**: the Claude usage tab now shows your real 5-hour and 7-day limit utilization (% + reset countdown) — the same data as Claude Code's `/usage`, fetched from the official `api/oauth/usage` endpoint (token read from the macOS Keychain; first read prompts a Keychain authorization). It's cached 60s so it's near-instant, unlike ccusage. Codex/OpenCode have no equivalent limit API and keep their ccusage cost view.

- **Menu-bar usage tray**: a system-tray item shows your live Claude limit usage right in the macOS menu bar — `5h X% · 周 Y%` (refreshed every 60s from the OAuth usage data); its menu opens the app / refreshes / quits.
- **Context usage on terminal tabs**: Claude sessions now show an `NN%` badge on their tab — the current conversation's context-window fill. The window size is read from Claude Code's startup banner (`(1M context)`), so it's correct on both 1M and 200K plans without guessing; the fill comes from the session's transcript and reads 0 before the first turn.
- **Graceful Node-less degradation**: the rate-limit usage and context % are fully built-in (no Node needed). The cost stats / Codex / OpenCode views depend on `ccusage` (run via `npx`); when `npx` is absent the app now shows a friendly hint with a one-click "Install Node.js" button instead of a raw error, and the rate-limit usage keeps working.

**Fixed**
- **Usage panel "cannot run ccusage"**: the helper shell now runs as an interactive login shell (`-ilc`) so it inherits the full PATH (nvm's node/npx live in `.zshrc`, which non-interactive login shells skip); switched the npx fallback off `--prefer-offline` (the cached build was missing the darwin-arm64 native binary) to `ccusage@latest`; and JSON parsing now tolerates shell-startup noise on stdout.
- **Usage panel slowness**: ccusage cost/weekly results are now file-cached (60s for the 5-hour window, 10min for weekly; the background poller keeps the cache warm), so re-opening the panel is instant instead of re-running ccusage every time.

### 中文

**新增**
- **会话状态感知 + 通知**：内置终端现在能识别某会话"持续输出了一阵后突然安静"——即 AI CLI（Claude/Codex/…）可能跑完了或在等你输入——并提醒你。标签上出现琥珀色呼吸点；若窗口失焦或你正看着别的标签，会弹原生桌面通知 + 提示音。终端工具栏新增铃铛图标可开关提醒（默认开，选择会记住）。瞬时的提示符打印（空闲的普通 shell）已被过滤，只在真正干活时才提醒。会话退出也会通知。
- **项目卡片 Git 状态徽标**：每个本地项目卡片现在显示当前分支、工作区改动（● 已追踪 / + 未追踪）、相对上游的领先/落后提交数（↑/↓），干净且与上游同步时显示绿色 ✓。后台并行 `git status` 扫描，启动时及窗口重新聚焦时刷新。
- **会话恢复**：内置终端记住你打开的标签布局（每个标签的工作目录 + 所用 CLI）。下次启动时询问是否恢复——在同目录重新拉起对应 CLI；Claude 标签用 `--continue` 接上次对话。
- **Prompt/片段库**：终端工具栏新增书签图标，打开可复用的 Prompt/命令库；点一条即注入当前终端（仅文本、不自动回车，可先检查再发送；无活动终端会先开一个空白的）。管理弹窗可增删改片段，数据存于 `snippets.json`（与其他数据放一起）。
- **"恢复现场"卡片**：每个项目卡片新增历史图标，打开一张速览帮你接回上次的工作——git 概览（分支/改动/领先落后）、最近 5 条提交、改动文件列表、项目 CLAUDE.md 摘要、以及上次在该项目启动了哪个 CLI、多久前。底部按钮可一键接回（打开终端 / 打开 Claude）。
- **限流用量（Claude）**：Claude 用量 tab 现在显示真实的 5 小时 / 7 天限流使用率（百分比 + 重置倒计时）——和 Claude Code 的 `/usage` 同一数据源，调官方 `api/oauth/usage` 接口（token 从 macOS 钥匙串读，首次读取会弹钥匙串授权）。缓存 60 秒，几乎秒出，不像 ccusage 那么慢。Codex/OpenCode 没有对应限流 API，保留各自的 ccusage 花费视图。

- **菜单栏用量托盘**：系统托盘常驻显示 Claude 限流用量 `5h X% · 周 Y%`（每 60 秒按 OAuth 用量刷新）；菜单可打开应用 / 刷新 / 退出。
- **终端标签上下文用量**：Claude 会话的标签上显示 `NN%` 徽标——当前对话的上下文窗口占用。窗口大小从 Claude Code 启动横幅 `(1M context)` 读取，1M 和 200K 套餐都准、无需猜测；占用来自会话 transcript，新会话发第一句前为 0。
- **无 Node 优雅降级**：限流用量和上下文 % 完全内置（无需 Node）。花费统计 / Codex / OpenCode 依赖 `ccusage`（经 `npx` 运行）；没有 `npx` 时不再丢原始报错，而是显示友好提示 + 一键「去安装 Node.js」按钮，且限流用量照常工作。

**修复**
- **用量面板「无法运行 ccusage」**：辅助 shell 改用交互式登录（`-ilc`）以继承完整 PATH（nvm 的 node/npx 写在 `.zshrc`，非交互登录不加载）；npx 回退从 `--prefer-offline`（缓存版缺 darwin-arm64 原生二进制）改为 `ccusage@latest`；解析 JSON 时容忍 shell 启动噪声。
- **用量面板慢**：ccusage 的花费/周用量结果改为文件缓存（5 小时窗口 60 秒、周用量 10 分钟；后台 poller 预热），重开面板秒出，不再每次重跑 ccusage。

## v1.2.4

### English

**Added**
- **Claude usage panel** (5-hour window): a new clock icon in the terminal toolbar opens a panel showing the current 5-hour billing window — a live countdown to reset, cost so far + projected cost, burn rate ($/hr), total/output tokens, and the active models. Data comes from the community `ccusage` tool reading your local `~/.claude` logs; nothing is uploaded.
- **Auto-hello on window reset**: an optional toggle that, once your 5-hour window has reset / gone idle, automatically fires a tiny `claude -p hello` to immediately open a fresh window so the clock restarts when you want it. A "send hello now" button is also provided for manual triggering.

### 中文

**新增**
- **Claude 用量面板**（5 小时窗口）：终端工具栏新增时钟图标，打开后显示当前 5 小时计费窗口——实时倒计时、本窗口花费 + 预计花费、燃烧速率（美元/小时）、总/输出 token、活跃模型。数据来自社区工具 `ccusage` 读取本机 `~/.claude` 日志，不上传任何数据。
- **窗口重置后自动 hello**：可选开关，当 5 小时窗口重置 / 空闲后，自动发一句极小的 `claude -p hello` 立刻开新窗口，让计时从你想要的时刻重新开始；另有「立刻发一次 hello」按钮可手动触发。

## v1.2.3

### English

**Added**
- AI CLI launch menu now includes **Gemini** (`gemini`) and **agy** (`agy`), in addition to Claude / Codex / opencode. Each gets its own tab badge color (gemini purple, agy cyan).

**Fixed**
- Built-in terminal switched to the WebGL renderer, fixing selection "ghosting" — a blue block smearing across consecutive lines — when scrolling on a macOS trackpad. The default DOM renderer failed to reposition the selection layer on scroll. WebGL falls back to the default renderer gracefully when unavailable.

### 中文

**新增**
- AI CLI 启动菜单新增 **Gemini**（`gemini`）和 **agy**（`agy`），与 Claude / Codex / opencode 并列。各有独立 tab 色标（gemini 紫、agy 青）。

**修复**
- 内置终端改用 WebGL 渲染器，修复 macOS 触控板滚动时选区「ghosting」——一块蓝色高亮糊在连续多行上。默认 DOM 渲染器在滚动时没有重新定位选区层。WebGL 不可用时安全降级回默认渲染器。

## v1.2.2

### English

**Added**
- Rename a group inline: hover a group in the sidebar, click the pencil icon, edit the name, press Enter. All projects in that group are re-assigned in one batch (groups have no standalone entity — they aggregate from each project's `group` field).
- Close-terminal confirmation: closing a terminal tab now prompts first. If the session was started with an AI CLI (claude/codex/…), it reminds you to let the tool "update its memory" before closing, so context isn't lost.

**Changed**
- Title bar now shows the app version.
- Server management moved to the top of the sidebar; the redundant project count was removed.
- The confirm dialog was generalized (title / message / button text / danger style) and now supports multi-line messages.
- DMG installer now uses a "drag to Applications" layout.

**Fixed**
- Confirm dialogs were hidden behind the built-in terminal panel when it was open — their z-index is now raised above it.

### 中文

**新增**
- 分组就地重命名：在侧栏 hover 分组、点铅笔图标、改名后回车。组内所有项目一次性批量迁移（分组没有独立实体，靠各项目的 `group` 字段聚合）。
- 关闭终端前确认：关终端标签会先弹确认。若该会话起的是某个 AI CLI（claude/codex/…），会提醒你先让它「更新记忆」再关，避免上下文丢失。

**变更**
- 标题栏显示应用版本号。
- 服务器管理移到侧栏顶部；去掉冗余的项目数显示。
- 确认弹窗抽象为通用组件（标题 / 内容 / 按钮文案 / 危险样式），支持多行内容。
- DMG 安装界面改为「拖到 Applications」布局。

**修复**
- 内置终端面板打开时确认弹窗会被压在底下——已把弹窗层级提到终端之上。

## v1.2.1

### English

**Added**
- File tree: drag a file or folder onto the terminal to insert its path — handy for pointing an AI session at a specific directory.
- File tree right-click menu: **Open folder** (folder → open in system file manager; file → open its containing folder), **Insert path into terminal**, **Copy path**, **Move to Trash** (recoverable, with confirmation).
- File preview now supports more formats:
  - **Images** (png/jpg/gif/webp/svg/ico/avif) rendered on a checkerboard transparency background.
  - **PDF** rendered inline.
  - **Markdown** rendered as a formatted page, with a Source / Rendered toggle.
  - **CSV / TSV** rendered as a table, switchable back to source.

**Security**
- Markdown preview is sanitized with DOMPurify, and links open in the system browser instead of navigating the app — any untrusted file can be previewed safely.

### 中文

**新增**
- 文件树：把文件/文件夹拖到终端即可插入路径——跟 AI 对话时指定某个目录很方便。
- 文件树右键菜单：**打开文件夹**（文件夹 → 在系统文件管理器打开；文件 → 打开所在文件夹）、**插入路径到终端**、**复制路径**、**移到废纸篓**（可恢复，删除前有确认）。
- 文件预览支持更多格式：
  - **图片**（png/jpg/gif/webp/svg/ico/avif），棋盘格透明底。
  - **PDF** 内嵌渲染。
  - **Markdown** 渲染成排版页面，支持「源码 / 渲染」切换。
  - **CSV / TSV** 渲染成表格，可切回源码。

**安全**
- Markdown 预览经 DOMPurify 净化，链接走系统浏览器而非劫持应用导航——任意来源的文件都能安全预览。

## v1.2.0

### English

- Cross-platform: added **Windows x64 / ARM64** builds alongside macOS (Apple Silicon).
- Built-in terminal: color themes (Default Dark / Homebrew), font size shortcuts (`⌘/Ctrl +/-/0`, `⌘/Ctrl + wheel`), drag a file from the OS into the terminal to insert its path.
- Launch **Claude / Codex / opencode** from a project card, with a tool badge on the tab.
- File tree with lazy loading and read-only syntax-highlighted preview.

### 中文

- 跨平台：在 macOS（Apple Silicon）之外新增 **Windows x64 / ARM64** 构建。
- 内置终端：配色主题（默认深色 / Homebrew）、字号快捷键（`⌘/Ctrl +/-/0`、`⌘/Ctrl + 滚轮`）、从系统拖文件进终端插入路径。
- 项目卡片一键启动 **Claude / Codex / opencode**，标签上有工具色标。
- 文件树（懒加载）+ 只读语法高亮预览。
