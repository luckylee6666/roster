//! 会话体积预算：把各家 CLI 会话在磁盘上的体积换算成估算 token，并给出三档状态。
//!
//! 只读不写：列表用它给会话标体积与档位，续接前的提示与拦截也用它，**不改任何用户数据**。
//!
//! 窗口是登记值，每条都写清出处：
//! - `codex` 272 000 来自本机 `~/.codex/models_cache.json` 的 `context_window`（5 个模型一致；
//!   `max_context_window` 872 000 需要实验特性，不按它算）。
//! - `cmd` 1 048 576 来自它对超窗请求自己回的 400 原文（`maximum context length is 1048576
//!   tokens`，2026-09-18 实见）。
//! - `mimo` 1 000 000 来自它自己的 `mimo models` 输出（`mimo/mimo-auto — window 1M`、
//!   `xiaomi/mimo-v2.5 — window 1.05M`，取家族里最小的对话窗口；TTS 那几个 8K 不在其列）。
//!   这条是 2026-09-18 真机核对时纠正的：原先按保守默认写 200k，比实际小 5 倍，会把两条
//!   本来能跑的 MiMo 会话判成超窗。
//! - `claude` 与 `lib.rs` 的 `DEFAULT_CONTEXT_WINDOW` 保持一致（当前默认模型是 1M 档；老的
//!   200k 模型最多少提示，不会误拦）。
//! - `grok` / `agy` / `qwen` / `opencode` 本机没有可读的窗口证据（`grok models` 只列名字、
//!   `opencode models` 不给窗口、Qwen 核对时配额用尽），取保守默认：**宁可早提示**——真实
//!   窗口比登记值大时只是多一条提示，不会改变任何行为。
//!
//! `bytes_per_token` 是经验换算比，用 2026-09-18 那条 cmd 会话标定（7.15MB 文件 / 1.27M token
//! ≈ 5.6，取 6.0 略偏保守）。JSONL 结构开销与图片 base64 都会让它偏大，所以界面展示一律写
//! "估算"，不当精确值用。

use serde::Serialize;

pub const BAND_OK: &str = "ok";
pub const BAND_LONG: &str = "long";
pub const BAND_OVER: &str = "over";
/// 这家 CLI 的存储结构给不出单会话体积（例如共享一个大文件的场景）。
pub const BAND_UNKNOWN: &str = "unknown";

/// 到达窗口这个比例就先标 `long`（只要提示，不拦）。
const LONG_RATIO: f64 = 0.6;
/// 没有登记窗口时的换算比。
const DEFAULT_BYTES_PER_TOKEN: f64 = 6.0;

struct ProviderBudget {
    id: &'static str,
    window: u64,
    bytes_per_token: f64,
    /// `over` 时是否该拦（`blocks`）。只有"**磁盘上的历史就是下一轮要发的上下文**"的家才拦。
    ///
    /// 拦：`cmd`（每轮 `--session <id>` 回放整条转录，2026-09-18 实见 1.27M token 被 400 拒，
    /// 瘦身到 65 万后同一会话正常）、`mimo` / `opencode`（SQLite + ACP，加载要读整份 part 数据，
    /// 2026-09-10 有 41.9MB 会话把 CLI 与压缩一起卡死的实见）。
    ///
    /// 不拦（只提示）：`claude` / `codex` 的转录是只增日志且 CLI 自己会压缩（2026-09-18 真机核对：
    /// 本机 22MB 的 claude、210MB 的 codex 会话都在正常用）。`grok` / `agy` / `qwen` 同理暂不拦——
    /// 但**这三家没有实测依据**（grok 走 ACP 的 `noReplay`、agy 与 cmd 同属双向 JSON 但未验回放行为、
    /// qwen 核对时配额用尽），要收紧先补一次实测，别照 cmd 的样子推。
    gate: bool,
}

const BUDGETS: [ProviderBudget; 8] = [
    ProviderBudget {
        id: "claude",
        window: 1_000_000,
        bytes_per_token: DEFAULT_BYTES_PER_TOKEN,
        gate: false,
    },
    ProviderBudget {
        id: "codex",
        window: 272_000,
        bytes_per_token: DEFAULT_BYTES_PER_TOKEN,
        gate: false,
    },
    ProviderBudget {
        id: "cmd",
        window: 1_048_576,
        bytes_per_token: DEFAULT_BYTES_PER_TOKEN,
        gate: true,
    },
    ProviderBudget {
        id: "grok",
        window: 256_000,
        bytes_per_token: DEFAULT_BYTES_PER_TOKEN,
        gate: false,
    },
    ProviderBudget {
        id: "agy",
        window: 1_000_000,
        bytes_per_token: DEFAULT_BYTES_PER_TOKEN,
        gate: false,
    },
    ProviderBudget {
        id: "qwen",
        window: 256_000,
        bytes_per_token: DEFAULT_BYTES_PER_TOKEN,
        gate: false,
    },
    ProviderBudget {
        id: "opencode",
        window: 200_000,
        bytes_per_token: DEFAULT_BYTES_PER_TOKEN,
        gate: true,
    },
    ProviderBudget {
        id: "mimo",
        window: 1_000_000,
        bytes_per_token: DEFAULT_BYTES_PER_TOKEN,
        gate: true,
    },
];

/// 单条会话的体积估算。`size_bytes` 是实测值，其余都是估算。
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBudget {
    pub size_bytes: u64,
    pub est_tokens: u64,
    /// 登记的窗口；0 表示这家没有登记值。
    pub window: u64,
    pub band: &'static str,
    /// `over` 且这家"历史即上下文"时为真：续接前该拦。其余情况只提示不拦。
    pub blocks: bool,
}

