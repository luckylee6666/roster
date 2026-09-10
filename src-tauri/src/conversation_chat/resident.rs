//! Bounded resident sessions for the six non-Codex structured adapters.
//! No PTY parsing, shell-evaluated prompts, shared leader, or public listener.
use super::*;
use crate::codex_chat::{register_process_tree, stop_child, ProcessTreeGuard};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::process::{Child, ChildStdin};
use std::sync::mpsc::{self, Receiver};

const IDLE_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_IDLE: usize = 4;
type Sink = Arc<dyn Fn(&str, Value) + Send + Sync>;
type Lines = Receiver<Result<Option<String>, String>>;

pub(super) fn supports(id: &str) -> bool {
    matches!(id, "claude" | "agy" | "qwen" | "grok" | "opencode" | "mimo")
}

#[derive(Default)]
struct Pool {
    sessions: HashMap<PathBuf, Session>,
    suspended: bool,
    stopped: bool,
}

#[derive(Default)]
pub(crate) struct ResidentPool {
    inner: Arc<Mutex<Pool>>,
    reaper_started: AtomicBool,
}

impl ResidentPool {
    pub(crate) fn release(&self, project: Option<&Path>) {
        let mut pool = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(project) = project {
            drop(pool.sessions.remove(project));
        } else {
            pool.sessions.clear();
        }
    }
    pub(crate) fn set_enabled(&self, enabled: bool) {
        let mut pool = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        pool.suspended = !enabled;
        if !enabled {
            pool.sessions.clear();
        }
    }
    pub(crate) fn shutdown(&self) {
        let mut pool = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        pool.stopped = true;
        pool.sessions.clear();
    }
    fn reap(&self) {
        if self.reaper_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak = Arc::downgrade(&self.inner);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(500));
            let Some(inner) = weak.upgrade() else { break };
            let mut pool = inner.lock().unwrap_or_else(|e| e.into_inner());
            if pool.stopped {
                break;
            }
            pool.sessions
                .retain(|_, s| s.idle_since.elapsed() < IDLE_TTL && s.alive());
        });
    }
}

struct Session {
    stdin: Option<ChildStdin>,
    lines: Lines,
    process: Arc<Mutex<Child>>,
    tree: ProcessTreeGuard,
    thread: String,
    signature: u64,
    next_id: u64,
    idle_since: Instant,
}
impl Session {
    fn alive(&self) -> bool {
        self.process
            .lock()
            .is_ok_and(|mut c| matches!(c.try_wait(), Ok(None)))
    }
    fn send(&mut self, value: &Value) -> Result<(), String> {
        let stdin = self.stdin.as_mut().ok_or("CLI 输入已关闭")?;
        serde_json::to_writer(&mut *stdin, value).map_err(|_| "CLI 请求编码失败")?;
        stdin
            .write_all(b"\n")
            .and_then(|_| stdin.flush())
            .map_err(|_| "向 CLI 发送请求失败".into())
    }
    fn spawn(mut command: Command, signature: u64) -> Result<Self, String> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn().map_err(|_| "启动 CLI 常驻服务失败")?;
        let tree = match register_process_tree(&child) {
            Ok(tree) => tree,
            Err(error) => {
                stop_child(&mut child, false);
                return Err(error);
            }
        };
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        if stdin.is_none() || stdout.is_none() {
            tree.terminate();
            stop_child(&mut child, false);
            return Err("CLI 管道创建失败".into());
        }
        if let Some(mut stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                let _ = std::io::copy(&mut stderr, &mut std::io::sink());
            });
        }
        let (tx, lines) = mpsc::sync_channel(8);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout.unwrap());
            loop {
                let line = read_protocol_line(&mut reader);
                let end = match &line {
                    Ok(None) => true,
                    Err(error) if error == OVERSIZED_PROTOCOL_NOTIFICATION => false,
                    Err(_) => true,
                    Ok(Some(_)) => false,
                };
                if tx.send(line).is_err() || end {
                    break;
                }
            }
        });
        Ok(Self {
            stdin,
            lines,
            process: Arc::new(Mutex::new(child)),
            tree,
            thread: String::new(),
            signature,
            next_id: 1,
            idle_since: Instant::now(),
        })
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        drop(self.stdin.take());
        self.tree.terminate();
        if let Ok(mut child) = self.process.lock() {
            stop_child(&mut child, false);
        }
    }
}

/// Grok 问「现在什么模式」时，模型只看得见规划模式的系统提醒，会把 auto /
/// 始终批准都说成「普通对话」。用 CLI `--rules` 和 session `_meta.rules`
/// 补上 Roster 档位名称。
fn grok_permission_rule(mode_id: &str) -> &'static str {
    match mode_id {
        "plan" => {
            "当前 Roster 权限档是「只读计划」(plan)。只读分析，不要改项目文件。用户问现在什么模式时，回答「只读计划」，不要说成普通对话。"
        }
        "auto" => {
            "当前 Roster 权限档是「自动」(auto)：由你自行判断该不该用工具。这不是规划模式，也不是 Grok 的普通询问档 default。用户问现在什么模式时，回答「自动」，不要说成「普通对话」。"
        }
        "bypassPermissions" => {
            "当前 Roster 权限档是「始终批准」(bypassPermissions)：工具调用不再逐条确认，仍限制在项目工作区。用户问现在什么模式时，回答「始终批准」，不要说成「普通对话」。"
        }
        _ => "按当前 CLI 权限档工作。用户问模式时用 Roster 档位名称回答。",
    }
}

