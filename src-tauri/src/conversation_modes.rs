//! 每家 CLI 自己的权限模式。
//!
//! Roster 不再用一个二元开关去映射各家策略——那是有损的，而且实测证明同名不
//! 等于同行为（Grok 的 `acceptEdits` 在无头下根本无法自我批准）。这里把各家原
//! 生的档位原样登记下来，前端只传模式 ID，认不认由这份白名单说了算。
//!
//! 收录标准：
//! 1. 必须在无头（`--print` / `run` / app-server）下实测能跑通，需要 TTY 交互
//!    才能应答的档不收——没人应答只会变成挂起或 `User cancelled`。
//! 2. 不替各家自造"更宽松"的档。Roster 不会用 `--dangerously-skip-permissions`、
//!    `--yolo`、OpenCode `--auto` 这类参数去绕开某一档本身的权限检查。
//! 3. 更宽松的档只登记这家 CLI 自己就摆在用户面前的那些——判据是它出现在该产品
//!    自己的模式环/档位选择里，而不是藏在一个警告性的启动参数后面。所以：
//!    - Codex 的「完全访问权限」（`danger-full-access`，`unsandboxed: true`）收，
//!      它是 Codex 自己的一档；
//!    - Grok 的 Always-Approve（CLI 拼作 `bypassPermissions`）收，它在 Grok 的
//!      Shift+Tab 环里；
//!    - Claude 的 `bypassPermissions` 不收——它不在 Claude 的 Shift+Tab 环里，
//!      要靠 `--dangerously-skip-permissions` 才能进去。
//!
//!    这类档永远不能是默认档：`default_mode` 取第一档，而每家第一档都必须只读。

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMode {
    /// 各家 CLI 自己的取值，直接作为参数传下去。
    pub id: &'static str,
    pub label: &'static str,
    pub hint: &'static str,
    /// 这一档是否可能改动项目文件。
    pub writes: bool,
    /// 这一档是否完全不开沙箱。前端据此额外提醒，别和普通写入档混为一谈。
    pub unsandboxed: bool,
}

const fn mode(
    id: &'static str,
    label: &'static str,
    hint: &'static str,
    writes: bool,
) -> ConversationMode {
    ConversationMode {
        id,
        label,
        hint,
        writes,
        unsandboxed: false,
    }
}

/// 无沙箱档。单独开一个构造器，是为了让"哪些档不受沙箱约束"在代码里一眼可数。
const fn unsandboxed_mode(
    id: &'static str,
    label: &'static str,
    hint: &'static str,
) -> ConversationMode {
    ConversationMode {
        id,
        label,
        hint,
        writes: true,
        unsandboxed: true,
    }
}

// Claude 的 --permission-mode 里真正有区别的三档。manual 与 dontAsk 在无头下
// 都只是"拒绝"的变体（实测：不挂住，直接拒），列出来只会让人分不清；
// bypassPermissions 属绕过档，不收。标签用 Claude 自己的取值打头。
const CLAUDE_MODES: &[ConversationMode] = &[
    mode(
        "plan",
        "plan · 只读计划",
        "只读取和分析，先给方案，不动任何文件",
        false,
    ),
    mode(
        "acceptEdits",
        "acceptEdits · 自动接受修改",
        "文件修改直接生效，不再逐条确认",
        true,
    ),
    mode("auto", "auto · 自动", "由 Claude 自行判断该不该动手", true),
];

// Grok 自己的 Shift+Tab 环是 Normal → Plan → Auto → Always-Approve。其中
// Normal（CLI 取值 `default`）和 acceptEdits 都要人逐条点批准，无头下没人可点，
// 实测整轮直接失败（`subtype: error_during_execution`），所以只收能跑通的三档。
// Normal 要等审批界面做出来才能放，和 Codex 的「请求批准」卡在同一件事上。
const GROK_MODES: &[ConversationMode] = &[
    mode("plan", "只读计划", "读项目、给方案，不动任何文件", false),
    mode("auto", "自动", "由 Grok 自行判断该不该动手", true),
    // Grok 环里的 Always-Approve，CLI 的 --permission-mode 拼作 bypassPermissions
    // （另有等价的 --always-approve 标志）。它只放开审批，不动沙箱：新会话仍在
    // workspace profile 里，改不到项目以外。
    mode(
        "bypassPermissions",
        "始终批准",
        "不再逐条确认工具调用；仍限制在项目工作区内，改不到项目外",
        true,
    ),
];

