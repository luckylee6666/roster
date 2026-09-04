# Changelog

All notable changes to this project are documented here. 本项目的更新记录如下。

## Unreleased

### English

**Fixed**
- Resumed Codex conversations are ordered by the JSONL file's last activity time instead of the thread's original creation timestamp, and returning from Developer mode refreshes the conversation sidebar immediately. A long-running thread continued today no longer appears buried under weeks-old history.
- Opening the usage panel now reuses the CLI installation result already maintained at startup and on window focus instead of hiding all tabs and probing again every time. Manual Refresh shows a visible state, explicitly rechecks capabilities and installation, and bypasses each provider's normal 60-second cache. Grok now makes a real read-only billing request through the official local `grok agent stdio` ACP process (`x.ai/billing`) without creating a conversation or sending a prompt; the structured local billing log remains a stale-data fallback only when that live query fails.

### 中文

**修复**
- Codex 续接会话改按 JSONL 文件的最后活动时间排序，不再按线程首次创建时间；从开发模式切回对话模式时也会立即重读历史。今天仍在继续的长期会话不会再沉到数周前。
- 打开用量面板会直接复用应用启动和窗口聚焦时维护的 CLI 安装结果，不再每次隐藏所有标签并重复探测；手动刷新会显示明确状态，重查平台能力与安装状态，并绕过各家的普通 60 秒缓存。Grok 现在会通过官方本机 `grok agent stdio` ACP 进程真实请求 `x.ai/billing`，不创建对话、也不发送模型请求；只有实时查询失败时，才把结构化本地 billing 日志作为明确标记的旧数据兜底。

## v1.4.0

### English

**Added**
- **Grok subscription usage is now available alongside Claude and Codex.** The usage panel rechecks locally installed CLIs when opened or refreshed and hides every provider tab whose CLI is absent or whose usage backend is unavailable on the current platform. On macOS/Linux, Roster reads only the bounded, structured billing snapshot written by the official Grok CLI and shows the weekly/monthly utilization, reset time, subscription tier, data age, and an explicit stale warning. It never reads Grok credentials or calls the private billing endpoint directly. The observed log schema is beta rather than a public stable API; Windows hides Grok usage until an equivalent reparse-point-safe reader is available.

**Fixed**
- Claude terminal context percentages now prefer an explicit limit, then infer the window from the transcript model and observed usage instead of falling back to a stale fixed 200k window; canonical Opus 4.8 model ids are correctly recognized as 1M even without a suffix.
- Closing a successful cross-CLI handoff no longer recursively re-enters the handoff state sync and fails with `Maximum call stack size exceeded`; failure cleanup no longer reports the same stack overflow as a terminal-close error.

### 中文

**新增**
- **用量面板在 Claude、Codex 之外加入 Grok 订阅用量。** 打开面板或点刷新时会重新探测本机 CLI，没有安装或当前平台没有对应后端能力的 provider 标签不会显示。macOS/Linux 上，Roster 只会有界读取 Grok 官方 CLI 写下的结构化 billing 快照，显示周/月已用百分比、重置时间、订阅档位、数据年龄和明确的旧数据提示；不会读取 Grok 凭据，也不直接调用其私有账单接口。该日志结构目前属于 beta 观测而非公开稳定 API；Windows 在具备等价的 reparse-point 安全读取前会隐藏 Grok 用量。

**修复**
- Claude 终端上下文占比现在优先采用显式上限，其次按 transcript 模型和实际观测值推断，不再回退到已经过时的固定 200k 窗口；不带后缀的 Opus 4.8 canonical model id 也会正确识别为 1M。
- 成功完成跨 CLI 交接时不再递归进入交接状态同步并报 `Maximum call stack size exceeded`；异常回滚也不再把同一栈溢出连带报成终端关闭失败。

## v1.3.3

### English

**Changed**
- **Gemini has been removed.** It was the one CLI of the seven that could not be verified here — not installed, so no headless test of any tier was possible — and it was no longer needed in developer mode either. Its provider registration, permission tiers, `/model` and skill directories, history listing/preview/deletion/handoff, session parsing and resume command, registry entry and colour token are all gone. `~/.gemini/antigravity-cli/` belongs to agy, not Gemini, and is untouched; a regression test now pins that a Gemini session directory left on disk no longer appears in history while agy's history under the same parent keeps working.
- Qwen's parser no longer borrows other CLIs'. It used to fall back to the Gemini and OpenCode parsers; testing showed neither ever fires for Qwen — its stream carries only Anthropic-shaped events, has no OpenCode `part` field, and its `result` uses `subtype`/`is_error` rather than the `status` the Gemini branch checked. Had that branch ever fired it would have told a Qwen user "Gemini 处理失败".
- **The menu-bar tray no longer shows usage.** It reported only Claude's quota, which does not represent the state of someone switching between several CLIs, and a system-level menu bar is the wrong place for it. The "refresh usage" menu item and the 60-second background refresh (whose first run also triggered a keychain prompt) are gone with it. The header quota in the conversation workspace stays — it sits beside the assistant badge and belongs to that assistant.

**Fixed**
- **agy's read-only tier was never actually plan mode.** With `--disable-slash-commands` agy warns that `--mode` has no effect, and asked what mode it is in it cannot answer; without the flag it answers "规划模式". Read-only held only because agy's default tier happens not to write — a coincidence, not a guarantee. That flag exists solely to stop user text beginning with `/` from being executed as an agy command (Roster passes an unrecognised `/xxx` through as an ordinary prompt, so the risk is real), so it is now applied only when the prompt could actually be read as a command.
- Changing the model through `/model` did not drop a reasoning level the new model lacks, unlike the tuning panel. Codex accepts an unsupported level silently and downgrades it, so the setting looked applied and did nothing.
- A Codex process that died while an approval was pending left the turn hanging for up to an hour: the wait loop polled only the cancellation flag while the turn watchdog sets a different one, and no one reads stdout while waiting. It now also watches the turn timeout and the child process, and ends the turn with an explanation.
- An assistant that no longer exists could persist in local preferences — only the format of the stored id was checked, not whether it is still registered — so after Gemini's removal its last user reopened the app to a badge for an assistant that is gone.
- When all conversation slots are busy, the message no longer says "try again later" if the slots are held by turns waiting for your approval: waiting will not help, the approvals need answering.

### 中文

**变更**
- **移除 Gemini。** 它是七家里唯一无法在本机验证的一家——没有安装，任何档位都做不了无头实测——开发模式也不再需要它。provider 登记、权限档、`/model` 与 skill 目录、历史列表/预览/删除/交接、会话解析与续接命令、登记表条目与色标全部移除。`~/.gemini/antigravity-cli/` 属于 agy 而非 Gemini，未受影响；新增回归测试钉住：Gemini 的会话目录即便留在磁盘上也不再出现在历史里，而同一父目录下的 agy 历史必须继续可用。
- Qwen 的解析器不再借用别家。它此前会回退到 Gemini 与 OpenCode 两个解析器，实测这两条对 Qwen 一次都不会触发——它的流只有 Anthropic 形状的事件，没有 OpenCode 的 `part` 字段，`result` 用的是 `subtype`/`is_error` 而不是 Gemini 分支检查的 `status`。那条分支一旦真触发，还会给 Qwen 的用户报「Gemini 处理失败」。
- **菜单栏托盘不再显示用量。** 它只报 Claude 一家的额度，代表不了在多家 CLI 之间切换的实际状态，挂在系统级菜单栏里也不合适。菜单里的「刷新用量」和每 60 秒刷新的后台线程（首次运行还会触发钥匙串授权）一并去掉。会话工作台顶栏的额度保留——它紧挨着助手徽标，显示的就是那位助手自己的额度。

