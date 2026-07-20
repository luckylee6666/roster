//! 用量查询：OAuth 限流用量（Claude，同 /usage 数据源）+ 多 CLI 周用量（ccusage）。
//!
//! Claude 限流用量走一次 https 调用（api/oauth/usage），零 Node 依赖。
//! Codex / OpenCode 周用量走社区工具 `ccusage`（读各 CLI 本地日志，不联网传数据）。
//! ccusage 每次运行都把全量 JSONL 日志读进内存（可达数百 MB），并发多个足以把整机
//! 内存吃爆——所以走 ccusage 的路径必须过全局单飞锁 + 失败冷却（见 CCUSAGE_GATE）。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 经「交互式登录」shell 跑一条命令，继承用户完整 PATH
/// （GUI 启动的进程默认拿不到 nvm/npx/claude）。
/// 必须是交互式（-i）：nvm 等对 PATH 的设置几乎都写在 .zshrc/.bashrc 里，
/// 而这些 rc 只在交互式 shell 加载；只用 -l（登录非交互）只读 .zprofile/.zlogin，
/// 拿不到 nvm 的 node/npx → ccusage 跑不起来。内置终端是真交互 PTY 所以一直正常。
/// 带超时，避免 ccusage / claude 卡死拖住调用线程。
fn run_shell(script: &str, timeout_secs: u64) -> Result<String, String> {
    use std::io::Read;
    use std::process::Stdio;

    // 持 child 句柄而非把整个 output() 丢进线程：超时时才能 kill 掉子进程（ccusage/npx/node
    // 整棵进程树），否则超时返回后进程会成孤儿继续跑、读线程也永远醒不过来——是真实的泄漏。
    #[cfg(not(target_os = "windows"))]
    let spawn = {
        use std::os::unix::process::CommandExt;
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        std::process::Command::new(shell)
            .arg("-ilc")
            .arg(script)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // 自成进程组：超时时才能连 shell 派生的 ccusage/npx/node 孙进程一起 kill，
            // 否则只杀直接子进程（shell），孙进程成孤儿继续跑、两个读线程也醒不过来。
            .process_group(0)
            .spawn()
    };
    #[cfg(target_os = "windows")]
    let spawn = std::process::Command::new("powershell.exe")
        .arg("-NoProfile")
        .arg("-Command")
        .arg(script)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let mut child = spawn.map_err(|e| e.to_string())?;
    let mut stdout_pipe = child.stdout.take().ok_or("无法接管子进程 stdout")?;
    let mut stderr_pipe = child.stderr.take().ok_or("无法接管子进程 stderr")?;

    // stdout / stderr 各用一个线程读干净：任一管道写满都会阻塞子进程（经典 pipe 死锁），
    // 分开排空避开它。stdout 读完（子进程退出即 EOF）作为完成信号；kill 后管道关闭，
    // 两个读线程都会自然从 read_to_end 返回，不残留线程。
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    let stderr_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buf);
        buf
    });

    match rx.recv_timeout(Duration::from_secs(timeout_secs)) {
        Ok(out) => {
            let _ = child.wait(); // 回收，避免僵尸进程
            let stdout = String::from_utf8_lossy(&out).to_string();
            if !stdout.trim().is_empty() {
                Ok(stdout)
            } else {
                let err = stderr_handle.join().unwrap_or_default();
                Err(String::from_utf8_lossy(&err).trim().to_string())
            }
        }
        Err(_) => {
            // 超时：杀掉整个进程组（shell + ccusage/npx/node 孙进程）并回收，
            // 不然孙进程成孤儿继续跑、两个读线程也永远等不到 EOF。
            #[cfg(not(target_os = "windows"))]
            {
                // child 是进程组组长（process_group(0)），pid==pgid，kill 负号 pid 即杀整组。
                let _ = std::process::Command::new("/bin/kill")
                    .arg("-KILL")
                    .arg(format!("-{}", child.id()))
                    .status();
            }
            let _ = child.kill(); // 兜底 + Windows 路径
            let _ = child.wait();
            Err("命令超时（ccusage/claude 未响应）".to_string())
        }
    }
}

/// 从可能带 shell 启动噪声（交互式 zsh 的 .zshrc 偶尔往 stdout 打印 "Restored session:" 等）
/// 的输出里截出 JSON 主体——从第一个 `{` 或 `[` 开始。
fn slice_json(s: &str) -> &str {
    match s.find(|c| c == '{' || c == '[') {
        Some(i) => &s[i..],
        None => s,
    }
}