// Codex 的档位用它自己的说法。「请求批准」(approvalPolicy on-request + reviewer
// user) 要人应答，无头下没人可问，等审批界面做好再放出来。「帮我批准」把审批交给
// Codex 自己的自动审核，无需人工，已用 app-server 协议实测通过。
// 「完全访问权限」就是 Codex 自己的 danger-full-access：不开沙箱，能读写项目以外
// 的地方、也能联网。由用户明确选中才生效，默认仍是只读。
const CODEX_MODES: &[ConversationMode] = &[
    mode("read-only", "只读", "只能读项目，写入一律被沙箱挡下", false),
    mode(
        "approve-for-me",
        "帮我批准",
        "可改工作区；风险操作交给 Codex 自动审核，不用你逐条点",
        true,
    ),
    // 实测：这一档并不会为工作区内的正常读写打断你，只在动作要越出沙箱时才问
    // （联网、写到可写根之外等）。提示语必须照这个说，别写成"每次修改都确认"。
    mode(
        "request-approval",
        "请求批准",
        "可改工作区；要联网或越出项目时先问你一句",
        true,
    ),
    unsandboxed_mode(
        "full-access",
        "完全访问权限",
        "不开沙箱：可读写项目以外的文件、可联网，请只在信任的任务上用",
    ),
];

// Qwen 曾与 Gemini 共用一张表，但两家取值早就分叉（Qwen 是 auto-edit 连字符，
// Gemini 是 autoEdit 驼峰），共用等于两边都错。Gemini 已整体移除。
// Qwen 自己的 Shift+Tab 环遍历 APPROVAL_MODES 全部五个：
// plan → default → auto-edit → auto → yolo。实测（--sandbox --safe-mode）：
//   plan      只读，明确回"当前处于 Plan 模式（禁止任何写入）"
//   default   没人可问就不注册写工具，干不了活，和 Grok 的 Normal 同源
//   auto-edit 写入成功
//   auto      240 秒未返回，再跑一次仍然挂住——挂起比失败更糟，不收
//   yolo      写入成功
const QWEN_MODES: &[ConversationMode] = &[
    mode("plan", "只读计划", "读项目、给方案，不动任何文件", false),
    mode("auto-edit", "自动接受修改", "文件改动直接生效", true),
    // Qwen 环里的 YOLO。这是它自己的一档，不是我们额外加的 `--yolo` 绕过参数；
    // 沙箱仍由 `--sandbox` 开着（macOS 上是 seatbelt）。
    mode(
        "yolo",
        "始终批准",
        "不再逐条确认工具调用；仍在 Qwen 自己的沙箱内执行",
        true,
    ),
];

const AGY_MODES: &[ConversationMode] = &[
    mode("plan", "只读计划", "读项目、给方案，不动任何文件", false),
    mode("accept-edits", "自动接受修改", "文件改动直接生效", true),
];

// OpenCode 与 MiMo 的 plan / build 都是真实存在的 primary agent（`<cli> agent list`
// 可列出），且 plan 的只读是**权限层**的硬禁令而非提示词：源码里
// `edit: { "*": "deny" }`，描述就叫 "Plan mode. Disallows all edit tools."。
//
// 两家在这一点上有分叉，记下来免得以后误以为等价：
// - MiMo 在 user 配置合并**之后**重新追加 edit 禁令，用户配置无法放松；
// - OpenCode 是 user 最后合并，所以用户自己的 opencode 配置**可以**覆盖它。
// 另外两家都刻意没把 `bash` 纳入禁令（源码注释明说"留给模型自己的只读自觉"），
// 所以理论上能用 shell 绕过——实测两家都拒绝了这么做。
// 因此提示语只承诺能担保的那部分：编辑工具被禁用。
const AGENT_MODES: &[ConversationMode] = &[
    mode(
        "plan",
        "只读计划",
        "用内置 plan agent，编辑工具被禁用",
        false,
    ),
    mode(
        "build",
        "可改工作区",
        "用默认 build agent，可以改文件",
        true,
    ),
];

pub fn modes_for(provider: &str) -> &'static [ConversationMode] {
    match provider {
        "claude" => CLAUDE_MODES,
        "grok" => GROK_MODES,
        "codex" => CODEX_MODES,
        "qwen" => QWEN_MODES,
        "agy" => AGY_MODES,
        "opencode" | "mimo" => AGENT_MODES,
        _ => &[],
    }
}

/// 第一档永远是这家最保守的那个，空模式和未知 provider 都落到这里。
pub fn default_mode(provider: &str) -> ConversationMode {
    modes_for(provider).first().copied().unwrap_or(mode(
        "plan",
        "只读计划",
        "读项目、给方案，不动任何文件",
        false,
    ))
}