**修复**
- **agy 的只读档此前并不是 plan 模式。** 带 `--disable-slash-commands` 时 agy 会 warning 说 `--mode` 无效，问它处于什么模式也答不上来；不带该标志它才回答「规划模式」。只读之所以成立，只是因为 agy 默认档恰好不写文件——巧合，不是保证。该标志的唯一职责是拦住以 `/` 开头的用户文本被当成 agy 命令执行（Roster 认不出的 `/xxx` 会照常作为普通 prompt 发下去，所以风险是真的），因此现在只在 prompt 真可能被读成命令时才加。
- 通过 `/model` 换模型时没有像调音面板那样丢掉新模型不支持的推理强度。Codex 对不支持的档是静默收下再降级，于是设置看着生效、实际什么也没做。
- 等待审批期间 Codex 进程死掉，会把这一轮挂住最多一小时：等待循环只轮询取消标志，而整轮超时的看门狗设的是另一个标志，且等待期间没有人读 stdout。现在同时盯整轮超时和子进程，进程退出就结束这一轮并说明原因。
- 已不存在的助手会留在本地偏好里——存下来的 ID 只校验格式，不校验它还在不在登记表——于是 Gemini 移除后，上次用它的用户重开应用会看到一个已经没有的助手。
- 对话名额占满时，如果占着名额的是等待你批准的轮次，不再提示「稍后再试」：再等也不会好，那些审批需要你去处理。

## v1.3.2

### English

**Fixed**
- **Qwen and Gemini could never write at all.** Their write mode was registered as `auto_edit`, but the actual enum value is `auto-edit` in Qwen Code and `autoEdit` in Gemini CLI — an invalid value that the argument parser rejects outright, so every write turn failed before the model ran. The two also shared one mode table, which meant both were wrong at once; they are now separate. Qwen offers plan / auto-edit / yolo, each verified headless: `default` registers no write tools when there is nobody to approve, and `auto` hung past four minutes on two separate runs, so neither is offered. Gemini is not installed here, so only the value was corrected from its official source and no unverified mode was added.
- **agy failed on every single turn.** The prompt was passed as `-- <text>`, which agy refuses outright ("Attach the prompt to the flag"), so the process exited during argument parsing every time. It also never received `--add-dir`: agy binds to registered projects rather than the process working directory, so its file writes landed in `~/.gemini/antigravity-cli/scratch/` and never touched the user's project. Both are fixed and verified end to end.
- **OpenCode ran in Roster's own directory.** Asked to print its working directory, it answered with the parent process's — Roster's — rather than the selected project, and it wrote a file into the Roster repository during testing. Every OpenCode conversation was therefore reading and writing in whatever directory Roster was launched from. It is now given `--dir` explicitly. MiMo honours the process working directory, but is passed the same flag rather than relying on the two staying alike.
- **Grok could not resume a conversation after switching modes.** A sandbox profile is fixed when the session is created, and resuming under a different one is refused outright — `--fork-session` does not get around it, as the check runs before the fork. New sessions now pin the writable `workspace` profile and resumes omit `--sandbox` entirely, leaving `--permission-mode` to decide whether a given turn may write.
- **Codex quota did not appear in the header.** Codex reports per-model windows in addition to the account total, and the three segments together collapsed that flex cell to zero width. The header now shows only account-level windows, the detailed breakdown stays in the developer usage panel, and the cell has a width floor so an overlong value degrades to an ellipsis instead of vanishing.
- Reasoning effort is now filtered by the selected model. Codex accepts an unsupported level silently and downgrades it, so a level the current model does not have was simply ignored without saying so.
- Reset times beyond two days are given in days; a weekly window previously read as "about 156 hours 51 minutes".

**Added**
- **Codex 「请求批准」 with an approval prompt.** Verification showed this mode does not confirm each edit — ordinary work inside the workspace is never interrupted; it asks only when an action needs to leave the sandbox, such as reaching the network. The request appears above the composer with the reason and the exact command, and Allow once / Deny answer it. Because an approval blocks the whole turn, a project waiting on one is marked in the sidebar, raises a notice, and sends a desktop notification when the window is not in front; the run status says it is waiting on you rather than still working. The protocol's `acceptForSession` is not offered: its scope could not be pinned down in testing, and a permission control should not make a promise that cannot be verified.
- **Codex 「完全访问权限」**, its own `danger-full-access` tier. The default remains read-only, the mode is marked apart from ordinary write modes, and starting a turn in it is recorded in the log.
- **Grok 「始终批准」**, the Always-Approve entry from Grok's own Shift+Tab ring. It relaxes approvals only; the sandbox profile is unchanged, so it still cannot reach outside the project.
- Codex rate-limit figures pushed during a turn are stored, so refreshing the quota after a turn no longer starts a second `codex app-server`.

### 中文

**修复**
- **Qwen 与 Gemini 的写入档从来没能用过。** 档位表写的是 `auto_edit`，而实际取值在 Qwen Code 是 `auto-edit`、在 Gemini CLI 是 `autoEdit`——非法值会被参数解析直接拒，于是每一次写入轮在模型开跑之前就失败了。两家此前还共用同一张表，等于两边都错，现已拆开。Qwen 收 plan / auto-edit / yolo，每一档都无头实测过：`default` 在没人可批准时根本不注册写工具，`auto` 两次实测都四分钟以上不返回，均不收录。Gemini 本机未安装，只按官方源码把取值改对，不新增未经验证的档。
- **agy 每一轮都失败。** prompt 用 `-- <文本>` 传，而 agy 明确拒绝这种写法（"Attach the prompt to the flag"），进程在参数解析阶段就退出。它也从未收到 `--add-dir`：agy 绑定的是注册过的项目而不是进程工作目录，所以文件都写进了 `~/.gemini/antigravity-cli/scratch/`，碰不到用户项目。两处均已修复并端到端验证。
- **OpenCode 跑在 Roster 自己的目录里。** 让它打印工作目录，回答是父进程（Roster）的目录而不是所选项目，测试期间它还真往 Roster 仓库里写了文件。也就是说每一次 OpenCode 对话都在"Roster 被启动的那个目录"里读写。现在显式传 `--dir`。MiMo 实测认进程工作目录，但同样传这个参数，不把正确性押在两家行为保持一致上。
- **Grok 换档后无法续接。** 沙箱 profile 在会话创建时就固定，用另一个 profile 续接会被直接拒绝——`--fork-session` 也绕不过，因为检查发生在分叉之前。现在新会话固定使用可写的 `workspace` profile，续接一律不传 `--sandbox`，这一轮能不能写由 `--permission-mode` 决定。
- **Codex 额度在顶栏不显示。** Codex 除账号总额度外还按模型各报一份，三段拼在一起会把顶栏那一格挤成零宽。现在只显示账号级窗口，详细分档仍留在开发模式的用量面板；那一格另加了宽度下限，值过长时退化成省略号而不是整条消失。
- 推理强度按所选模型过滤。Codex 对不支持的档会静默收下并降级，此前选了当前模型没有的档，等于什么也没发生却毫无提示。
- 超过两天的重置时间改按天显示；周窗口此前会写成"约 156 小时 51 分后重置"。

**新增**
- **Codex「请求批准」及配套审批提示。** 实测这一档并不逐条确认修改——工作区内的正常读写不会打断你，只有动作需要越出沙箱（例如联网）时才问。请求会出现在输入框上方，带上理由和完整命令，由「允许一次 / 拒绝」答复。因为审批会挡住整轮，等待中的项目会在侧栏标记、弹出提示，窗口不在前台时还会发桌面通知，运行状态也会显示成在等你而不是仍在处理。协议里的 `acceptForSession` 没有放出来：测试中没能确定它的作用范围，而权限控件不该做一个无法验证的承诺。
- **Codex「完全访问权限」**，即它自己的 `danger-full-access` 档。默认档仍是只读，该档在界面上与普通写入档区分开，以该档启动的轮次会记入日志。
- **Grok「始终批准」**，取自 Grok 自己 Shift+Tab 环里的 Always-Approve。它只放开审批，不改动沙箱 profile，因此仍然改不到项目以外。
- Codex 在轮次中主动推送的限流数据会被留存，轮次结束刷新额度时不再另起一个 `codex app-server`。

## v1.3.1

### English