impl SessionBudget {
    pub fn unknown() -> Self {
        Self {
            size_bytes: 0,
            est_tokens: 0,
            window: 0,
            band: BAND_UNKNOWN,
            blocks: false,
        }
    }

    /// 按磁盘体积给一条会话定档。体积未知（0）时返回 `unknown`，不猜。
    pub fn for_bytes(provider_id: &str, size_bytes: u64) -> Self {
        let budget = provider_budget(provider_id);
        let ratio = budget
            .map(|item| item.bytes_per_token)
            .unwrap_or(DEFAULT_BYTES_PER_TOKEN);
        let window = budget.map(|item| item.window).unwrap_or(0);
        let est_tokens = estimate_tokens(size_bytes, ratio);
        let band = if size_bytes == 0 || window == 0 {
            BAND_UNKNOWN
        } else if est_tokens >= window {
            BAND_OVER
        } else if (est_tokens as f64) >= (window as f64) * LONG_RATIO {
            BAND_LONG
        } else {
            BAND_OK
        };
        let blocks = band == BAND_OVER && budget.is_some_and(|item| item.gate);
        Self {
            size_bytes,
            est_tokens,
            window,
            band,
            blocks,
        }
    }
}

fn estimate_tokens(size_bytes: u64, bytes_per_token: f64) -> u64 {
    if size_bytes == 0 || bytes_per_token <= 0.0 {
        return 0;
    }
    (size_bytes as f64 / bytes_per_token).round() as u64
}

fn provider_budget(provider_id: &str) -> Option<&'static ProviderBudget> {
    let normalized = provider_id.trim().to_ascii_lowercase();
    BUDGETS.iter().find(|item| item.id == normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归锚点：2026-09-18 那条 cmd 会话（7.15MB）真的被 400 拒了（窗口 1 048 576），
    /// 瘦身到 4.02MB 后同一会话能正常跑完一轮——两个档位都必须复现。
    #[test]
    fn commandcode_incident_lands_in_the_right_bands() {
        let died = SessionBudget::for_bytes("cmd", 7_500_196);
        assert_eq!(died.band, BAND_OVER);
        assert!(died.est_tokens >= died.window);

        let repaired = SessionBudget::for_bytes("cmd", 4_219_398);
        assert_eq!(repaired.band, BAND_LONG);
        assert!(repaired.est_tokens < repaired.window);
    }

    #[test]
    fn small_sessions_stay_ok() {
        assert_eq!(SessionBudget::for_bytes("claude", 256 * 1024).band, BAND_OK);
        assert_eq!(SessionBudget::for_bytes("cmd", 0).band, BAND_UNKNOWN);
    }

    #[test]
    fn unknown_provider_is_never_guessed() {
        let budget = SessionBudget::for_bytes("nope", 9 * 1024 * 1024);
        assert_eq!(budget.band, BAND_UNKNOWN);
        assert_eq!(budget.window, 0);
        assert_eq!(budget.est_tokens, 9 * 1024 * 1024 / 6);
    }

    #[test]
    fn registered_providers_cover_the_canonical_set() {
        let ids = BUDGETS.map(|item| item.id);
        for id in [
            "claude", "grok", "codex", "qwen", "agy", "opencode", "mimo", "cmd",
        ] {
            assert!(ids.contains(&id), "{id} 没有登记窗口");
        }
        assert!(BUDGETS
            .iter()
            .all(|item| item.window > 0 && item.bytes_per_token > 0.0));
    }

    #[test]
    fn band_only_goes_up_with_more_bytes() {
        let order = |band: &str| match band {
            BAND_UNKNOWN => 0,
            BAND_OK => 1,
            BAND_LONG => 2,
            _ => 3,
        };
        let mut previous = 0;
        for step in 0..64 {
            let bytes = step * 256 * 1024;
            let band = SessionBudget::for_bytes("codex", bytes);
            let current = order(band.band);
            assert!(current >= previous, "{bytes} 字节的档位回落了");
            previous = current;
        }
    }

    #[test]
    fn codex_window_matches_the_local_model_catalog() {
        // ~/.codex/models_cache.json 的 context_window；改这里必须同时改注释里的出处。
        assert_eq!(provider_budget("codex").unwrap().window, 272_000);
        assert_eq!(provider_budget("CMD").unwrap().window, 1_048_576);
        // `mimo models` 自报 window 1M / 1.05M：不能被写回成 200k 那种保守猜测。
        assert_eq!(provider_budget("mimo").unwrap().window, 1_000_000);
    }

    /// 只有"历史即上下文"的家才拦。2026-09-18 真机核对：本机 22MB 的 claude、210MB 的
    /// codex 会话都在正常用，拦它们就是挡住能跑的会话；cmd / mimo / opencode 有超窗即死的实见。
    #[test]
    fn only_replay_providers_block_an_over_session() {
        for provider in ["cmd", "mimo", "opencode"] {
            let budget = SessionBudget::for_bytes(provider, 64 * 1024 * 1024);
            assert_eq!(budget.band, BAND_OVER, "{provider} 这个体积应该是 over");
            assert!(budget.blocks, "{provider} 超窗应当拦");
        }
        for provider in ["claude", "codex", "grok", "agy", "qwen"] {
            let budget = SessionBudget::for_bytes(provider, 64 * 1024 * 1024);
            assert_eq!(budget.band, BAND_OVER, "{provider} 这个体积应该是 over");
            assert!(!budget.blocks, "{provider} 只提示不拦");
        }
        // 没到窗口、或体积未知时永远不拦。
        assert!(!SessionBudget::for_bytes("cmd", 1024).blocks);
        assert!(!SessionBudget::unknown().blocks);
    }
}
