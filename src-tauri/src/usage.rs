//! 用量查询：Claude 走官方 OAuth 限流接口；Codex 走官方 `app-server` JSON-RPC；
//! Grok 读取官方 CLI 自己写下的结构化账单快照。
//!
//! Claude：一次 https 调用 `api/oauth/usage`（仅官方地址），零 Node 依赖。
//! Codex：拉起本机 `codex app-server`，握手后调用 `account/rateLimits/read`。
//! Grok：有界读取 `~/.grok/logs/unified.jsonl` 中官方
//! `billing: fetched credits config` 事件；该快照由 Grok 的真实请求和 `/usage` 更新。
//! Claude/Codex 带 60s 文件缓存，Codex 另有单飞锁，避免连点刷新堆进程。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// ============================================================================
// 通用缓存
// ============================================================================

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn cache_file(name: &str) -> PathBuf {
    crate::data_dir().join(name)
}

/// 通用文件缓存：写（带时间戳）。
fn cache_write<T: Serialize>(path: &PathBuf, data: &T) {
    let v = serde_json::json!({ "ts": now_ms(), "data": data });
    if let Ok(s) = serde_json::to_string(&v) {
        let tmp = path.with_extension("tmp");
        if std::fs::write(&tmp, s).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

/// 失败冷却：冷却窗口内直接返回上次错误，避免连点再起进程。
static LAST_FAIL: OnceLock<Mutex<HashMap<String, (u64, String)>>> = OnceLock::new();
const FAIL_COOLDOWN_MS: u64 = 15_000;

fn fail_map() -> &'static Mutex<HashMap<String, (u64, String)>> {
    LAST_FAIL.get_or_init(|| Mutex::new(HashMap::new()))
}
fn recent_failure(key: &str) -> Option<String> {
    let m = fail_map().lock().unwrap_or_else(|p| p.into_inner());
    m.get(key)
        .filter(|(ts, _)| now_ms().saturating_sub(*ts) < FAIL_COOLDOWN_MS)
        .map(|(_, err)| err.clone())
}
fn record_failure(key: &str, err: &str) {
    let mut m = fail_map().lock().unwrap_or_else(|p| p.into_inner());
    m.insert(key.to_string(), (now_ms(), err.to_string()));
}

// ============================================================================
// OAuth 用量（限流窗口）：和 Claude Code 的 /usage 同一数据源。
// 只有 Anthropic 官方地址调用标准 oauth/usage 接口；检测到自定义 API 地址时直接跳过，
// 不向未知第三方探测或发送 token。官方地址的认证优先跟随 Claude Code 配置（进程环境变量
// 或 ~/.claude/settings.json 的 env），未配置时回退 Claude Code OAuth 登录凭据。
// ============================================================================

const OFFICIAL_ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com";

fn non_empty_config_value(value: String) -> Option<String> {
    let value = value.trim().to_string();
    (!value.is_empty()).then_some(value)
}

/// 读取 Claude Code 用户 settings.json 的 env 值，不含当前进程环境变量。
pub(crate) fn claude_user_env_value(key: &str) -> Option<String> {
    let config_dir = std::env::var("CLAUDE_CONFIG_DIR")
        .ok()
        .and_then(non_empty_config_value)
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".claude")))?;
    let json = std::fs::read_to_string(config_dir.join("settings.json")).ok()?;
    let settings: Value = serde_json::from_str(&json).ok()?;
    settings
        .get("env")?
        .get(key)?
        .as_str()
        .map(str::to_string)
        .and_then(non_empty_config_value)
}

/// 读取 Claude Code 生效的 ANTHROPIC_* 配置。GUI 从访达/启动台启动时通常拿不到
/// shell 环境变量，因此还要读取 Claude Code 用户配置里的 env。
fn claude_env_value(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .and_then(non_empty_config_value)
        .or_else(|| claude_user_env_value(key))
}

/// ANTHROPIC_BASE_URL 通常是主机根地址；兼容用户误带尾部 `/v1` 或直接填写
/// 完整 usage 地址。只允许 HTTP(S)，避免把配置值解释成 curl 的其他协议。
fn oauth_usage_endpoint(base_url: &str) -> Result<String, String> {
    let mut base = base_url.trim().trim_end_matches('/');
    if !(base.starts_with("https://") || base.starts_with("http://")) {
        return Err("Claude API 地址必须以 http:// 或 https:// 开头".to_string());
    }
    if base.ends_with("/api/oauth/usage") {
        return Ok(base.to_string());
    }
    if let Some(without_v1) = base.strip_suffix("/v1") {
        base = without_v1.trim_end_matches('/');
    }
    Ok(format!("{base}/api/oauth/usage"))
}

fn configured_oauth_endpoint() -> Result<(String, bool), String> {
    let official = oauth_usage_endpoint(OFFICIAL_ANTHROPIC_BASE_URL)?;
    match claude_env_value("ANTHROPIC_BASE_URL") {
        Some(base_url) => {
            let endpoint = oauth_usage_endpoint(&base_url)?;
            let is_custom = endpoint != official;
            Ok((endpoint, is_custom))
        }
        None => Ok((official, false)),
    }
}

/// 一个限流窗口（5 小时 / 7 天）。
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct OAuthWindow {
    /// 已用百分比 0-100
    pub utilization: f64,
    /// 重置时刻（ISO8601）
    pub resets_at: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct OAuthUsage {
    pub ok: bool,
    pub error: Option<String>,
    pub five_hour: OAuthWindow,
    pub seven_day: OAuthWindow,
    pub plan: Option<String>,
    /// true = 这是过期缓存（实时请求失败时回退）
    pub stale: bool,
    /// 数据年龄（秒）。0 = 刚实时拉取。用于显示"X 分钟前更新"并判断是否冻结。
    #[serde(default)]
    pub age_secs: u64,
}

fn oauth_cache_path(endpoint: &str) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    endpoint.hash(&mut hasher);
    cache_file(&format!("oauth-usage-cache-{:016x}.json", hasher.finish()))
}

/// 读 Claude OAuth 登录凭据（仅供 Anthropic 官方地址使用）：macOS 钥匙串优先，
/// 文件存储兜底。自定义 API 地址必须配置自己的 ANTHROPIC_AUTH_TOKEN，不能转发此 token。
fn read_claude_oauth_token() -> Option<String> {
    let pick = |v: &Value| -> Option<String> {
        v.pointer("/claudeAiOauth/accessToken")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
    };
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = std::process::Command::new("/usr/bin/security")
            .args([
                "find-generic-password",
                "-s",
                "Claude Code-credentials",
                "-w",
            ])
            .output()
        {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout);
                if let Ok(v) = serde_json::from_str::<Value>(s.trim()) {
                    if let Some(t) = pick(&v) {
                        return Some(t);
                    }
                }
            }
        }
    }
    if let Some(home) = dirs::home_dir() {
        if let Ok(s) = std::fs::read_to_string(home.join(".claude").join(".credentials.json")) {
            if let Ok(v) = serde_json::from_str::<Value>(&s) {
                if let Some(t) = pick(&v) {
                    return Some(t);
                }
            }
        }
    }
    crate::log_warn!(
        "读取登录凭据失败：钥匙串未授权/无此项，且 ~/.claude/.credentials.json 不可用"
    );
    None
}

/// curl 可执行路径。GUI 应用从访达/启动台拉起时 PATH 往往极简，裸 "curl" 可能找不到，
/// 故 unix 下用绝对路径；Windows 系统自带 curl 在 PATH 里，用裸名。
fn curl_bin() -> &'static str {
    if cfg!(target_os = "windows") {
        "curl"
    } else if std::path::Path::new("/usr/bin/curl").exists() {
        "/usr/bin/curl"
    } else {
        "curl"
    }
}