**Added**
- **A conversation now belongs to one assistant.** The assistant is shown as a badge in the header beside the project, not as a control in the composer — since it cannot be changed once the conversation starts, a greyed-out dropdown was the wrong shape for it. Before the first message the badge is clickable and opens the assistant picker; after that it is a plain label and **Handoff** sits next to it. Starting a new conversation asks which installed assistant to use, and once the conversation has begun the assistant is locked. Switching mid-thread was never really a switch — a session's ID, sandbox binding and history file belong to one CLI — and presenting it as a dropdown is what produced the mode and resume conflicts. To bring in another assistant there is now an explicit **Handoff**, which states that it opens a new conversation over there, carries the last 24 messages, and leaves the original session untouched.
- **The "allow writing" checkbox is gone.** It mapped a single yes/no onto seven CLIs with different permission systems, and the mapping was lossy — verification showed Grok's write path was broken twice over. In its place each assistant offers its own native modes (Claude: plan / acceptEdits / auto; Codex: read-only / workspace-write; and so on), listed by the backend, validated against a per-provider allowlist on start, and remembered per assistant. Modes that need a TTY to answer prompts are excluded because the workspace runs headless, and modes that bypass the sandbox or permission system entirely are never offered.
- **Model, reasoning effort and mode are now visible controls**, gathered into one button in the composer that reads out the current setup (`opus · high · 自动`) and opens a two-level menu — pick a row, pick a value. They were only reachable through `/model` and `/effort` before, which is no use to the people the conversation workspace is for. Each list still comes from the CLI itself, and the slash commands keep working.
- Mode options are labelled with each CLI's own value first (`plan · 只读计划`, `acceptEdits · 自动接受修改`), so what you pick is visibly the setting that CLI actually takes. Claude offers the three that differ in practice — plan, acceptEdits, auto; `manual` and `dontAsk` were checked headless and both merely refuse, so listing them would only blur the choice.
- Codex now offers its own named levels rather than raw sandbox values: **只读** and **帮我批准**, the latter routing approvals to Codex's own automatic review (`approvalPolicy: on-request` + `approvalsReviewer: auto_review`), verified against the app-server protocol. 「请求批准」 needs a human to answer and stays out until the approval UI exists; 「完全访问权限」 is a bypass tier and is never offered.
- **Fixed: Claude history could not be resumed in projects whose path contains non-ASCII characters.** Recent Claude versions encode every non-alphanumeric character in the project path as `-`, so `/杂项` becomes `---`, while Roster's own project-memory feature creates a directory using Roster's encoding. The lookup accepted that same-named but empty directory on name alone and never scanned further, so a project with real history reported "this session does not belong to the current project". It now prefers whichever directory actually holds sessions for that cwd, falling back to the name match only when no history exists anywhere.
- **Fixed: switching assistants could send another assistant's mode.** The mode list was global, so while the new assistant's list was still loading the previous one stayed selectable — picking then would store, say, Grok's `auto` under Codex and the turn was rejected on start. The list is now tagged with the assistant it belongs to, is cleared the moment the assistant changes, and a stored mode the current assistant does not have is treated as unset.
- **Fixed: Grok could not write at all.** Its `--sandbox` takes a profile name from `~/.grok/sandbox.toml`, not Codex's fixed enum, so the `workspace-write` value Roster passed made Grok refuse to start; and headless `acceptEdits` still emitted approval requests nobody could answer, ending as `User cancelled`. Write turns now use `auto` with the built-in `workspace` profile, verified end to end.
- Sessions in Recent conversations can be renamed. The alias is Roster's own layer — no CLI history file is touched — and renaming a session back to its original title drops the alias instead of storing a duplicate. The store is bounded at 500 entries and 80 characters per title, with invalid keys dropped on load.
- Recent conversations can be filtered by assistant when more than one has been used in the project; the chips carry counts and the filter hides itself when only one assistant is present.
- A first run with no projects gets three steps instead of a prompt it cannot act on, including the read-only default and where writing is granted.
- Very long replies start collapsed with a fade and an expand control that says roughly how long they are; expanding is remembered per message and streaming replies are never collapsed mid-flight.
- A failed turn now offers to retry it: the original message and its images go back into the composer, still waiting on your confirmation. The empty assistant bubble a failure used to leave behind is no longer rendered.
- The composer footer is less crowded: snippet management moved into the snippet picker as its own entry, and the send hint no longer repeats the model name that the assistant picker already shows.
- **Fixed: the header could show one assistant's quota next to another's name.** Opening a project auto-resumes its latest session, which can switch the assistant — but the quota had been fetched for the previous one and was never re-evaluated, so Claude's numbers sat beside Grok's badge. The reading now carries the assistant it belongs to and is dropped the moment that no longer matches, and opening a history refreshes the quota and mode list for the assistant it switches to. An assistant without a quota endpoint shows nothing at all.
- Rate-limit usage sits in the header right after the assistant badge — it is that assistant's property, so it belongs with its name, and the badge already says who it is, so the line just reads `5 小时 77% · 7 天 19%`. It stays quiet until it matters: it turns amber past 70% and red past 90%, adding the reset time only when it is close, and the composer says the quota is spent **before** you press Send instead of letting the CLI reject the turn. The quota also appears in the assistant badge's tooltip, so which assistant it belongs to is never ambiguous. Focusing the composer refreshes it when the reading is over a minute old — fresh when you need it, still not polling.
- The conversation sidebar shows the current assistant's rate-limit usage (Claude and Codex only, reusing the existing limit endpoints). It is fetched when the assistant or project changes and after a turn finishes, at most once every three minutes, and stays hidden when the assistant has no limit endpoint or the query fails.
- Typing `@` in the composer lists project files and inserts the project-relative path, so a request can point at an exact file without typing the path. The listing is produced in the backend from the saved project record — the frontend only sends the project ID — and the walk is bounded by depth, entry count, and result count, skips version-control, dependency, build, and hidden entries, and never follows a symlinked directory out of the project.
- Cmd/Ctrl+F searches inside the open conversation: matching messages are ringed, Enter and Shift+Enter step through them with a counter, and Esc closes and clears. Search never re-renders the Markdown, so long transcripts stay smooth.
- Stopping a turn no longer dead-ends: the notice offers to pick up where the reply stopped, filling the composer with a continuation so you still confirm before sending.
- Any conversation with content can be exported to Markdown from the Recent conversations header; the file holds only the readable transcript and is saved wherever the native dialog puts it.
- Images can now be attached by dragging them onto the composer or picking them with a button, not only by pasting. Dropped and picked files are read and validated in the backend by magic bytes, regular-file check, and an 8 MB limit; extensions are never trusted, and the four-image limit per message still applies. Drag and drop is ignored while Developer mode is on screen.
- A back-to-latest button appears over the transcript once new replies scroll out of view.
- The empty-state suggestions now follow the project: uncommitted changes, a missing project description, or recent commits each offer their own opener instead of three fixed lines.
- Keyboard shortcuts in the conversation workspace: Cmd/Ctrl+K focuses project search, Cmd/Ctrl+Shift+N starts a new conversation in the current project. Neither fires while Developer mode is on screen.
- The assistant picker is wider and carries the full model and effort in its tooltip, so long model names are no longer cut off.
- The rail's plan section is no longer Codex-only: Claude, Grok, agy, and Qwen surface their todo tool as processing steps, with the step text and a coarse status crossing the boundary and nothing of the raw tool input.
- After a turn run in a write-capable mode, the rail lists what actually changed on disk — file plus New / Modified / Deleted / Committed-or-reverted — diffed from Git before and after the turn rather than from what the CLI claimed. Git caps the listing at 20 files, and a truncated snapshot is labelled as partial.
**Tests**
- Frontend suite: 398 tests. Rust suite: 154 tests, adding the parallel-project run registry, incremental transcript rendering, message and code copy, dark-mode tokens, drag-and-drop and picked image validation, in-conversation search, project-file mentions with a bounded symlink-safe walk, the post-write change report, todo-driven plan events, retry after failure, history filtering and renaming, and first-run guidance.


### 中文

