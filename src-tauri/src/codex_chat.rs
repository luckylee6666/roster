//! 普通用户对话工作台的 Codex 适配器。
//!
//! 每个 turn 使用一条独立的 `codex app-server --stdio` 连接：完成后立即回收进程，
//! 下一轮通过 thread id 恢复。这样不会长期占用 writer，也能和安装版 Codex 的线程锁
//! 明确隔离。前端只收到经过收敛的消息、计划和活动事件，不接触原始 JSON-RPC、
//! reasoning 文本、命令完整输出或工具参数。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
struct WindowsJob(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
unsafe impl Send for WindowsJob {}
#[cfg(windows)]
unsafe impl Sync for WindowsJob {}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

/// A generation-stable owner for a spawned process tree. Windows Job Objects
/// keep working after the leader exits, unlike a PID-based `taskkill /T`.
#[derive(Clone)]
pub(crate) struct ProcessTreeGuard {
    #[cfg(windows)]
    job: Arc<WindowsJob>,
}

impl ProcessTreeGuard {
    /// Explicitly end the tree before waiting for the leader/stdout. A child
    /// can retain stdout, so waiting for this guard's Drop can deadlock cleanup.
    pub(crate) fn terminate(&self) {
        #[cfg(windows)]
        unsafe {
            let _ = windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job.0, 1);
        }
    }
}

/// Must be called immediately after spawn. Refuse startup if job registration
/// fails; silently continuing would leave a tree that cannot be safely reaped.
pub(crate) fn register_process_tree(child: &Child) -> Result<ProcessTreeGuard, String> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        let raw_job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw_job.is_null() {
            return Err(format!(
                "无法创建 Windows Job Object：{}",
                std::io::Error::last_os_error()
            ));
        }
        let job = Arc::new(WindowsJob(raw_job));
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const std::ffi::c_void,
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(format!(
                "无法配置 Windows Job Object：{}",
                std::io::Error::last_os_error()
            ));
        }
        if unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle()) } == 0 {
            return Err(format!(
                "无法将对话进程加入 Windows Job Object：{}",
                std::io::Error::last_os_error()
            ));
        }
        return Ok(ProcessTreeGuard { job });
    }
    #[cfg(not(windows))]
    {
        let _ = child;
        Ok(ProcessTreeGuard {})
    }
}

pub(crate) const MAX_ACTIVE_RUNS: usize = 4;
pub(crate) const MAX_PROMPT_BYTES: usize = 64 * 1024;
const MAX_EVENT_TEXT_CHARS: usize = 32 * 1024;
const MAX_PROTOCOL_LINE_BYTES: usize = 1024 * 1024;
const MAX_PROTOCOL_MESSAGES: usize = 16_384;
const MAX_PROTOCOL_TURN_BYTES: usize = 64 * 1024 * 1024;
const MAX_ASSISTANT_TURN_BYTES: usize = 2 * 1024 * 1024;
const MAX_NORMALIZED_EVENTS: usize = 4_096;
const MAX_ACTIVITY_PATH_BYTES: usize = 1_024;
const MAX_ACTIVITY_FILES_PER_EVENT: usize = 32;
const MAX_ACTIVITY_EVENT_BYTES: usize = 64 * 1024;
const MAX_ACTIVITY_EVENTS_PER_TURN: usize = 1_024;
const MAX_ACTIVITY_TURN_BYTES: usize = 4 * 1024 * 1024;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);
const TURN_TIMEOUT: Duration = Duration::from_secs(60 * 60);

#[derive(Clone)]
pub(crate) struct ActiveRun {
    pub(crate) project_id: String,
    // A run is reserved before resolving or spawning its CLI. This closes the
    // check-then-spawn race while still allowing cancellation during startup.
    pub(crate) process: Option<Arc<Mutex<Child>>>,
    // Held until normal/cancellation cleanup removes the active run. Closing
    // this guard on Windows kills every assigned descendant.
    pub(crate) process_tree: Option<ProcessTreeGuard>,
    pub(crate) cancelled: Arc<AtomicBool>,
    // 「请求批准」这一档才用得上：协议线程正阻塞在读 stdout 上，而 Codex 在等
    // 我们回话，所以让那个线程自己等决定，比多一处共享 stdin 安全（不必再操心
    // stdin 的 EOF 时序）。这里只放一个发送端和"当前在等哪一条"。
    pub(crate) approval_tx: Option<Sender<ApprovalDecision>>,
    pub(crate) pending_approval: Arc<Mutex<Option<String>>>,
}

/// 用户对一条审批请求的答复。取值来自 app-server schema 的
/// CommandExecutionApprovalDecision / FileChangeApprovalDecision。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalDecision {
    Accept,
    AcceptForSession,
    Decline,
}

impl ApprovalDecision {
    fn as_protocol(self) -> &'static str {
        match self {
            Self::Accept => "accept",
            Self::AcceptForSession => "acceptForSession",
            Self::Decline => "decline",
        }
    }

    /// 前端只能传这三个词，别的一律拒——不认的值绝不能退化成"批准"。
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "accept" => Ok(Self::Accept),
            "acceptForSession" => Ok(Self::AcceptForSession),
            "decline" => Ok(Self::Decline),
            _ => Err("不认识的审批决定".into()),
        }
    }
}

#[derive(Default)]
pub struct CodexChatState {
    pub(crate) active: Arc<Mutex<HashMap<String, ActiveRun>>>,
}