// ============================================================================
// 多 CLI 周用量统计（claude / codex / opencode），同样走 ccusage 读本地日志。
// ============================================================================

/// 单个 CLI 的周用量统计。
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentWeekly {
    pub ok: bool,
    pub error: Option<String>,
    /// "claude" | "codex" | "opencode"
    pub agent: String,
    /// 累计总花费（USD）
    pub total_cost: f64,
    /// 累计总 token
    pub total_tokens: u64,
    /// 近若干周，按时间倒序（最新在前）
    pub weeks: Vec<WeekRow>,
}

/// 一周的用量。
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct WeekRow {
    /// 周起始日（周一）YYYY-MM-DD
    pub period: String,
    pub cost_usd: f64,
    pub total_tokens: u64,
    pub models: Vec<String>,
}

/// 最多展示几周。
const MAX_WEEKS: usize = 8;

// ccusage 不同子命令字段名不统一：weekly 用 totalCost / period / modelsUsed，
// codex daily 用 costUSD / date / models(对象)。下面几个取值器吸收差异。
fn row_cost(o: &Value) -> f64 {
    o.get("totalCost")
        .or_else(|| o.get("costUSD"))
        .and_then(|x| x.as_f64())
        .unwrap_or(0.0)
}
fn row_tokens(o: &Value) -> u64 {
    o.get("totalTokens").and_then(|x| x.as_u64()).unwrap_or(0)
}
fn row_period(o: &Value) -> String {
    o.get("period")
        .or_else(|| o.get("date"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string()
}
fn row_models(o: &Value) -> Vec<String> {
    if let Some(arr) = o.get("modelsUsed").and_then(|x| x.as_array()) {
        return arr.iter().filter_map(|x| x.as_str().map(String::from)).collect();
    }
    if let Some(obj) = o.get("models").and_then(|x| x.as_object()) {
        return obj.keys().cloned().collect();
    }
    Vec::new()
}

/// 拉某个 agent 的周用量。claude/opencode 有原生 `weekly`；codex 只有 `daily`，
/// 在此按 ISO 周（周一为起）聚合成周。
pub fn fetch_agent_weekly(agent: &str) -> AgentWeekly {
    // 白名单：agent 会拼进 shell 命令，杜绝注入
    let agent = match agent {
        "claude" | "opencode" | "codex" => agent,
        other => {
            return AgentWeekly {
                ok: false,
                agent: other.to_string(),
                error: Some(format!("不支持的 agent：{other}")),
                ..Default::default()
            }
        }
    };
    let sub = if agent == "codex" { "daily" } else { "weekly" };
    let script = format!(
        "ccusage {agent} {sub} --json 2>/dev/null || npx -y ccusage@latest {agent} {sub} --json 2>/dev/null"
    );
    match run_shell(&script, 90) {
        Ok(json) => match parse_agent_weekly(&json, agent) {
            Ok(mut w) => {
                w.ok = true;
                w.agent = agent.to_string();
                w
            }
            Err(e) => {
                crate::log_warn!("ccusage {agent} 周用量解析失败：{e}");
                AgentWeekly {
                    ok: false,
                    agent: agent.to_string(),
                    error: Some(format!("解析 ccusage 输出失败：{e}")),
                    ..Default::default()
                }
            }
        },
        Err(e) => {
            crate::log_warn!(
                "ccusage {agent} 周用量运行失败：{}",
                if e.is_empty() { "(无输出)" } else { e.as_str() }
            );
            AgentWeekly {
                ok: false,
                agent: agent.to_string(),
                error: Some(if e.is_empty() {
                    format!("无法运行 ccusage（确认装了 Node/npx，且用过 {agent}）")
                } else {
                    e
                }),
                ..Default::default()
            }
        }
    }
}

fn parse_agent_weekly(json: &str, agent: &str) -> Result<AgentWeekly, String> {
    let v: Value = serde_json::from_str(slice_json(json)).map_err(|e| e.to_string())?;
    let totals = v.get("totals");
    let total_cost = totals.map(row_cost).unwrap_or(0.0);
    let total_tokens = totals.map(row_tokens).unwrap_or(0);

    let mut weeks: Vec<WeekRow> = if agent == "codex" {
        aggregate_daily_to_weeks(&v)?
    } else {
        let arr = v
            .get("weekly")
            .and_then(|x| x.as_array())
            .ok_or("缺少 weekly 字段")?;
        arr.iter()
            .map(|o| WeekRow {
                period: row_period(o),
                cost_usd: row_cost(o),
                total_tokens: row_tokens(o),
                models: row_models(o),
            })
            .collect()
    };
    // 按周起始日倒序（最新在前），只留最近 MAX_WEEKS 周
    weeks.sort_by(|a, b| b.period.cmp(&a.period));
    weeks.truncate(MAX_WEEKS);
    Ok(AgentWeekly {
        total_cost,
        total_tokens,
        weeks,
        ..Default::default()
    })
}

/// 把 codex 的 daily 数组按周一为起的周聚合。
fn aggregate_daily_to_weeks(v: &Value) -> Result<Vec<WeekRow>, String> {
    use chrono::{Datelike, Duration as Dur, NaiveDate};
    let arr = v
        .get("daily")
        .and_then(|x| x.as_array())
        .ok_or("缺少 daily 字段")?;
    let mut map: std::collections::BTreeMap<String, WeekRow> = std::collections::BTreeMap::new();
    for o in arr {
        let date = row_period(o);
        // 该日所在周的周一；解析失败就退化成按当日分组（不丢数据）
        let monday = NaiveDate::parse_from_str(&date, "%Y-%m-%d")
            .map(|d| d - Dur::days(d.weekday().num_days_from_monday() as i64))
            .map(|d| d.format("%Y-%m-%d").to_string())
            .unwrap_or_else(|_| date.clone());
        let entry = map.entry(monday.clone()).or_insert_with(|| WeekRow {
            period: monday.clone(),
            ..Default::default()
        });
        entry.cost_usd += row_cost(o);
        entry.total_tokens += row_tokens(o);
        for m in row_models(o) {
            if !entry.models.contains(&m) {
                entry.models.push(m);
            }
        }
    }
    Ok(map.into_values().collect())
}

/// 检测 npx 是否可用（ccusage 经 `npx -y` 自动拉取，所以只需 npx；有 npx 即可，
/// 没装 ccusage 也会自动下载）。用显式标记判断，避免交互式 shell 启动噪声误判。
pub fn has_npx() -> bool {
    run_shell("command -v npx >/dev/null 2>&1 && echo __NPX_OK__", 15)
        .map(|s| s.contains("__NPX_OK__"))
        .unwrap_or(false)
}

// ============================================================================
// OAuth 用量（限流窗口）：和 Claude Code 的 /usage 同一数据源
// （GET api.anthropic.com/api/oauth/usage），给出 5h / 7d 的使用百分比 + 重置时间。
// 比 ccusage 快得多（一次 https 调用），并带 60s 文件缓存。token 从钥匙串读。
// ============================================================================

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

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn cache_file(name: &str) -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("vibe-coding-manage")
        .join(name)
}
fn oauth_cache_path() -> PathBuf {
    cache_file("oauth-usage-cache.json")
}

/// 通用文件缓存：读。ttl_ms 内算新鲜；传 u64::MAX 表示不限期。
fn cache_read<T: serde::de::DeserializeOwned>(path: &PathBuf, ttl_ms: u64) -> Option<T> {
    let s = std::fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&s).ok()?;
    let ts = v.get("ts").and_then(|x| x.as_u64())?;
    if now_ms().saturating_sub(ts) > ttl_ms {
        return None;
    }
    serde_json::from_value(v.get("data")?.clone()).ok()
}
/// 通用文件缓存：写（带时间戳）。
fn cache_write<T: Serialize>(path: &PathBuf, data: &T) {
    let v = serde_json::json!({ "ts": now_ms(), "data": data });
    if let Ok(s) = serde_json::to_string(&v) {
        // 同目录 tmp + rename，避免崩溃/断电留半截缓存文件（与主数据存储一致）
        let tmp = path.with_extension("tmp");
        if std::fs::write(&tmp, s).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

// ============================================================================
// ccusage 进程防护：全局单飞 + 失败冷却。
// 每棵 ccusage/npx/node 进程树都把全量日志读进内存；没有防护时连点刷新/快速切
// tab 会并发堆出一排 node，内存爆满整机卡死（真实事故，2026-07）。
// ============================================================================

/// 全局单飞锁：任一时刻至多一棵 ccusage 进程树在跑，其余调用排队等锁后重查缓存。
static CCUSAGE_GATE: Mutex<()> = Mutex::new(());

/// 失败冷却表：key → (失败时刻 ms, 错误信息)。冷却窗口内直接返回上次错误，不再起进程。
static LAST_FAIL: OnceLock<Mutex<HashMap<String, (u64, String)>>> = OnceLock::new();
const FAIL_COOLDOWN_MS: u64 = 30_000;

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

/// 带缓存的周用量（面板用）：周数据变化慢，缓存 10 分钟。
/// 缓存未命中时过全局单飞锁——等锁期间别的调用可能已拉好或刚失败，拿到锁后先重查。
pub fn fetch_agent_weekly_cached(agent: &str) -> AgentWeekly {
    let fail_result = |err: String| AgentWeekly {
        ok: false,
        agent: agent.to_string(),
        error: Some(err),
        ..Default::default()
    };
    let path = cache_file(&format!("ccusage-weekly-{agent}-cache.json"));
    if let Some(c) = cache_read::<AgentWeekly>(&path, 600_000) {
        return c;
    }
    if let Some(err) = recent_failure(agent) {
        return fail_result(err);
    }
    let _gate = CCUSAGE_GATE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(c) = cache_read::<AgentWeekly>(&path, 600_000) {
        return c;
    }
    if let Some(err) = recent_failure(agent) {
        return fail_result(err);
    }
    let w = fetch_agent_weekly(agent);
    if w.ok {
        cache_write(&path, &w);
    } else {
        record_failure(agent, w.error.as_deref().unwrap_or("ccusage 运行失败"));
    }
    w
}

/// 读 Claude 登录 token：优先 macOS 钥匙串（首用会弹一次授权框），
/// 兜底读 ~/.claude/.credentials.json（Linux/Windows 或文件存储）。
fn read_oauth_token() -> Option<String> {
    let pick = |v: &Value| -> Option<String> {
        v.pointer("/claudeAiOauth/accessToken")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
    };
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = std::process::Command::new("/usr/bin/security")
            .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
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
    crate::log_warn!("读取登录凭据失败：钥匙串未授权/无此项，且 ~/.claude/.credentials.json 不可用");
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
        // 个别发行版 curl 不在 /usr/bin，回退裸名走 PATH
        "curl"
    }
}

/// 调用 oauth/usage 接口。token 走 curl 的 stdin 配置（-K -），不进 argv（避免 ps 泄露）。
/// 出错时尽量带出真实原因（curl stderr / HTTP 状态码 / 响应片段），便于定位"静默不更新"。
fn fetch_oauth_usage_raw(token: &str) -> Result<String, String> {
    use std::io::Write;
    use std::process::Stdio;
    let bin = curl_bin();
    let mut child = std::process::Command::new(bin)
        .args([
            "-sS",            // -S：即便 -s 也输出错误信息到 stderr
            "--max-time",
            "15",
            "-w",
            "\n%{http_code}", // 末行追加 HTTP 状态码，用于区分 200 / 401 / 5xx
            "-K",
            "-",
            "https://api.anthropic.com/api/oauth/usage",
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
    // stdout = 响应体 + "\n" + http_code（我们追加的末行）
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
        // 可能是 token 过期 / API 用户 / 错误响应
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
        plan: v.get("plan").and_then(|x| x.as_str()).map(|s| s.to_string()),
        stale: false,
        age_secs: 0,
    })
}

/// 读 OAuth 缓存并返回 (数据, 年龄毫秒)。年龄用于判断新鲜度 + 显示"X 分钟前更新"。
fn read_oauth_cache_with_age() -> Option<(OAuthUsage, u64)> {
    let s = std::fs::read_to_string(oauth_cache_path()).ok()?;
    let v: Value = serde_json::from_str(&s).ok()?;
    let ts = v.get("ts").and_then(|x| x.as_u64())?;
    let data: OAuthUsage = serde_json::from_value(v.get("data")?.clone()).ok()?;
    Some((data, now_ms().saturating_sub(ts)))
}
fn write_oauth_cache(u: &OAuthUsage) {
    cache_write(&oauth_cache_path(), u);
}

/// 拉 OAuth 用量。60s 文件缓存命中则秒返；否则读 token → 调 API → 写缓存。
/// 失败时回退到任意旧缓存，并**带上真实失败原因 + 数据年龄**（标 stale），
/// 避免把几小时前的旧值当现值静默显示。
pub fn fetch_oauth_usage() -> OAuthUsage {
    // 60s 内的缓存视为新鲜，直接返回（附上年龄）。
    if let Some((mut c, age)) = read_oauth_cache_with_age() {
        if age <= 60_000 {
            c.stale = false;
            c.age_secs = age / 1000;
            return c;
        }
    }
    let token = match read_oauth_token() {
        Some(t) => t,
        None => {
            crate::log_warn!("oauth 用量：未读到登录凭据（钥匙串/凭据文件均无），无法刷新");
            return OAuthUsage {
                ok: false,
                error: Some("未找到 Claude 登录凭据（需用 Claude Code 登录过；首次读取钥匙串会弹授权）".to_string()),
                ..Default::default()
            }
        }
    };
    match fetch_oauth_usage_raw(&token).and_then(|j| parse_oauth_usage(&j)) {
        Ok(mut u) => {
            u.stale = false;
            u.age_secs = 0;
            // 只在数值变化时记 INFO（先读旧缓存再写），避免每分钟一条例行成功淹没日志
            let prev = read_oauth_cache_with_age().map(|(c, _)| {
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
            write_oauth_cache(&u);
            u
        }
        Err(e) => {
            // 记真实失败原因，便于排查"为何不更新"
            crate::log_warn!("oauth 用量刷新失败，回退旧缓存：{e}");
            if let Some((mut c, age)) = read_oauth_cache_with_age() {
                c.stale = true;
                c.age_secs = age / 1000;
                c.error = Some(e); // 携带真实原因供面板显示
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
    fn parse_native_weekly() {
        // claude/opencode 原生 weekly 形态
        let json = r#"{
            "totals":{"totalCost":99.5,"totalTokens":1000},
            "weekly":[
                {"period":"2026-06-08","totalCost":40.0,"totalTokens":400,"modelsUsed":["claude-opus-4-8"]},
                {"period":"2026-06-15","totalCost":59.5,"totalTokens":600,"modelsUsed":["claude-opus-4-8","claude-haiku-4-5"]}
            ]
        }"#;
        let w = parse_agent_weekly(json, "claude").expect("应解析成功");
        assert_eq!(w.total_cost, 99.5);
        assert_eq!(w.total_tokens, 1000);
        // 倒序：最新的 2026-06-15 在前
        assert_eq!(w.weeks[0].period, "2026-06-15");
        assert_eq!(w.weeks[0].cost_usd, 59.5);
        assert_eq!(w.weeks[0].models.len(), 2);
        assert_eq!(w.weeks[1].period, "2026-06-08");
    }

    #[test]
    fn codex_daily_aggregates_into_weeks() {
        // codex 只有 daily（字段名 costUSD / date / models 对象），按周聚合
        // 2026-06-08 周一、2026-06-10 周三 → 同一周；2026-06-15 → 下一周
        let json = r#"{
            "totals":{"costUSD":12.0,"totalTokens":300},
            "daily":[
                {"date":"2026-06-08","costUSD":2.0,"totalTokens":50,"models":{"gpt-5.4":{}}},
                {"date":"2026-06-10","costUSD":3.0,"totalTokens":70,"models":{"gpt-5.3-codex":{}}},
                {"date":"2026-06-15","costUSD":7.0,"totalTokens":180,"models":{"gpt-5.4":{}}}
            ]
        }"#;
        let w = parse_agent_weekly(json, "codex").expect("应解析成功");
        assert_eq!(w.total_cost, 12.0);
        assert_eq!(w.weeks.len(), 2);
        // 倒序：本周（06-15 起）在前
        assert_eq!(w.weeks[0].period, "2026-06-15");
        assert_eq!(w.weeks[0].total_tokens, 180);
        // 上一周：06-08 + 06-10 合并，周起为周一 06-08
        assert_eq!(w.weeks[1].period, "2026-06-08");
        assert!((w.weeks[1].cost_usd - 5.0).abs() < 1e-9);
        assert_eq!(w.weeks[1].total_tokens, 120);
        assert_eq!(w.weeks[1].models.len(), 2);
    }

    #[test]
    fn unsupported_agent_errors() {
        let w = fetch_agent_weekly("agy");
        assert!(!w.ok);
        assert_eq!(w.agent, "agy");
    }
}
