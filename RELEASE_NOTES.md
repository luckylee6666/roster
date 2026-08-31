Cross-platform desktop app: macOS (Apple Silicon) + Windows (x64 / ARM64)
跨平台桌面版：macOS (Apple Silicon) + Windows (x64 / ARM64)

## What's new in v1.3.3 / 本版更新

**English**
- **Gemini has been removed.** It was the one CLI of the seven that could not be verified here — not installed, so no tier could be tested headless — and developer mode no longer needed it. agy's `~/.gemini/antigravity-cli/` is a different product under the same parent directory and is untouched.
- **Fixed: agy's read-only tier was never actually plan mode.** `--disable-slash-commands` silently voids `--mode`; read-only held only because agy's default tier happens not to write. That flag now applies only when the prompt could actually be read as a command, so the tier you pick is the tier that runs.
- **Fixed: a Codex process that died while an approval was pending hung the turn for up to an hour.** The wait now watches the turn timeout and the child process and ends the turn with an explanation.
- **Fixed: changing the model through `/model`** did not drop a reasoning level the new model lacks, so the setting looked applied and did nothing — Codex downgrades an unsupported level silently.
- **Fixed: an assistant that no longer exists could persist in local preferences**, so Gemini's last user reopened the app to a badge for an assistant that is gone.
- **The menu-bar tray no longer shows usage** — it reported only Claude's quota, which does not represent someone switching between several CLIs. The header quota in the conversation workspace stays, beside the assistant it belongs to.
- macOS builds remain **ad-hoc signed**.

**中文**
- **移除 Gemini。** 它是七家里唯一无法在本机验证的一家——没有安装，任何档位都做不了无头实测——开发模式也不再需要它。agy 的 `~/.gemini/antigravity-cli/` 是同一父目录下的另一家产品，未受影响。
- **修复：agy 的只读档此前并不是 plan 模式。** `--disable-slash-commands` 会让 `--mode` 静默失效，只读之所以成立只是因为 agy 默认档恰好不写文件。该标志现在只在 prompt 真可能被读成命令时才加——你选的档位就是真正在跑的档位。
- **修复：等待审批时 Codex 进程死掉会把这一轮挂住最多一小时。** 现在同时盯整轮超时和子进程，进程退出就结束这一轮并说明原因。
- **修复：通过 `/model` 换模型**没有丢掉新模型不支持的推理强度，设置看着生效、实际什么也没做——Codex 对不支持的档是静默降级。
- **修复：已不存在的助手会留在本地偏好里**，于是 Gemini 移除后，上次用它的用户重开应用会看到一个已经没有的助手。
- **菜单栏托盘不再显示用量**——它只报 Claude 一家的额度，代表不了在多家 CLI 之间切换的实际状态。会话工作台顶栏的额度保留，紧挨着它所属的那位助手。
- macOS 包仍使用 **adhoc 签名**。

## Install / 安装

**macOS** — the app is unsigned / 应用未签名：
1. Open the `.dmg`, drag the app into Applications / 打开 `.dmg`，把应用拖入「应用程序」
2. First launch is blocked → **System Settings → Privacy & Security** → scroll down → **Open Anyway** / 首次打开被拦 → **系统设置 → 隐私与安全性** → 滚到底 → **仍要打开**

**Windows** — unsigned, SmartScreen will warn / 未签名，会弹 SmartScreen：
1. Download the `*-setup.exe` for your architecture and run it / 下载对应架构的 `*-setup.exe` 安装
2. On the SmartScreen prompt → **More info → Run anyway** / SmartScreen 提示 → **更多信息 → 仍要运行**
3. Pick **x64** for Intel/AMD, **arm64** for Snapdragon/Surface-ARM machines / Intel/AMD 选 **x64**，骁龙/ARM Surface 选 **arm64**