impl Drop for CodexChatState {
    fn drop(&mut self) {
        let runs = self
            .active
            .lock()
            .map(|runs| runs.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for run in runs {
            run.cancelled.store(true, Ordering::SeqCst);
            if let Some(process_tree) = run.process_tree {
                process_tree.terminate();
            }
            if let Some(process) = run.process {
                if let Ok(mut child) = process.lock() {
                    stop_child(&mut child, false);
                }
            }
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexChatEvent {
    pub run_id: String,
    pub provider_id: String,
    pub kind: String,
    pub data: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexChatStartResult {
    pub run_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexChatStartInput {
    pub project_id: String,
    pub run_id: String,
    #[serde(default)]
    pub thread_id: String,
    pub prompt: String,
    #[serde(default)]
    pub allow_write: bool,
    /// Codex 自己的档位 ID（read-only / approve-for-me）。
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: String,
}

fn valid_protocol_id(value: &str, max_len: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

pub(crate) fn validate_run_id(value: &str) -> Result<(), String> {
    if valid_protocol_id(value, 96) {
        Ok(())
    } else {
        Err("对话运行 ID 非法".into())
    }
}

fn validate_thread_id(value: &str) -> Result<(), String> {
    if value.is_empty() || valid_protocol_id(value, 160) {
        Ok(())
    } else {
        Err("Codex 会话 ID 非法".into())
    }
}

pub(crate) fn validate_prompt(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("请输入这次要做什么".into());
    }
    if value.len() > MAX_PROMPT_BYTES {
        return Err("消息过长，请控制在 64KB 以内".into());
    }
    if value
        .chars()
        .any(|ch| ch == '\0' || ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
    {
        return Err("消息包含不支持的控制字符".into());
    }
    Ok(value.to_string())
}

pub(crate) fn validate_project_path(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path.trim());
    if !path.is_absolute() {
        return Err("项目路径必须是绝对路径".into());
    }
    let meta = std::fs::metadata(&path).map_err(|_| "项目目录不存在或不可访问".to_string())?;
    if !meta.is_dir() {
        return Err("项目路径不是目录".into());
    }
    std::fs::canonicalize(&path).map_err(|_| "项目目录无法安全解析".to_string())
}

fn bounded_text(value: &str, limit: usize) -> String {
    let mut out = value.chars().take(limit).collect::<String>();
    if value.chars().count() > limit {
        out.push('…');
    }
    out
}

fn bounded_utf8_bytes(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_string();
    }

    const ELLIPSIS: &str = "…";
    if limit < ELLIPSIS.len() {
        return String::new();
    }
    let mut end = limit - ELLIPSIS.len();
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    let mut output = value[..end].to_string();
    output.push_str(ELLIPSIS);
    output
}

fn normalized_status(value: Option<&str>) -> &'static str {
    match value {
        Some("inProgress") => "inProgress",
        Some("completed") => "completed",
        Some("failed") => "failed",
        Some("declined") => "declined",
        Some("cancelled") => "cancelled",
        _ => "unknown",
    }
}

fn normalized_plan_status(value: Option<&str>) -> &'static str {
    match value {
        Some("inProgress") => "inProgress",
        Some("completed") => "completed",
        _ => "pending",
    }
}

fn normalized_change_kind(value: Option<&str>) -> &'static str {
    match value {
        Some("add") => "add",
        Some("delete") => "delete",
        _ => "update",
    }
}

trait ChatEventSink: Send + Sync {
    fn emit(&self, event: CodexChatEvent);
}

struct MainWebviewSink {
    app: AppHandle,
}

impl ChatEventSink for MainWebviewSink {
    fn emit(&self, event: CodexChatEvent) {
        if let Some(window) = self.app.get_webview_window("main") {
            let _ = window.emit("conversation-chat-event", event);
        }
    }
}

fn emit_event(sink: &dyn ChatEventSink, run_id: &str, kind: &str, data: Value) {
    sink.emit(CodexChatEvent {
        run_id: run_id.to_string(),
        provider_id: "codex".to_string(),
        kind: kind.to_string(),
        data,
    });
}

fn relative_display_path(raw: &str, cwd: &Path) -> String {
    let path = Path::new(raw);
    let display = path
        .strip_prefix(cwd)
        .ok()
        .filter(|relative| !relative.as_os_str().is_empty())
        .filter(|relative| {
            relative
                .components()
                .all(|component| matches!(component, std::path::Component::Normal(_)))
        })
        .map(|relative| relative.to_string_lossy().into_owned())
        .unwrap_or_else(|| "项目外文件".to_string());
    bounded_utf8_bytes(&display, MAX_ACTIVITY_PATH_BYTES)
}

fn activity_from_item(item: &Value, cwd: &Path) -> Option<Value> {
    let item_type = item.get("type")?.as_str()?;
    let raw_id = item.get("id").and_then(Value::as_str).unwrap_or(item_type);
    let id = if valid_protocol_id(raw_id, 160) {
        raw_id
    } else {
        item_type
    };
    let status = normalized_status(item.get("status").and_then(Value::as_str));
    match item_type {
        "commandExecution" => Some(json!({
            "id": id,
            "type": "command",
            "status": status,
            "title": "执行项目操作",
        })),
        "fileChange" => {
            let files = item
                .get("changes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .take(MAX_ACTIVITY_FILES_PER_EVENT)
                .filter_map(|change| {
                    let path = change.get("path")?.as_str()?;
                    Some(json!({
                        "path": relative_display_path(path, cwd),
                        "kind": normalized_change_kind(change.get("kind").and_then(Value::as_str)),
                    }))
                })
                .collect::<Vec<_>>();
            Some(json!({
                "id": id,
                "type": "file",
                "status": status,
                "title": if files.len() == 1 { "更新 1 个文件" } else { "更新项目文件" },
                "files": files,
            }))
        }
        "webSearch" => Some(json!({
            "id": id,
            "type": "search",
            "status": status,
            "title": "搜索资料",
        })),
        "mcpToolCall" | "dynamicToolCall" => Some(json!({
            "id": id,
            "type": "tool",
            "status": status,
            "title": "使用工具",
        })),
        "collabAgentToolCall" | "subAgentActivity" => Some(json!({
            "id": id,
            "type": "agent",
            "status": status,
            "title": "协调协作者",
        })),
        "imageGeneration" => Some(json!({
            "id": id,
            "type": "image",
            "status": status,
            "title": "生成图片",
        })),
        _ => None,
    }
}

#[derive(Default)]
struct AssistantMessageState {
    // App Server's item/agentMessage/delta carries params.itemId and its final
    // item/completed carries params.item.id. Track them per message rather than
    // per turn: multiple agent messages can legitimately occur in one turn.
    delta_item_ids: HashSet<String>,
    // A few server versions omit every item ID on streamed deltas. Retain only
    // their bounded text so an identical final item can still be de-duplicated
    // without suppressing a different assistant message in the same turn.
    anonymous_delta_text: String,
    emitted_text: bool,
}

fn protocol_item_id(value: Option<&str>) -> Option<String> {
    value
        .filter(|value| valid_protocol_id(value, 160))
        .map(str::to_string)
}

fn agent_message_delta_item_id(message: &Value) -> Option<String> {
    protocol_item_id(message.pointer("/params/itemId").and_then(Value::as_str))
        .or_else(|| protocol_item_id(message.pointer("/params/item/id").and_then(Value::as_str)))
}

fn agent_message_completed_item_id(item: &Value) -> Option<String> {
    protocol_item_id(item.get("id").and_then(Value::as_str))
}

fn normalized_notification(
    message: &Value,
    cwd: &Path,
    assistant_messages: &AssistantMessageState,
) -> Option<(String, Value)> {
    let method = message.get("method")?.as_str()?;
    let params = message.get("params").unwrap_or(&Value::Null);
    match method {
        "item/agentMessage/delta" => {
            let text = bounded_text(params.get("delta")?.as_str()?, MAX_EVENT_TEXT_CHARS);
            (!text.is_empty()).then(|| ("assistant_delta".into(), json!({ "text": text })))
        }
        "item/started" | "item/completed" => {
            let item = params.get("item")?;
            if item.get("type").and_then(Value::as_str) == Some("agentMessage") {
                if method != "item/completed" {
                    return None;
                }
                // App Server often repeats the complete assistant message here.
                // Suppress only the matching item: another agent message in this
                // same turn may have no deltas and still needs its fallback text.
                if agent_message_completed_item_id(item)
                    .is_some_and(|item_id| assistant_messages.delta_item_ids.contains(&item_id))
                {
                    return None;
                }
                if item.get("text").and_then(Value::as_str)
                    == Some(assistant_messages.anonymous_delta_text.as_str())
                    && !assistant_messages.anonymous_delta_text.is_empty()
                {
                    return None;
                }
                let text = bounded_text(
                    item.get("text").and_then(Value::as_str).unwrap_or(""),
                    MAX_EVENT_TEXT_CHARS,
                );
                if text.is_empty() {
                    return None;
                }
                // The frontend's assistant_message replaces the visible text.
                // A distinct no-delta item arriving after any reply therefore
                // becomes a delta so it appends instead of erasing prior output.
                let kind = if assistant_messages.emitted_text {
                    "assistant_delta"
                } else {
                    "assistant_message"
                };
                return Some((kind.into(), json!({ "text": text })));
            }
            activity_from_item(item, cwd).map(|data| ("activity".into(), data))
        }
        "turn/plan/updated" => {
            let plan = params
                .get("plan")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .take(32)
                .filter_map(|step| {
                    let text = bounded_text(step.get("step")?.as_str()?, 500);
                    Some(json!({
                        "step": text,
                        "status": normalized_plan_status(step.get("status").and_then(Value::as_str)),
                    }))
                })
                .collect::<Vec<_>>();
            Some(("plan".into(), json!({ "items": plan })))
        }
        "error" => {
            let text = bounded_text(
                params
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("Codex 运行出现问题"),
                2_000,
            );
            Some((
                "notice".into(),
                json!({
                    "message": text,
                    "willRetry": params.get("willRetry").and_then(Value::as_bool).unwrap_or(false),
                }),
            ))
        }
        "turn/completed" => {
            let turn = params.get("turn")?;
            let error = turn
                .pointer("/error/message")
                .and_then(Value::as_str)
                .map(|value| bounded_text(value, 2_000));
            Some((
                "completed".into(),
                json!({
                    "status": normalized_status(turn.get("status").and_then(Value::as_str)),
                    "error": error,
                }),
            ))
        }
        _ => None,
    }
}

fn send_json(stdin: &mut ChildStdin, value: &Value) -> Result<(), String> {
    stdin
        .write_all(format!("{value}\n").as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("向 Codex 写入请求失败：{error}"))
}

fn response_error(message: &Value, fallback: &str) -> Option<String> {
    message.get("error").map(|error| {
        bounded_text(
            error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or(fallback),
            2_000,
        )
    })
}

fn response_id(message: &Value) -> Option<i64> {
    message.get("id").and_then(Value::as_i64)
}

fn is_approval_request(message: &Value) -> bool {
    matches!(
        message.get("method").and_then(Value::as_str),
        Some("item/commandExecution/requestApproval") | Some("item/fileChange/requestApproval")
    )
}

/// 发给前端的审批卡片所需的一切。只带收敛过的字段，不透传协议对象。
struct ApprovalContext {
    event_sink: Arc<dyn ChatEventSink>,
    run_id: String,
    cancelled: Arc<AtomicBool>,
    // 等审批期间我们不读 stdout，所以进程死了不会有任何动静。没有这两个，
    // Codex 一旦在这时崩掉，界面会挂着「等你批准后继续」空等到整轮超时。
    process: Arc<Mutex<Child>>,
    turn_timed_out: Arc<AtomicBool>,
    pending: Arc<Mutex<Option<String>>>,
    rx: Receiver<ApprovalDecision>,
}

/// 等用户按下"允许"或"拒绝"。
///
/// 每秒醒一次检查取消标志；超过整轮上限就放弃。返回 `Err("")` 表示用户取消，
/// 不需要再报错。
fn wait_for_user_decision(
    message: &Value,
    context: &ApprovalContext,
) -> Result<ApprovalDecision, String> {
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let item_id = params
        .get("itemId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !valid_protocol_id(item_id, 160) {
        return Err("Codex 发来的审批请求无效".into());
    }
    let kind = if message.get("method").and_then(Value::as_str)
        == Some("item/fileChange/requestApproval")
    {
        "fileChange"
    } else {
        "command"
    };
    let reason = bounded_text(
        params.get("reason").and_then(Value::as_str).unwrap_or(""),
        MAX_EVENT_TEXT_CHARS,
    );
    let command = bounded_text(
        params.get("command").and_then(Value::as_str).unwrap_or(""),
        MAX_EVENT_TEXT_CHARS,
    );
    if let Ok(mut pending) = context.pending.lock() {
        *pending = Some(item_id.to_string());
    }
    emit_event(
        context.event_sink.as_ref(),
        &context.run_id,
        "approval",
        json!({
            "approvalId": item_id,
            "kind": kind,
            "reason": reason,
            "command": command,
        }),
    );
    let deadline = Instant::now() + TURN_TIMEOUT;
    let outcome = loop {
        if context.cancelled.load(Ordering::SeqCst) {
            break Err(String::new());
        }
        // 整轮超时的看门狗只设 turn_timed_out、不设 cancelled，这里要单独认。
        if context.turn_timed_out.load(Ordering::SeqCst) {
            break Err("等待你的批准时这一轮已超时".to_string());
        }
        // 进程已经退出就别再等人批准了——它已经没人接这个答复。
        if context
            .process
            .lock()
            .ok()
            .and_then(|mut child| child.try_wait().ok())
            .flatten()
            .is_some()
        {
            break Err("Codex 在等待批准时退出了，这一轮已结束".to_string());
        }
        if Instant::now() >= deadline {
            break Err("等待你的批准超时，这一轮已停止".to_string());
        }
        match context.rx.recv_timeout(Duration::from_secs(1)) {
            Ok(decision) => break Ok(decision),
            Err(RecvTimeoutError::Timeout) => continue,
            // 发送端随 active run 一起没了，说明这轮已经在收尾。
            Err(RecvTimeoutError::Disconnected) => break Err(String::new()),
        }
    };
    if let Ok(mut pending) = context.pending.lock() {
        *pending = None;
    }
    // 卡片已经有结论了，让前端把按钮收掉，别留一张永远能点的卡。
    emit_event(
        context.event_sink.as_ref(),
        &context.run_id,
        "approval_resolved",
        json!({
            "approvalId": item_id,
            "decision": outcome.as_ref().map(|d| d.as_protocol()).unwrap_or("cancelled"),
        }),
    );
    outcome
}

fn respond_to_server_request(
    stdin: &mut ChildStdin,
    message: &Value,
    allow_write: bool,
) -> Result<bool, String> {
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return Ok(false);
    };
    let Some(id) = message.get("id").cloned() else {
        return Ok(false);
    };
    let result = match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => json!({
            "id": id,
            "result": { "decision": if allow_write { "accept" } else { "decline" } }
        }),
        "item/tool/requestUserInput" => {
            json!({ "id": id, "result": { "answers": {} } })
        }
        _ => json!({
            "id": id,
            "error": {
                "code": -32000,
                "message": "Roster 对话模式暂不支持这类交互请求"
            }
        }),
    };
    send_json(stdin, &result)?;
    Ok(true)
}

fn read_protocol_line<R: BufRead>(reader: &mut R) -> Result<Option<String>, String> {
    let mut line = Vec::new();
    loop {
        let (take, complete) = {
            let available = reader
                .fill_buf()
                .map_err(|error| format!("读取 Codex 响应失败：{error}"))?;
            if available.is_empty() {
                if line.is_empty() {
                    return Ok(None);
                }
                (0, true)
            } else if let Some(index) = available.iter().position(|byte| *byte == b'\n') {
                if line.len().saturating_add(index) > MAX_PROTOCOL_LINE_BYTES {
                    return Err("Codex 返回的单条消息过大，已停止处理".into());
                }
                line.extend_from_slice(&available[..index]);
                (index + 1, true)
            } else {
                if line.len().saturating_add(available.len()) > MAX_PROTOCOL_LINE_BYTES {
                    return Err("Codex 返回的单条消息过大，已停止处理".into());
                }
                line.extend_from_slice(available);
                (available.len(), false)
            }
        };
        reader.consume(take);
        if complete {
            return Ok(Some(String::from_utf8_lossy(&line).into_owned()));
        }
    }
}

#[derive(Default)]
struct ProtocolBudget {
    protocol_messages: usize,
    protocol_bytes: usize,
    activity_events: usize,
    activity_bytes: usize,
}

impl ProtocolBudget {
    fn record_protocol_line(&mut self, line: &str) -> Result<(), String> {
        let next_messages = self.protocol_messages.saturating_add(1);
        let next_bytes = self.protocol_bytes.saturating_add(line.len());
        if next_messages > MAX_PROTOCOL_MESSAGES || next_bytes > MAX_PROTOCOL_TURN_BYTES {
            return Err("Codex 返回的协议消息过多，已停止处理".into());
        }
        self.protocol_messages = next_messages;
        self.protocol_bytes = next_bytes;
        Ok(())
    }