/// 调用 oauth/usage 接口。token 走 curl 的 stdin 配置（-K -），不进 argv（避免 ps 泄露）。
/// 出错时尽量带出真实原因（curl stderr / HTTP 状态码 / 响应片段），便于定位"静默不更新"。
fn fetch_oauth_usage_raw(endpoint: &str, token: &str) -> Result<String, String> {
    use std::io::Write;
    use std::process::Stdio;
    let bin = curl_bin();
    let mut child = std::process::Command::new(bin)
        .args([
            "-sS",
            "--max-time",
            "15",
            "-w",
            "\n%{http_code}",
            "-K",
            "-",
            endpoint,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 curl 失败（{bin}）：{e}"))?;
    {
        let mut stdin = child.stdin.take().ok_or("无法写入 curl stdin")?;
        let cfg = format!(
            "header = \"Authorization: Bearer {token}\"\nheader = \"anthropic-beta: oauth-2025-04-20\"\nheader = \"user-agent: claude-code/2.1\"\n"
        );
        stdin
            .write_all(cfg.as_bytes())
            .map_err(|e| format!("写 curl 配置失败：{e}"))?;
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("等待 curl 失败：{e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    if !out.status.success() {
        return Err(format!(
            "curl 失败（exit {:?}）：{}",
            out.status.code(),
            stderr.trim()
        ));
    }
    let (body, code) = match stdout.rsplit_once('\n') {
        Some((b, c)) => (b.to_string(), c.trim().to_string()),
        None => (stdout.clone(), String::new()),
    };
    if code != "200" {
        let snippet: String = body.trim().chars().take(200).collect();
        return Err(format!("HTTP {code}：{snippet}"));
    }
    Ok(body)
}

fn parse_oauth_usage(json: &str) -> Result<OAuthUsage, String> {
    let v: Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    if v.get("five_hour").is_none() && v.get("seven_day").is_none() {
        let msg = v
            .get("error")
            .and_then(|e| e.get("message").or(Some(e)))
            .and_then(|x| x.as_str())
            .unwrap_or("usage API 返回异常（可能登录已过期，请在 Claude Code 重新登录）");
        return Err(msg.to_string());
    }
    let win = |key: &str| -> OAuthWindow {
        let o = v.get(key);
        OAuthWindow {
            utilization: o
                .and_then(|x| x.get("utilization"))
                .and_then(|x| x.as_f64())
                .unwrap_or(0.0),
            resets_at: o
                .and_then(|x| x.get("resets_at"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
        }
    };
    Ok(OAuthUsage {
        ok: true,
        error: None,
        five_hour: win("five_hour"),
        seven_day: win("seven_day"),
        plan: v
            .get("plan")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
        stale: false,
        age_secs: 0,
    })
}

/// 读 OAuth 缓存并返回 (数据, 年龄毫秒)。年龄用于判断新鲜度 + 显示"X 分钟前更新"。
fn read_oauth_cache_with_age(endpoint: &str) -> Option<(OAuthUsage, u64)> {
    let s = std::fs::read_to_string(oauth_cache_path(endpoint)).ok()?;
    let v: Value = serde_json::from_str(&s).ok()?;
    let ts = v.get("ts").and_then(|x| x.as_u64())?;
    let data: OAuthUsage = serde_json::from_value(v.get("data")?.clone()).ok()?;
    Some((data, now_ms().saturating_sub(ts)))
}
fn write_oauth_cache(endpoint: &str, usage: &OAuthUsage) {
    cache_write(&oauth_cache_path(endpoint), usage);
}

/// 拉 OAuth 用量。60s 文件缓存命中则秒返；否则读 token → 调 API → 写缓存。
/// 失败时回退到当前 API 地址的旧缓存，并**带上真实失败原因 + 数据年龄**（标 stale），
/// 避免把几小时前的旧值当现值静默显示。
pub fn fetch_oauth_usage() -> OAuthUsage {
    let (endpoint, is_custom_endpoint) = match configured_oauth_endpoint() {
        Ok(config) => config,
        Err(error) => {
            return OAuthUsage {
                ok: false,
                error: Some(error),
                ..Default::default()
            };
        }
    };
    if is_custom_endpoint {
        return OAuthUsage {
            ok: false,
            error: Some(
                "当前是第三方 Claude API 地址，未调用用量接口（第三方未声明支持）".to_string(),
            ),
            ..Default::default()
        };
    }
    if let Some((mut c, age)) = read_oauth_cache_with_age(&endpoint) {
        if age <= 60_000 {
            c.stale = false;
            c.age_secs = age / 1000;
            return c;
        }
    }
    let token = match claude_env_value("ANTHROPIC_AUTH_TOKEN").or_else(read_claude_oauth_token) {
        Some(token) => token,
        None => {
            let error = "未找到 Claude 登录凭据（需用 Claude Code 登录过；首次读取钥匙串会弹授权）";
            crate::log_warn!("oauth 用量：{error}，无法刷新");
            return OAuthUsage {
                ok: false,
                error: Some(error.to_string()),
                ..Default::default()
            };
        }
    };
    match fetch_oauth_usage_raw(&endpoint, &token).and_then(|j| parse_oauth_usage(&j)) {
        Ok(mut u) => {
            u.stale = false;
            u.age_secs = 0;
            let prev = read_oauth_cache_with_age(&endpoint).map(|(c, _)| {
                (
                    c.five_hour.utilization.round() as i64,
                    c.seven_day.utilization.round() as i64,
                )
            });
            let now = (
                u.five_hour.utilization.round() as i64,
                u.seven_day.utilization.round() as i64,
            );
            if prev != Some(now) {
                crate::log_info!("oauth 用量刷新：5h {}% · 周 {}%", now.0, now.1);
            }
            write_oauth_cache(&endpoint, &u);
            u
        }
        Err(e) => {
            crate::log_warn!("oauth 用量刷新失败，回退旧缓存：{e}");
            if let Some((mut c, age)) = read_oauth_cache_with_age(&endpoint) {
                c.stale = true;
                c.age_secs = age / 1000;
                c.error = Some(e);
                return c;
            }
            OAuthUsage {
                ok: false,
                error: Some(e),
                ..Default::default()
            }
        }
    }
}

// ============================================================================
// Codex 限流用量：官方 app-server JSON-RPC `account/rateLimits/read`。
// 只拉起本机已安装的 `codex`，由它自己读 ~/.codex/auth.json，Roster 不经手 token。
// ============================================================================

/// 一个 Codex 限流窗口。窗口长度以服务端 `windowDurationMins` 为准，不假设一定是 5h/7d。
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LimitWindow {
    pub label: String,
    pub utilization: f64,
    pub resets_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsage {
    pub ok: bool,
    pub error: Option<String>,
    pub plan: Option<String>,
    pub stale: bool,
    #[serde(default)]
    pub age_secs: u64,
    pub windows: Vec<LimitWindow>,
}

static CODEX_GATE: Mutex<()> = Mutex::new(());
const CODEX_CACHE_NAME: &str = "codex-usage-cache.json";
const CODEX_FAIL_KEY: &str = "codex";

fn json_number(v: Option<&Value>) -> Option<f64> {
    let v = v?;
    v.as_f64()
        .or_else(|| v.as_i64().map(|n| n as f64))
        .or_else(|| v.as_u64().map(|n| n as f64))
}

pub(crate) fn limit_window_label(mins: f64) -> String {
    if !(mins.is_finite()) || mins <= 0.0 {
        return "用量窗口".to_string();
    }
    let mins_i = mins.round() as i64;
    if mins_i <= 0 {
        return "用量窗口".to_string();
    }
    const WEEK: i64 = 60 * 24 * 7;
    const DAY: i64 = 60 * 24;
    if mins_i % WEEK == 0 {
        let weeks = mins_i / WEEK;
        return if weeks == 1 {
            "7 天窗口".to_string()
        } else {
            format!("{weeks} 周窗口")
        };
    }
    if mins_i % DAY == 0 {
        let days = mins_i / DAY;
        return if days == 1 {
            "24 小时窗口".to_string()
        } else {
            format!("{days} 天窗口")
        };
    }
    if mins_i % 60 == 0 {
        return format!("{} 小时窗口", mins_i / 60);
    }
    format!("{mins_i} 分钟窗口")
}

pub(crate) fn unix_seconds_to_iso(value: f64) -> String {
    if !(value.is_finite()) || value <= 0.0 {
        return String::new();
    }
    let secs = if value >= 1_000_000_000_000.0 {
        (value / 1000.0).round() as i64
    } else {
        value.round() as i64
    };
    chrono::DateTime::<chrono::Utc>::from_timestamp(secs, 0)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_default()
}

fn window_from_json(win: &Value, name_prefix: Option<&str>) -> Option<LimitWindow> {
    if win.is_null() {
        return None;
    }
    if !win.is_object() {
        return None;
    }
    let utilization = json_number(win.get("usedPercent")).unwrap_or(0.0);
    let mins = json_number(win.get("windowDurationMins")).unwrap_or(0.0);
    let resets = json_number(win.get("resetsAt"))
        .map(unix_seconds_to_iso)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            win.get("resetsAt")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_default();
    let base = limit_window_label(mins);
    let label = match name_prefix.map(str::trim).filter(|s| !s.is_empty()) {
        Some(name) => format!("{name} · {base}"),
        None => base,
    };
    Some(LimitWindow {
        label,
        utilization,
        resets_at: resets,
    })
}

fn push_bucket_windows(
    bucket: &Value,
    name_prefix: Option<&str>,
    out: &mut Vec<LimitWindow>,
    seen: &mut HashSet<String>,
) {
    for key in ["primary", "secondary"] {
        if let Some(win) = bucket
            .get(key)
            .and_then(|w| window_from_json(w, name_prefix))
        {
            let fingerprint = format!("{}|{:.4}|{}", win.label, win.utilization, win.resets_at);
            if seen.insert(fingerprint) {
                out.push(win);
            }
        }
    }
}

fn collect_codex_windows(result: &Value) -> Vec<LimitWindow> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    if let Some(main) = result.get("rateLimits") {
        if !main.is_null() {
            push_bucket_windows(main, None, &mut out, &mut seen);
        }
    }
    let main_id = result
        .pointer("/rateLimits/limitId")
        .and_then(|x| x.as_str());
    if let Some(map) = result
        .get("rateLimitsByLimitId")
        .and_then(|x| x.as_object())
    {
        for (id, bucket) in map {
            if main_id == Some(id.as_str()) {
                continue;
            }
            let name = bucket
                .get("limitName")
                .and_then(|x| x.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let Some(name) = name else {
                continue;
            };
            push_bucket_windows(bucket, Some(name), &mut out, &mut seen);
        }
    }
    out
}

fn parse_codex_usage(result: &Value) -> Result<CodexUsage, String> {
    if result.get("error").is_some() && result.get("rateLimits").is_none() {
        let msg = result
            .pointer("/error/message")
            .and_then(|x| x.as_str())
            .unwrap_or("Codex 限流查询失败");
        return Err(msg.to_string());
    }
    let windows = collect_codex_windows(result);
    if windows.is_empty() {
        return Err(
            "没有套餐限流数据（API Key 登录或当前账号不提供额度，请用 ChatGPT 登录 Codex）"
                .to_string(),
        );
    }
    let plan = result
        .pointer("/rateLimits/planType")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    Ok(CodexUsage {
        ok: true,
        error: None,
        plan,
        stale: false,
        age_secs: 0,
        windows,
    })
}

pub(crate) fn resolve_codex_bin() -> Result<PathBuf, String> {
    crate::cli_detect::resolve_registered_cli_bin("codex").map_err(|_| {
        "未找到安全可执行的 Codex CLI（请确认已安装 `codex`，并用 ChatGPT 登录过）".to_string()
    })
}

fn kill_child(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        let _ = std::process::Command::new("/bin/kill")
            .arg("-KILL")
            .arg(format!("-{}", child.id()))
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn fetch_codex_rate_limits_raw(bin: &Path) -> Result<Value, String> {
    use std::io::{BufRead, BufReader, Write};
    use std::process::Stdio;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Instant;

    let mut command = std::process::Command::new(bin);
    command
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("启动 Codex app-server 失败：{e}"))?;
    let mut stdin = child.stdin.take().ok_or("无法写入 Codex stdin")?;
    let stdout = child.stdout.take().ok_or("无法读取 Codex stdout")?;
    if let Some(mut stderr) = child.stderr.take() {
        thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = std::io::Read::read_to_end(&mut stderr, &mut buf);
        });
    }

    let (tx, rx) = mpsc::channel::<Result<Value, String>>();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<Value>(line) {
                        Ok(v) => {
                            if tx.send(Ok(v)).is_err() {
                                break;
                            }
                        }
                        Err(e) => {
                            let _ = tx.send(Err(format!("Codex 输出不是 JSON：{e}")));
                            break;
                        }
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(format!("读取 Codex 输出失败：{e}")));
                    break;
                }
            }
        }
    });

    let init = serde_json::json!({
        "method": "initialize",
        "id": 1,
        "params": {
            "clientInfo": {
                "name": "roster",
                "title": "Roster",
                "version": env!("CARGO_PKG_VERSION")
            }
        }
    });
    stdin
        .write_all(format!("{init}\n").as_bytes())
        .map_err(|e| {
            kill_child(&mut child);
            format!("向 Codex 写入握手失败：{e}")
        })?;
    stdin.flush().ok();

    let deadline = Instant::now() + Duration::from_secs(15);
    let mut initialized = false;
    loop {
        let remain = deadline.saturating_duration_since(Instant::now());
        if remain.is_zero() {
            kill_child(&mut child);
            return Err("查询 Codex 限流超时（codex app-server 未响应）".to_string());
        }
        match rx.recv_timeout(remain) {
            Ok(Ok(msg)) => {
                if msg.get("id") == Some(&Value::from(1)) {
                    if let Some(err) = msg.get("error") {
                        kill_child(&mut child);
                        let text = err
                            .get("message")
                            .and_then(|x| x.as_str())
                            .unwrap_or("Codex 握手失败");
                        return Err(text.to_string());
                    }
                    if msg.get("result").is_none() {
                        continue;
                    }
                    let _ = stdin.write_all(b"{\"method\":\"initialized\",\"params\":{}}\n");
                    let req = serde_json::json!({
                        "method": "account/rateLimits/read",
                        "id": 2
                    });
                    if stdin.write_all(format!("{req}\n").as_bytes()).is_err() {
                        kill_child(&mut child);
                        return Err("向 Codex 写入限流查询失败".to_string());
                    }
                    stdin.flush().ok();
                    initialized = true;
                } else if msg.get("id") == Some(&Value::from(2)) {
                    kill_child(&mut child);
                    if let Some(err) = msg.get("error") {
                        let text = err
                            .get("message")
                            .and_then(|x| x.as_str())
                            .unwrap_or("Codex 限流查询失败");
                        return Err(text.to_string());
                    }
                    return msg
                        .get("result")
                        .cloned()
                        .ok_or_else(|| "Codex 限流查询没有返回数据".to_string());
                }
            }
            Ok(Err(e)) => {
                kill_child(&mut child);
                return Err(e);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                kill_child(&mut child);
                return Err("查询 Codex 限流超时（codex app-server 未响应）".to_string());
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                kill_child(&mut child);
                if !initialized {
                    return Err(
                        "Codex app-server 已退出（请确认 `codex` 可用且已登录）".to_string()
                    );
                }
                return Err("Codex app-server 在返回限流前退出".to_string());
            }
        }
    }
}

