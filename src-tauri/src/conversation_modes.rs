//! 每家 CLI 自己的权限模式。
//!
//! Roster 不再用一个二元开关去映射各家策略——那是有损的，而且实测证明同名不
//! 等于同行为（Grok 的 `acceptEdits` 在无头下根本无法自我批准）。这里把各家原
//! 生的档位原样登记下来，前端只传模式 ID，认不认由这份白名单说了算。
//!
//! 收录标准有两条：
//! 1. 必须在无头（`--print` / `run` / app-server）下实测能跑通，需要 TTY 交互
//!    才能应答的档不收——没人应答只会变成挂起或 `User cancelled`。
//! 2. 会完全绕过沙箱或权限检查的档不收：`bypassPermissions`、
//!    `danger-full-access`、`--dangerously-skip-permissions`、`--yolo`。

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMode {
    /// 各家 CLI 自己的取值，直接作为参数传下去。
    pub id: &'static str,
    pub label: &'static str,
    pub hint: &'static str,
    /// 这一档是否可能改动项目文件。
    pub writes: bool,
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

// Grok 的 acceptEdits 在无头下仍会发审批请求且无人应答，故不收录。
const GROK_MODES: &[ConversationMode] = &[
    mode("plan", "只读计划", "读项目、给方案，不动任何文件", false),
    mode("auto", "自动", "由 Grok 自行判断该不该动手", true),
];

// Codex 的档位用它自己的说法。「请求批准」(approvalPolicy on-request + reviewer
// user) 要人应答，无头下没人可问，等审批界面做好再放出来；「完全访问权限」属于
// 绕过档，不收。「帮我批准」把审批交给 Codex 自己的自动审核，无需人工，已用
// app-server 协议实测通过。
const CODEX_MODES: &[ConversationMode] = &[
    mode("read-only", "只读", "只能读项目，写入一律被沙箱挡下", false),
    mode(
        "approve-for-me",
        "帮我批准",
        "可改工作区；风险操作交给 Codex 自动审核，不用你逐条点",
        true,
    ),
];

const GEMINI_MODES: &[ConversationMode] = &[
    mode("plan", "只读计划", "读项目、给方案，不动任何文件", false),
    mode("auto_edit", "自动接受修改", "文件改动直接生效", true),
];

const AGY_MODES: &[ConversationMode] = &[
    mode("plan", "只读计划", "读项目、给方案，不动任何文件", false),
    mode("accept-edits", "自动接受修改", "文件改动直接生效", true),
];

const AGENT_MODES: &[ConversationMode] = &[
    mode("plan", "只读计划", "用内置 plan agent，只读不写", false),
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
        "gemini" | "qwen" => GEMINI_MODES,
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
        for provider in [
            "claude", "grok", "codex", "gemini", "qwen", "agy", "opencode", "mimo",
        ] {
            let modes = modes_for(provider);
            assert!(!modes.is_empty(), "{provider} 应该有模式表");
            assert!(!modes[0].writes, "{provider} 的第一档必须是只读");
            assert_eq!(
                resolve(provider, "").unwrap(),
                modes[0],
                "{provider} 空模式应落到最保守的一档"
            );
            assert!(
                resolve(provider, "bypassPermissions").is_err(),
                "{provider} 不得接受绕过档"
            );
            assert!(resolve(provider, "随便编的").is_err());
        }
    }

    #[test]
    fn never_exposes_trust_bypassing_modes() {
        for provider in [
            "claude", "grok", "codex", "gemini", "qwen", "agy", "opencode", "mimo",
        ] {
            for entry in modes_for(provider) {
                assert!(
                    !matches!(
                        entry.id,
                        // dontAsk 不在此列：实测它是"不问且拒绝"，与绕过相反。
                        "bypassPermissions" | "danger-full-access" | "yolo" | "workspace-write"
                    ),
                    "{provider} 暴露了绕过档或裸沙箱值 {}",
                    entry.id
                );
            }
        }
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
        assert_eq!(ids, vec!["read-only", "approve-for-me"]);
        // 「请求批准」要人应答，无头下没人可问，做出审批界面之前不许放出来。
        assert!(resolve("codex", "on-request").is_err());
        assert!(resolve("codex", "danger-full-access").is_err());
        // 裸沙箱值不是 Codex 面向用户的说法，也不该出现在选择器里。
        assert!(resolve("codex", "workspace-write").is_err());
    }

    #[test]
    fn unknown_provider_falls_back_to_read_only() {
        assert!(modes_for("nope").is_empty());
        assert!(!default_mode("nope").writes);
        assert!(!resolve("nope", "").unwrap().writes);
    }
}