**新增**
- **一条对话固定属于一个助手。** 助手改为顶栏上项目名旁边的标识，而不是输入栏里的控件——既然开始后不能换，一个灰掉的下拉本来就是错的形状。发出第一条消息之前，点它可以换；之后它就只是个标识，「交接」紧挨在旁边。 开新对话时先问用哪个已安装的助手，对话一旦开始助手就锁定。中途"换助手"从来不是换——会话 ID、沙箱绑定和历史文件都属于某一家 CLI，把它做成下拉框正是模式错配和续接冲突的来源。要请另一位来接手，改用明确的**交接**：会说清楚它是在那边**新开一条**对话、带走最近 24 条正文，原会话保持不动。
- **去掉「允许修改项目」复选框。** 一个是非开关去映射七家各不相同的权限体系，本来就是有损的——实测证明 Grok 的写入路径是双重损坏的。改成每家列自己的原生模式（Claude：plan / acceptEdits / auto；Codex：read-only / workspace-write，其余同理），模式表由后端给出、启动时按 provider 白名单复核，并按助手分别记住。需要 TTY 应答的档不收（工作台是无头的，没人能应答），完全绕过沙箱或权限检查的档一律不提供。
- **模型、推理强度、模式变成看得见的控件**，收进输入框里同一个按钮：收起时显示当前配置（`opus · high · 自动`），展开分两层选——先点一行，再挑取值。以前只有 `/model`、`/effort` 能进，而对话模式的用户根本不会去打命令。各家的可选项仍然是从该 CLI 自己取的，斜杠命令照常可用。
- 模式选项以各家自己的取值打头（`plan · 只读计划`、`acceptEdits · 自动接受修改`），选的就是那家 CLI 真正接受的设置。Claude 列真正有区别的三档：plan、acceptEdits、auto；`manual` 与 `dontAsk` 实测在无头下都只是"拒绝"的变体，列出来只会让人分不清。
- Codex 改用它自己的档位名，而不是裸沙箱取值：**只读** 与 **帮我批准**——后者把审批交给 Codex 自己的自动审核（`approvalPolicy: on-request` + `approvalsReviewer: auto_review`），已对着 app-server 协议实测。「请求批准」需要人应答，做出审批界面之前不放出来；「完全访问权限」属绕过档，始终不提供。
- **修复：项目路径含中文时，Claude 历史无法续接。** Claude 新版把项目路径里每个非字母数字字符都编码成 `-`（`/杂项` → `---`），而 Roster 的项目记忆功能会按自己的编码建出一个同名目录。查找时只凭名字就认下了那个空目录、不再往下扫，于是明明有历史却报「这个 Claude 会话不属于当前项目」。现在优先认「里面真有这个 cwd 会话」的目录，只有哪里都没有历史时才退回名字匹配。
- **修复：换助手时可能把别家的模式发出去。** 模式表原来是全局的，新助手的表还在加载时旧表仍可选，这时改一下模式就会把比如 Grok 的 `auto` 存到 Codex 名下，启动时被拒。现在模式表带上它属于哪个助手，换助手瞬间失效，存着的档位如果当前助手没有就当作没选过。
- **修复：Grok 其实一直写不了。** 它的 `--sandbox` 收的是 `~/.grok/sandbox.toml` 里的 profile 名，不是 Codex 那种固定枚举，Roster 传的 `workspace-write` 会让 Grok 拒绝启动；而且无头下 `acceptEdits` 仍会发出没人能应答的审批请求，最终变成 `User cancelled`。写入轮改用 `auto` 配内建的 `workspace` profile，已端到端验证。
- 「最近对话」里的会话可以改名。别名是 Roster 自己的一层，不改任何 CLI 的历史文件；改回原标题等于清掉别名，不会存一条重复的。存储限 500 条、单条 80 字，加载时丢掉非法键。
- 项目里用过不止一个助手时，「最近对话」可以按助手筛选，筛选条带条数；只有一家时自动隐藏。
- 第一次打开、一个项目都没有时，空状态换成三步说明（含默认只读和在哪一步才放开写入），而不是一句用不上的提问。
- 特别长的回答默认收起，底部渐隐并给出「展开全部（约 N 千字）」；展开状态按消息记住，流式过程中不会中途折叠。
- 失败的一轮可以一键重试：原消息连同图片放回输入框，仍然由你确认后再发。失败留下的空助手气泡不再显示。
- 输入框底部不再那么挤：片段管理并进片段下拉，发送提示也不再重复助手选择器上已经写着的模型名。
- **修复：顶栏可能把一家的额度挂在另一家的名字旁边。** 点开项目会自动续接最近一条会话，这可能连带换掉助手，但额度是按上一家查的、之后没有重新判定，于是 Claude 的数字出现在 Grok 的徽标旁。现在额度带上它属于哪个助手，一旦对不上立刻作废；打开历史时也会按新助手重新取额度和模式表。没有额度接口的助手就什么都不显示。
- 限流用量放在顶栏、紧跟助手徽标——它是这家助手的属性，就该跟名字在一起；徽标已经写着是谁，所以这行只留 `5 小时 77% · 7 天 19%`。平时安静，接近上限才抢注意力：超过 70% 转暖色、超过 90% 转红并补上重置时间；额度打满时**在按下发送之前**就在输入区说清楚，而不是让 CLI 拒了才知道。额度同时挂在助手徽标的悬停说明里，「谁的额度」不会有歧义。聚焦输入框时，若数据超过一分钟会重新取一次——要新鲜，但仍然不轮询。
- 对话左栏显示当前助手的限流用量（只有 Claude 与 Codex 有，复用已有的限流接口）。切换助手、切换项目和一轮结束后才查，最快三分钟一次；助手没有限流接口或查询失败时安静地不显示。
- 输入框里打 `@` 会列出项目文件并插入项目内相对路径，指名道姓地让助手看某个文件，不用自己敲路径。清单由后端从已保存的项目记录生成（前端只传项目 ID），扫描的深度、条目数与返回数都有上限，跳过版本库、依赖、构建产物和隐藏项，并且不跟随目录符号链接走出项目。
- ⌘/Ctrl + F 在当前对话里搜索：命中的消息描边高亮，Enter / Shift + Enter 上下跳并显示第几处，Esc 关闭并清除。搜索不重新渲染 Markdown，长对话不会因此卡顿。
- 停止不再是死路：提示条上给出「接着刚才继续」，把续写指令填进输入框，仍由你确认后发送。
- 有内容的对话可以从「最近对话」标题旁一键导出成 Markdown，文件里只有能读的正文，保存位置由原生对话框决定。
- 图片除了粘贴，现在还能直接拖进输入框，或用按钮从文件里选。拖入和选中的文件由后端按魔数、普通文件和 8MB 上限校验，不认扩展名；一条消息最多四张的限制不变。停在开发模式时不接管拖放。
- 新回复滚出视野时，消息区上方出现「回到最新」按钮。
- 空状态的快捷句跟着项目现场走：有未提交改动、缺项目说明、有最近提交各自给对应的开场句，不再永远是固定三句。
- 对话工作台快捷键：⌘/Ctrl + K 聚焦项目搜索，⌘/Ctrl + Shift + N 在当前项目开新对话；停在开发模式时都不触发。
- 助手选择器加宽，并在悬停提示里给出完整模型与推理强度，长模型名不再被截断。
- 右栏的「处理步骤」不再只有 Codex 有数据：Claude、Grok、agy 与 Qwen 的待办工具会转成处理步骤，只透出步骤文字和粗粒度状态，不带任何原始工具参数。
- 用会写入的模式跑完一轮后，右栏列出磁盘上真正变化的文件，并标注新增 / 修改 / 删除 / 已提交或还原。清单来自本轮前后的 Git 对比，而不是 CLI 自己的说法；Git 最多返回 20 个文件，快照被截断时会明确标为部分。

**测试**
- 前端 398 项、Rust 154 项；新增多项目并行运行登记、消息节点复用、消息与代码复制、深色令牌、拖入与选中图片校验、对话内搜索、`@` 项目文件的有界安全扫描、写入轮改动清单、待办转处理步骤、失败重试、历史筛选与改名，以及首次使用引导。

## v1.3.0

### English

