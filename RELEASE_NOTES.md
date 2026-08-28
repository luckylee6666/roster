Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.3.2 / 本版更新

This release comes out of running every registered CLI headless, one permission tier at a time, instead of trusting their documentation. Each of the seven turned out to have a real fault; four of them meant that assistant could not do useful work in the conversation workspace at all.

**English**
- **Fixed: Qwen and Gemini could never write.** Their write mode was registered as `auto_edit`, but the real value is `auto-edit` (Qwen) and `autoEdit` (Gemini) — rejected by the argument parser, so every write turn failed before the model ran. The two also shared one mode table, so both were wrong at once; they are now separate, and each mode Qwen offers was verified headless.
- **Fixed: agy failed on every turn**, and wrote into its own scratch directory. The prompt form it is given was one it refuses outright, and it was never bound to the project — agy binds registered projects, not the process working directory, so its writes landed in `~/.gemini/antigravity-cli/scratch/`.
- **Fixed: OpenCode ran in Roster's own directory.** Asked for its working directory it named the parent process's, not the selected project, and during testing it wrote a file into the Roster repository. It is now given `--dir` explicitly.
- **Fixed: Grok could not resume after switching modes.** A sandbox profile is fixed at session creation and resuming under another is refused; new sessions now pin the writable profile and resumes leave `--sandbox` off entirely.
- **Fixed: the Codex quota was missing from the header** — its per-model windows made the line long enough to collapse the cell to zero width.
- **New: Codex 「请求批准」 with an approval prompt.** It does not confirm every edit; ordinary work in the workspace is never interrupted, and it asks only when an action needs to leave the sandbox. A project waiting on approval is marked in the sidebar and raises a desktop notification, since an unanswered request blocks the whole turn.
- **New: Codex 「完全访问权限」 and Grok 「始终批准」**, each taken from that CLI's own tiers. The default stays read-only everywhere.
- Reasoning effort is filtered by the selected model, because Codex silently downgrades a level the model does not support.
- macOS builds remain **ad-hoc signed**.

**中文**
本版是把每一家已登记的 CLI 按权限档逐档拉起来实测的结果，而不是照着文档写。七家**每一家都查出了真问题**，其中四家的问题意味着那个助手在对话工作台里根本干不了活。

- **修复：Qwen 与 Gemini 的写入档从来没能用过。** 档位表写的是 `auto_edit`，而实际取值是 `auto-edit`（Qwen）和 `autoEdit`（Gemini），会被参数解析直接拒——每一次写入轮在模型开跑前就失败了。两家此前还共用一张表，等于两边都错；现已拆开，Qwen 的每一档都经过无头实测。
- **修复：agy 每一轮都失败**，而且文件写进了它自己的 scratch 目录。我们传 prompt 的写法是它明确拒绝的，而且从未绑定项目——agy 绑的是注册过的项目而不是进程工作目录，所以写入都落在 `~/.gemini/antigravity-cli/scratch/`。
- **修复：OpenCode 跑在 Roster 自己的目录里。** 问它工作目录，它报的是父进程的而不是所选项目；测试中它真的往 Roster 仓库里写了文件。现在显式传 `--dir`。
- **修复：Grok 换档后无法续接。** 沙箱 profile 在会话创建时固定，换一个续接会被拒；新会话现在固定使用可写 profile，续接一律不传 `--sandbox`。
- **修复：Codex 额度在顶栏不显示**——它按模型另报的窗口让那一行长到把格子挤成零宽。
- **新增：Codex「请求批准」及配套审批提示。** 它并不逐条确认修改，工作区内的正常读写不会打断你，只有动作要越出沙箱时才问。等待审批的项目会在侧栏标记并发桌面通知——没人回答就会挡住整轮。
- **新增：Codex「完全访问权限」与 Grok「始终批准」**，都取自各家自己的档位。所有助手的默认档仍是只读。
- 推理强度按所选模型过滤，因为 Codex 对模型不支持的档会静默降级。
- macOS 包仍使用 **adhoc 签名**。

## Install / 安装

**macOS** — the app is unsigned / 应用未签名：
1. Open the `.dmg`, drag the app into Applications / 打开 `.dmg`，把应用拖入「应用程序」
2. First launch is blocked → **System Settings → Privacy & Security** → scroll down → **Open Anyway** / 首次打开被拦 → **系统设置 → 隐私与安全性** → 滚到底 → **仍要打开**

**Windows** — unsigned, SmartScreen will warn / 未签名，会弹 SmartScreen：
1. Download the `*-setup.exe` for your architecture and run it / 下载对应架构的 `*-setup.exe` 安装
2. On the SmartScreen prompt → **More info → Run anyway** / SmartScreen 提示 → **更多信息 → 仍要运行**
3. Pick **x64** for Intel/AMD, **arm64** for Snapdragon/Surface-ARM machines / Intel/AMD 选 **x64**，骁龙/ARM Surface 选 **arm64**