    fn record_activity(&mut self, data: &Value) -> Result<(), String> {
        let event_bytes = data.to_string().len();
        if event_bytes > MAX_ACTIVITY_EVENT_BYTES {
            return Err("Codex 返回的单条项目活动过大，已停止处理".into());
        }

        let next_events = self.activity_events.saturating_add(1);
        let next_bytes = self.activity_bytes.saturating_add(event_bytes);
        if next_events > MAX_ACTIVITY_EVENTS_PER_TURN || next_bytes > MAX_ACTIVITY_TURN_BYTES {
            return Err("Codex 返回的项目活动过多，已停止处理".into());
        }
        self.activity_events = next_events;
        self.activity_bytes = next_bytes;
        Ok(())
    }
}

#[cfg(unix)]
fn process_group_exists(process_id: u32) -> bool {
    let Ok(process_group_id) = i32::try_from(process_id) else {
        return false;
    };
    // A process group is not reusable while any of its original members still
    // exists. We issue this probe immediately after reaping/observing the leader
    // and only target its negative PGID during this cleanup window. Unix has no
    // generation-stable process-group handle, so an extreme PID-wrap race after
    // an already empty group disappears cannot be proved away; prompt cleanup and
    // the ESRCH check make that window as small as this model permits.
    unsafe {
        if libc::kill(-process_group_id, 0) == 0 {
            true
        } else {
            std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        }
    }
}

pub(crate) fn stop_child(child: &mut Child, allow_graceful_exit: bool) {
    if allow_graceful_exit {
        // app-server 在 stdin EOF 后自行收尾；给线程记录充分落盘时间，再强制回收。
        for _ in 0..200 {
            if child.try_wait().ok().flatten().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    let process_id = child.id();
    #[cfg(unix)]
    {
        let Ok(process_group_id) = i32::try_from(process_id) else {
            let _ = child.kill();
            let _ = child.wait();
            return;
        };
        // The leader can have exited and been reaped while tools it spawned still
        // own its process group. Do not return based on try_wait above: its PGID
        // remains reserved until the last group member exits.
        unsafe {
            let _ = libc::kill(-process_group_id, libc::SIGTERM);
        }
        // A normal completed app-server has no remaining group members, so avoid
        // imposing a fixed delay. Only wait briefly when TERM left a group alive.
        for _ in 0..10 {
            if !process_group_exists(process_id) {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if process_group_exists(process_id) {
            // 工具子进程可能忽略 TERM；最后对同一进程组发 KILL，避免留下孤儿。
            unsafe {
                let _ = libc::kill(-process_group_id, libc::SIGKILL);
            }
        }
    }
    #[cfg(windows)]
    let _ = process_id;
    let _ = child.kill();
    let _ = child.wait();
}

fn cleanup_run(
    active: &Arc<Mutex<HashMap<String, ActiveRun>>>,
    run_id: &str,
    process: &Arc<Mutex<Child>>,
    allow_graceful_exit: bool,
) {
    let process_tree = match active.lock() {
        Ok(active) => active.get(run_id).and_then(|run| run.process_tree.clone()),
        Err(poisoned) => poisoned
            .into_inner()
            .get(run_id)
            .and_then(|run| run.process_tree.clone()),
    };
    if !allow_graceful_exit {
        if let Some(process_tree) = &process_tree {
            process_tree.terminate();
        }
    }
    let mut child = match process.lock() {
        Ok(child) => child,
        Err(poisoned) => poisoned.into_inner(),
    };
    stop_child(&mut child, allow_graceful_exit);
    // A successful Codex turn gets its normal stdin-EOF grace period first so
    // the CLI can persist the session. Only then terminate any descendant that
    // outlived the leader. Error/cancel paths terminate the tree before waiting.
    if allow_graceful_exit {
        if let Some(process_tree) = &process_tree {
            process_tree.terminate();
        }
    }
    match active.lock() {
        Ok(mut active) => {
            active.remove(run_id);
        }
        Err(poisoned) => {
            poisoned.into_inner().remove(run_id);
        }
    }
}

struct ProtocolContext {
    event_sink: Arc<dyn ChatEventSink>,
    active: Arc<Mutex<HashMap<String, ActiveRun>>>,
    process: Arc<Mutex<Child>>,
    process_tree: ProcessTreeGuard,
    cancelled: Arc<AtomicBool>,
    finished: Arc<AtomicBool>,
    timed_out: Arc<AtomicBool>,
    turn_timed_out: Arc<AtomicBool>,
    completion: Arc<(Mutex<bool>, Condvar)>,
    startup_signal: Sender<()>,
    run_id: String,
    cwd: PathBuf,
    requested_thread_id: String,
    prompt: String,
    allow_write: bool,
    mode: String,
    model: String,
    // 「请求批准」这一档才有；其余档位仍走原来的自动应答。
    approval_rx: Option<Receiver<ApprovalDecision>>,
    pending_approval: Arc<Mutex<Option<String>>>,
}

fn mark_finished(finished: &AtomicBool, completion: &Arc<(Mutex<bool>, Condvar)>) {
    finished.store(true, Ordering::SeqCst);
    let (lock, wake) = &**completion;
    if let Ok(mut done) = lock.lock() {
        *done = true;
        wake.notify_all();
    }
}

fn wait_for_completion(completion: &Arc<(Mutex<bool>, Condvar)>, timeout: Duration) -> bool {
    let (lock, wake) = &**completion;
    let Ok(done) = lock.lock() else {
        return false;
    };
    if *done {
        return true;
    }
    wake.wait_timeout_while(done, timeout, |done| !*done)
        .map(|(done, _)| *done)
        .unwrap_or(false)
}

struct PreparedStart {
    run_id: String,
    thread_id: String,
    prompt: String,
    allow_write: bool,
    mode: String,
    model: String,
    effort: String,
    cwd: PathBuf,
}

/// Atomically reserve one project/run slot before any expensive resolution or
/// process creation. The returned cancellation flag is also used by `cancel`
/// while the process is still being prepared.
pub(crate) fn reserve_run(
    state: &CodexChatState,
    project_id: &str,
    run_id: &str,
) -> Result<Arc<AtomicBool>, String> {
    let mut active = state.active.lock().map_err(|error| error.to_string())?;
    if active.len() >= MAX_ACTIVE_RUNS {
        return Err("同时运行的对话太多，请稍后再试".into());
    }
    if active.contains_key(run_id) {
        return Err("这个对话请求已经在运行".into());
    }
    if active.values().any(|run| run.project_id == project_id) {
        return Err("这个项目已有一条对话正在处理".into());
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    active.insert(
        run_id.to_string(),
        ActiveRun {
            project_id: project_id.to_string(),
            process: None,
            process_tree: None,
            cancelled: cancelled.clone(),
            approval_tx: None,
            pending_approval: Arc::new(Mutex::new(None)),
        },
    );
    Ok(cancelled)
}

/// 在协议线程启动前把审批通道登记到 active run 上。
fn bind_approval_channel(
    state: &CodexChatState,
    run_id: &str,
    tx: Sender<ApprovalDecision>,
    pending: Arc<Mutex<Option<String>>>,
) {
    if let Ok(mut active) = state.active.lock() {
        if let Some(run) = active.get_mut(run_id) {
            run.approval_tx = Some(tx);
            run.pending_approval = pending;
        }
    }
}

/// 把用户的决定送给正在等它的协议线程。
///
/// 只接受"当前确实在等的那一条"：ID 对不上就拒，避免前端拿旧卡片或伪造的 ID
/// 去批准另一个动作。协议线程收到后自己写回 stdin。
pub fn approve(
    state: &CodexChatState,
    run_id: &str,
    approval_id: &str,
    decision: &str,
) -> Result<(), String> {
    validate_run_id(run_id)?;
    let decision = ApprovalDecision::parse(decision)?;
    let run = state
        .active
        .lock()
        .map_err(|error| error.to_string())?
        .get(run_id)
        .cloned()
        .ok_or_else(|| "这轮对话已经结束了".to_string())?;
    let waiting = run
        .pending_approval
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    if waiting.as_deref() != Some(approval_id) {
        return Err("这条审批已经处理过了".into());
    }
    run.approval_tx
        .ok_or_else(|| "这轮对话不接受审批".to_string())?
        .send(decision)
        .map_err(|_| "这轮对话已经结束了".to_string())
}

pub(crate) fn release_run(state: &CodexChatState, run_id: &str) {
    match state.active.lock() {
        Ok(mut active) => {
            active.remove(run_id);
        }
        Err(poisoned) => {
            poisoned.into_inner().remove(run_id);
        }
    }
}

/// Attach a spawned process to an existing reservation. Returns whether it was
/// cancelled while resolution/spawn was in progress.
pub(crate) fn bind_reserved_process(
    state: &CodexChatState,
    run_id: &str,
    process: Arc<Mutex<Child>>,
    process_tree: ProcessTreeGuard,
) -> Result<bool, String> {
    let mut active = state.active.lock().map_err(|error| error.to_string())?;
    let run = active
        .get_mut(run_id)
        .ok_or_else(|| "对话启动已取消".to_string())?;
    if run.process.is_some() {
        return Err("这个对话请求已经在运行".into());
    }
    run.process = Some(process);
    run.process_tree = Some(process_tree);
    Ok(run.cancelled.load(Ordering::SeqCst))
}

fn run_protocol(stdin: ChildStdin, stdout: ChildStdout, context: ProtocolContext) {
    let panic_sink = context.event_sink.clone();
    let panic_active = context.active.clone();
    let panic_process = context.process.clone();
    let panic_process_tree = context.process_tree.clone();
    let panic_cancelled = context.cancelled.clone();
    let panic_finished = context.finished.clone();
    let panic_completion = context.completion.clone();
    let panic_startup_signal = context.startup_signal.clone();
    let panic_run_id = context.run_id.clone();
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        run_protocol_inner(stdin, stdout, context)
    }))
    .is_err()
    {
        panic_process_tree.terminate();
        cleanup_run(&panic_active, &panic_run_id, &panic_process, false);
        mark_finished(&panic_finished, &panic_completion);
        let _ = panic_startup_signal.send(());
        if panic_cancelled.load(Ordering::SeqCst) {
            emit_event(panic_sink.as_ref(), &panic_run_id, "cancelled", json!({}));
        } else {
            emit_event(
                panic_sink.as_ref(),
                &panic_run_id,
                "error",
                json!({ "message": "Codex 对话服务异常退出，已安全释放运行槽位" }),
            );
        }
    }
}

fn run_protocol_inner(mut stdin: ChildStdin, stdout: ChildStdout, context: ProtocolContext) {
    let ProtocolContext {
        event_sink,
        active,
        process,
        process_tree,
        cancelled,
        finished,
        timed_out,
        turn_timed_out,
        completion,
        startup_signal,
        run_id,
        cwd,
        requested_thread_id,
        prompt,
        allow_write,
        mode,
        model,
        approval_rx,
        pending_approval,
    } = context;

    // Codex 自己的档位：只读就是纯沙箱只读；「帮我批准」把审批交给它自己的
    // 自动审核（协议里是 approvalsReviewer=auto_review），无头下不需要人应答。
    let approve_for_me = allow_write && mode == "approve-for-me";
    // 「请求批准」用同样的 on-request，但把审核人换回 user——这时 app-server 会
    // 把 requestApproval 发给我们，由用户拍板。实测它只在动作要越出沙箱时才问
    // （联网、写到可写根之外等），工作区内的正常读写不会打断。
    let ask_user = allow_write && mode == "request-approval";
    let approval_policy = if approve_for_me || ask_user {
        "on-request"
    } else {
        "never"
    };
    let approvals_reviewer = if approve_for_me {
        "auto_review"
    } else {
        "user"
    };
    let context_for_approval = approval_rx.map(|rx| ApprovalContext {
        event_sink: event_sink.clone(),
        run_id: run_id.clone(),
        cancelled: cancelled.clone(),
        process: process.clone(),
        turn_timed_out: turn_timed_out.clone(),
        pending: pending_approval.clone(),
        rx,
    });
    // 没有通道就退回自动应答，绝不能变成"没人应答却当成批准"。
    let ask_user = ask_user && context_for_approval.is_some();
    let sandbox_mode = codex_sandbox_mode(&mode, allow_write);

    let init = json!({
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
    if let Err(error) = send_json(&mut stdin, &init) {
        emit_event(
            event_sink.as_ref(),
            &run_id,
            "error",
            json!({ "message": error }),
        );
        mark_finished(&finished, &completion);
        let _ = startup_signal.send(());
        process_tree.terminate();
        cleanup_run(&active, &run_id, &process, false);
        return;
    }

    // A descendant can retain stdout after the app-server leader exits. Keep
    // blocking reads off the coordinator thread so it can observe that exit
    // and finish the turn instead of waiting until the global timeout.
    let (line_sender, line_receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let line = read_protocol_line(&mut reader);
            let done = !matches!(line, Ok(Some(_)));
            if line_sender.send(line).is_err() || done {
                break;
            }
        }
    });
    let mut reported_error = false;
    let mut completed = false;
    let mut completed_data = None;
    let mut thread_id = String::new();
    let mut assistant_bytes = 0usize;
    let mut assistant_messages = AssistantMessageState::default();
    let mut normalized_events = 0usize;
    let mut budget = ProtocolBudget::default();
    loop {
        if cancelled.load(Ordering::SeqCst) || turn_timed_out.load(Ordering::SeqCst) {
            break;
        }
        let line = match line_receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if process
                    .lock()
                    .ok()
                    .and_then(|mut child| child.try_wait().ok())
                    .flatten()
                    .is_some()
                {
                    break;
                }
                continue;
            }
            Ok(Err(error)) => {
                emit_event(
                    event_sink.as_ref(),
                    &run_id,
                    "error",
                    json!({ "message": error }),
                );
                reported_error = true;
                break;
            }
        };
        if let Err(error) = budget.record_protocol_line(&line) {
            emit_event(
                event_sink.as_ref(),
                &run_id,
                "error",
                json!({ "message": error }),
            );
            reported_error = true;
            break;
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if cancelled.load(Ordering::SeqCst) {
            break;
        }
        if message.get("method").is_some() && message.get("id").is_some() {
            // 「请求批准」这一档把决定权交回用户：先把请求收敛成一张卡片发给前端，
            // 再在这里等答复。此刻 Codex 正等着我们回话，不会再有本轮输出，所以
            // 阻塞在这里是安全的；但仍要按秒轮询取消标志和整轮超时，不能死等。
            if let (true, Some(approval)) = (
                ask_user && is_approval_request(&message),
                context_for_approval.as_ref(),
            ) {
                match wait_for_user_decision(&message, approval) {
                    Ok(decision) => {
                        let reply = json!({
                            "id": message.get("id").cloned().unwrap_or(Value::Null),
                            "result": { "decision": decision.as_protocol() }
                        });
                        if let Err(error) = send_json(&mut stdin, &reply) {
                            emit_event(
                                event_sink.as_ref(),
                                &run_id,
                                "error",
                                json!({ "message": error }),
                            );
                            reported_error = true;
                            break;
                        }
                        continue;
                    }
                    // 取消或超时：不替用户做决定，直接结束这一轮。
                    Err(reason) => {
                        if !reason.is_empty() {
                            emit_event(
                                event_sink.as_ref(),
                                &run_id,
                                "error",
                                json!({ "message": reason }),
                            );
                            reported_error = true;
                        }
                        break;
                    }
                }
            }
            if let Err(error) = respond_to_server_request(&mut stdin, &message, allow_write) {
                emit_event(
                    event_sink.as_ref(),
                    &run_id,
                    "error",
                    json!({ "message": error }),
                );
                reported_error = true;
                break;
            }
            continue;
        }
        match response_id(&message) {
            Some(1) => {
                if let Some(error) = response_error(&message, "Codex 握手失败") {
                    emit_event(
                        event_sink.as_ref(),
                        &run_id,
                        "error",
                        json!({ "message": error }),
                    );
                    reported_error = true;
                    break;
                }
                if message.get("result").is_none() {
                    continue;
                }
                if send_json(
                    &mut stdin,
                    &json!({ "method": "initialized", "params": {} }),
                )
                .is_err()
                {
                    break;
                }
                let mut request = if requested_thread_id.is_empty() {
                    json!({
                        "method": "thread/start",
                        "id": 2,
                        "params": {
                            "cwd": cwd,
                            "approvalPolicy": approval_policy,
                            "approvalsReviewer": approvals_reviewer,
                            "sandbox": sandbox_mode,
                            "personality": "friendly",
                            "serviceName": "roster"
                        }
                    })
                } else {
                    json!({
                        "method": "thread/resume",
                        "id": 2,
                        "params": {
                            "threadId": requested_thread_id,
                            "cwd": cwd,
                            "approvalPolicy": approval_policy,
                            "approvalsReviewer": approvals_reviewer,
                            "sandbox": sandbox_mode,
                            "personality": "friendly"
                        }
                    })
                };
                if !model.is_empty() {
                    request["params"]["model"] = json!(model);
                }
                if let Err(error) = send_json(&mut stdin, &request) {
                    emit_event(
                        event_sink.as_ref(),
                        &run_id,
                        "error",
                        json!({ "message": error }),
                    );
                    reported_error = true;
                    break;
                }
            }
            Some(2) => {
                if let Some(error) = response_error(&message, "无法打开 Codex 会话") {
                    emit_event(
                        event_sink.as_ref(),
                        &run_id,
                        "error",
                        json!({ "message": error }),
                    );
                    reported_error = true;
                    break;
                }
                thread_id = message
                    .pointer("/result/thread/id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if thread_id.is_empty() || validate_thread_id(&thread_id).is_err() {
                    emit_event(
                        event_sink.as_ref(),
                        &run_id,
                        "error",
                        json!({ "message": "Codex 返回了无效的会话 ID" }),
                    );
                    reported_error = true;
                    break;
                }
                emit_event(
                    event_sink.as_ref(),
                    &run_id,
                    "thread",
                    json!({ "threadId": thread_id }),
                );
                let sandbox_policy = codex_sandbox_policy(&mode, allow_write, &cwd);
                let turn = json!({
                    "method": "turn/start",
                    "id": 3,
                    "params": {
                        "threadId": thread_id,
                        "input": [{ "type": "text", "text": prompt }],
                        "cwd": cwd,
                        "approvalPolicy": approval_policy,
                        "approvalsReviewer": approvals_reviewer,
                        "sandboxPolicy": sandbox_policy,
                        "summary": "concise",
                        "personality": "friendly"
                    }
                });
                if let Err(error) = send_json(&mut stdin, &turn) {
                    emit_event(
                        event_sink.as_ref(),
                        &run_id,
                        "error",
                        json!({ "message": error }),
                    );
                    reported_error = true;
                    break;
                }
            }
            Some(3) => {
                if let Some(error) = response_error(&message, "Codex 无法开始处理") {
                    emit_event(
                        event_sink.as_ref(),
                        &run_id,
                        "error",
                        json!({ "message": error }),
                    );
                    reported_error = true;
                    break;
                }
                let turn_id = message
                    .pointer("/result/turn/id")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if !valid_protocol_id(turn_id, 160) {
                    emit_event(
                        event_sink.as_ref(),
                        &run_id,
                        "error",
                        json!({ "message": "Codex 返回了无效的处理 ID" }),
                    );
                    reported_error = true;
                    break;
                }
                let _ = startup_signal.send(());
                emit_event(
                    event_sink.as_ref(),
                    &run_id,
                    "turn",
                    json!({ "threadId": thread_id, "turnId": turn_id, "status": "inProgress" }),
                );
            }
            _ => {
                // Codex 每轮都会主动推一次限流数据。收下写进用量缓存，额度
                // 就不用再另起一个 app-server 去问同样的问题。
                if message.get("method").and_then(Value::as_str)
                    == Some("account/rateLimits/updated")
                {
                    crate::usage::record_codex_rate_limits(
                        message.get("params").unwrap_or(&Value::Null),
                    );
                }
                let delta_item_id = agent_message_delta_item_id(&message);
                if let Some((kind, data)) =
                    normalized_notification(&message, &cwd, &assistant_messages)
                {
                    normalized_events = normalized_events.saturating_add(1);
                    if normalized_events > MAX_NORMALIZED_EVENTS {
                        emit_event(
                            event_sink.as_ref(),
                            &run_id,
                            "error",
                            json!({ "message": "Codex 返回的事件过多，已停止处理" }),
                        );
                        reported_error = true;
                        break;
                    }
                    if kind == "assistant_delta" {
                        if let Some(item_id) = delta_item_id {
                            assistant_messages.delta_item_ids.insert(item_id);
                        } else if let Some(text) = data.get("text").and_then(Value::as_str) {
                            let remaining = MAX_ASSISTANT_TURN_BYTES
                                .saturating_sub(assistant_messages.anonymous_delta_text.len());
                            assistant_messages
                                .anonymous_delta_text
                                .push_str(&bounded_utf8_bytes(text, remaining));
                        }
                        assistant_messages.emitted_text = true;
                    }
                    if kind == "assistant_delta" || kind == "assistant_message" {
                        assistant_bytes = assistant_bytes.saturating_add(
                            data.get("text")
                                .and_then(Value::as_str)
                                .map(str::len)
                                .unwrap_or(0),
                        );
                        if assistant_bytes > MAX_ASSISTANT_TURN_BYTES {
                            emit_event(
                                event_sink.as_ref(),
                                &run_id,
                                "error",
                                json!({ "message": "Codex 回复过长，已停止处理" }),
                            );
                            reported_error = true;
                            break;
                        }
                    }
                    if kind == "assistant_message" {
                        assistant_messages.emitted_text = true;
                    }
                    if kind == "activity" {
                        if let Err(error) = budget.record_activity(&data) {
                            emit_event(
                                event_sink.as_ref(),
                                &run_id,
                                "error",
                                json!({ "message": error }),
                            );
                            reported_error = true;
                            break;
                        }
                    }
                    // Cancellation wins over any buffered protocol traffic,
                    // including a late completed notification.
                    if cancelled.load(Ordering::SeqCst) {
                        break;
                    }
                    if kind == "completed" {
                        completed = true;
                        completed_data = Some(data);
                        break;
                    }
                    emit_event(event_sink.as_ref(), &run_id, &kind, data);
                }
            }
        }
    }

    // EOF on stdin lets a normally completed app-server persist its thread.
    // Drop the writer before graceful cleanup: otherwise the child keeps
    // waiting for input until the grace period expires and we terminate it.
    drop(stdin);
    mark_finished(&finished, &completion);
    let _ = startup_signal.send(());
    let completed_normally = completed && !cancelled.load(Ordering::SeqCst);
    if !completed_normally {
        process_tree.terminate();
    }
    cleanup_run(&active, &run_id, &process, completed_normally);
    let cancelled_now = cancelled.load(Ordering::SeqCst);
    if completed_normally && !cancelled_now {
        emit_event(
            event_sink.as_ref(),
            &run_id,
            "completed",
            completed_data.unwrap_or_else(|| json!({ "status": "completed" })),
        );
    } else if cancelled_now {
        emit_event(event_sink.as_ref(), &run_id, "cancelled", json!({}));
    } else if timed_out.load(Ordering::SeqCst) {
        emit_event(
            event_sink.as_ref(),
            &run_id,
            "error",
            json!({ "message": "Codex 对话服务启动超时，请确认 Codex 已登录后重试" }),
        );
    } else if turn_timed_out.load(Ordering::SeqCst) {
        emit_event(
            event_sink.as_ref(),
            &run_id,
            "error",
            json!({ "message": "Codex 对话处理超时（最长 60 分钟），已停止" }),
        );
    } else if !completed && !reported_error {
        emit_event(
            event_sink.as_ref(),
            &run_id,
            "error",
            json!({ "message": "Codex 后台进程意外退出，请确认 Codex 已安装并已登录" }),
        );
    }
}

fn start_prepared(
    event_sink: Arc<dyn ChatEventSink>,
    state: &CodexChatState,
    prepared: PreparedStart,
    mut command: Command,
) -> Result<CodexChatStartResult, String> {
    let PreparedStart {
        run_id,
        thread_id,
        prompt,
        allow_write,
        mode,
        model,
        effort,
        cwd,
    } = prepared;
    let project_key = cwd.to_string_lossy();
    let cancelled = reserve_run(state, &project_key, &run_id)?;

    command.arg("app-server").arg("--stdio");
    if !effort.is_empty() {
        command.args(["-c", &format!("model_reasoning_effort={effort}")]);
    }
    command
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::proxy_settings::apply_to_std_command(&mut command);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            release_run(state, &run_id);
            return Err(format!("启动 Codex 对话服务失败：{error}"));
        }
    };
    let process_tree = match register_process_tree(&child) {
        Ok(process_tree) => process_tree,
        Err(error) => {
            stop_child(&mut child, false);
            release_run(state, &run_id);
            return Err(error);
        }
    };
    let stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            process_tree.terminate();
            stop_child(&mut child, false);
            release_run(state, &run_id);
            return Err("无法写入 Codex 对话服务".into());
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            process_tree.terminate();
            stop_child(&mut child, false);
            release_run(state, &run_id);
            return Err("无法读取 Codex 对话服务".into());
        }
    };
    if let Some(mut stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let mut sink = std::io::sink();
            let _ = std::io::copy(&mut stderr, &mut sink);
        });
    }
    let process = Arc::new(Mutex::new(child));
    let finished = Arc::new(AtomicBool::new(false));
    let timed_out = Arc::new(AtomicBool::new(false));
    let turn_timed_out = Arc::new(AtomicBool::new(false));
    let completion = Arc::new((Mutex::new(false), Condvar::new()));
    let (startup_signal, startup_wait) = std::sync::mpsc::channel();
    let cancelled_during_start =
        match bind_reserved_process(state, &run_id, process.clone(), process_tree.clone()) {
            Ok(cancelled) => cancelled,
            Err(error) => {
                process_tree.terminate();
                if let Ok(mut child) = process.lock() {
                    stop_child(&mut child, false);
                }
                release_run(state, &run_id);
                return Err(error);
            }
        };
    if cancelled_during_start {
        process_tree.terminate();
        if let Ok(mut child) = process.lock() {
            stop_child(&mut child, false);
        }
        release_run(state, &run_id);
        return Err("对话启动已取消".into());
    }

    // 只有「请求批准」这一档需要把决定权交回用户，其余档位不建通道，
    // 这样即便协议意外发来审批请求也走不到"等人应答"的路径上。
    let pending_approval = Arc::new(Mutex::new(None));
    let approval_rx = if allow_write && mode == "request-approval" {
        let (tx, rx) = mpsc::channel();
        bind_approval_channel(state, &run_id, tx, pending_approval.clone());
        Some(rx)
    } else {
        None
    };
    let context = ProtocolContext {
        event_sink,
        active: state.active.clone(),
        process: process.clone(),
        process_tree: process_tree.clone(),
        cancelled: cancelled.clone(),
        finished: finished.clone(),
        timed_out: timed_out.clone(),
        turn_timed_out: turn_timed_out.clone(),
        completion: completion.clone(),
        startup_signal,
        run_id: run_id.clone(),
        cwd,
        requested_thread_id: thread_id,
        prompt,
        allow_write,
        mode: mode.clone(),
        model,
        approval_rx,
        pending_approval: pending_approval.clone(),
    };
    std::thread::spawn(move || run_protocol(stdin, stdout, context));
    let startup_process = process.clone();
    let startup_process_tree = process_tree.clone();
    let startup_cancelled = cancelled.clone();
    std::thread::spawn(move || {
        if startup_wait.recv_timeout(STARTUP_TIMEOUT).is_ok()
            || finished.load(Ordering::SeqCst)
            || startup_cancelled.load(Ordering::SeqCst)
        {
            return;
        }
        if finished.load(Ordering::SeqCst) || startup_cancelled.load(Ordering::SeqCst) {
            return;
        }
        timed_out.store(true, Ordering::SeqCst);
        startup_process_tree.terminate();
        if let Ok(mut child) = startup_process.lock() {
            stop_child(&mut child, false);
        }
    });
    std::thread::spawn(move || {
        if wait_for_completion(&completion, TURN_TIMEOUT) || cancelled.load(Ordering::SeqCst) {
            return;
        }
        turn_timed_out.store(true, Ordering::SeqCst);
        process_tree.terminate();
        if let Ok(mut child) = process.lock() {
            stop_child(&mut child, false);
        }
    });
    Ok(CodexChatStartResult { run_id })
}