**Added**
- Added a default conversation workspace for non-developers with structured adapters for all eight locally installed assistants: Claude, Grok, Codex, OpenCode, Gemini, agy, Qwen, and MiMo Code.
- Combined all eight registered CLIs into one recent-session timeline with source badges, project-scoped preview/delete, same-provider resume, and cross-provider takeover that carries filtered conversation context without reusing incompatible session IDs.
- Brought high-frequency Developer-mode context into the conversation workspace: Git/project context, folder open and refresh, and prompt snippets.
- Added an explicit Developer mode switch that preserves the existing terminal, file, Git, multi-CLI handoff, collaboration, companion web, and game workflows.
- The conversation composer accepts pasted images (PNG/JPEG/GIF/WebP, up to 4 per message, 8 MB each) with thumbnail previews and per-image removal. Images are saved to a bounded paste directory under the app data folder and handed to the assistant as local file paths to read; Gemini receives native `@path` references instead. Thumbnails and in-message images open a full-screen preview; Esc or clicking the mask closes it.
- The conversation workspace can create projects without leaving it: a permanent “+” next to the Projects title opens a lightweight dialog with folder picker, name (auto-filled from the folder), and group input suggested from existing groups; new group names create groups on the fly.
- Every project keeps its own conversation, draft, and running turn, so a turn started in one project keeps streaming while you read or type in another. The project list marks running projects with a pulse dot, and up to four turns run in parallel, matching the backend cap.
- The run status shows live elapsed time while a turn runs and the total duration when it ends. A desktop notification arrives when the result lands in a background project, an unfocused window, or while Developer mode is on screen; the foreground conversation stays undisturbed.
- Each message exposes hover actions — copy for any message, plus “ask again” to drop a user message back into the composer without overwriting a draft — and every fenced code block gets its own copy button.

**Changed**
- Historical conversations now use a dedicated, bounded transcript reader instead of the 24-message cross-CLI handoff summary. Validated embedded screenshots are restored, and project-local image/video links render with type and path checks.
- Selecting a conversation-mode project resumes that project’s most recent CLI session; a blank chat is used only when the project has no history, or after New chat. The left-sidebar New chat CTA was removed; a quiet control now appears next to Recent conversations once a session is open.
- Assistant Markdown no longer preserves HTML source newlines as extra blank lines; list items, headings, and paragraphs use compact spacing. User bubbles still keep typed line breaks.
- Removed the first-letter project tiles and per-message CLI letter avatars. Project rows keep name and path; assistant messages keep the CLI name.
- The conversation composer now offers per-CLI slash-command hints. `/model` switches the next-turn model, `/new` starts a blank chat, and TUI-only commands stay in Developer mode.
- Slash completion is discovered live from the current project: Grok via `inspect --json`, others by scanning that CLI’s skills/commands directories. The old hardcoded command table was removed.
- `/model` now opens a live model picker for the current CLI: Grok and agy use their `models` command, Claude uses `--help` aliases, Codex reads `~/.codex/models_cache.json`, and Gemini uses `models list` when installed.
- `/effort` lists live reasoning levels for Grok, Claude, agy, and Codex, and passes `--effort` or Codex `model_reasoning_effort` on the next turn.
- The transcript reuses the DOM node of every unchanged message, so streaming re-parses only the message being written; long sessions no longer stutter and local images/videos stop flickering or restarting on each frame.
- Project groups in the conversation sidebar start collapsed the first time they appear. The group holding the current project stays open, and expand/collapse choices persist for the session.
- The conversation workspace has a dark theme. Appearance follows the system by default and the sidebar footer cycles system → light → dark, stored per install and applied before the stylesheet so there is no white flash on launch. Dark only redefines the palette tokens — every conversation colour, including the eight CLI source badges, now comes from a token on `:root`, and native controls follow via `color-scheme`. Developer mode stays light for now.
- Handing a conversation to another assistant no longer sits behind a separate “Handoff” button that only reopened the assistant dropdown. Switching the assistant while a session is open now states the consequence right above the composer — who takes over from whom, that only the last 24 messages travel, and that the source session is left untouched — with one click to switch back.

**Removed**
- Removed the project-ideas feature from both Conversation and Developer modes; existing `ideas.json` data is left untouched on disk and is no longer read or written.

**Security / reliability**
- Conversation turns use each CLI's read-only/plan policy by default, with Codex `readOnly`, Claude safe mode/customization isolation, and Grok/Gemini/agy sandbox flags. Workspace writes require an explicit per-turn toggle that resets at the terminal state; extra approvals are never granted automatically. Third-party plugins, local configuration, and network behavior remain governed by that CLI rather than an OS-level Roster sandbox.
- The backend accepts only a static provider ID, resolves its registered executable from the validated current-process PATH first and a safely quoted, time-bounded login shell only as fallback, and never accepts an executable, argument list, or cwd from the frontend. It canonicalizes project paths, verifies resumed/handoff sessions against project history, bounds protocol/output resources, scopes events to the main WebView, and cleans up complete process trees on cancellation, timeout, error, and natural completion (Unix process groups and Windows Job Objects).
- Gemini stream UUIDs are resolved back to verified project session files before reuse; structured CLI errors stop immediately; long streamed Codex replies are preserved per message item; and Codex resolves only validated executables and closes App Server stdin before graceful cleanup. Conversation deletion resolves a saved project ID in the backend; project media is opened component-by-component without following symlinks on Unix and verified against the actual opened handle on Windows. Bursty metadata rendering is coalesced while terminal events remain immediate, and destructive actions use the application confirmation dialog supported by WKWebView.

**Tests**
- Frontend suite: 370 tests. Rust suite: 142 tests, including provider routing/command/parser coverage, bounded historical transcript and symlink-safe media validation, current-PATH-first bounded CLI lookup, live slash-command discovery, Grok/Claude/Codex/agy model and effort listing, long-transcript composer containment, project-scoped deletion, process-tree cleanup, Gemini session canonicalization, atomic start reservations, completion/timeout signaling, paste-image validation/saving/pruning with per-provider prompt hints, and a fake Codex App Server contract for start, resume, approvals, long streamed replies, stdin EOF, completion, and cancellation.

### 中文

**新增**
- 新增面向普通用户的默认对话工作台，接入本机已安装的全部 8 家助手：Claude、Grok、Codex、OpenCode、Gemini、agy、Qwen 与 MiMo Code。
- 8 家已登记 CLI 的最近会话合并为一条时间线，明确显示来源色标，支持按项目预览/删除、同 CLI 续接，以及携带过滤后对话上下文的跨 CLI 接手；不会混用不兼容的会话 ID。
- 把开发模式里的高频项目能力带入对话工作台：Git/项目现场、打开文件夹和刷新、Prompt 片段。
- 新增明确的开发模式切换，原有终端、文件、Git、多 CLI 交接、协作、伴生网页和游戏流程完整保留。
- 对话输入框支持粘贴图片（PNG/JPEG/GIF/WebP，每条消息最多 4 张、单张 8MB），带缩略图预览和逐张移除；图片保存到数据目录下的有界粘贴目录，以本机路径交给助手查看，Gemini 改用原生 `@路径` 引用。缩略图和消息内图片可点击全屏预览，Esc 或点遮罩关闭。
- 对话工作台可直接新建项目：「项目」标题旁常驻「＋」，轻量弹窗里选文件夹、名称默认用文件夹名、分组可从已有分组建议或填新分组即时创建，不再强制跳去开发模式。
- 每个项目保留自己的对话、草稿和运行中的轮次：一个项目在跑时可以自由切到别的项目查看或输入，两边互不覆盖。项目列表用脉冲圆点标出正在处理的项目，最多 4 个项目并行，与后端上限一致。
- 运行中状态条实时显示已用时间，结束后显示本轮用时。结果落在后台项目、窗口失焦或人停在开发模式时会发桌面通知；当前项目且窗口在前台时不打扰。
- 每条消息 hover 出现操作：任意消息可复制，用户消息还能「重新提问」放回输入框且不覆盖已有草稿；回答里的代码块各自带复制按钮。