fn read_codex_cache_with_age() -> Option<(CodexUsage, u64)> {
    let path = cache_file(CODEX_CACHE_NAME);
    let s = std::fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&s).ok()?;
    let ts = v.get("ts").and_then(|x| x.as_u64())?;
    let data: CodexUsage = serde_json::from_value(v.get("data")?.clone()).ok()?;
    Some((data, now_ms().saturating_sub(ts)))
}

fn write_codex_cache(usage: &CodexUsage) {
    cache_write(&cache_file(CODEX_CACHE_NAME), usage);
}

/// 收下 Codex app-server 在对话过程中主动推来的限流数据（`account/rateLimits/
/// updated`），直接写进用量缓存。这样每轮结束刷额度时读的就是这份新数据，
/// 不必再拉起一个 app-server 去问一遍同样的问题。
///
/// 参数是协议原样的 `params`，形状与 `account/rateLimits/read` 的结果一致。
pub fn record_codex_rate_limits(params: &Value) -> bool {
    let Some(limits) = params.get("rateLimits").filter(|value| !value.is_null()) else {
        return false;
    };
    let payload = serde_json::json!({ "rateLimits": limits.clone() });
    match parse_codex_usage(&payload) {
        Ok(mut usage) => {
            usage.stale = false;
            usage.age_secs = 0;
            write_codex_cache(&usage);
            true
        }
        Err(_) => false,
    }
}