pub fn start(
    app: AppHandle,
    state: &CodexChatState,
    project_path: &str,
    input: CodexChatStartInput,
) -> Result<CodexChatStartResult, String> {
    let CodexChatStartInput {
        project_id,
        run_id,
        thread_id,
        prompt,
        allow_write,
        mode,
        model,
        effort,
    } = input;
    validate_run_id(&run_id)?;
    validate_thread_id(&thread_id)?;
    let prompt = validate_prompt(&prompt)?;
    let cwd = validate_project_path(project_path)?;
    // Keep accepting the frontend record ID for protocol compatibility, but
    // never use it as a concurrency identity: canonical cwd is the only key.
    let _ = project_id;
    if !thread_id.is_empty() {
        let home = dirs::home_dir().ok_or("找不到用户目录")?;
        let canonical_project_path = cwd.to_string_lossy().into_owned();
        crate::project_sessions::preview_project_session_with_home(
            &canonical_project_path,
            "codex",
            &thread_id,
            &home,
        )
        .map_err(|_| "这个 Codex 会话不属于当前项目，无法续接".to_string())?;
    }

    let bin = crate::cli_detect::resolve_registered_cli_bin("codex")?;
    start_prepared(
        Arc::new(MainWebviewSink { app }),
        state,
        PreparedStart {
            run_id,
            thread_id,
            prompt,
            allow_write,
            mode,
            model,
            effort,
            cwd,
        },
        Command::new(bin),
    )
}