**变更**
- 历史对话改用独立且有边界的正文读取，不再受跨 CLI 交接摘要的 24 条上限影响；可恢复经验证的内联截图，并在路径和文件类型校验后显示项目内图片/视频。
- 对话模式点选项目会续接该项目最近一条 CLI 历史；没有历史，或点了「新对话」，才进入空白对话。左侧栏常驻「新对话」已去掉，会话打开后才在右侧「最近对话」旁显示轻量入口。
- 助手 Markdown 不再把 HTML 源码换行画成大段空白；列表、标题和段落间距收紧。用户气泡仍保留手打换行。
- 去掉项目首字方块和消息里的 CLI 字母头像。项目行只保留名称和路径，助手消息只留 CLI 名称。
- 对话输入框按当前 CLI 提供斜杠命令提示。`/model` 切换下一轮模型，`/new` 开始空白对话；仅终端可用的命令仍留在开发模式。
- 斜杠补全改为按当前项目动态发现：Grok 走 `inspect --json`，其他 CLI 扫描各自 skills/commands 目录。已去掉写死的命令表。
- `/model` 会打开当前 CLI 的模型选择器：Grok / agy 走 `models`，Claude 解析 `--help` 别名，Codex 读本机 `models_cache.json`，Gemini 在已安装时走 `models list`。
- `/effort` 覆盖 Grok、Claude、agy、Codex 的实时推理强度，下一轮带上 `--effort` 或 Codex 的 `model_reasoning_effort`。
- 消息区改为复用未变化消息的 DOM 节点，流式只重新解析正在书写的那一条；长会话不再卡顿，项目内图片/视频也不会每帧重建导致闪烁或重播。
- 对话左侧的项目分组第一次出现时默认折叠；当前项目所在的分组保持展开，用户自己的展开/收起在本次会话内保留。
- 对话工作台支持深色。默认跟随系统，左下角「外观」按钮在跟随系统 → 浅色 → 深色之间切换，选择持久保存并在样式表之前生效，启动不会闪白。深色只重定义配色令牌——对话区所有颜色（含 8 家 CLI 来源色标）都改为 `:root` 上的令牌，原生控件通过 `color-scheme` 跟随。开发模式暂时仍是浅色。
- 跨 CLI 交接不再依赖一个「点了只会重新弹开助手下拉」的「交接」按钮。会话打开时切换助手，输入框上方直接说明后果：谁接手谁、只带最近 24 条正文、来源会话保持不动，并可一键改回原助手。

**移除**
- 移除项目想法功能（对话模式与开发模式）；磁盘上已有的 `ideas.json` 数据原样保留，应用不再读写。

**安全 / 稳定性**
- 对话每轮默认使用各 CLI 的只读/计划策略：Codex 使用 `readOnly`，Claude 使用 safe mode 并隔离自定义扩展/MCP，Grok、Gemini 与 agy 启用各自 sandbox；只有本轮明确勾选后才允许写项目，进入终态立即复位。额外交互审批不会自动放行；第三方 CLI 的插件、本机配置和联网行为仍由其自身控制，并非 Roster 提供的系统级隔离。
- 后端只接受静态登记的 provider ID，优先从经校验的当前进程 PATH 解析登记命令，只在未命中时才用安全引用且有超时边界的登录壳兜底，不接受前端传入可执行文件、参数或 cwd；同时规范化项目路径、复核续接/交接会话归属、限制协议与回复资源、只向主 WebView 发事件，并在取消、超时、错误或自然完成时回收整棵进程树（Unix 进程组 / Windows Job Object）。
- Gemini 流式 UUID 会在续接前解析回已验证的项目会话文件；CLI 结构化错误会立即停止；Codex 长流式回复按消息项保留，并且只运行已验证的可执行文件、正常完成时先关闭 App Server stdin 再清理。对话删除由后端解析已保存项目 ID；Unix 下项目媒体逐级安全打开且不跟随符号链接，Windows 下按实际打开句柄复核路径。高频元数据合并渲染但终态仍立即呈现，删除统一使用 WKWebView 可用的应用内确认弹窗。

**测试**
- 前端 370 项、Rust 142 项；新增多 CLI 路由、命令与结构化解析、有界历史正文与符号链接安全媒体验证、当前 PATH 优先的有界命令定位、Grok/Claude/Codex/agy 模型与推理强度解析、长会话输入区布局边界、项目范围删除、进程树回收、Gemini 会话归一化、启动原子占位及完成/超时信号覆盖、粘贴图片校验/保存/清理与按 CLI 的图片提示，并保留 fake Codex App Server 对新建、续接、审批、长流式回复、stdin EOF、完成与取消协议的验证。

## v1.2.24

### English

**Added**
- Added per-project ideas inside the terminal: capture multiple rough thoughts, edit or archive them, and place a mature idea into the active same-project CLI input without pressing Enter.
- Expanded cross-CLI handoff to every registered CLI: any running Claude, Grok, Codex, OpenCode, Gemini, agy, Qwen, or MiMo Code tab can hand its latest project conversation to any other installed CLI while preserving the source session.

**Changed / Removed**
- Removed the global Requirements sidebar and its `requirements.json` model. Project ideas now use the isolated `ProjectIdea` model in `ideas.json`; ideas left by a removed project can be explicitly reassigned.
- Hardened idea persistence with single-flight UI mutations, executable rollback coverage, project/session revalidation, bounded backend input, duplicate-ID rejection, startup validation with recoverable bad-file backups, symlink/special-file rejection, and randomized atomic temporary files.
- Project cards and Collaborate now show only CLIs detected on the local machine, force-refresh availability when the window regains focus or Collaborate opens, and never treat a failed probe as “all installed.”
- Fixed project-idea capacity checks so every successfully saved UTF-8 JSON file remains readable after restart. Handoff now locks its modal to the active operation, validates edited drafts by UTF-8 bytes, and rejects oversized Gemini/Grok JSON before parsing.
- Fixed the handoff toolbar action being disabled by a stale or failed background CLI probe; clicking it now performs the authoritative fresh probe before showing installed targets.

**Tests**
- Frontend suite: 294 tests. Rust suite: 71 tests, plus Debug App visual verification of the project ideas and handoff flows.

### 中文

**新增**
- 终端内新增按项目隔离的「想法」：可记录多条未成形念头、持续编辑或归档，成熟后放入当前项目的 CLI 输入框且不自动回车。
- 跨 CLI 交接扩展到全部已登记工具：运行中的 Claude、Grok、Codex、OpenCode、Gemini、agy、Qwen 或 MiMo Code 都能把当前项目最新会话交给任意另一家已安装 CLI，来源会话保持不动。

**变更 / 移除**
- 移除全局「需求清单」侧栏及 `requirements.json` 模型；项目想法改用独立 `ProjectIdea` / `ideas.json`，项目删除后留下的想法可逐条明确迁入。
- 想法持久化增加单事务 UI 写入与可执行回滚覆盖、项目/会话二次校验、后端容量边界、重复 ID 拒绝、启动校验与可恢复坏文件备份、符号链接/特殊文件拒绝，以及随机原子临时文件。
- 项目卡片与「开协作」现在只显示本机探测到的 CLI；窗口重新聚焦或打开协作时强制刷新，探测失败也不再误判成“全部已安装”。
- 修复项目想法容量按字符/字节计算不一致导致保存后重启无法读回；交接进行中锁定当前操作，编辑稿按 UTF-8 字节校验，Gemini/Grok 超限 JSON 在解析前拒绝。
- 修复交接按钮会被过期或失败的后台 CLI 探测错误禁用；现在点击后再执行权威的实时探测并展示已安装目标。

**测试**
- 前端 294 项、Rust 71 项，并用独立 Debug App 完成项目想法与交接流程的真机视觉验收。

## v1.2.23

### English

**Added**
- Added Qwen and MiMo Code project history, including listing, search, preview, project-scoped deletion, recent-session restore, and explicit session resume.
- Collaborate now lets users choose one installed CLI as the brain and one or more installed CLIs as workers, and remembers the last successful combination.

**Improved / Fixed**
- Collaboration startup is transactional: it uses fresh, explicitly bound terminals and restores the previous shared files and layout if terminal launch, file commit, or final liveness validation fails.
- Fixed stale project selection during concurrent CLI probes and cleaned up collaboration state when the brain or workers exit.
- Hardened `.vibe/orchestra` access against symlink and hard-link traversal, including intermediate directories and `.gitignore`.

**Tests**
- Frontend suite: 266 tests. Rust suite: 64 tests, with strict Clippy and changed-source formatting checks.

### 中文