fn fail_codex(err: String) -> CodexUsage {
    record_failure(CODEX_FAIL_KEY, &err);
    if let Some((mut c, age)) = read_codex_cache_with_age() {
        c.stale = true;
        c.age_secs = age / 1000;
        c.error = Some(err);
        return c;
    }
    CodexUsage {
        ok: false,
        error: Some(err),
        ..Default::default()
    }
}

/// 拉 Codex 限流用量。60s 缓存命中则秒返；否则单飞拉起 `codex app-server`。
pub fn fetch_codex_usage() -> CodexUsage {
    if let Some((mut c, age)) = read_codex_cache_with_age() {
        if age <= 60_000 && c.ok {
            c.stale = false;
            c.age_secs = age / 1000;
            return c;
        }
    }
    if let Some(err) = recent_failure(CODEX_FAIL_KEY) {
        if let Some((mut c, age)) = read_codex_cache_with_age() {
            c.stale = true;
            c.age_secs = age / 1000;
            c.error = Some(err);
            return c;
        }
        return CodexUsage {
            ok: false,
            error: Some(err),
            ..Default::default()
        };
    }
    let _gate = CODEX_GATE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some((mut c, age)) = read_codex_cache_with_age() {
        if age <= 60_000 && c.ok {
            c.stale = false;
            c.age_secs = age / 1000;
            return c;
        }
    }
    if let Some(err) = recent_failure(CODEX_FAIL_KEY) {
        return fail_codex(err);
    }
    let bin = match resolve_codex_bin() {
        Ok(bin) => bin,
        Err(e) => {
            crate::log_warn!("codex 用量：{e}");
            return fail_codex(e);
        }
    };
    match fetch_codex_rate_limits_raw(&bin).and_then(|v| parse_codex_usage(&v)) {
        Ok(mut u) => {
            u.stale = false;
            u.age_secs = 0;
            let summary = u
                .windows
                .iter()
                .map(|w| format!("{} {}%", w.label, w.utilization.round() as i64))
                .collect::<Vec<_>>()
                .join(" · ");
            crate::log_info!("codex 用量刷新：{summary}");
            write_codex_cache(&u);
            u
        }
        Err(e) => {
            crate::log_warn!("codex 用量刷新失败，回退旧缓存：{e}");
            fail_codex(e)
        }
    }
}

// ============================================================================
// Grok 限流用量：读取官方 Grok CLI 落下的结构化 billing 日志。
//
// Grok 1.0.13 的 `agent stdio` 尚未对外暴露源码已有的 `x.ai/billing`
// 扩展（会返回 Method not found）；`grok models` 也不会刷新 billing。真实
// Grok 请求和交互式 `/usage` 会把经过收敛的快照写入 unified.jsonl。
// Roster 不读 auth.json、不经手 token，也不通过隐藏 TUI 制造空会话。
// ============================================================================

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GrokUsage {
    pub ok: bool,
    pub error: Option<String>,
    pub plan: Option<String>,
    pub stale: bool,
    #[serde(default)]
    pub age_secs: u64,
    #[serde(default)]
    pub age_ms: u64,
    pub windows: Vec<LimitWindow>,
}

#[derive(Clone, Debug)]
struct GrokLogSnapshot {
    usage: GrokUsage,
    observed_at_ms: u64,
}

#[derive(Clone, Debug)]
struct GrokCacheEntry {
    snapshot: GrokLogSnapshot,
    cached_at_ms: u64,
}

static GROK_CACHE: OnceLock<Mutex<Option<GrokCacheEntry>>> = OnceLock::new();
const GROK_BILLING_LOG_MESSAGE: &str = "billing: fetched credits config";
const GROK_LOG_TAIL_BYTES: u64 = 1024 * 1024;
const GROK_LOG_LINE_MAX_BYTES: usize = 128 * 1024;
const GROK_FRESH_MS: u64 = 60_000;
const GROK_FUTURE_CLOCK_SKEW_MS: u64 = 5 * 60_000;

fn bounded_log_text(value: Option<&Value>, max_chars: usize) -> Option<String> {
    let value = value?.as_str()?.trim();
    if value.is_empty() {
        return None;
    }
    let text = value
        .chars()
        .filter(|ch| !ch.is_control())
        .take(max_chars)
        .collect::<String>();
    (!text.is_empty()).then_some(text)
}

fn grok_cent(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    json_number(value.get("val")).or_else(|| json_number(Some(value)))
}

fn rfc3339_ms(value: &str) -> Option<u64> {
    let millis = chrono::DateTime::parse_from_rfc3339(value)
        .ok()?
        .timestamp_millis();
    (millis >= 0).then_some(millis as u64)
}

fn grok_log_timestamp_ms(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    if let Some(text) = value.as_str() {
        return rfc3339_ms(text.trim());
    }
    json_number(Some(value)).and_then(|number| {
        if !number.is_finite() || number <= 0.0 {
            return None;
        }
        let millis = if number < 1_000_000_000_000.0 {
            number * 1000.0
        } else {
            number
        };
        Some(millis.round() as u64)
    })
}

fn normalized_grok_reset(value: Option<&Value>) -> String {
    let Some(text) = bounded_log_text(value, 128) else {
        return String::new();
    };
    if rfc3339_ms(&text).is_some() {
        text
    } else {
        String::new()
    }
}

fn grok_period_label(period_type: &str, start: &str, end: &str) -> String {
    let kind = period_type.trim().to_ascii_uppercase();
    if kind.contains("WEEKLY") {
        return "7 天窗口".to_string();
    }
    if kind.contains("MONTHLY") {
        return "月度窗口".to_string();
    }
    let duration_minutes = rfc3339_ms(start)
        .zip(rfc3339_ms(end))
        .and_then(|(start, end)| end.checked_sub(start))
        .map(|millis| millis as f64 / 60_000.0);
    duration_minutes
        .map(limit_window_label)
        .unwrap_or_else(|| "用量窗口".to_string())
}

fn grok_usage_percent(config: &Value) -> Option<f64> {
    if let Some(percent) = json_number(config.get("creditUsagePercent")) {
        return (percent.is_finite() && percent >= 0.0).then_some(percent.min(100.0));
    }
    let used = grok_cent(config.get("used"))?;
    let limit = grok_cent(config.get("monthlyLimit"))?;
    (used.is_finite() && used >= 0.0 && limit.is_finite() && limit > 0.0)
        .then_some(((used / limit) * 100.0).clamp(0.0, 100.0))
}

