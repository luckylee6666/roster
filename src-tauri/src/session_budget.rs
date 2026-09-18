//! 会话体积预算：把各家 CLI 会话在磁盘上的体积换算成估算 token，并给出三档状态。
//!
//! 只读不写：列表用它给会话标体积与档位，续接前的提示与拦截也用它，**不改任何用户数据**。
//!
//! 窗口是登记值，每条都写清出处：
//! - `codex` 272 000 来自本机 `~/.codex/models_cache.json` 的 `context_window`（5 个模型一致；
//!   `max_context_window` 872 000 需要实验特性，不按它算）。
//! - `cmd` 1 048 576 来自它对超窗请求自己回的 400 原文（`maximum context length is 1048576
//!   tokens`，2026-09-18 实见）。
//! - `claude` 与 `lib.rs` 的 `DEFAULT_CONTEXT_WINDOW` 保持一致（当前默认模型是 1M 档；老的
//!   200k 模型最多少提示，不会误拦）。
//! - 其余（grok / agy / qwen / opencode / mimo）本机没有可读的窗口证据，取保守默认：
//!   **宁可早提示**——真实窗口比登记值大时只是多一条提示，不会改变任何行为。
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
}

const BUDGETS: [ProviderBudget; 8] = [
    ProviderBudget {
        id: "claude",
        window: 1_000_000,
        bytes_per_token: DEFAULT_BYTES_PER_TOKEN,
    },
    ProviderBudget {
        id: "codex",
        window: 272_000,
        bytes_per_token: DEFAULT_BYTES_PER_TOKEN,
    },
    ProviderBudget {
        id: "cmd",
        window: 1_048_576,
        bytes_per_token: DEFAULT_BYTES_PER_TOKEN,
    },
    ProviderBudget {
        id: "grok",
        window: 256_000,
        bytes_per_token: DEFAULT_BYTES_PER_TOKEN,
    },
    ProviderBudget {
        id: "agy",
        window: 1_000_000,
        bytes_per_token: DEFAULT_BYTES_PER_TOKEN,
    },
    ProviderBudget {
        id: "qwen",
        window: 256_000,
        bytes_per_token: DEFAULT_BYTES_PER_TOKEN,
    },
    ProviderBudget {
        id: "opencode",
        window: 200_000,
        bytes_per_token: DEFAULT_BYTES_PER_TOKEN,
    },
    ProviderBudget {
        id: "mimo",
        window: 200_000,
        bytes_per_token: DEFAULT_BYTES_PER_TOKEN,
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
}

impl SessionBudget {
    pub fn unknown() -> Self {
        Self {
            size_bytes: 0,
            est_tokens: 0,
            window: 0,
            band: BAND_UNKNOWN,
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
        Self {
            size_bytes,
            est_tokens,
            window,
            band,
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
    }
}