pub fn cancel(state: &CodexChatState, run_id: &str) -> Result<(), String> {
    validate_run_id(run_id)?;
    let Some(run) = state
        .active
        .lock()
        .map_err(|error| error.to_string())?
        .get(run_id)
        .cloned()
    else {
        // 完成通知前会先回收进程并移出 active；取消必须幂等，避免这个窗口误报失败。
        return Ok(());
    };
    run.cancelled.store(true, Ordering::SeqCst);
    if let Some(process_tree) = run.process_tree {
        process_tree.terminate();
    }
    if let Some(process) = run.process {
        let mut child = process.lock().map_err(|error| error.to_string())?;
        stop_child(&mut child, false);
    }
    Ok(())
}

/// thread/start 的 `sandbox`：Codex 的 SandboxMode 枚举。
///
/// 「完全访问权限」是 Codex 自己的 danger-full-access——不开沙箱，能读写项目
/// 以外的地方，也能联网。只有用户明确选中这一档才会走到这里；档位表的第一档
/// 永远是只读，空模式也落在只读上。
fn codex_sandbox_mode(mode: &str, allow_write: bool) -> &'static str {
    if !allow_write {
        return "read-only";
    }
    match mode {
        "full-access" => "danger-full-access",
        _ => "workspace-write",
    }
}