fn parse_grok_billing_event(event: &Value, now: u64) -> Result<GrokLogSnapshot, String> {
    if event.get("msg").and_then(Value::as_str) != Some(GROK_BILLING_LOG_MESSAGE) {
        return Err("不是 Grok billing 快照".to_string());
    }
    let observed_at_ms = grok_log_timestamp_ms(event.get("ts"))
        .ok_or_else(|| "Grok 用量快照缺少有效时间".to_string())?;
    if observed_at_ms > now.saturating_add(GROK_FUTURE_CLOCK_SKEW_MS) {
        return Err("Grok 用量快照时间明显晚于本机时间".to_string());
    }
    let ctx = event
        .get("ctx")
        .and_then(Value::as_object)
        .ok_or_else(|| "Grok 用量快照缺少 ctx".to_string())?;
    let config = ctx
        .get("config")
        .filter(|value| value.is_object())
        .ok_or_else(|| "当前 Grok 登录没有返回订阅用量".to_string())?;
    let utilization =
        grok_usage_percent(config).ok_or_else(|| "Grok 用量快照缺少有效百分比".to_string())?;
    let current_period = config
        .get("currentPeriod")
        .filter(|value| value.is_object());
    let period_type = bounded_log_text(current_period.and_then(|p| p.get("type")), 64)
        .unwrap_or_else(|| {
            if config.get("monthlyLimit").is_some() {
                "USAGE_PERIOD_TYPE_MONTHLY".to_string()
            } else {
                String::new()
            }
        });
    let period_start = bounded_log_text(
        current_period
            .and_then(|p| p.get("start"))
            .or_else(|| config.get("billingPeriodStart")),
        128,
    )
    .unwrap_or_default();
    let period_end = bounded_log_text(
        current_period
            .and_then(|p| p.get("end"))
            .or_else(|| config.get("billingPeriodEnd")),
        128,
    )
    .unwrap_or_default();
    let resets_at = normalized_grok_reset(
        current_period
            .and_then(|p| p.get("end"))
            .or_else(|| config.get("billingPeriodEnd")),
    );
    let plan = bounded_log_text(ctx.get("subscriptionTier"), 128);
    Ok(GrokLogSnapshot {
        usage: GrokUsage {
            ok: true,
            error: None,
            plan,
            stale: false,
            age_secs: now.saturating_sub(observed_at_ms) / 1000,
            age_ms: now.saturating_sub(observed_at_ms),
            windows: vec![LimitWindow {
                label: grok_period_label(&period_type, &period_start, &period_end),
                utilization,
                resets_at,
            }],
        },
        observed_at_ms,
    })
}

fn parse_grok_usage_log(text: &str, now: u64) -> Result<GrokLogSnapshot, String> {
    for line in text.lines().rev() {
        // Rust str::len() 返回 UTF-8 字节数，与常量的字节语义一致。
        if line.len() > GROK_LOG_LINE_MAX_BYTES {
            if line.contains(GROK_BILLING_LOG_MESSAGE) {
                return Err("最新 Grok 用量快照超过单行上限".to_string());
            }
            continue;
        }
        let event = match serde_json::from_str::<Value>(line) {
            Ok(event) => event,
            Err(_) if line.contains(GROK_BILLING_LOG_MESSAGE) => {
                return Err("最新 Grok 用量快照已损坏".to_string())
            }
            Err(_) => continue,
        };
        if event.get("msg").and_then(Value::as_str) == Some(GROK_BILLING_LOG_MESSAGE) {
            return parse_grok_billing_event(&event, now);
        }
    }
    Err("没有找到 Grok 用量快照（请先运行 `grok login`）".to_string())
}

fn read_open_file_tail_bounded(mut file: std::fs::File, max_bytes: u64) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};

    let metadata = file
        .metadata()
        .map_err(|_| "无法读取 Grok 用量日志属性".to_string())?;
    if !metadata.is_file() {
        return Err("Grok 用量日志不是普通文件".to_string());
    }
    let truncated = metadata.len() > max_bytes;
    if truncated {
        // 多读偏移前一个字节：若它正好是换行，说明 max_bytes 已从完整行开头
        // 起读，不能再误删第一条完整记录；否则丢弃首个半行残片。
        file.seek(SeekFrom::Start(metadata.len() - max_bytes - 1))
            .map_err(|_| "无法定位 Grok 用量日志尾部".to_string())?;
    }
    let mut bytes = Vec::with_capacity(max_bytes.min(16 * 1024) as usize);
    (&mut file)
        .take(max_bytes + if truncated { 2 } else { 1 })
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取 Grok 用量日志".to_string())?;
    if file.metadata().map(|current| current.len()).ok() != Some(metadata.len()) {
        return Err("Grok 用量日志读取期间发生变化，请重试".to_string());
    }
    let expected_max = max_bytes + u64::from(truncated);
    if bytes.len() as u64 > expected_max {
        return Err("Grok 用量日志读取期间增长过快，请重试".to_string());
    }
    if truncated {
        let start = if bytes.first() == Some(&b'\n') {
            1
        } else {
            bytes
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|index| index + 1)
                .unwrap_or(bytes.len())
        };
        bytes.drain(..start);
    }
    String::from_utf8(bytes).map_err(|_| "Grok 用量日志不是 UTF-8".to_string())
}

#[cfg(unix)]
fn open_unix_directory_path_nofollow(path: &Path) -> Result<std::fs::File, String> {
    use std::ffi::CString;
    use std::fs::OpenOptions;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::OpenOptionsExt;
    use std::path::Component;

    if !path.is_absolute() {
        return Err("GROK_HOME 必须能解析为绝对路径".to_string());
    }
    let mut current = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC)
        .open("/")
        .map_err(|_| "无法打开文件系统根目录".to_string())?;
    for component in path.components() {
        let Component::Normal(name) = component else {
            if matches!(component, Component::RootDir | Component::CurDir) {
                continue;
            }
            return Err("GROK_HOME 含不安全路径组件".to_string());
        };
        let name =
            CString::new(name.as_bytes()).map_err(|_| "GROK_HOME 含非法路径组件".to_string())?;
        // SAFETY: current 是已打开的目录 fd，name 是无 NUL 的单个路径组件。
        let fd = unsafe {
            libc::openat(
                current.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY
                    | libc::O_DIRECTORY
                    | libc::O_NOFOLLOW
                    | libc::O_CLOEXEC
                    | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            return Err("GROK_HOME 含符号链接、不是目录或无法打开".to_string());
        }
        // SAFETY: openat 成功返回新的 owned fd，交给 File 负责关闭。
        current = unsafe { std::fs::File::from_raw_fd(fd) };
    }
    Ok(current)
}

#[cfg(unix)]
fn open_grok_log_file(home: &Path) -> Result<std::fs::File, String> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::MetadataExt;

    let root = open_unix_directory_path_nofollow(home)?;
    let open_at = |parent: &std::fs::File, name: &str, flags: libc::c_int| {
        let name = CString::new(name).map_err(|_| "Grok 用量日志路径无效".to_string())?;
        // SAFETY: parent 是已打开的目录句柄，name 是固定、无 NUL 的单个路径组件；
        // 返回值成功时是一个新的 owned fd。
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            Err("Grok 用量日志路径含符号链接或无法打开".to_string())
        } else {
            // SAFETY: openat 成功返回新的 owned fd，交给 File 负责关闭。
            Ok(unsafe { std::fs::File::from_raw_fd(fd) })
        }
    };
    let logs = open_at(&root, "logs", libc::O_RDONLY | libc::O_DIRECTORY)?;
    let file = open_at(&logs, "unified.jsonl", libc::O_RDONLY)?;
    let metadata = file
        .metadata()
        .map_err(|_| "无法读取 Grok 用量日志属性".to_string())?;
    if !metadata.is_file() {
        return Err("Grok 用量日志不是普通文件".to_string());
    }
    if metadata.nlink() != 1 {
        return Err("Grok 用量日志不能有多个硬链接".to_string());
    }
    Ok(file)
}