/// 不认的模式 ID 直接拒绝，不退回成"给个写入权限算了"。
pub fn resolve(provider: &str, requested: &str) -> Result<ConversationMode, String> {
    let requested = requested.trim();
    if requested.is_empty() {
        return Ok(default_mode(provider));
    }
    modes_for(provider)
        .iter()
        .find(|entry| entry.id == requested)
        .copied()
        .ok_or_else(|| format!("这个助手没有「{requested}」这个模式"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_provider_starts_read_only_and_rejects_unknown_modes() {
        for provider in ["claude", "grok", "codex", "qwen", "agy", "opencode", "mimo"] {
            let modes = modes_for(provider);
            assert!(!modes.is_empty(), "{provider} 应该有模式表");
            assert!(!modes[0].writes, "{provider} 的第一档必须是只读");
            assert_eq!(
                resolve(provider, "").unwrap(),
                modes[0],
                "{provider} 空模式应落到最保守的一档"
            );
            // 只有 Grok 的环里真有 Always-Approve 这一档；别家一律拒。
            if provider != "grok" {
                assert!(
                    resolve(provider, "bypassPermissions").is_err(),
                    "{provider} 不得接受绕过档"
                );
            }
            assert!(resolve(provider, "随便编的").is_err());
        }
    }

    #[test]
    fn never_invents_looser_modes_than_the_cli_itself_offers() {
        // 判据是"这家 CLI 自己就把它摆在用户面前"：出现在它自己的模式环里算，
        // 藏在警告性启动参数后面的不算。所以 Grok 的 Always-Approve（在它的
        // Shift+Tab 环里）收，Claude 的同名档（要 --dangerously-skip-permissions
        // 才进得去）不收。放宽这张表之前，先确认那一档真在该产品的档位选择里。
        const ALWAYS_APPROVE: &[(&str, &str)] = &[("grok", "bypassPermissions"), ("qwen", "yolo")];

        for provider in ["claude", "grok", "codex", "qwen", "agy", "opencode", "mimo"] {
            for entry in modes_for(provider) {
                let allowed = ALWAYS_APPROVE.contains(&(provider, entry.id));
                assert!(
                    allowed
                        || !matches!(
                            entry.id,
                            // 只列真正的"绕过审批"档。dontAsk 不在此列：实测它是
                            // "不问且拒绝"，与绕过相反；auto-edit / acceptEdits
                            // 这类"自动接受修改"也不在此列，它们是各家正常的写入
                            // 档，不是绕过。
                            "bypassPermissions" | "yolo" | "dangerously-skip-permissions"
                        ),
                    "{provider} 登记了靠绕过参数换来的档 {}",
                    entry.id
                );
            }
        }

        // 名单本身也要锁住：登记了这类档的必须确实有，没登记的不许偷偷冒出来。
        for (provider, id) in ALWAYS_APPROVE {
            assert!(
                modes_for(provider).iter().any(|entry| entry.id == *id),
                "{provider} 的 {id} 档已从表里消失，名单该跟着改"
            );
        }
        assert!(
            resolve("claude", "bypassPermissions").is_err(),
            "Claude 的 bypassPermissions 不在它自己的环里，不能收"
        );
    }

    #[test]
    fn qwen_uses_its_own_hyphenated_spelling() {
        // 曾经写成 `auto_edit`（下划线），yargs 的 choices 直接拒，写入档从来没能用过。
        // 官方枚举是 plan / default / auto-edit / auto / yolo。
        let qwen = modes_for("qwen")
            .iter()
            .map(|entry| entry.id)
            .collect::<Vec<_>>();
        assert_eq!(qwen, vec!["plan", "auto-edit", "yolo"]);
        assert!(resolve("qwen", "auto_edit").is_err());
        // Gemini 的驼峰拼法也不该被 Qwen 接受（两家取值本就不同，Gemini 已移除）。
        assert!(resolve("qwen", "autoEdit").is_err());
        // 实测挂住（两次都 240s+ 未返回）和无头下干不了活的档都不收。
        assert!(resolve("qwen", "auto").is_err(), "auto 实测会挂住");
        assert!(
            resolve("qwen", "default").is_err(),
            "default 无头下没有写工具"
        );
        // 已移除的 provider 不再有任何档位。
        assert!(modes_for("gemini").is_empty(), "Gemini 已整体移除");
    }

    #[test]
    fn grok_lists_the_three_modes_that_actually_run_headless() {
        // Grok 自己的环是 Normal → Plan → Auto → Always-Approve。实测无头下
        // Normal（CLI 取值 default）和 acceptEdits 都会整轮失败
        // （subtype: error_during_execution），因为没人能点批准，所以不收。
        let ids = modes_for("grok")
            .iter()
            .map(|entry| entry.id)
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["plan", "auto", "bypassPermissions"]);
        assert!(resolve("grok", "default").is_err(), "Normal 无头下跑不通");
        assert!(
            resolve("grok", "acceptEdits").is_err(),
            "无头下无法自我批准"
        );
        // 只放开审批，不动沙箱——新会话仍在 workspace profile 里。
        assert!(!resolve("grok", "bypassPermissions").unwrap().unsandboxed);
    }

    #[test]
    fn only_codex_has_an_unsandboxed_mode_and_it_is_never_the_default() {
        // 无沙箱档只登记各家自己就提供的那一个。改这条之前先想清楚：
        // 这一档下 CLI 能读写项目以外的文件，也能联网。
        for provider in ["claude", "grok", "qwen", "agy", "opencode", "mimo"] {
            assert!(
                modes_for(provider).iter().all(|entry| !entry.unsandboxed),
                "{provider} 目前不该有无沙箱档"
            );
        }
        let codex: Vec<_> = modes_for("codex")
            .iter()
            .filter(|entry| entry.unsandboxed)
            .map(|entry| entry.id)
            .collect();
        assert_eq!(codex, vec!["full-access"], "Codex 只有这一个无沙箱档");

        for provider in ["claude", "grok", "codex", "qwen", "agy", "opencode", "mimo"] {
            assert!(
                !default_mode(provider).unsandboxed,
                "{provider} 的默认档绝不能是无沙箱的"
            );
            // 空模式和不认识的模式都不许落到无沙箱档上。
            assert!(!resolve(provider, "").unwrap().unsandboxed);
            assert!(resolve(provider, "随便编的").is_err());
        }
        let entry = resolve("codex", "full-access").unwrap();
        assert!(entry.unsandboxed && entry.writes);
        assert!(!resolve("codex", "approve-for-me").unwrap().unsandboxed);
        assert!(!resolve("codex", "read-only").unwrap().unsandboxed);
        assert!(!resolve("claude", "auto").unwrap().unsandboxed);
    }

    #[test]
    fn claude_lists_its_own_permission_modes() {
        let ids = modes_for("claude")
            .iter()
            .map(|entry| entry.id)
            .collect::<Vec<_>>();
        // 只留真正有区别的三档，取值与 `claude --help` 的枚举一致。
        assert_eq!(ids, vec!["plan", "acceptEdits", "auto"]);
        // manual / dontAsk 在无头下都只是"拒绝"的变体，不进选择器。
        assert!(resolve("claude", "manual").is_err());
        assert!(resolve("claude", "dontAsk").is_err());
        assert!(resolve("claude", "bypassPermissions").is_err());
        // 标签用 Claude 自己的取值打头，不自造一套名字。
        for entry in modes_for("claude") {
            assert!(
                entry.label.starts_with(entry.id),
                "{} 的标签应以原生取值开头",
                entry.id
            );
        }
        // 无头下能自我批准写文件的只有这两档，其余按实测都是拒绝。
        let writable = modes_for("claude")
            .iter()
            .filter(|entry| entry.writes)
            .map(|entry| entry.id)
            .collect::<Vec<_>>();
        assert_eq!(writable, vec!["acceptEdits", "auto"]);
    }

    #[test]
    fn codex_uses_its_own_named_levels_not_raw_sandbox_values() {
        let ids = modes_for("codex")
            .iter()
            .map(|entry| entry.id)
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            vec![
                "read-only",
                "approve-for-me",
                "request-approval",
                "full-access"
            ]
        );
        // 前端传的是我们自己的档位 ID，协议取值由后端映射，不能直接当模式传进来。
        assert!(resolve("codex", "on-request").is_err());
        // 前端只传我们自己的档位 ID，裸沙箱值由后端映射，不能直接当模式传进来。
        assert!(resolve("codex", "danger-full-access").is_err());
        assert!(resolve("codex", "workspace-write").is_err());
    }

    #[test]
    fn unknown_provider_falls_back_to_read_only() {
        assert!(modes_for("nope").is_empty());
        assert!(!default_mode("nope").writes);
        assert!(!resolve("nope", "").unwrap().writes);
    }
}