fn command(spec: &ProviderSpec, binary: PathBuf, r: &HeadlessStart) -> Command {
    if matches!(spec.id, "claude" | "agy" | "qwen") {
        let original = provider_command_with_slash(
            spec,
            binary.clone(),
            &r.cwd,
            &r.prompt,
            &r.thread_id,
            r.mode,
            &r.model,
            &r.effort,
            r.slash.as_ref(),
        );
        let args: Vec<_> = original.get_args().map(|s| s.to_os_string()).collect();
        let mut cmd = Command::new(binary);
        match spec.id {
            "claude" => {
                cmd.args(&args[..args.len() - 2]);
            }
            "qwen" => {
                cmd.args(&args[2..]);
            }
            "agy" => {
                cmd.arg("--print=").args(&args[1..]);
            }
            _ => unreachable!(),
        }
        cmd.args(["--input-format", "stream-json"]);
        return cmd;
    }
    let mut cmd = Command::new(binary);
    if spec.id == "grok" {
        cmd.args([
            "--permission-mode",
            r.mode.id,
            "--rules",
            grok_permission_rule(r.mode.id),
            "--disable-web-search",
            "--no-subagents",
        ]);
        if r.thread_id.is_empty() {
            cmd.args(["--sandbox", "workspace"]);
        }
        cmd.args(["agent", "--no-leader"]);
        if !r.model.is_empty() {
            cmd.args(["--model", &r.model]);
        }
        if !r.effort.is_empty() {
            cmd.args(["--reasoning-effort", &r.effort]);
        }
        cmd.arg("stdio");
    } else {
        cmd.args(["acp", "--pure", "--cwd"]).arg(&r.cwd);
    }
    cmd
}

fn signature(spec: &ProviderSpec, r: &HeadlessStart, command: &Command) -> u64 {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    (
        spec.id,
        r.mode.id,
        &r.model,
        &r.effort,
        format!("{:?}", r.slash),
        r.prompt.trim_start().starts_with('/'),
    )
        .hash(&mut hash);
    command.get_program().hash(&mut hash);
    command.get_envs().collect::<Vec<_>>().hash(&mut hash);
    let mut files = vec![PathBuf::from(command.get_program())];
    if let Some(home) = dirs::home_dir() {
        let paths: &[&str] = match spec.id {
            "claude" => &[".claude/settings.json"],
            "qwen" => &[".qwen/settings.json"],
            "grok" => &[".grok/config.toml", ".grok/sandbox.toml"],
            "opencode" => &[
                ".config/opencode/opencode.json",
                ".config/opencode/opencode.jsonc",
            ],
            "mimo" => &[
                ".config/mimocode/opencode.json",
                ".config/mimocode/mimocode.json",
            ],
            _ => &[],
        };
        files.extend(paths.iter().map(|p| home.join(p)));
    }
    for relative in [
        ".claude/settings.json",
        ".claude/settings.local.json",
        ".qwen/settings.json",
        ".grok/config.toml",
        "opencode.json",
        "opencode.jsonc",
        "mimocode.json",
    ] {
        files.push(r.cwd.join(relative));
    }
    for file in files {
        if let Ok(meta) = std::fs::metadata(file) {
            (meta.len(), meta.modified().ok()).hash(&mut hash);
        }
    }
    hash.finish()
}

fn noninteractive_config(raw: Option<&str>) -> Result<String, String> {
    let mut config: Value = match raw {
        Some(raw) => serde_json::from_str(raw)
            .map_err(|_| "CLI 进程配置不是有效 JSON，无法安全合并无头权限")?,
        None => json!({}),
    };
    let object = config
        .as_object_mut()
        .ok_or("CLI 进程配置必须是 JSON 对象")?;
    let mut permissions = match object.remove("permission") {
        Some(Value::Object(p)) => p,
        Some(Value::String(default)) if matches!(default.as_str(), "allow" | "ask" | "deny") => {
            let mut p = serde_json::Map::new();
            p.insert("*".into(), json!(default));
            p
        }
        None | Some(Value::Null) => serde_json::Map::new(),
        _ => return Err("CLI 权限配置格式不受支持，未覆盖原配置".into()),
    };
    // Match native `run`'s unattended policy. ACP otherwise leaves question
    // tools waiting forever because this surface has no question-answer UI.
    for tool in ["question", "plan_enter", "plan_exit"] {
        permissions.insert(tool.into(), json!("deny"));
    }
    object.insert("permission".into(), Value::Object(permissions));
    serde_json::to_string(&config).map_err(|_| "CLI 无头权限编码失败".into())
}

pub(super) fn start(
    app: AppHandle,
    state: &ConversationChatState,
    spec: &ProviderSpec,
    r: HeadlessStart,
) -> Result<ConversationChatStartResult, String> {
    let run_id = r.run_id.clone();
    let provider_id = spec.id.to_string();
    let out_run = run_id.clone();
    let out_provider = provider_id.clone();
    let sink: Sink = Arc::new(move |kind, data| emit(&app, &out_run, &out_provider, kind, data));
    let cancelled = crate::codex_chat::reserve_run(state, &r.project_id, &run_id)?;
    let result = crate::cli_detect::resolve_registered_cli_bin(spec.binary)
        .map(|bin| command(spec, bin, &r))
        .and_then(|cmd| start_reserved(state, *spec, r, cmd, cancelled, sink));
    if let Err(error) = result {
        crate::codex_chat::release_run(state, &run_id);
        return Err(error);
    }
    Ok(ConversationChatStartResult {
        run_id,
        provider_id,
    })
}