/// turn/start 的 `sandboxPolicy`：与上面同一档，形状换成协议里的 SandboxPolicy。
fn codex_sandbox_policy(mode: &str, allow_write: bool, cwd: &Path) -> Value {
    match codex_sandbox_mode(mode, allow_write) {
        "danger-full-access" => json!({ "type": "dangerFullAccess" }),
        "workspace-write" => json!({
            "type": "workspaceWrite",
            "writableRoots": [cwd],
            "networkAccess": false
        }),
        _ => json!({ "type": "readOnly" }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_access_maps_to_codex_own_unsandboxed_values() {
        // 取值来自 `codex app-server generate-json-schema`：SandboxMode 是
        // read-only / workspace-write / danger-full-access，SandboxPolicy 的
        // 无沙箱变体叫 dangerFullAccess。写错一个字 Codex 就拒绝开工。
        let cwd = Path::new("/tmp/proj");
        assert_eq!(
            codex_sandbox_mode("full-access", true),
            "danger-full-access"
        );
        assert_eq!(
            codex_sandbox_policy("full-access", true, cwd),
            json!({ "type": "dangerFullAccess" })
        );

        // 没打开写入开关时，哪怕模式是完全访问也不许脱离沙箱。
        assert_eq!(codex_sandbox_mode("full-access", false), "read-only");
        assert_eq!(
            codex_sandbox_policy("full-access", false, cwd),
            json!({ "type": "readOnly" })
        );

        // 其余写入档仍然只给工作区，且不放网。
        for mode in ["approve-for-me", "", "什么乱七八糟的"] {
            assert_eq!(codex_sandbox_mode(mode, true), "workspace-write");
            assert_eq!(
                codex_sandbox_policy(mode, true, cwd),
                json!({
                    "type": "workspaceWrite",
                    "writableRoots": [cwd],
                    "networkAccess": false
                })
            );
        }
    }

    #[test]
    fn approve_for_me_routes_approvals_to_codex_auto_review() {
        // 实测过 app-server 接受这三个值并回显；这里固化映射，别再退回
        // 「一律 never」那种盲跑。
        for (mode, allow_write, policy, reviewer) in [
            ("approve-for-me", true, "on-request", "auto_review"),
            ("read-only", false, "never", "user"),
            ("", true, "never", "user"),
        ] {
            let approve_for_me = allow_write && mode == "approve-for-me";
            assert_eq!(
                if approve_for_me {
                    "on-request"
                } else {
                    "never"
                },
                policy,
                "{mode} 的审批策略不对"
            );
            assert_eq!(
                if approve_for_me {
                    "auto_review"
                } else {
                    "user"
                },
                reviewer,
                "{mode} 的审核者不对"
            );
        }
    }

    #[test]
    fn concurrent_reservation_starts_only_one_run_per_project() {
        let state = Arc::new(CodexChatState::default());
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let workers = ["run-a", "run-b"].map(|run_id| {
            let state = state.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                reserve_run(&state, "same-project", run_id).is_ok()
            })
        });
        barrier.wait();
        let started = workers
            .into_iter()
            .map(|worker| worker.join().expect("reservation worker"))
            .filter(|started| *started)
            .count();
        assert_eq!(started, 1);
        assert_eq!(state.active.lock().expect("active state").len(), 1);
    }

    #[cfg(unix)]
    #[cfg(unix)]
    #[test]
    fn process_tree_guard_is_kept_until_cleanup_removes_the_active_run() {
        let state = CodexChatState::default();
        let cancelled = reserve_run(&state, "guard-project", "guard-run").expect("reserve");
        assert!(!cancelled.load(Ordering::SeqCst));
        let child = Command::new("/bin/sh")
            .arg("-c")
            .arg("sleep 5")
            .spawn()
            .expect("spawn child");
        let process_tree = register_process_tree(&child).expect("register process tree");
        let process = Arc::new(Mutex::new(child));
        bind_reserved_process(&state, "guard-run", process.clone(), process_tree)
            .expect("bind process");
        assert!(state
            .active
            .lock()
            .expect("active lock")
            .get("guard-run")
            .and_then(|run| run.process_tree.as_ref())
            .is_some());

        cleanup_run(&state.active, "guard-run", &process, false);
        assert!(!state
            .active
            .lock()
            .expect("active lock")
            .contains_key("guard-run"));
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_run_recovers_poisoned_locks_and_releases_slot() {
        let state = CodexChatState::default();
        reserve_run(&state, "poison-project", "poison-run").expect("reserve");
        let child = Command::new("/bin/sh")
            .arg("-c")
            .arg("sleep 5")
            .spawn()
            .expect("spawn child");
        let process_tree = register_process_tree(&child).expect("register process tree");
        let process = Arc::new(Mutex::new(child));
        bind_reserved_process(&state, "poison-run", process.clone(), process_tree)
            .expect("bind process");

        let active = state.active.clone();
        assert!(std::thread::spawn(move || {
            let _guard = active.lock().expect("active lock");
            panic!("poison active lock");
        })
        .join()
        .is_err());
        let poisoned_process = process.clone();
        assert!(std::thread::spawn(move || {
            let _guard = poisoned_process.lock().expect("process lock");
            panic!("poison process lock");
        })
        .join()
        .is_err());

        cleanup_run(&state.active, "poison-run", &process, false);
        let active = match state.active.lock() {
            Ok(_) => panic!("lock should remain poisoned"),
            Err(poisoned) => poisoned.into_inner(),
        };
        assert!(!active.contains_key("poison-run"));
    }

    #[test]
    fn completion_signal_prevents_turn_timeout_wait() {
        let finished = AtomicBool::new(false);
        let completion = Arc::new((Mutex::new(false), Condvar::new()));
        mark_finished(&finished, &completion);
        assert!(finished.load(Ordering::SeqCst));
        assert!(wait_for_completion(&completion, Duration::from_millis(1)));
    }

    #[cfg(unix)]
    struct TestEventSink(std::sync::mpsc::Sender<CodexChatEvent>);

    #[cfg(unix)]
    impl ChatEventSink for TestEventSink {
        fn emit(&self, event: CodexChatEvent) {
            let _ = self.0.send(event);
        }
    }

    #[cfg(unix)]
    fn fake_app_server_command(log_path: &Path, scenario: &str) -> Command {
        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-codex-app-server.sh");
        let mut command = Command::new("/bin/sh");
        command
            .arg(fixture)
            .env("ROSTER_FAKE_CODEX_LOG", log_path)
            .env("ROSTER_FAKE_CODEX_SCENARIO", scenario)
            .env("ROSTER_FAKE_CODEX_TIMEOUT_SECONDS", "5");
        command
    }

    #[cfg(unix)]
    fn receive_until_kind(
        receiver: &std::sync::mpsc::Receiver<CodexChatEvent>,
        expected_kind: &str,
    ) -> Vec<CodexChatEvent> {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut events = Vec::new();
        loop {
            let remaining = deadline
                .checked_duration_since(std::time::Instant::now())
                .expect("等待 Codex 契约事件超时");
            let event = receiver
                .recv_timeout(remaining)
                .expect("没有收到预期的 Codex 契约事件");
            let finished = event.kind == expected_kind;
            events.push(event);
            if finished {
                return events;
            }
        }
    }

    #[cfg(unix)]
    fn read_fake_requests(log_path: &Path) -> Vec<Value> {
        std::fs::read_to_string(log_path)
            .expect("读取 fake app-server 请求日志")
            .lines()
            .map(|line| serde_json::from_str(line).expect("fake app-server 日志应为 JSON"))
            .collect()
    }

    #[cfg(unix)]
    fn contract_start(
        state: &CodexChatState,
        cwd: &Path,
        log_path: &Path,
        scenario: &str,
        thread_id: &str,
        allow_write: bool,
    ) -> std::sync::mpsc::Receiver<CodexChatEvent> {
        contract_start_with_mode(state, cwd, log_path, scenario, thread_id, allow_write, "")
    }

    #[cfg(unix)]
    #[allow(clippy::too_many_arguments)]
    fn contract_start_with_mode(
        state: &CodexChatState,
        cwd: &Path,
        log_path: &Path,
        scenario: &str,
        thread_id: &str,
        allow_write: bool,
        mode: &str,
    ) -> std::sync::mpsc::Receiver<CodexChatEvent> {
        let (event_sender, event_receiver) = std::sync::mpsc::channel();
        let run_id = format!("contract-{scenario}");
        let result = start_prepared(
            Arc::new(TestEventSink(event_sender)),
            state,
            PreparedStart {
                run_id: run_id.clone(),
                thread_id: thread_id.to_string(),
                prompt: "检查项目状态".to_string(),
                allow_write,
                mode: mode.to_string(),
                model: String::new(),
                effort: String::new(),
                cwd: cwd.to_path_buf(),
            },
            fake_app_server_command(log_path, scenario),
        )
        .expect("启动 fake Codex app-server");
        assert_eq!(result.run_id, run_id);
        event_receiver
    }

    #[cfg(unix)]
    #[test]
    fn a_dead_process_ends_the_turn_instead_of_waiting_for_an_answer() {
        // 等审批时我们不读 stdout，进程死了不会有任何动静；没有失活检查的话，
        // 界面会挂着「等你批准后继续」一直空等到整轮超时（一小时）。
        let dir = std::env::temp_dir().join(format!("roster-approval-die-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let log_path = dir.join("fake.log");
        let state = CodexChatState::default();
        let events = contract_start_with_mode(
            &state,
            &dir,
            &log_path,
            "approval-then-die",
            "",
            true,
            "request-approval",
        );

        receive_until_kind(&events, "approval");

        // 必须很快收尾。整轮超时是一小时，所以这里卡住就意味着界面会挂着
        // 「等你批准后继续」空等一小时；10 秒的上限足以把那种情况判成失败。
        let mut settled = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while let Ok(event) =
            events.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
        {
            settled.push(event);
        }

        let resolved = settled
            .iter()
            .find(|event| event.kind == "approval_resolved")
            .expect("卡片要被收掉，不能留一张永远能点的");
        assert_eq!(resolved.data["decision"], json!("cancelled"));
        let error = settled
            .iter()
            .find(|event| event.kind == "error")
            .expect("要告诉用户这一轮为什么结束了");
        assert!(
            error.data["message"]
                .as_str()
                .unwrap_or_default()
                .contains("退出"),
            "错误信息要说清是进程退出，实际：{}",
            error.data["message"]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn request_approval_mode_asks_the_user_and_sends_back_the_decision() {
        let dir = std::env::temp_dir().join(format!("roster-approval-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let log_path = dir.join("fake.log");
        let state = CodexChatState::default();
        let events = contract_start_with_mode(
            &state,
            &dir,
            &log_path,
            "user-approval",
            "",
            true,
            "request-approval",
        );

        // 请求要先变成一张收敛过的卡片：只有理由和命令，没有协议原文。
        let seen = receive_until_kind(&events, "approval");
        let card = seen.last().expect("应该收到审批事件");
        assert_eq!(card.kind, "approval");
        assert_eq!(card.data["approvalId"], json!("exec-approval-1"));
        assert_eq!(card.data["kind"], json!("command"));
        assert_eq!(card.data["reason"], json!("是否允许联网抓取 example.com？"));
        assert_eq!(card.data["command"], json!("curl -sS https://example.com"));
        assert!(card.data.get("params").is_none(), "不得透传协议对象");

        // 伪造的 ID 和不认识的决定都必须被拒，绝不能退化成"批准"。
        assert!(approve(&state, "contract-user-approval", "别的ID", "accept").is_err());
        assert!(approve(&state, "contract-user-approval", "exec-approval-1", "yes").is_err());

        approve(
            &state,
            "contract-user-approval",
            "exec-approval-1",
            "accept",
        )
        .expect("送出用户的决定");
        let resolved = receive_until_kind(&events, "approval_resolved");
        let last = resolved.last().unwrap();
        assert_eq!(last.data["approvalId"], json!("exec-approval-1"));
        assert_eq!(last.data["decision"], json!("accept"));

        receive_until_kind(&events, "completed");
        // 决定必须真的按协议格式回给了 app-server。
        let requests = read_fake_requests(&log_path);
        let reply = requests
            .iter()
            .find(|item| item.get("id") == Some(&json!(101)))
            .expect("审批答复要回到 app-server");
        assert_eq!(reply["result"]["decision"], json!("accept"));

        // 答复过一次之后就不再等待，重复提交要被拒。
        assert!(approve(
            &state,
            "contract-user-approval",
            "exec-approval-1",
            "accept"
        )
        .is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn validates_ids_and_bounded_prompts() {
        assert!(validate_run_id("chat-123_ok").is_ok());
        assert!(validate_run_id("../bad").is_err());
        assert!(validate_thread_id("019f-f00d").is_ok());
        assert!(validate_thread_id("bad/thread").is_err());
        assert!(validate_prompt("  帮我整理项目  ").is_ok());
        assert!(validate_prompt("\0").is_err());
        assert!(validate_prompt(&"a".repeat(MAX_PROMPT_BYTES + 1)).is_err());
        let exact_chinese_bytes = format!("{}a", "你".repeat(MAX_PROMPT_BYTES / 3));
        assert_eq!(exact_chinese_bytes.len(), MAX_PROMPT_BYTES);
        assert!(validate_prompt(&exact_chinese_bytes).is_ok());
        assert!(validate_prompt(&format!("{exact_chinese_bytes}a")).is_err());
        assert!(validate_prompt(&"🙂".repeat(MAX_PROMPT_BYTES / 4)).is_ok());
        assert!(validate_prompt(&"🙂".repeat(MAX_PROMPT_BYTES / 4 + 1)).is_err());
    }

    #[test]
    fn normalizes_agent_plan_and_file_events_without_raw_output() {
        let cwd = Path::new("/tmp/demo");
        let delta = json!({
            "method": "item/agentMessage/delta",
            "params": { "delta": "正在处理" }
        });
        assert_eq!(
            normalized_notification(&delta, cwd, &AssistantMessageState::default()),
            Some(("assistant_delta".into(), json!({ "text": "正在处理" })))
        );

        let file = json!({
            "method": "item/completed",
            "params": {
                "item": {
                    "id": "item-1",
                    "type": "fileChange",
                    "status": "completed",
                    "changes": [{
                        "path": "/tmp/demo/src/main.js",
                        "kind": "update",
                        "diff": "secret diff that must not cross the boundary"
                    }]
                }
            }
        });
        let (_, activity) = normalized_notification(&file, cwd, &AssistantMessageState::default())
            .expect("activity");
        assert_eq!(
            activity.pointer("/files/0/path").and_then(Value::as_str),
            Some("src/main.js")
        );
        assert!(activity.to_string().find("secret diff").is_none());

        let plan = json!({
            "method": "turn/plan/updated",
            "params": { "plan": [{ "step": "检查现状", "status": "completed" }] }
        });
        assert_eq!(
            normalized_notification(&plan, cwd, &AssistantMessageState::default())
                .and_then(|(_, data)| data.pointer("/items/0/step").cloned()),
            Some(Value::String("检查现状".into()))
        );
    }

    #[test]
    fn completed_event_keeps_only_safe_turn_summary() {
        let message = json!({
            "method": "turn/completed",
            "params": {
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "status": "failed",
                    "error": { "message": "登录已过期", "additionalDetails": "private" },
                    "items": [{ "aggregatedOutput": "secret" }]
                }
            }
        });
        let (kind, data) = normalized_notification(
            &message,
            Path::new("/tmp"),
            &AssistantMessageState::default(),
        )
        .expect("event");
        assert_eq!(kind, "completed");
        assert_eq!(
            data.get("error").and_then(Value::as_str),
            Some("登录已过期")
        );
        assert!(data.to_string().find("secret").is_none());
        assert!(data.to_string().find("private").is_none());
    }

    #[test]
    fn completed_agent_message_is_only_a_no_delta_fallback() {
        let message = json!({
            "method": "item/completed",
            "params": { "item": { "id": "agent-1", "type": "agentMessage", "text": "完整回复" } }
        });
        assert_eq!(
            normalized_notification(
                &message,
                Path::new("/tmp"),
                &AssistantMessageState::default()
            ),
            Some(("assistant_message".into(), json!({ "text": "完整回复" })))
        );
        let mut streamed = AssistantMessageState::default();
        streamed.delta_item_ids.insert("agent-1".into());
        assert_eq!(
            normalized_notification(&message, Path::new("/tmp"), &streamed),
            None
        );

        let anonymous = AssistantMessageState {
            anonymous_delta_text: "完整回复".into(),
            ..AssistantMessageState::default()
        };
        assert_eq!(
            normalized_notification(&message, Path::new("/tmp"), &anonymous),
            None
        );
        let different_anonymous = AssistantMessageState {
            anonymous_delta_text: "另一条回复".into(),
            ..AssistantMessageState::default()
        };
        assert!(
            normalized_notification(&message, Path::new("/tmp"), &different_anonymous).is_some()
        );

        let nested_id_delta = json!({
            "method": "item/agentMessage/delta",
            "params": { "item": { "id": "agent-1" }, "delta": "兼容旧协议" }
        });
        assert_eq!(
            agent_message_delta_item_id(&nested_id_delta).as_deref(),
            Some("agent-1")
        );
    }

    #[test]
    fn protocol_reader_rejects_oversized_lines() {
        let mut small = std::io::Cursor::new(b"{\"ok\":true}\nnext".to_vec());
        assert_eq!(
            read_protocol_line(&mut small).expect("small line"),
            Some("{\"ok\":true}".into())
        );
        assert_eq!(
            read_protocol_line(&mut small).expect("line without newline"),
            Some("next".into())
        );

        let mut oversized = std::io::Cursor::new(vec![b'x'; MAX_PROTOCOL_LINE_BYTES + 1]);
        assert!(read_protocol_line(&mut oversized).is_err());
    }

    #[test]
    fn protocol_budget_counts_every_line() {
        let mut budget = ProtocolBudget::default();
        let lines = [
            "not-json",
            r#"{"method":"unknown/notification"}"#,
            r#"{"id":9,"method":"unknown/request","params":{}}"#,
        ];
        for line in lines {
            budget.record_protocol_line(line).expect("within budget");
        }
        budget
            .record_protocol_line("")
            .expect("empty protocol records count toward the message budget");
        let whitespace = "  \t ";
        budget
            .record_protocol_line(whitespace)
            .expect("whitespace bytes count toward the protocol budget");
        assert_eq!(budget.protocol_messages, lines.len() + 2);
        assert_eq!(
            budget.protocol_bytes,
            lines.iter().map(|line| line.len()).sum::<usize>() + whitespace.len()
        );

        budget.protocol_messages = MAX_PROTOCOL_MESSAGES;
        assert!(budget.record_protocol_line("{}").is_err());

        let mut byte_limited = ProtocolBudget {
            protocol_bytes: MAX_PROTOCOL_TURN_BYTES,
            ..ProtocolBudget::default()
        };
        assert!(byte_limited.record_protocol_line("{}").is_err());
    }

    #[test]
    fn file_activities_bound_paths_files_and_turn_totals() {
        let cwd = Path::new("/tmp/demo");
        let long_name = "界".repeat(MAX_ACTIVITY_PATH_BYTES);
        let changes = (0..MAX_ACTIVITY_FILES_PER_EVENT + 10)
            .map(|index| {
                json!({
                    "path": format!("/tmp/demo/{index}-{long_name}"),
                    "kind": "update",
                })
            })
            .collect::<Vec<_>>();
        let item = json!({
            "id": "item-bounded",
            "type": "fileChange",
            "status": "completed",
            "changes": changes,
        });
        let activity = activity_from_item(&item, cwd).expect("file activity");
        let files = activity
            .get("files")
            .and_then(Value::as_array)
            .expect("files");
        assert_eq!(files.len(), MAX_ACTIVITY_FILES_PER_EVENT);
        assert!(files.iter().all(|file| {
            file.get("path")
                .and_then(Value::as_str)
                .is_some_and(|path| path.len() <= MAX_ACTIVITY_PATH_BYTES && path.ends_with('…'))
        }));
        assert_eq!(
            relative_display_path("/tmp/demo/../outside/private.txt", cwd),
            "项目外文件"
        );

        let mut budget = ProtocolBudget::default();
        budget.record_activity(&activity).expect("within budget");
        budget.activity_events = MAX_ACTIVITY_EVENTS_PER_TURN;
        assert!(budget.record_activity(&activity).is_err());

        let mut turn_bytes_limited = ProtocolBudget {
            activity_bytes: MAX_ACTIVITY_TURN_BYTES,
            ..ProtocolBudget::default()
        };
        assert!(turn_bytes_limited.record_activity(&activity).is_err());

        let oversized = json!({ "payload": "x".repeat(MAX_ACTIVITY_EVENT_BYTES + 1) });
        assert!(ProtocolBudget::default()
            .record_activity(&oversized)
            .is_err());
    }

    #[test]
    fn cancelling_an_already_finished_run_is_idempotent() {
        assert!(cancel(&CodexChatState::default(), "chat-finished").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn app_server_contract_starts_read_only_and_declines_interactions() {
        let root = tempfile::tempdir().expect("temp project");
        let cwd = std::fs::canonicalize(root.path()).expect("canonical project");
        let log_path = cwd.join("fresh-requests.jsonl");
        let state = CodexChatState::default();
        let receiver = contract_start(&state, &cwd, &log_path, "start", "", false);

        let events = receive_until_kind(&receiver, "completed");
        assert!(events.iter().all(|event| event.kind != "error"));
        assert!(events.iter().any(|event| {
            event.kind == "thread"
                && event.data.get("threadId").and_then(Value::as_str) == Some("thread-contract-1")
        }));
        assert!(events.iter().any(|event| {
            event.kind == "completed"
                && event.data.get("status").and_then(Value::as_str) == Some("completed")
        }));

        let requests = read_fake_requests(&log_path);
        assert_eq!(requests.len(), 7);
        assert_eq!(
            requests[0].get("method").and_then(Value::as_str),
            Some("initialize")
        );
        assert_eq!(
            requests[1].get("method").and_then(Value::as_str),
            Some("initialized")
        );
        assert_eq!(
            requests[2].get("method").and_then(Value::as_str),
            Some("thread/start")
        );
        assert_eq!(
            requests[2]
                .pointer("/params/sandbox")
                .and_then(Value::as_str),
            Some("read-only")
        );
        assert_eq!(
            requests[3].get("method").and_then(Value::as_str),
            Some("turn/start")
        );
        assert_eq!(
            requests[3]
                .pointer("/params/sandboxPolicy/type")
                .and_then(Value::as_str),
            Some("readOnly")
        );
        assert_eq!(
            requests[3]
                .pointer("/params/input/0/text")
                .and_then(Value::as_str),
            Some("检查项目状态")
        );
        assert_eq!(
            requests[4],
            json!({ "id": 101, "result": { "decision": "decline" } })
        );
        assert_eq!(
            requests[5],
            json!({ "id": 102, "result": { "decision": "decline" } })
        );
        assert_eq!(
            requests[6],
            json!({ "id": 103, "result": { "answers": {} } })
        );
    }

    #[cfg(unix)]
    #[test]
    fn app_server_contract_resumes_with_workspace_write() {
        let root = tempfile::tempdir().expect("temp project");
        let cwd = std::fs::canonicalize(root.path()).expect("canonical project");
        let log_path = cwd.join("resume-requests.jsonl");
        let state = CodexChatState::default();
        let receiver = contract_start(&state, &cwd, &log_path, "resume", "thread-existing-1", true);

        let events = receive_until_kind(&receiver, "completed");
        assert!(events.iter().all(|event| event.kind != "error"));
        let requests = read_fake_requests(&log_path);
        assert_eq!(requests.len(), 7);
        assert_eq!(
            requests[2].get("method").and_then(Value::as_str),
            Some("thread/resume")
        );
        assert_eq!(
            requests[2]
                .pointer("/params/threadId")
                .and_then(Value::as_str),
            Some("thread-existing-1")
        );
        assert_eq!(
            requests[2]
                .pointer("/params/sandbox")
                .and_then(Value::as_str),
            Some("workspace-write")
        );
        assert_eq!(
            requests[3]
                .pointer("/params/sandboxPolicy/type")
                .and_then(Value::as_str),
            Some("workspaceWrite")
        );
        assert_eq!(
            requests[3]
                .pointer("/params/sandboxPolicy/networkAccess")
                .and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            requests[3]
                .pointer("/params/sandboxPolicy/writableRoots/0")
                .and_then(Value::as_str),
            Some(cwd.to_string_lossy().as_ref())
        );
        assert_eq!(
            requests[4],
            json!({ "id": 101, "result": { "decision": "accept" } })
        );
        assert_eq!(
            requests[5],
            json!({ "id": 102, "result": { "decision": "accept" } })
        );
    }

    #[cfg(unix)]
    #[test]
    fn app_server_contract_cancel_kills_process_and_emits_cancelled() {
        let root = tempfile::tempdir().expect("temp project");
        let cwd = std::fs::canonicalize(root.path()).expect("canonical project");
        let log_path = cwd.join("cancel-requests.jsonl");
        let state = CodexChatState::default();
        let receiver = contract_start(&state, &cwd, &log_path, "hang", "", false);

        let before_cancel = receive_until_kind(&receiver, "assistant_delta");
        assert!(before_cancel.iter().all(|event| event.kind != "error"));
        cancel(&state, "contract-hang").expect("cancel fake Codex app-server");
        let after_cancel = receive_until_kind(&receiver, "cancelled");
        assert!(after_cancel.iter().all(|event| event.kind != "completed"));
        assert!(state.active.lock().expect("active runs").is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn completed_turn_closes_stdin_before_graceful_cleanup() {
        let root = tempfile::tempdir().expect("temp project");
        let cwd = std::fs::canonicalize(root.path()).expect("canonical project");
        let log_path = cwd.join("stdin-eof-requests.jsonl");
        let state = CodexChatState::default();
        let receiver = contract_start(&state, &cwd, &log_path, "wait-stdin-eof", "", false);

        let events = receive_until_kind(&receiver, "completed");
        assert!(events.iter().all(|event| event.kind != "error"));
        assert!(
            read_fake_requests(&log_path)
                .iter()
                .any(|request| request.get("observed").and_then(Value::as_str) == Some("stdin-eof")),
            "completed App Server should observe stdin EOF before graceful cleanup"
        );
        assert!(state.active.lock().expect("active runs").is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn canonical_project_path_is_the_mutual_exclusion_key() {
        let root = tempfile::tempdir().expect("temp project");
        let cwd = std::fs::canonicalize(root.path()).expect("canonical project");
        let state = CodexChatState::default();
        let (sender, _receiver) = std::sync::mpsc::channel();
        let first = start_prepared(
            Arc::new(TestEventSink(sender)),
            &state,
            PreparedStart {
                run_id: "canonical-a".into(),
                thread_id: String::new(),
                prompt: "检查".into(),
                allow_write: false,
                mode: String::new(),
                model: String::new(),
                effort: String::new(),
                cwd: cwd.clone(),
            },
            fake_app_server_command(&cwd.join("canonical-a.jsonl"), "hang"),
        );
        assert!(first.is_ok());
        let (duplicate_sender, _duplicate_receiver) = std::sync::mpsc::channel();
        let duplicate = start_prepared(
            Arc::new(TestEventSink(duplicate_sender)),
            &state,
            PreparedStart {
                run_id: "canonical-b".into(),
                thread_id: String::new(),
                prompt: "检查".into(),
                allow_write: false,
                mode: String::new(),
                model: String::new(),
                effort: String::new(),
                cwd,
            },
            fake_app_server_command(&root.path().join("canonical-b.jsonl"), "hang"),
        );
        assert!(duplicate
            .expect_err("same canonical directory must be exclusive")
            .contains("已有一条对话"));
        cancel(&state, "canonical-a").expect("cancel fixture");
    }

    #[cfg(unix)]
    #[test]
    fn app_server_keeps_long_stream_when_completed_message_repeats_it() {
        let root = tempfile::tempdir().expect("temp project");
        let cwd = std::fs::canonicalize(root.path()).expect("canonical project");
        let log_path = cwd.join("delta-completed-requests.jsonl");
        let state = CodexChatState::default();
        let receiver = contract_start(&state, &cwd, &log_path, "delta-completed", "", false);

        let events = receive_until_kind(&receiver, "completed");
        let streamed = events
            .iter()
            .filter(|event| event.kind == "assistant_delta")
            .filter_map(|event| event.data.get("text").and_then(Value::as_str))
            .collect::<String>();
        assert_eq!(streamed.len(), 40_000);
        assert_eq!(&streamed[..20_000], "a".repeat(20_000));
        assert_eq!(&streamed[20_000..], "b".repeat(20_000));
        assert!(events.iter().all(|event| event.kind != "assistant_message"));
    }

    #[cfg(unix)]
    #[test]
    fn app_server_keeps_no_delta_agent_message_after_another_item_streams() {
        let root = tempfile::tempdir().expect("temp project");
        let cwd = std::fs::canonicalize(root.path()).expect("canonical project");
        let log_path = cwd.join("multi-agent-requests.jsonl");
        let state = CodexChatState::default();
        let receiver = contract_start(&state, &cwd, &log_path, "multi-agent-message", "", false);

        let events = receive_until_kind(&receiver, "completed");
        let text = events
            .iter()
            .filter(|event| event.kind == "assistant_delta")
            .filter_map(|event| event.data.get("text").and_then(Value::as_str))
            .collect::<String>();
        assert_eq!(text, "流式第一段无流式第二段");
        assert!(events.iter().all(|event| event.kind != "assistant_message"));
    }

    #[cfg(unix)]
    #[test]
    fn stop_child_does_not_wait_for_an_already_empty_process_group() {
        use std::os::unix::process::CommandExt;

        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg("exit 0").process_group(0);
        let mut child = command.spawn().expect("spawn short lived leader");
        let _ = child.wait().expect("reap short lived leader");

        let started = std::time::Instant::now();
        stop_child(&mut child, false);
        assert!(
            started.elapsed() < Duration::from_millis(80),
            "empty process group cleanup should not incur the former fixed TERM delay"
        );
    }

    #[cfg(unix)]
    #[test]
    fn completed_run_reaps_group_after_leader_exits() {
        let root = tempfile::tempdir().expect("temp project");
        let cwd = std::fs::canonicalize(root.path()).expect("canonical project");
        let log_path = cwd.join("leader-exit-requests.jsonl");
        let child_pid_path = cwd.join("leader-exit-child.pid");
        let state = CodexChatState::default();
        let (sender, receiver) = std::sync::mpsc::channel();
        let mut command = fake_app_server_command(&log_path, "leader-exit-with-child");
        command.env("ROSTER_FAKE_CODEX_CHILD_PID_FILE", &child_pid_path);
        start_prepared(
            Arc::new(TestEventSink(sender)),
            &state,
            PreparedStart {
                run_id: "contract-leader-exit".into(),
                thread_id: String::new(),
                prompt: "检查项目状态".into(),
                allow_write: false,
                mode: String::new(),
                model: String::new(),
                effort: String::new(),
                cwd,
            },
            command,
        )
        .expect("启动 fake Codex app-server");

        let events = receive_until_kind(&receiver, "completed");
        assert!(events.iter().all(|event| event.kind != "error"));
        let process_ids =
            std::fs::read_to_string(&child_pid_path).expect("fixture 应记录进程组和子进程 pid");
        let mut process_ids = process_ids.split_whitespace();
        let process_group_id = process_ids
            .next()
            .expect("进程组 pid")
            .parse::<u32>()
            .expect("进程组 pid 应合法");
        let _child_pid = process_ids
            .next()
            .expect("子进程 pid")
            .parse::<u32>()
            .expect("子进程 pid 应合法");
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while process_group_exists(process_group_id) {
            assert!(std::time::Instant::now() < deadline, "组内子进程未被回收");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(unix)]
    #[test]
    fn leader_exit_without_completed_releases_the_run_and_reports_error() {
        let root = tempfile::tempdir().expect("temp project");
        let cwd = std::fs::canonicalize(root.path()).expect("canonical project");
        let log_path = cwd.join("leader-no-completed-requests.jsonl");
        let child_pid_path = cwd.join("leader-no-completed-child.pid");
        let state = CodexChatState::default();
        let (sender, receiver) = std::sync::mpsc::channel();
        let mut command = fake_app_server_command(&log_path, "leader-exit-with-child-no-completed");
        command.env("ROSTER_FAKE_CODEX_CHILD_PID_FILE", &child_pid_path);
        start_prepared(
            Arc::new(TestEventSink(sender)),
            &state,
            PreparedStart {
                run_id: "contract-leader-no-completed".into(),
                thread_id: String::new(),
                prompt: "检查项目状态".into(),
                allow_write: false,
                mode: String::new(),
                model: String::new(),
                effort: String::new(),
                cwd,
            },
            command,
        )
        .expect("启动 fake Codex app-server");

        let events = receive_until_kind(&receiver, "error");
        assert!(events.iter().all(|event| event.kind != "completed"));
        assert!(state.active.lock().expect("active runs").is_empty());
    }
}