#[cfg(windows)]
fn open_grok_log_file(_home: &Path) -> Result<std::fs::File, String> {
    Err("Windows 暂不支持安全读取 Grok 本地账单日志".to_string())
}

#[cfg(all(not(unix), not(windows)))]
fn open_grok_log_file(home: &Path) -> Result<std::fs::File, String> {
    let logs = home.join("logs");
    let path = logs.join("unified.jsonl");
    for entry in [home, logs.as_path(), path.as_path()] {
        let metadata =
            std::fs::symlink_metadata(entry).map_err(|_| "找不到 Grok 用量日志".to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("Grok 用量日志路径不能包含符号链接".to_string());
        }
    }
    let file = std::fs::File::open(path).map_err(|_| "找不到 Grok 用量日志".to_string())?;
    if !file
        .metadata()
        .map_err(|_| "无法读取 Grok 用量日志属性".to_string())?
        .is_file()
    {
        return Err("Grok 用量日志不是普通文件".to_string());
    }
    Ok(file)
}

#[cfg(test)]
fn read_tail_bounded(path: &Path, max_bytes: u64) -> Result<String, String> {
    #[cfg(unix)]
    let file = {
        use std::fs::OpenOptions;
        use std::os::unix::fs::OpenOptionsExt;
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(path)
            .map_err(|_| "Grok 用量日志不能是符号链接或无法打开".to_string())?
    };
    #[cfg(not(unix))]
    let file = std::fs::File::open(path).map_err(|_| "找不到 Grok 用量日志".to_string())?;
    read_open_file_tail_bounded(file, max_bytes)
}

fn grok_home_dir() -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os("GROK_HOME").filter(|value| !value.is_empty()) {
        let path = PathBuf::from(value);
        return if path.is_absolute() {
            Ok(path)
        } else {
            std::env::current_dir()
                .map(|cwd| cwd.join(path))
                .map_err(|_| "无法解析 GROK_HOME".to_string())
        };
    }
    dirs::home_dir()
        .map(|home| home.join(".grok"))
        .ok_or_else(|| "找不到用户目录，无法读取 Grok 用量".to_string())
}

fn read_grok_log_snapshot(now: u64) -> Result<GrokLogSnapshot, String> {
    let home = grok_home_dir()?;
    let file = open_grok_log_file(&home)?;
    let tail = read_open_file_tail_bounded(file, GROK_LOG_TAIL_BYTES)?;
    parse_grok_usage_log(&tail, now)
}

fn grok_log_modified_ms() -> Option<u64> {
    let home = grok_home_dir().ok()?;
    let file = open_grok_log_file(&home).ok()?;
    file.metadata()
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
}

fn grok_cache() -> &'static Mutex<Option<GrokCacheEntry>> {
    GROK_CACHE.get_or_init(|| Mutex::new(None))
}

fn finish_grok_snapshot(mut snapshot: GrokLogSnapshot, now: u64) -> GrokUsage {
    if snapshot.observed_at_ms > now.saturating_add(GROK_FUTURE_CLOCK_SKEW_MS) {
        snapshot.usage.stale = true;
        snapshot.usage.error = Some("Grok 用量快照时间明显晚于本机时间".to_string());
        snapshot.usage.age_secs = 0;
        snapshot.usage.age_ms = 0;
        return snapshot.usage;
    }
    let age_ms = now.saturating_sub(snapshot.observed_at_ms);
    snapshot.usage.age_secs = age_ms / 1000;
    snapshot.usage.age_ms = age_ms;
    if age_ms > GROK_FRESH_MS {
        snapshot.usage.stale = true;
        snapshot.usage.error =
            Some("Grok 会在下一次真实请求或交互式 `/usage` 后更新这份数据".to_string());
    }
    snapshot.usage
}

fn grok_error_or_cached(cached: Option<GrokLogSnapshot>, error: String, now: u64) -> GrokUsage {
    if let Some(snapshot) = cached {
        let mut usage = finish_grok_snapshot(snapshot, now);
        usage.stale = true;
        usage.error = Some(format!("读取最新 Grok 用量失败：{error}"));
        return usage;
    }
    GrokUsage {
        ok: false,
        error: Some(error),
        ..Default::default()
    }
}