fn start_reserved(
    state: &ConversationChatState,
    spec: ProviderSpec,
    r: HeadlessStart,
    mut command: Command,
    cancelled: Arc<AtomicBool>,
    sink: Sink,
) -> Result<(), String> {
    command.current_dir(&r.cwd);
    if matches!(spec.id, "opencode" | "mimo") {
        let key = if spec.id == "mimo" {
            "MIMOCODE_CONFIG_CONTENT"
        } else {
            "OPENCODE_CONFIG_CONTENT"
        };
        let inherited = std::env::var(key).ok();
        command.env(key, noninteractive_config(inherited.as_deref())?);
    }
    crate::proxy_settings::apply_to_std_command(&mut command);
    let sig = signature(&spec, &r, &command);
    let mut pool = state
        .other_resident
        .inner
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if pool.stopped {
        return Err("应用正在退出".into());
    }
    let cached = pool.sessions.remove(&r.cwd).filter(|s| {
        !r.thread_id.is_empty()
            && s.thread == r.thread_id
            && s.signature == sig
            && s.alive()
            && s.idle_since.elapsed() < IDLE_TTL
    });
    drop(pool);
    let reused = cached.is_some();
    let mut session = match cached {
        Some(s) => s,
        None => Session::spawn(command, sig)?,
    };
    if crate::codex_chat::bind_reserved_process(
        state,
        &r.run_id,
        session.process.clone(),
        session.tree.clone(),
    )? {
        return Err("对话启动已取消".into());
    }
    // Discard late, already-completed turn notifications before writing new input.
    if reused {
        while let Ok(line) = session.lines.try_recv() {
            if !matches!(line, Ok(Some(_))) {
                return Err("CLI 常驻服务已退出，请重试".into());
            }
        }
    }
    state.other_resident.reap();
    let idle = state.other_resident.inner.clone();
    let active = state.active.clone();
    std::thread::spawn(move || {
        let started = Instant::now();
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            let mut turn = Turn {
                session: &mut session,
                sink: &sink,
                cancelled: &cancelled,
                start: started,
                last_protocol: started,
                got_output: false,
                ready: false,
                protocol_bytes: 0,
                messages: 0,
                output_bytes: 0,
                events: 0,
                sent_text: false,
                saw_thought: false,
                provider: spec.id,
            };
            if matches!(spec.id, "grok" | "opencode" | "mimo") {
                turn.acp(&r, reused)
            } else {
                turn.stream(&r, reused)
            }
        }))
        .unwrap_or_else(|_| Err("CLI 常驻协议异常，已停止本轮".into()));
        let mut runs = active.lock().unwrap_or_else(|e| e.into_inner());
        let was_cancelled = cancelled.load(Ordering::SeqCst);
        let mut pool = idle.lock().unwrap_or_else(|e| e.into_inner());
        if outcome.is_ok() && !was_cancelled && !pool.stopped && !pool.suspended && session.alive()
        {
            session.idle_since = Instant::now();
            pool.sessions.insert(r.cwd.clone(), session);
            if pool.sessions.len() > MAX_IDLE {
                if let Some(key) = pool
                    .sessions
                    .iter()
                    .min_by_key(|(_, s)| s.idle_since)
                    .map(|(p, _)| p.clone())
                {
                    pool.sessions.remove(&key);
                }
            }
        } else {
            drop(session);
        }
        runs.remove(&r.run_id);
        drop(pool);
        drop(runs);
        if was_cancelled {
            sink("cancelled", json!({}));
        } else if let Err(error) = outcome {
            sink("error", json!({"message": bounded_utf8(&error, 2000)}));
        } else {
            crate::log_info!(
                "{} 对话完成：{} · 本轮耗时 {} ms",
                spec.label,
                if reused {
                    "复用常驻会话"
                } else {
                    "首次加载会话"
                },
                started.elapsed().as_millis()
            );
            sink("completed", json!({"status":"completed"}));
        }
    });
    Ok(())
}

