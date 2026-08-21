//! 用量查询：Claude 走官方 OAuth 限流接口；Codex 走官方 `app-server` JSON-RPC。
//!
//! Claude：一次 https 调用 `api/oauth/usage`（仅官方地址），零 Node 依赖。
//! Codex：拉起本机 `codex app-server`，握手后调用 `account/rateLimits/read`。
//! 两条路径都带 60s 文件缓存；Codex 另有单飞锁，避免连点刷新堆进程。

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

fn which_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(windows)]
        {
            let exe = dir.join(format!("{name}.exe"));
            if exe.is_file() {
                return Some(exe);
            }
        }
    }
    None
}

fn resolve_codex_bin() -> Result<PathBuf, String> {
    const FIXED: &[&str] = &[
        "/opt/homebrew/bin/codex",
        "/usr/local/bin/codex",
        "/usr/bin/codex",
    ];
    for path in FIXED {
        if Path::new(path).is_file() {
            return Ok(PathBuf::from(path));
        }
    }
    if let Some(home) = dirs::home_dir() {
        for rel in [".local/bin/codex", ".cargo/bin/codex"] {
            let path = home.join(rel);
            if path.is_file() {
                return Ok(path);
            }
        }
        #[cfg(windows)]
        {
            let exe = home.join("AppData/Local/codex/codex.exe");
            if exe.is_file() {
                return Ok(exe);
            }
        }
    }
    which_in_path("codex")
        .ok_or_else(|| "未找到 Codex CLI（请确认已安装 `codex`，并用 ChatGPT 登录过）".to_string())
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

#[cfg(test)]
mod tests {
    use super::*;

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