/// 读取 Grok 订阅用量。Grok 当前没有可供外部无头客户端调用的 billing 刷新
/// 方法，因此只展示它最近一次真实请求或 `/usage` 写下的精确快照，并如实标记年龄。
pub fn fetch_grok_usage() -> GrokUsage {
    if cfg!(windows) {
        return GrokUsage {
            ok: false,
            error: Some("Windows 暂不支持安全读取 Grok 本地账单日志".to_string()),
            ..Default::default()
        };
    }

    let now = now_ms();
    let mut cached = grok_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(entry) = cached.as_ref() {
        let cache_age = now.saturating_sub(entry.cached_at_ms);
        let log_unchanged = grok_log_modified_ms()
            .map(|modified| modified <= entry.cached_at_ms)
            .unwrap_or(false);
        if cache_age <= GROK_FRESH_MS && log_unchanged {
            return finish_grok_snapshot(entry.snapshot.clone(), now);
        }
    }
    match read_grok_log_snapshot(now) {
        Ok(snapshot) => {
            *cached = Some(GrokCacheEntry {
                snapshot: snapshot.clone(),
                cached_at_ms: now,
            });
            finish_grok_snapshot(snapshot, now)
        }
        Err(error) => grok_error_or_cached(
            cached.as_ref().map(|entry| entry.snapshot.clone()),
            error,
            now,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_grok_weekly_billing_snapshot() {
        let now = rfc3339_ms("2026-09-03T12:00:30Z").unwrap();
        let event = serde_json::json!({
            "ts": "2026-09-03T12:00:00Z",
            "msg": GROK_BILLING_LOG_MESSAGE,
            "ctx": {
                "config": {
                    "creditUsagePercent": 42.5,
                    "currentPeriod": {
                        "type": "USAGE_PERIOD_TYPE_WEEKLY",
                        "start": "2026-09-01T12:00:00Z",
                        "end": "2026-09-08T12:00:00Z"
                    },
                    "prepaidBalance": { "val": 5000 }
                },
                "subscriptionTier": "SuperGrok Heavy"
            }
        });
        let snapshot = parse_grok_billing_event(&event, now).expect("应解析周额度");
        assert_eq!(
            snapshot.observed_at_ms,
            rfc3339_ms("2026-09-03T12:00:00Z").unwrap()
        );
        assert!(snapshot.usage.ok);
        assert_eq!(snapshot.usage.plan.as_deref(), Some("SuperGrok Heavy"));
        assert_eq!(snapshot.usage.age_secs, 30);
        assert_eq!(snapshot.usage.windows.len(), 1);
        assert_eq!(snapshot.usage.windows[0].label, "7 天窗口");
        assert!((snapshot.usage.windows[0].utilization - 42.5).abs() < f64::EPSILON);
        assert_eq!(snapshot.usage.windows[0].resets_at, "2026-09-08T12:00:00Z");
    }

    #[test]
    fn parses_grok_legacy_monthly_billing_snapshot() {
        let event = serde_json::json!({
            "ts": 1_788_436_800u64,
            "msg": GROK_BILLING_LOG_MESSAGE,
            "ctx": {
                "config": {
                    "monthlyLimit": { "val": 2000 },
                    "used": { "val": 500 },
                    "billingPeriodStart": "2026-09-01T00:00:00Z",
                    "billingPeriodEnd": "2026-10-01T00:00:00Z"
                }
            }
        });
        let snapshot = parse_grok_billing_event(&event, 1_788_436_800_000).unwrap();
        assert_eq!(snapshot.usage.plan, None);
        assert_eq!(snapshot.usage.windows[0].label, "月度窗口");
        assert!((snapshot.usage.windows[0].utilization - 25.0).abs() < f64::EPSILON);
        assert_eq!(snapshot.usage.windows[0].resets_at, "2026-10-01T00:00:00Z");
    }

    #[test]
    fn grok_log_uses_latest_billing_event_and_ignores_unrelated_lines() {
        let log = concat!(
            "not json\n",
            "{\"ts\":\"2026-09-03T11:00:00Z\",\"msg\":\"other event\"}\n",
            "{\"ts\":\"2026-09-03T11:30:00Z\",\"msg\":\"billing: fetched credits config\",\"ctx\":{\"config\":{\"creditUsagePercent\":10,\"currentPeriod\":{\"type\":\"USAGE_PERIOD_TYPE_WEEKLY\",\"end\":\"2026-09-08T12:00:00Z\"}}}}\n",
            "{\"ts\":\"2026-09-03T12:00:00Z\",\"msg\":\"billing: fetched credits config\",\"ctx\":{\"config\":{\"creditUsagePercent\":27,\"currentPeriod\":{\"type\":\"USAGE_PERIOD_TYPE_WEEKLY\",\"end\":\"2026-09-08T12:00:00Z\"}}}}\n",
        );
        let snapshot =
            parse_grok_usage_log(log, rfc3339_ms("2026-09-03T12:00:01Z").unwrap()).unwrap();
        assert!((snapshot.usage.windows[0].utilization - 27.0).abs() < f64::EPSILON);
        assert_eq!(snapshot.usage.age_secs, 1);
    }

    #[test]
    fn grok_billing_parser_fails_closed_on_invalid_latest_snapshot() {
        let log = concat!(
            "{\"ts\":\"2026-09-03T11:00:00Z\",\"msg\":\"billing: fetched credits config\",\"ctx\":{\"config\":{\"creditUsagePercent\":20}}}\n",
            "{\"ts\":\"2026-09-03T12:00:00Z\",\"msg\":\"billing: fetched credits config\",\"ctx\":{\"config\":{\"creditUsagePercent\":-1}}}\n",
        );
        let error = parse_grok_usage_log(log, rfc3339_ms("2026-09-03T12:00:01Z").unwrap())
            .expect_err("不能用更旧的正常值掩盖最新 schema/数据异常");
        assert!(error.contains("百分比"));
    }

    #[test]
    fn grok_billing_parser_bounds_fields_and_percent() {
        let event = serde_json::json!({
            "ts": "2026-09-03T12:00:00Z",
            "msg": GROK_BILLING_LOG_MESSAGE,
            "ctx": {
                "config": {
                    "creditUsagePercent": 125,
                    "currentPeriod": {
                        "type": "USAGE_PERIOD_TYPE_WEEKLY",
                        "end": "not-a-date"
                    }
                },
                "subscriptionTier": format!("Super\n{}", "x".repeat(200))
            }
        });
        let snapshot =
            parse_grok_billing_event(&event, rfc3339_ms("2026-09-03T12:00:01Z").unwrap()).unwrap();
        assert_eq!(snapshot.usage.windows[0].utilization, 100.0);
        assert_eq!(snapshot.usage.windows[0].resets_at, "");
        let plan = snapshot.usage.plan.unwrap();
        assert!(!plan.contains('\n'));
        assert_eq!(plan.chars().count(), 128);
    }

    #[test]
    fn grok_snapshot_marks_old_data_stale_without_changing_its_value() {
        let observed = rfc3339_ms("2026-09-03T12:00:00Z").unwrap();
        let event = serde_json::json!({
            "ts": "2026-09-03T12:00:00Z",
            "msg": GROK_BILLING_LOG_MESSAGE,
            "ctx": { "config": { "creditUsagePercent": 33 } }
        });
        let fresh = finish_grok_snapshot(
            parse_grok_billing_event(&event, observed + 30_000).unwrap(),
            observed + 30_000,
        );
        assert!(!fresh.stale);
        assert_eq!(fresh.error, None);
        assert_eq!(fresh.age_secs, 30);

        let stale = finish_grok_snapshot(
            parse_grok_billing_event(&event, observed + 61_000).unwrap(),
            observed + 61_000,
        );
        assert!(stale.stale);
        assert_eq!(stale.age_secs, 61);
        assert_eq!(stale.windows[0].utilization, 33.0);
        assert!(stale.error.unwrap().contains("下一次真实请求"));
    }

    #[test]
    fn grok_snapshot_rejects_a_timestamp_far_in_the_future() {
        let now = rfc3339_ms("2026-09-03T12:00:00Z").unwrap();
        let event = serde_json::json!({
            "ts": "2026-09-03T12:06:00Z",
            "msg": GROK_BILLING_LOG_MESSAGE,
            "ctx": { "config": { "creditUsagePercent": 20 } }
        });
        assert!(parse_grok_billing_event(&event, now)
            .unwrap_err()
            .contains("晚于本机时间"));
    }

    #[test]
    fn grok_read_error_falls_back_to_the_last_good_snapshot_as_stale() {
        let observed = rfc3339_ms("2026-09-03T12:00:00Z").unwrap();
        let cached = GrokLogSnapshot {
            usage: GrokUsage {
                ok: true,
                windows: vec![LimitWindow {
                    label: "7 天窗口".to_string(),
                    utilization: 41.0,
                    resets_at: "2026-09-08T12:00:00Z".to_string(),
                }],
                ..Default::default()
            },
            observed_at_ms: observed,
        };
        let usage =
            grok_error_or_cached(Some(cached), "日志正在写入".to_string(), observed + 10_000);
        assert!(usage.ok);
        assert!(usage.stale);
        assert_eq!(usage.windows[0].utilization, 41.0);
        assert!(usage.error.unwrap().contains("日志正在写入"));

        let empty = grok_error_or_cached(None, "没有日志".to_string(), observed);
        assert!(!empty.ok);
        assert_eq!(empty.error.as_deref(), Some("没有日志"));
    }

    #[test]
    fn bounded_tail_keeps_a_complete_line_that_starts_at_the_boundary() {
        use std::io::Write;

        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"discard\nkeep-me\n").unwrap();
        let tail = read_tail_bounded(file.path(), b"keep-me\n".len() as u64).unwrap();
        assert_eq!(tail, "keep-me\n");
    }

    #[cfg(unix)]
    #[test]
    fn bounded_tail_rejects_a_symlinked_log() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.jsonl");
        let link = dir.path().join("unified.jsonl");
        std::fs::write(&real, b"{}\n").unwrap();
        symlink(&real, &link).unwrap();
        assert!(read_tail_bounded(&link, 1024)
            .unwrap_err()
            .contains("符号链接"));
    }

    #[cfg(unix)]
    #[test]
    fn grok_log_open_rejects_symlinked_home_and_logs_directory() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let real_home = base.join("real-home");
        let real_logs = real_home.join("logs");
        std::fs::create_dir_all(&real_logs).unwrap();
        std::fs::write(real_logs.join("unified.jsonl"), b"{}\n").unwrap();
        assert!(open_grok_log_file(&real_home).is_ok());

        let linked_home = base.join("linked-home");
        symlink(&real_home, &linked_home).unwrap();
        assert!(open_grok_log_file(&linked_home).is_err());

        let real_parent = base.join("real-parent");
        let nested_home = real_parent.join("nested-home");
        std::fs::create_dir_all(nested_home.join("logs")).unwrap();
        std::fs::write(nested_home.join("logs/unified.jsonl"), b"{}\n").unwrap();
        let linked_parent = base.join("linked-parent");
        symlink(&real_parent, &linked_parent).unwrap();
        assert!(open_grok_log_file(&linked_parent.join("nested-home")).is_err());

        let home_with_linked_logs = base.join("home-with-linked-logs");
        std::fs::create_dir(&home_with_linked_logs).unwrap();
        symlink(&real_logs, home_with_linked_logs.join("logs")).unwrap();
        assert!(open_grok_log_file(&home_with_linked_logs).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn grok_log_open_rejects_a_hard_linked_file() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let logs = home.join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let real = dir.path().join("real.jsonl");
        std::fs::write(&real, b"{}\n").unwrap();
        std::fs::hard_link(&real, logs.join("unified.jsonl")).unwrap();
        let canonical_home = std::fs::canonicalize(home).unwrap();
        assert!(open_grok_log_file(&canonical_home)
            .unwrap_err()
            .contains("硬链接"));
    }

    #[test]
    #[ignore = "人工核对用：需要本机已安装并登录 Grok"]
    fn probe_local_grok_usage_snapshot_without_exposing_account_values() {
        let usage = fetch_grok_usage();
        assert!(usage.ok, "Grok 用量探针失败：{:?}", usage.error);
        assert!(!usage.windows.is_empty(), "Grok 没有返回任何用量窗口");
        assert!(usage.windows.iter().all(|window| {
            window.utilization.is_finite()
                && (0.0..=100.0).contains(&window.utilization)
                && !window.label.is_empty()
        }));
    }

    #[test]
    fn parses_pushed_rate_limits_with_only_a_weekly_window() {
        // 本机实测 `account/rateLimits/updated` 推来的真实形状：secondary 为
        // null，只有一个 10080 分钟的窗口，resetsAt 是 Unix 秒。
        let params = serde_json::json!({
            "rateLimits": {
                "limitId": "codex",
                "limitName": null,
                "primary": { "usedPercent": 16, "windowDurationMins": 10080, "resetsAt": 1_788_401_283u64 },
                "secondary": null,
                "planType": "prolite"
            }
        });
        let usage = parse_codex_usage(&params).expect("单个周窗口也该能解析");
        assert!(usage.ok);
        assert_eq!(usage.plan.as_deref(), Some("prolite"));
        assert_eq!(
            usage.windows.len(),
            1,
            "secondary 是 null，不该硬凑出第二个窗口"
        );
        assert_eq!(usage.windows[0].label, "7 天窗口");
        assert_eq!(usage.windows[0].utilization, 16.0);
        // Unix 秒必须换成 ISO，否则前端 Date.parse 不出来，重置时间会是空的。
        assert!(
            usage.windows[0].resets_at.contains('T'),
            "resetsAt 应转成 ISO 时间，实际是 {}",
            usage.windows[0].resets_at
        );

        // 推来的东西不成形状就当没收到，不能把空数据写进缓存。
        assert!(!record_codex_rate_limits(&serde_json::json!({})));
        assert!(!record_codex_rate_limits(
            &serde_json::json!({ "rateLimits": null })
        ));
    }

    #[test]
    fn failure_cooldown_roundtrip() {
        record_failure("test-cooldown-agent", "boom");
        assert_eq!(
            recent_failure("test-cooldown-agent"),
            Some("boom".to_string())
        );
        assert_eq!(recent_failure("never-failed-agent"), None);
    }

    #[test]
    fn oauth_endpoint_follows_configured_base_url() {
        assert_eq!(
            oauth_usage_endpoint("https://proxy.example.com").unwrap(),
            "https://proxy.example.com/api/oauth/usage"
        );
        assert_eq!(
            oauth_usage_endpoint("https://proxy.example.com/v1/").unwrap(),
            "https://proxy.example.com/api/oauth/usage"
        );
        assert_eq!(
            oauth_usage_endpoint("https://proxy.example.com/api/oauth/usage").unwrap(),
            "https://proxy.example.com/api/oauth/usage"
        );
        assert!(oauth_usage_endpoint("file:///tmp/api").is_err());
    }

    #[test]
    fn window_label_uses_duration_not_hardcoded_5h() {
        assert_eq!(limit_window_label(10080.0), "7 天窗口");
        assert_eq!(limit_window_label(300.0), "5 小时窗口");
        assert_eq!(limit_window_label(15.0), "15 分钟窗口");
        assert_eq!(limit_window_label(1440.0), "24 小时窗口");
        assert_eq!(limit_window_label(0.0), "用量窗口");
    }

    #[test]
    fn unix_seconds_become_rfc3339() {
        assert_eq!(unix_seconds_to_iso(1_780_000_000.0), "2026-05-28T20:26:40Z");
        assert_eq!(unix_seconds_to_iso(0.0), "");
    }

    #[test]
    fn parse_codex_weekly_only_bucket() {
        let result = serde_json::json!({
            "rateLimits": {
                "limitId": "codex",
                "planType": "pro",
                "primary": {
                    "usedPercent": 30,
                    "windowDurationMins": 10080,
                    "resetsAt": 1787196627
                },
                "secondary": null
            }
        });
        let u = parse_codex_usage(&result).expect("应解析成功");
        assert!(u.ok);
        assert_eq!(u.plan.as_deref(), Some("pro"));
        assert_eq!(u.windows.len(), 1);
        assert_eq!(u.windows[0].label, "7 天窗口");
        assert!((u.windows[0].utilization - 30.0).abs() < 1e-9);
        assert_eq!(u.windows[0].resets_at, unix_seconds_to_iso(1_787_196_627.0));
    }

    #[test]
    fn parse_codex_primary_and_secondary() {
        let result = serde_json::json!({
            "rateLimits": {
                "limitId": "codex",
                "planType": "plus",
                "primary": {
                    "usedPercent": 12.5,
                    "windowDurationMins": 300,
                    "resetsAt": 1787000000
                },
                "secondary": {
                    "usedPercent": 44,
                    "windowDurationMins": 10080,
                    "resetsAt": 1787196627
                }
            }
        });
        let u = parse_codex_usage(&result).expect("应解析成功");
        assert_eq!(u.windows.len(), 2);
        assert_eq!(u.windows[0].label, "5 小时窗口");
        assert_eq!(u.windows[1].label, "7 天窗口");
        assert!((u.windows[0].utilization - 12.5).abs() < 1e-9);
    }

    #[test]
    fn parse_codex_named_extra_bucket() {
        let result = serde_json::json!({
            "rateLimits": {
                "limitId": "codex",
                "planType": "pro",
                "primary": {
                    "usedPercent": 30,
                    "windowDurationMins": 10080,
                    "resetsAt": 1787196627
                }
            },
            "rateLimitsByLimitId": {
                "codex": {
                    "limitId": "codex",
                    "primary": {
                        "usedPercent": 30,
                        "windowDurationMins": 10080,
                        "resetsAt": 1787196627
                    }
                },
                "codex_spark": {
                    "limitId": "codex_spark",
                    "limitName": "GPT-5.3-Codex-Spark",
                    "primary": {
                        "usedPercent": 0,
                        "windowDurationMins": 10080,
                        "resetsAt": 1787538575
                    }
                }
            }
        });
        let u = parse_codex_usage(&result).expect("应解析成功");
        assert_eq!(u.windows.len(), 2);
        assert_eq!(u.windows[0].label, "7 天窗口");
        assert_eq!(u.windows[1].label, "GPT-5.3-Codex-Spark · 7 天窗口");
        assert!((u.windows[1].utilization - 0.0).abs() < 1e-9);
    }

    #[test]
    fn parse_codex_missing_limits_errors() {
        let result = serde_json::json!({ "rateLimits": null });
        let err = parse_codex_usage(&result).expect_err("应失败");
        assert!(err.contains("没有套餐限流数据"));
    }
}