**新增**
- 接入 Qwen 与 MiMo Code 项目历史：支持列表、搜索、预览、按项目隔离删除、续接最近会话及指定会话续接。
- 「开协作」支持从已安装 CLI 中单选一个大脑、多选一个或多个干活终端，并记住上次成功组合。

**改进 / 修复**
- 协作启动改为事务流程：始终新开并精确绑定本轮终端；终端启动、共享文件提交或最终存活检查失败时，恢复上一场共享文件与终端布局。
- 修复 CLI 并发探测导致项目串线，以及大脑或干活终端退出后的协作状态残留。
- 加固 `.vibe/orchestra` 文件边界，拒绝目标文件、中间目录和 `.gitignore` 的符号链接及多硬链接。

**测试**
- 前端 266 项、Rust 64 项，并通过严格 Clippy 与本次 Rust 源码格式检查。

## v1.2.22

### English

**Added**
- One-click CLI launch on project cards: a login-shell probe detects which registered AI CLIs (Claude / Grok / Codex / OpenCode / Gemini / agy) are installed and shows them as colored chips on each card. Clicking one focuses the running session for that project, or resumes the latest on-disk session when none is running.

**Changed**
- Slimmer card layout: the git branch badge sits next to the project name, paths render in full and adapt to the card width (leading part elided on overflow), and CLI chips share a single footer row. Terminal tabs opened from a card or the kit are named after the project instead of the tool / session title.
- The session rail opens at maximum height by default, and dragged heights now persist reliably across launches.

**Removed**
- The floating search-style launch menu; the card chips are now the single launch entry.

**Tests**
- Coverage for the CLI registry, install probe, and launch-focus/resume flow; rail height persistence regressions.

### 中文

**新增**
- 项目卡片底部一键打开 CLI：登录壳探测本机已装的登记 AI CLI（Claude / Grok / Codex / OpenCode / Gemini / agy），以色标显示在卡片上；点击先聚焦该项目运行中的会话，没有则续接最近一次磁盘会话。

**变更**
- 卡片布局收整：分支徽标并入标题行，路径不再固定截断成 `/.../xxx`，全路径随宽度自适应（溢出裁头保尾），色标在底行一行收尾；卡片与「开一套」打开的终端标签改用项目名。
- 会话条默认顶到最大高度；拖过的高度现在能可靠记住，不再每次启动被压小。

**移除**
- 无入口的搜索式启动菜单；卡片色标成为打开 CLI 的唯一入口。

**测试**
- 登记表、安装探测、点击聚焦/续接的回归测试；会话条高度持久化测试。

## v1.2.21

### English

**Added**
- The terminal file tree now has a compact session rail under the files: running AI tabs for the current project first, then recent on-disk sessions. Click a running row to focus it; click a history row to resume. Search, preview, and delete stay on the project card. The rail height is resizable and can be collapsed on its own.

**Changed**
- The usage panel dropped the OpenCode tab. Codex now reads ChatGPT rate-limit windows from the official `codex app-server` `account/rateLimits/read` RPC (same % + reset countdown as Claude), instead of the slow `ccusage` weekly cost scan. Window labels follow the server duration, so a weekly-only Pro bucket is not forced into a fake 5-hour row.

**Tests**
- Added coverage for rail ordering, resume-vs-focus actions, height/hidden fallbacks, in-flight loading, and the tree/rail wiring.
- Added usage-panel wiring tests (Claude/Codex only, no OpenCode, no `ccusage`) and Codex rate-limit JSON parsing (weekly-only, 5h+7d, named extra buckets).

### 中文

**新增**
- 终端文件树下方增加细会话条：先列当前项目正在跑的 AI 标签，再列最近磁盘会话。点进行中的一行聚焦，点历史一行续接。搜索、预览、删除仍在项目卡片。会话条可拖高度，也可单独收起。

**变更**
- 用量面板去掉 OpenCode 标签。Codex 改为走官方 `codex app-server` 的 `account/rateLimits/read`（百分比 + 重置倒计时，和 Claude 一样），不再用慢的 `ccusage` 周花费。窗口标题按服务端时长显示，只有周窗口时不会硬画一条假的 5 小时。

**测试**
- 新增会话条排序、聚焦/续接动作、高度与收起回退、加载中不画成空，以及文件树接线的回归测试。
- 新增用量面板接线测试（只留 Claude/Codex、去掉 OpenCode 和 `ccusage`），以及 Codex 限流 JSON 解析（仅周窗口、5h+7d、具名额外桶）。

## v1.2.20

### English

**Improved**
- Replaced the generic `<>` mark with a name-tag **R** icon (sidebar, Dock, tray, `.icns` / `.ico`).
- Chrome type is larger by default (16px body). The terminal toolbar **Aa** menu sets chrome Standard / Large and the terminal size (`⌘+/-` still works).
- Removed the redundant **项目管理** header title and breadcrumb. Search sits on the left; action buttons stay on the right.

**Tests**
- Added coverage for chrome Standard / Large normalization, storage fallback, and the toolbar **Aa** menu wiring.

### 中文

**改进**
- 应用图标从通用 `<>` 换成名牌 **R**（侧栏、Dock、托盘、`.icns` / `.ico`）。
- 工作台默认字号加大（正文 16px）。终端顶栏 **Aa** 可调界面标准 / 偏大和终端字号（`⌘+/-` 仍可用）。
- 去掉顶栏重复的「项目管理」标题和面包屑。搜索靠左，操作按钮仍在右侧。

**测试**
- 新增界面字号标准 / 偏大归一化、存储失败回退，以及顶栏 **Aa** 菜单接线的回归测试。

## v1.2.19

### English

**Changed**
- The app is now **Roster**. Window title, sidebar, tray, DMG/app bundle, crate, npm package, and bundle id (`com.lucky.roster`) all use the new name.
- Data lives in `~/.roster/` (backups in `~/.roster-backups/`). The first launch copies `~/.vibe-coding-manage/` and the older Application Support directory if they still exist. Old folders are kept as a fallback.

**Tests**
- Added a config check that the product name, identifier, crate, and sidebar all say Roster.

### 中文

**变更**
- 产品更名为 **Roster**。窗口标题、侧栏、托盘、DMG/应用包、crate、npm 包名和 bundle id（`com.lucky.roster`）一并更换。
- 数据目录改为 `~/.roster/`（备份在 `~/.roster-backups/`）。首次启动会从 `~/.vibe-coding-manage/` 和更早的 Application Support 目录拷过来，旧目录保留作回退。

**测试**
- 新增产品名、identifier、crate 和侧栏都指向 Roster 的配置检查。

## v1.2.18

### English

**Added**
- A header **Proxy** switch applies `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` to newly started terminals so Claude, Codex, and Grok can use a local Clash/Surge port without TUN. SOCKS URLs go only to `ALL_PROXY`. Settings persist in `~/.vibe-coding-manage/proxy-settings.json`.

**Improved / Fixed**
- After the login shell finishes, the terminal sources a 0600 `proxy-env.sh` so `.zshrc` cannot wipe the app proxy. The header tooltip redacts credentials. Turning the switch off no longer clears inherited process environment.

**Tests**
- Added coverage for proxy URL normalization, SOCKS vs HTTP env assignment, and the header switch wiring.

### 中文

**新增**
- 顶栏 **代理** 开关：打开后新启动的终端带上 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`，Claude / Codex / Grok 可走 Clash、Surge 本地端口，不必开 TUN。`socks5://` 只写入 `ALL_PROXY`。设置保存在 `~/.vibe-coding-manage/proxy-settings.json`。

**改进 / 修复**
- 登录壳跑完后再 source 0600 的 `proxy-env.sh`，避免 `.zshrc` 冲掉代理。顶栏 tooltip 会隐藏账号密码。关掉开关不会清掉进程里原来的代理环境。

**测试**
- 新增代理地址规范化、SOCKS/HTTP 环境变量分配，以及顶栏开关接线的回归测试。

## v1.2.17

### English