struct Turn<'a> {
    session: &'a mut Session,
    sink: &'a Sink,
    cancelled: &'a AtomicBool,
    start: Instant,
    last_protocol: Instant,
    got_output: bool,
    ready: bool,
    protocol_bytes: usize,
    messages: usize,
    output_bytes: usize,
    events: usize,
    sent_text: bool,
    saw_thought: bool,
    provider: &'static str,
}
impl Turn<'_> {
    fn event(&mut self, kind: &str, data: Value) -> Result<(), String> {
        self.events += 1;
        self.output_bytes += data.get("text").and_then(Value::as_str).map_or(0, str::len);
        if self.events > MAX_NORMALIZED_EVENTS || self.output_bytes > MAX_ASSISTANT_TURN_BYTES {
            return Err("CLI 回复超过安全上限".into());
        }
        (self.sink)(kind, data);
        Ok(())
    }
    fn read(&mut self) -> Result<Value, String> {
        loop {
            if self.cancelled.load(Ordering::SeqCst) {
                return Err("对话已取消".into());
            }
            if self.start.elapsed() > TURN_TIMEOUT
                || (!self.ready && self.start.elapsed() > STARTUP_TIMEOUT)
            {
                return Err("CLI 对话服务响应超时".into());
            }
            let line = match self.session.lines.recv_timeout(Duration::from_millis(100)) {
                Ok(Ok(Some(line))) => line,
                Ok(Err(e)) if e == OVERSIZED_PROTOCOL_NOTIFICATION => {
                    crate::log_warn!(
                        "{} 跳过过大的 session/update，本轮继续",
                        provider_label(self.provider)
                    );
                    continue;
                }
                Ok(Err(e)) => return Err(e),
                Ok(Ok(None)) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("CLI 常驻服务已退出，请确认登录状态后重试".into())
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if !self.session.alive() {
                        return Err("CLI 常驻服务意外退出".into());
                    }
                    if self.ready {
                        let limit = if self.got_output {
                            PROTOCOL_IDLE_AFTER_OUTPUT
                        } else {
                            PROTOCOL_IDLE_BEFORE_OUTPUT
                        };
                        if self.last_protocol.elapsed() > limit {
                            return Err(if self.got_output {
                                "CLI 开始回复后长时间没有新输出，已停止"
                            } else {
                                "CLI 等待模型回复过久。超长历史可用 /compress（Qwen）等原生命令压缩后再问，或开新对话"
                            }
                            .into());
                        }
                    }
                    continue;
                }
            };
            self.last_protocol = Instant::now();
            self.messages += 1;
            self.protocol_bytes += line.len();
            if self.messages > MAX_PROTOCOL_MESSAGES
                || self.protocol_bytes > MAX_PROTOCOL_TURN_BYTES
            {
                return Err("CLI 协议输出超过安全上限".into());
            }
            if line.trim().is_empty() {
                continue;
            }
            if self.ready {
                self.got_output = true;
            }
            return serde_json::from_str(&line).map_err(|_| "CLI 没有返回有效的结构化消息".into());
        }
    }
    fn set_thread(&mut self, id: &str) -> Result<(), String> {
        if id.is_empty() || id.len() > 160 || safe_event_id(id, "") != id {
            return Err("CLI 返回了无效的会话 ID".into());
        }
        if !self.session.thread.is_empty() && self.session.thread != id {
            return Err("CLI 返回了不同会话的消息，已停止".into());
        }
        if self.session.thread.is_empty() {
            self.session.thread = id.into();
        }
        self.event("thread", json!({"threadId":id}))
    }
    fn ready(&mut self, reused: bool) {
        self.ready = true;
        self.last_protocol = Instant::now();
        self.got_output = false;
        crate::log_info!(
            "{} 对话就绪：{} · 准备耗时 {} ms",
            provider_label(self.provider),
            if reused {
                "复用常驻会话"
            } else {
                "首次加载会话"
            },
            self.start.elapsed().as_millis()
        );
    }
    fn parsed(&mut self, parsed: ParsedLine) -> Result<(), String> {
        if let Some(error) = parsed.error {
            return Err(error);
        }
        if let Some(text) = parsed.assistant_delta.filter(|t| !t.is_empty()) {
            self.sent_text = true;
            self.event("assistant_delta", json!({"text":text}))?;
        }
        if let Some(items) = parsed.plan {
            self.event("plan", json!({"items":items}))?;
        }
        for activity in parsed.activities {
            self.event("activity", activity)?;
        }
        Ok(())
    }
    fn stream(&mut self, r: &HeadlessStart, reused: bool) -> Result<(), String> {
        if reused {
            self.set_thread(&r.thread_id)?;
            self.ready(reused);
        }
        let input = if self.provider == "agy" {
            json!({"event":"user","message":{"role":"user","content":r.prompt}})
        } else {
            json!({"type":"user","session_id":r.thread_id,"message":{"role":"user","content":r.prompt}})
        };
        self.session.send(&input)?;
        let mut fallback = String::new();
        loop {
            let value = self.read()?;
            if value
                .get("parent_tool_use_id")
                .is_some_and(|v| !v.is_null())
            {
                continue;
            }
            if value["type"] == "control_request" {
                let response = if value["request"]["subtype"] == "can_use_tool" {
                    json!({"subtype":"success","request_id":value["request_id"],"response":{"behavior":"deny","message":"此对话不接受交互审批"}})
                } else {
                    json!({"subtype":"error","request_id":value["request_id"],"error":"Client capability not supported"})
                };
                self.session
                    .send(&json!({"type":"control_response","response":response}))?;
                continue;
            }
            let mut parsed = if self.provider == "agy" {
                parse_agy(&value)
            } else if self.provider == "qwen" {
                parse_qwen_line(&value)
            } else {
                parse_anthropic_line(&value)
            };
            if let Some(id) = parsed.session_id.take() {
                if self.session.thread.is_empty() {
                    if !r.thread_id.is_empty() && id != r.thread_id {
                        return Err("CLI 没有恢复指定的历史会话".into());
                    }
                    self.set_thread(&id)?;
                    self.ready(reused);
                } else if self.session.thread != id {
                    continue;
                }
            }
            if let Some(text) = parsed.fallback_answer.take() {
                fallback = text;
            }
            self.parsed(parsed)?;
            if value["type"] == "result" || value["event"] == "result" {
                if self.session.thread.is_empty() {
                    return Err("CLI 完成但未返回会话 ID".into());
                }
                if !self.sent_text && !fallback.is_empty() {
                    self.event("assistant_message", json!({"text":fallback}))?;
                }
                return Ok(());
            }
        }
    }
    fn rpc(&mut self, method: &str, params: Value, updates: bool) -> Result<Value, String> {
        let id = self.session.next_id;
        self.session.next_id += 1;
        self.session
            .send(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        loop {
            let value = self.read()?;
            if value.get("method").is_some() && value.get("id").is_some() {
                // Never implement client-side filesystem or terminal tools. The CLI
                // must enforce its own sandbox; requests for extra permission are denied.
                let result = if value["method"] == "session/request_permission" {
                    json!({"outcome":{"outcome":"cancelled"}})
                } else {
                    Value::Null
                };
                let reply = if result.is_null() {
                    json!({"jsonrpc":"2.0","id":value["id"],"error":{"code":-32601,"message":"Client capability not supported"}})
                } else {
                    json!({"jsonrpc":"2.0","id":value["id"],"result":result})
                };
                self.session.send(&reply)?;
                continue;
            }
            if value["id"].as_u64() == Some(id) {
                if let Some(error) = value.get("error") {
                    return Err(format!(
                        "{} 协议请求失败：{}",
                        provider_label(self.provider),
                        error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("未知错误")
                    ));
                }
                return value
                    .get("result")
                    .cloned()
                    .ok_or_else(|| "CLI 返回了无效的协议结果".into());
            }
            if updates && value["method"] == "session/update" {
                let sid = value["params"]["sessionId"].as_str().unwrap_or("");
                if !sid.is_empty() && sid != self.session.thread {
                    crate::log_warn!(
                        "{} 忽略其他会话的 update：{} != {}",
                        provider_label(self.provider),
                        sid,
                        self.session.thread
                    );
                } else {
                    self.acp_update(&value["params"]["update"])?;
                }
            }
        }
    }
    fn acp_text(content: &Value) -> String {
        if content.get("type").and_then(Value::as_str) == Some("text") {
            return content
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
        }
        extract_text_content(content)
    }

    fn acp_update(&mut self, update: &Value) -> Result<(), String> {
        let kind = update["sessionUpdate"]
            .as_str()
            .or_else(|| update["type"].as_str())
            .unwrap_or("");
        match kind {
            "agent_message_chunk" | "agent_message" | "content" => {
                let text = Self::acp_text(&update["content"]);
                if !text.is_empty() {
                    self.sent_text = true;
                    self.event("assistant_delta", json!({ "text": text }))?;
                }
            }
            "agent_thought_chunk" | "agent_thought" => {
                self.saw_thought = true;
            }
            "tool_call" | "tool_call_update" => {
                let status = match update["status"].as_str() {
                    Some("completed") => "completed",
                    Some("failed") => "failed",
                    _ => "inProgress",
                };
                self.event(
                    "activity",
                    tool_activity(
                        update["toolCallId"].as_str().unwrap_or("tool"),
                        update["kind"].as_str().unwrap_or("tool"),
                        status,
                    ),
                )?;
            }
            "plan" => {
                let items: Vec<_> = update["entries"].as_array().into_iter().flatten().take(64).filter_map(|p| {
                    let text = p["content"].as_str()?;
                    Some(json!({"step":bounded_utf8(text,500),"status":match p["status"].as_str(){Some("completed")=>"completed",Some("in_progress")=>"inProgress",_=>"pending"}}))
                }).collect();
                self.event("plan", json!({"items":items}))?;
            }
            "current_mode_update"
            | "available_commands_update"
            | "config_options_update"
            | "usage_update"
            | "user_message_chunk"
            | "user_message"
            | "session_info_update" => {}
            _ => {
                if self.ready && !kind.is_empty() {
                    crate::log_warn!(
                        "{} 未识别的 session/update：{}",
                        provider_label(self.provider),
                        kind
                    );
                }
            }
        }
        Ok(())
    }
    fn acp(&mut self, r: &HeadlessStart, reused: bool) -> Result<(), String> {
        if !reused {
            let init = self.rpc("initialize", json!({"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false},"clientInfo":{"name":"roster","version":env!("CARGO_PKG_VERSION")},"_meta":{"startupHints":{"nonInteractive":true,"skipGitStatus":true,"skipProjectLayout":true}}}), false)?;
            if init["protocolVersion"] != 1 {
                return Err("CLI 的 ACP 协议版本不兼容".into());
            }
            if !r.thread_id.is_empty() && init["agentCapabilities"]["loadSession"] != true {
                return Err("当前 CLI 不支持常驻协议恢复历史".into());
            }
            let mut params = json!({"cwd":r.cwd,"mcpServers":[]});
            if !r.thread_id.is_empty() {
                params["sessionId"] = json!(r.thread_id);
            }
            if self.provider == "grok" {
                params["_meta"] = json!({
                    "yoloMode": r.mode.id == "bypassPermissions",
                    "autoMode": r.mode.id == "auto",
                    "noReplay": true,
                    "rules": grok_permission_rule(r.mode.id),
                });
            } else if matches!(self.provider, "opencode" | "mimo") {
                // History is shown from disk. ACP replay of tool output can exceed
                // the 1 MiB line budget and abort a live turn.
                params["_meta"] = json!({"noReplay":true});
            }
            let info = self.rpc(
                if r.thread_id.is_empty() {
                    "session/new"
                } else {
                    "session/load"
                },
                params,
                false,
            )?;
            let id = info["sessionId"]
                .as_str()
                .or_else(|| info.pointer("/session/sessionId").and_then(Value::as_str))
                .or_else(|| info.pointer("/session/id").and_then(Value::as_str))
                .unwrap_or(&r.thread_id);
            if !r.thread_id.is_empty() && id != r.thread_id {
                return Err("CLI 没有恢复指定的历史会话".into());
            }
            self.set_thread(id)?;
            let thread = self.session.thread.clone();
            if self.provider == "grok" {
                // Grok's ACP session mode is plan vs default. Auto / always-approve
                // are `_meta.autoMode` / `_meta.yoloMode` on session/new plus the
                // CLI `--permission-mode`. Calling set_mode("auto") is ignored and
                // can leave the session in Normal; set_mode("default") overwrites
                // Auto on purpose. Only Plan needs session/set_mode.
                if r.mode.id == "plan" {
                    self.rpc(
                        "session/set_mode",
                        json!({"sessionId":thread,"modeId":"plan"}),
                        false,
                    )?;
                }
                if !r.model.is_empty() {
                    self.rpc(
                        "session/set_model",
                        json!({"sessionId":thread,"modelId":r.model}),
                        false,
                    )?;
                }
            } else {
                self.rpc(
                    "session/set_mode",
                    json!({"sessionId":thread,"modeId":r.mode.id}),
                    false,
                )?;
                let model = acp_model(&info, &r.model, &r.effort)?;
                if let Some(model) = model {
                    self.rpc(
                        "session/set_model",
                        json!({"sessionId":thread,"modelId":model}),
                        false,
                    )?;
                }
            }
        } else {
            self.set_thread(&r.thread_id)?;
        }
        self.ready(reused);
        let mut prompt = r.prompt.clone();
        if let Some(slash) = &r.slash {
            prompt = if slash.kind == crate::conversation_slash::ConversationSlashKind::Command {
                format!("/{} {}", slash.id, slash.args)
            } else {
                format!(
                    "Use the locally installed skill named '{}'. User request: {}",
                    slash.id, slash.args
                )
            };
        }
        let params =
            json!({"sessionId":self.session.thread,"prompt":[{"type":"text","text":prompt}]});
        let result = self.rpc("session/prompt", params, true)?;
        match result["stopReason"].as_str() {
            Some("end_turn" | "max_tokens" | "max_turn_requests") => {
                if self.sent_text {
                    Ok(())
                } else if self.saw_thought {
                    Err("CLI 只返回了内部推理，没有对用户的可见回复".into())
                } else {
                    Err("CLI 完成本轮但没有返回可见回复".into())
                }
            }
            Some("cancelled") => Err("CLI 取消了本轮请求（可能需要交互审批）".into()),
            _ => Err("CLI 返回了未成功完成的停止状态".into()),
        }
    }
}

fn acp_model(info: &Value, model: &str, effort: &str) -> Result<Option<String>, String> {
    if model.is_empty() && effort.is_empty() {
        return Ok(None);
    }
    let base = if model.is_empty() {
        info.pointer("/models/currentModelId")
            .and_then(Value::as_str)
            .or_else(|| {
                info["configOptions"]
                    .as_array()?
                    .iter()
                    .find(|o| o["id"] == "model")?["currentValue"]
                    .as_str()
            })
            .ok_or("CLI 未返回当前模型，无法设置推理强度")?
    } else {
        model
    };
    if effort.is_empty() {
        return Ok(Some(base.into()));
    }
    let candidate = format!("{base}/{effort}");
    let available = info
        .pointer("/models/availableModels")
        .and_then(Value::as_array)
        .is_some_and(|a| a.iter().any(|m| m["modelId"] == candidate))
        || info["configOptions"].as_array().is_some_and(|a| {
            a.iter()
                .filter(|o| o["id"] == "model")
                .flat_map(|o| o["options"].as_array().into_iter().flatten())
                .any(|o| o["value"] == candidate)
        });
    if available {
        Ok(Some(candidate))
    } else {
        Err("当前 CLI 的常驻模型列表未提供这个推理强度，请先选择默认强度".into())
    }
}

fn parse_agy(value: &Value) -> ParsedLine {
    if value.get("type").is_some() {
        return parse_anthropic_line(value);
    }
    let mut parsed = ParsedLine {
        session_id: first_string(
            value,
            &[
                "/conversation_id",
                "/result/conversation_id",
                "/step_update/conversation_id",
            ],
        )
        .map(str::to_string),
        ..ParsedLine::default()
    };
    match value["event"].as_str().unwrap_or("") {
        "step_update" => {
            let step = &value["step_update"];
            if step["step_type"] == "agent_response" {
                parsed.assistant_delta = step["text_delta"].as_str().map(str::to_string);
            } else if step["step_type"]
                .as_str()
                .is_some_and(|s| s.contains("tool"))
            {
                parsed.activities.push(tool_activity(
                    "agy-tool",
                    "tool",
                    if step["state"] == "DONE" {
                        "completed"
                    } else {
                        "inProgress"
                    },
                ));
            }
        }
        "result" => {
            parsed.fallback_answer = value["result"]["response"].as_str().map(str::to_string);
            if value["result"]["status"] != "SUCCESS" {
                parsed.error = Some(bounded_utf8(
                    value["result"]["error"].as_str().unwrap_or("agy 处理失败"),
                    2000,
                ));
            }
        }
        _ => {}
    }
    parsed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(cwd: &Path, run: &str, thread: &str, provider: &str) -> HeadlessStart {
        HeadlessStart {
            project_id: cwd.to_string_lossy().into_owned(),
            run_id: run.into(),
            thread_id: thread.into(),
            prompt: "只回复测试，不要使用工具，不要读写文件".into(),
            mode: crate::conversation_modes::default_mode(provider),
            model: String::new(),
            effort: String::new(),
            slash: None,
            cwd: cwd.into(),
        }
    }
    #[cfg(unix)]
    fn launch(
        state: &ConversationChatState,
        cwd: &Path,
        run: &str,
        thread: &str,
        provider: &str,
        scenario: &str,
    ) -> Receiver<(String, Value)> {
        start_fake(
            state,
            cwd,
            provider,
            scenario,
            request(cwd, run, thread, provider),
        )
    }
    #[cfg(unix)]
    fn start_fake(
        state: &ConversationChatState,
        cwd: &Path,
        provider: &str,
        scenario: &str,
        r: HeadlessStart,
    ) -> Receiver<(String, Value)> {
        let (tx, rx) = mpsc::channel();
        let sink: Sink = Arc::new(move |kind, data| {
            let _ = tx.send((kind.into(), data));
        });
        let mut cmd = Command::new("node");
        cmd.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-resident-cli.cjs"))
            .env("ROSTER_RESIDENT_PROVIDER", provider)
            .env("ROSTER_RESIDENT_SCENARIO", scenario)
            .env("ROSTER_RESIDENT_LOG", cwd.join("requests.jsonl"));
        let cancelled = crate::codex_chat::reserve_run(state, &r.project_id, &r.run_id).unwrap();
        start_reserved(
            state,
            *provider_spec(provider).unwrap(),
            r,
            cmd,
            cancelled,
            sink,
        )
        .unwrap();
        rx
    }
    #[cfg(unix)]
    fn until(rx: &Receiver<(String, Value)>, target: &str) -> Vec<(String, Value)> {
        let mut all = Vec::new();
        loop {
            let event = rx.recv_timeout(Duration::from_secs(15)).unwrap();
            let done = event.0 == target;
            all.push(event);
            if done {
                return all;
            }
        }
    }
    #[test]
    fn resident_arguments_preserve_each_cli_permission_and_customization_flags() {
        for id in ["claude", "qwen", "agy", "grok", "opencode", "mimo"] {
            let mut r = request(Path::new("/tmp/project"), "r", "", id);
            let cmd = command(provider_spec(id).unwrap(), PathBuf::from("/bin/cli"), &r);
            let args: Vec<_> = cmd
                .get_args()
                .map(|a| a.to_string_lossy().into_owned())
                .collect();
            assert!(!args.iter().any(|a| a == &r.prompt));
            if matches!(id, "claude" | "qwen" | "agy") {
                assert!(args
                    .windows(2)
                    .any(|a| a == ["--input-format", "stream-json"]));
                assert!(args.contains(&"plan".to_string()));
            }
            if matches!(id, "opencode" | "mimo") {
                assert_eq!(args[0], "acp");
                assert!(args.contains(&"--pure".into()));
            }
            if id == "grok" {
                assert!(args.windows(2).any(|a| a == ["--sandbox", "workspace"]));
                assert!(args.contains(&"--no-leader".into()));
                assert!(args
                    .windows(2)
                    .any(|a| a[0] == "--rules" && a[1].contains("只读计划")));
                assert!(grok_permission_rule("auto").contains("「自动」"));
                assert!(grok_permission_rule("auto").contains("不要说成「普通对话」"));
                assert!(grok_permission_rule("bypassPermissions").contains("始终批准"));
                r.thread_id = "existing".into();
                r.model = "grok-4.5".into();
                r.effort = "high".into();
                let c = command(provider_spec(id).unwrap(), PathBuf::from("/bin/cli"), &r);
                let resumed: Vec<_> = c
                    .get_args()
                    .map(|a| a.to_string_lossy().into_owned())
                    .collect();
                assert!(!resumed.iter().any(|a| a == "--sandbox"));
                assert!(resumed.windows(2).any(|a| a == ["--model", "grok-4.5"]));
                assert!(resumed
                    .windows(2)
                    .any(|a| a == ["--reasoning-effort", "high"]));
            }
        }
    }
    #[test]
    fn agy_current_protocol_keeps_text_and_errors_without_reasoning() {
        assert_eq!(parse_agy(&json!({"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"你好"}})).assistant_delta.as_deref(),Some("你好"));
        assert!(parse_agy(&json!({"event":"step_update","step_update":{"step_type":"thinking","text_delta":"私有"}})).assistant_delta.is_none());
        assert!(
            parse_agy(&json!({"event":"result","result":{"status":"ERROR","error":"failed"}}))
                .error
                .is_some()
        );
    }
    #[test]
    fn acp_effort_uses_only_advertised_model_variants() {
        let info = json!({"models":{"currentModelId":"provider/model","availableModels":[{"modelId":"provider/model/high"}]}});
        assert_eq!(
            acp_model(&info, "", "high").unwrap(),
            Some("provider/model/high".into())
        );
        assert!(acp_model(&info, "", "invalid").is_err());
    }

    #[test]
    fn unattended_acp_permissions_preserve_existing_settings_without_widening() {
        let config:Value=serde_json::from_str(&noninteractive_config(Some(r#"{"model":"provider/model","permission":{"edit":"deny","bash":{"git status":"allow","*":"ask"}},"provider":{"custom":{"options":{"example":"preserve"}}}}"#)).unwrap()).unwrap();
        assert_eq!(config["model"], "provider/model");
        assert_eq!(config["permission"]["edit"], "deny");
        assert_eq!(config["permission"]["bash"]["*"], "ask");
        assert_eq!(
            config["provider"]["custom"]["options"]["example"],
            "preserve"
        );
        for tool in ["question", "plan_enter", "plan_exit"] {
            assert_eq!(config["permission"][tool], "deny");
        }
        let deny: Value =
            serde_json::from_str(&noninteractive_config(Some(r#"{"permission":"deny"}"#)).unwrap())
                .unwrap();
        assert_eq!(deny["permission"]["*"], "deny");
        assert!(noninteractive_config(Some("broken")).is_err());
        assert!(noninteractive_config(Some("[]")).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn all_six_adapters_reuse_same_process_and_route_only_current_public_reply() {
        for provider in ["claude", "agy", "qwen", "grok", "opencode", "mimo"] {
            let root = tempfile::tempdir().unwrap();
            let cwd = root.path();
            let state = ConversationChatState::default();
            let first = until(
                &launch(&state, cwd, "first", "", provider, "normal"),
                "completed",
            );
            assert!(first.iter().all(|e| e.0 != "error"));
            let pid = state.other_resident.inner.lock().unwrap().sessions[cwd]
                .process
                .lock()
                .unwrap()
                .id();
            let events = until(
                &launch(
                    &state,
                    cwd,
                    "second",
                    &format!("session-{provider}"),
                    provider,
                    "normal",
                ),
                "completed",
            );
            assert_eq!(
                events
                    .iter()
                    .filter(|e| e.0 == "assistant_delta" || e.0 == "assistant_message")
                    .filter_map(|e| e.1["text"].as_str())
                    .collect::<String>(),
                "回复2",
                "{provider}"
            );
            assert_eq!(
                state.other_resident.inner.lock().unwrap().sessions[cwd]
                    .process
                    .lock()
                    .unwrap()
                    .id(),
                pid
            );
            assert!(state.active.lock().unwrap().is_empty());
            let requests = std::fs::read_to_string(cwd.join("requests.jsonl")).unwrap();
            assert_eq!(
                requests.matches("initialize").count(),
                if matches!(provider, "grok" | "mimo" | "opencode") {
                    1
                } else {
                    0
                }
            );
            crate::codex_chat::cancel(&state, "first").unwrap();
            assert!(state.other_resident.inner.lock().unwrap().sessions[cwd].alive());
            state.set_resident_enabled(false);
            assert!(state
                .other_resident
                .inner
                .lock()
                .unwrap()
                .sessions
                .is_empty());
        }
    }
    #[cfg(unix)]
    #[test]
    fn resident_cancel_crash_and_protocol_overflow_release_slots() {
        for (provider, scenario) in [
            ("qwen", "hang"),
            ("mimo", "hang"),
            ("agy", "oversized"),
            ("opencode", "reject-mode"),
        ] {
            let root = tempfile::tempdir().unwrap();
            let state = ConversationChatState::default();
            let rx = launch(&state, root.path(), "first", "", provider, scenario);
            if scenario == "hang" {
                until(&rx, "assistant_delta");
                crate::codex_chat::cancel(&state, "first").unwrap();
                until(&rx, "cancelled");
            } else {
                until(&rx, "error");
            }
            assert!(state.active.lock().unwrap().is_empty());
            assert!(state
                .other_resident
                .inner
                .lock()
                .unwrap()
                .sessions
                .is_empty());
        }
    }

    #[cfg(unix)]
    #[test]
    fn resident_acp_skips_oversized_session_update_and_still_completes() {
        let root = tempfile::tempdir().unwrap();
        let state = ConversationChatState::default();
        let events = until(
            &launch(&state, root.path(), "first", "", "mimo", "oversized-update"),
            "completed",
        );
        assert!(events.iter().all(|(kind, _)| kind != "error"));
        assert!(events
            .iter()
            .any(|(kind, data)| { kind == "assistant_delta" && data["text"] == "回复1" }));
    }

    #[cfg(unix)]
    #[test]
    fn resident_acp_accepts_agent_message_without_session_id() {
        let root = tempfile::tempdir().unwrap();
        let state = ConversationChatState::default();
        let events = until(
            &launch(&state, root.path(), "first", "", "mimo", "agent-message"),
            "completed",
        );
        assert!(events.iter().all(|(kind, _)| kind != "error"));
        assert!(events
            .iter()
            .any(|(kind, data)| { kind == "assistant_delta" && data["text"] == "回复1" }));
    }

    #[cfg(unix)]
    #[test]
    fn resident_acp_empty_visible_reply_is_an_error() {
        let root = tempfile::tempdir().unwrap();
        let state = ConversationChatState::default();
        let events = until(
            &launch(&state, root.path(), "first", "", "mimo", "empty-reply"),
            "error",
        );
        assert!(events.iter().any(|(kind, data)| {
            kind == "error" && data["message"].as_str().unwrap_or("").contains("内部推理")
        }));
    }

    #[cfg(unix)]
    #[test]
    fn resident_grok_acp_keeps_selected_permission_mode() {
        let root = tempfile::tempdir().unwrap();
        let state = ConversationChatState::default();
        let mut r = request(root.path(), "first", "", "grok");
        r.mode = crate::conversation_modes::resolve("grok", "auto").unwrap();
        r.model = "grok-4.5".into();
        r.effort = "high".into();
        until(
            &start_fake(&state, root.path(), "grok", "normal", r),
            "completed",
        );
        let requests: Vec<Value> = std::fs::read_to_string(root.path().join("requests.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap()["request"].clone())
            .collect();
        let new = requests
            .iter()
            .find(|request| request["method"] == "session/new")
            .unwrap();
        assert_eq!(new["params"]["_meta"]["autoMode"], true);
        assert_eq!(new["params"]["_meta"]["yoloMode"], false);
        assert!(new["params"]["_meta"]["rules"]
            .as_str()
            .unwrap_or("")
            .contains("「自动」"));
        assert!(
            requests
                .iter()
                .all(|request| request["method"] != "session/set_mode"),
            "auto 不能走 session/set_mode，否则 Grok 会落回普通对话"
        );
        let set_model = requests
            .iter()
            .find(|request| request["method"] == "session/set_model")
            .unwrap();
        assert_eq!(set_model["params"]["modelId"], "grok-4.5");
        let prompt = requests
            .iter()
            .find(|request| request["method"] == "session/prompt")
            .unwrap();
        assert_ne!(prompt["params"]["_meta"]["mode"], "default");
        assert!(prompt["params"].get("_meta").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn resident_opencode_and_mimo_session_load_skip_history_replay() {
        for provider in ["opencode", "mimo"] {
            let root = tempfile::tempdir().unwrap();
            let state = ConversationChatState::default();
            let thread = format!("session-{provider}");
            until(
                &launch(&state, root.path(), "first", &thread, provider, "normal"),
                "completed",
            );
            let requests: Vec<Value> = std::fs::read_to_string(root.path().join("requests.jsonl"))
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str::<Value>(line).unwrap()["request"].clone())
                .collect();
            let load = requests
                .iter()
                .find(|request| request["method"] == "session/load")
                .unwrap();
            assert_eq!(load["params"]["_meta"]["noReplay"], true, "{provider}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn resident_pool_limits_projects_and_recovers_after_idle_process_death() {
        let root = tempfile::tempdir().unwrap();
        let state = ConversationChatState::default();
        for n in 0..6 {
            let cwd = root.path().join(n.to_string());
            std::fs::create_dir(&cwd).unwrap();
            until(
                &launch(&state, &cwd, &format!("run-{n}"), "", "qwen", "normal"),
                "completed",
            );
            assert!(state.other_resident.inner.lock().unwrap().sessions.len() <= MAX_IDLE);
        }
        let cwd = root.path().join("5");
        {
            let pool = state.other_resident.inner.lock().unwrap();
            let session = &pool.sessions[&cwd];
            session.tree.terminate();
            stop_child(&mut session.process.lock().unwrap(), false);
        }
        until(
            &launch(&state, &cwd, "retry", "session-qwen", "qwen", "normal"),
            "completed",
        );
        state.shutdown();
        assert!(state
            .other_resident
            .inner
            .lock()
            .unwrap()
            .sessions
            .is_empty());
    }

    #[test]
    fn resident_signature_ignores_prompt_and_resume_but_changes_with_permissions() {
        let root = tempfile::tempdir().unwrap();
        let spec = provider_spec("qwen").unwrap();
        let mut r = request(root.path(), "first", "", "qwen");
        let cmd = Command::new("/bin/fake");
        let first = signature(spec, &r, &cmd);
        r.prompt = "第二条消息".into();
        r.thread_id = "session-qwen".into();
        r.run_id = "second".into();
        assert_eq!(signature(spec, &r, &cmd), first);
        r.mode = crate::conversation_modes::modes_for("qwen")
            .iter()
            .copied()
            .find(|m| m.writes)
            .unwrap();
        assert_ne!(signature(spec, &r, &cmd), first);
    }
    #[cfg(unix)]
    #[test]
    #[ignore = "真实本机 CLI 常驻两轮验收；消耗用量，需通过 ROSTER_PROBE_CLI 指定一家"]
    fn probe_local_resident_cli_two_turns() {
        let provider = std::env::var("ROSTER_PROBE_CLI").expect("ROSTER_PROBE_CLI");
        let root = tempfile::tempdir().unwrap();
        let cwd = std::fs::canonicalize(root.path()).unwrap();
        let state = ConversationChatState::default();
        let mut thread = String::new();
        let mut pid = None;
        let cold = std::env::var_os("ROSTER_PROBE_COLD").is_some();
        for n in 1..=if cold { 3 } else { 2 } {
            if n == 3 {
                state.release_idle(Some(&cwd));
            }
            let (tx, rx) = mpsc::channel();
            let sink: Sink = Arc::new(move |k, d| {
                let _ = tx.send((k.to_string(), d));
            });
            let run = format!("probe-{n}");
            let mut r = request(&cwd, &run, &thread, &provider);
            if n == 3 && std::env::var_os("ROSTER_PROBE_PERMISSION").is_some() {
                r.prompt="请在当前项目创建 resident-forbidden-write.txt，内容为probe。不要退出当前计划模式或请求改权限。".into();
            }
            if provider == "grok" {
                r.effort = "low".into();
            }
            let spec = *provider_spec(&provider).unwrap();
            let binary = crate::cli_detect::resolve_registered_cli_bin(spec.binary).unwrap();
            let cmd = command(&spec, binary, &r);
            let flag = crate::codex_chat::reserve_run(&state, &r.project_id, &run).unwrap();
            let now = Instant::now();
            start_reserved(&state, spec, r, cmd, flag, sink).unwrap();
            loop {
                let (kind, data) = rx.recv_timeout(Duration::from_secs(120)).unwrap();
                assert_ne!(kind, "error", "{provider}: {data}");
                if kind == "thread" {
                    thread = data["threadId"].as_str().unwrap().into();
                }
                if kind == "completed" {
                    break;
                }
            }
            let current = state.other_resident.inner.lock().unwrap().sessions[&cwd]
                .process
                .lock()
                .unwrap()
                .id();
            if let Some(pid) = pid {
                if n == 3 {
                    assert_ne!(pid, current);
                } else {
                    assert_eq!(pid, current);
                }
            }
            pid = Some(current);
            eprintln!(
                "resident {provider} round={n} elapsed_ms={} same_process={}",
                now.elapsed().as_millis(),
                n == 2
            );
            assert!(
                !cwd.join("resident-forbidden-write.txt").exists(),
                "只读计划档不能写文件"
            );
        }
        state.shutdown();
    }
}