**Added**
- Project cards can expand each CLI's on-disk history (Claude, Codex, Grok, OpenCode, Gemini, agy), with search, preview, delete, and a **running** badge that only matches an explicit resume/`--continue`/`resume --last` command.
- **Open a set** launches Claude + Codex + Grok in a three-pane main layout, reusing already-running tabs for that project.
- **Collaborate** opens a conductor bar: one brain plans into `.vibe/orchestra/plan.md`, the other two implement. Collaborate always starts fresh terminals; it does not inject into an in-progress chat.
- Optional **Unify memory to Claude** mounts a project `.memory` symlink to the Claude project memory store. It stays off until opted in, and never auto-creates `CLAUDE.md` / `AGENTS.md`.
- Terminal layouts now include a **main** arrangement (large left pane + two stacked right panes). Fewer visible sessions collapse instead of leaving empty holes.

**Improved / Fixed**
- History delete stays inside the current project, rejects path escape, atomically rewrites the shared agy history log, and filters Claude sessions by jsonl `cwd` when encoded directories collide.

**Tests**
- Added coverage for history search/running-tab matching, preview/delete path boundaries, Claude cwd collisions, optional memory unify, and orchestra roles/file allowlists.

### 中文

**新增**
- 项目卡片可展开各家 CLI 磁盘历史（Claude、Codex、Grok、OpenCode、Gemini、agy），支持搜索、预览、删除；**运行中**只对齐明确的续接 / `--continue` / `resume --last`，不会把「开一套」的裸启动误标成最新历史。
- **开一套**同时打开 Claude + Codex + Grok 主从三窗，并复用该项目已在跑的标签。
- **开协作**提供指挥条：一个大脑把计划写入 `.vibe/orchestra/plan.md`，另外两个动手。协作一律新开终端，不会把提示打进正在进行的对话。
- 可选 **统一记忆到 Claude**：把项目 `.memory` 链到 Claude 项目记忆目录。默认关闭，且不会自动创建 `CLAUDE.md` / `AGENTS.md`。
- 终端布局新增**主从**（左主窗 + 右上右下）；可见会话不足时收拢，不留空位。

**改进 / 修复**
- 历史删除只动当前项目、拒绝路径穿越；agy 共享日志原子替换；Claude 编码目录撞名时按 jsonl `cwd` 过滤。

**测试**
- 新增历史搜索/运行中对齐、预览删除边界、Claude cwd 撞名、可选记忆统一，以及协作角色与文件白名单的回归测试。

## v1.2.16

### English

**Added**
- The project-card launch menu now includes **Grok** (`grok`). Restored Grok tabs append `--continue` so the CLI resumes the most recent session in that directory.
- On macOS, a native `NSEvent` monitor forwards Escape into the focused terminal so vim, less, and Claude Code can receive `\x1b`. Open overlays still consume Escape first.

**Tests**
- Added coverage for native Escape forwarding, Grok session restore, and the Grok launch-menu entry.

### 中文

**新增**
- 项目卡片启动菜单新增 **Grok**（`grok`）。恢复 Grok 标签时会追加 `--continue`，按该目录续接最近一次会话。
- macOS 上通过原生 `NSEvent` 监听把 ESC 转发给当前终端，vim / less / Claude Code 可以收到 `\x1b`。已打开的弹窗和菜单仍优先消费 ESC。

**测试**
- 新增原生 ESC 转发、Grok 会话续接和启动菜单入口的回归测试。

## v1.2.15

### English

**Added**
- Terminal sessions can now be arranged as a single pane, side-by-side panes, stacked panes, or a four-pane grid. Sessions can be selected or moved between panes, and splitters resize visible panes while background sessions continue running.
- File previews and the built-in text editor now show synchronized line numbers for LF, CRLF, and CR content.
- The file-tree context menu can insert a safely quoted command for a `.sh` file into the active terminal, with Bash availability checked before use.

**Improved / Fixed**
- Dragged files and folders are routed to the terminal pane under the pointer, and visible terminals are resized with throttled fitting after layout, font, and display-scale changes.
- Concurrent terminal-close requests are deduplicated so pane and tab state stay consistent with backend session cleanup.

**Tests**
- Added regression coverage for terminal pane layout and runtime behavior, concurrent session closing, line-number generation, and shell-script command quoting and preview races.

### 中文

**新增**
- 终端会话现支持单窗、左右分屏、上下分屏和四宫格布局；可在窗格间选择或移动会话，拖动分隔线调整可见窗格大小，后台会话继续运行。
- 文件预览和内置文本编辑器新增同步行号，兼容 LF、CRLF 与 CR 换行。
- 文件树右键菜单可将 `.sh` 文件的安全转义运行命令填入当前终端，并在使用前检查 Bash 是否可用。

**改进 / 修复**
- 拖入的文件和文件夹会写入指针所在的终端窗格；布局、字号和显示缩放变化后，对可见终端进行限频尺寸适配。
- 去重并发的终端关闭请求，确保窗格、标签状态与后端会话清理保持一致。

**测试**
- 新增终端窗格布局与运行时、并发会话关闭、行号生成，以及 Shell 脚本命令转义与预览竞态的回归测试。

## v1.2.14

### English

**Fixed**
- The macOS red close button and `Cmd+Q` now exit correctly while still requiring confirmation before discarding unsaved file edits.
- File previews now reliably replace the terminal even while its WebGL renderer is actively repainting, preventing a selected file from leaving terminal output visually stuck on top.
- Keystrokes entered while a terminal session is starting are buffered and replayed in order after the startup command. Duplicate or invalid terminal session IDs are rejected, and failed session creation cleans up child processes.
- Legacy-data migration writes its completion marker only after every required copy succeeds; failed migrations keep using the legacy directory and retry on the next launch.

**Hardened**
- Daily snapshots and pre-overwrite backups are now active, and failed disk writes no longer mutate in-memory project, server, snippet, or requirement data.
- Image, PDF, and terminal-theme reads use bounded file handles to prevent oversized or changing files from causing unbounded memory use.
- Remote-terminal WebSocket frames and input are bounded, with blocking PTY writes moved off asynchronous workers.

**Tests**
- Added regression coverage for exit guards, terminal startup input ordering, migration retries, bounded binary reads, terminal ID reuse, and data backups.

### 中文

**修复**
- macOS 左上角红色关闭按钮和 `Cmd+Q` 现可正常退出，同时继续保护尚未保存的文件修改，放弃修改前必须确认。
- 文件预览在 WebGL 终端持续重绘时也会稳定显示，避免文件已选中但终端输出仍卡在预览层上方。
- 终端创建期间的键入会先缓存，并在启动命令之后按顺序发送；重复或非法会话 ID 会被拒绝，创建失败时会清理子进程。
- 旧数据迁移仅在全部所需文件复制成功后写完成标记；迁移失败时继续使用旧目录，并在下次启动重试。

**安全加固**
- 每日快照和覆盖前备份正式生效；磁盘写入失败时不再提前修改内存中的项目、服务器、片段或需求数据。
- 图片、PDF 和终端主题图片均通过同一文件句柄进行有界读取，避免超大或变化中的文件导致无界内存占用。
- 限制远程终端 WebSocket 帧及输入大小，并将阻塞的 PTY 写入移出异步工作线程。

**测试**
- 新增退出保护、终端启动输入顺序、迁移重试、有界二进制读取、终端 ID 重用和数据备份的回归测试。

## v1.2.13

### English

**Added**
- **Workspace modes**: Normal, Relax (HTTPS / localhost companion WebView), and Entertainment (Tetris / 2048).
- **Moonlit Brocade** terminal theme with layered character animation on the built-in GuoFeng artwork.
- OpenCode session restore now appends `--continue`.

**Changed**
- App data moved to `~/.vibe-coding-manage/` so cleaner apps are less likely to delete it. The first launch migrates the legacy Application Support directory.

### 中文

**新增**
- **工作区模式**：普通 / 轻松（HTTPS 或 localhost 伴生网页）/ 娱乐（俄罗斯方块 / 2048）。
- 终端主题新增中国风 **黛月华裳**，并在内置原画上叠加分层人物动效。
- OpenCode 会话恢复会追加 `--continue`。

**变更**
- 数据目录改到 `~/.vibe-coding-manage/`，降低清理软件误删概率。首次启动会迁移旧的 Application Support 目录。

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
