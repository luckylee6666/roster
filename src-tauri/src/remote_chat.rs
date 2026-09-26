//! 手机远程的「对话」通道：让手机像 Codex 手机端那样遥控电脑上的对话工作台。
//!
//! 电脑是唯一的执行者。手机的指令经 PIN 与形状校验后转给主窗口，由对话工作台走和
//! 桌面输入框同一条发送路径——同一项目一轮、并发上限、记忆附加、续接复核都留在原处，
//! 这里不复制任何一条规则。对话事件在发往主窗口的同时抄送到这里，再推给手机：手机拿到
//! 的就是主窗口那一份已收敛的事件，不多拿任何东西（不含 cwd、完整路径或原始协议）。
//!
//! 手机中途连上也要能接着看正在跑的一轮，所以每个活跃运行留一份有界快照（已输出的
//! 正文、状态、提示）。快照与事件共用一把锁和一个全局序号：手机先订阅再拿快照，快照
//! 之前的事件按序号丢弃，之后的照常应用，不重不漏。
//!
//! 与终端镜像共用同一个服务：同一套 PIN、私网来源限制、按需启动与停止即断开。

use crate::remote::RemoteHub;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::broadcast;

/// 手机可选的助手：与对话工作台登记的八家一致，顺序即手机上的展示顺序。
const PROVIDERS: [(&str, &str); 8] = [
    ("claude", "Claude"),
    ("codex", "Codex"),
    ("grok", "Grok"),
    ("opencode", "OpenCode"),
    ("agy", "agy"),
    ("qwen", "Qwen"),
    ("mimo", "MiMo Code"),
    ("cmd", "cmd"),
];

/// 同时留快照的运行数。应用总并发上限是 4，这里留足余量防止异常路径漏删。
const MAX_RUNS: usize = 16;
/// 单个运行快照里保留的正文上限；超过后只记"已截断"，完整内容看历史。
const SNAPSHOT_TEXT_CAP: usize = 256 * 1024;
const PROMPT_PREVIEW_CAP: usize = 4 * 1024;
/// 手机发来的指令帧上限：64 KiB 的消息加上 JSON 转义与字段开销。
const CHAT_WS_MAX: usize = 160 * 1024;
const HISTORY_LIMIT: usize = 80;
const TRANSCRIPT_BUDGET: usize = 1536 * 1024;
const TRANSCRIPT_MESSAGE_CAP: usize = 64 * 1024;
const REJECT_MESSAGE_CAP: usize = 600;
const INSTALLED_TTL: Duration = Duration::from_secs(60);

static APP: OnceLock<AppHandle> = OnceLock::new();
static RELAY: OnceLock<Relay> = OnceLock::new();
static INSTALLED: Mutex<Option<(Instant, Vec<String>)>> = Mutex::new(None);

/// 应用启动时登记 AppHandle：手机的指令要转给主窗口，项目记录也在 Tauri 托管状态里。
pub(crate) fn install(app: AppHandle) {
    let _ = APP.set(app);
}

struct Relay {
    tx: broadcast::Sender<Arc<str>>,
    table: Mutex<RunTable>,
}

fn relay() -> &'static Relay {
    RELAY.get_or_init(|| Relay {
        tx: broadcast::channel(1024).0,
        table: Mutex::new(RunTable::default()),
    })
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct RunSnapshot {
    run_id: String,
    project_id: String,
    provider_id: String,
    thread_id: String,
    prompt: String,
    status: &'static str,
    text: String,
    text_truncated: bool,
    notice: String,
    approval: Option<Value>,
    started_at_ms: u64,
}

#[derive(Default)]
struct RunTable {
    seq: u64,
    runs: Vec<RunSnapshot>,
}

impl RunTable {
    fn next_seq(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }

    fn contains(&self, run_id: &str) -> bool {
        self.runs.iter().any(|run| run.run_id == run_id)
    }

    fn register(&mut self, snapshot: RunSnapshot) -> bool {
        if self.contains(&snapshot.run_id) {
            return false;
        }
        if self.runs.len() >= MAX_RUNS {
            self.runs.remove(0);
        }
        self.runs.push(snapshot);
        true
    }

    /// 按事件更新快照；终态事件移除快照。只认登记时的 provider，错家事件不改快照。
    fn apply(&mut self, run_id: &str, provider_id: &str, kind: &str, data: &Value) {
        let Some(index) = self
            .runs
            .iter()
            .position(|run| run.run_id == run_id && run.provider_id == provider_id)
        else {
            return;
        };
        if matches!(kind, "completed" | "error" | "cancelled") {
            self.runs.remove(index);
            return;
        }
        let run = &mut self.runs[index];
        let text = data.get("text").and_then(Value::as_str);
        match kind {
            "thread" => {
                if let Some(thread) = data.get("threadId").and_then(Value::as_str) {
                    run.thread_id = bounded(thread, 200);
                }
            }
            "turn" => run.status = "running",
            "assistant_delta" => {
                if let Some(delta) = text {
                    if run.text.len() + delta.len() > SNAPSHOT_TEXT_CAP {
                        run.text_truncated = true;
                    } else {
                        run.text.push_str(delta);
                    }
                }
            }
            "assistant_message" => {
                if let Some(full) = text {
                    run.text_truncated = full.len() > SNAPSHOT_TEXT_CAP;
                    run.text = bounded(full, SNAPSHOT_TEXT_CAP);
                }
            }
            "notice" => {
                run.notice = data
                    .get("message")
                    .and_then(Value::as_str)
                    .map(|message| bounded(message, REJECT_MESSAGE_CAP))
                    .unwrap_or_default();
            }
            "approval" => run.approval = Some(data.clone()),
            "approval_resolved" => {
                let resolved = data.get("approvalId").and_then(Value::as_str);
                let pending = run
                    .approval
                    .as_ref()
                    .and_then(|approval| approval.get("approvalId"))
                    .and_then(Value::as_str);
                if resolved.is_some() && resolved == pending {
                    run.approval = None;
                }
            }
            _ => {}
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// 按 UTF-8 字符边界截断到 `max` 字节以内，超出时以省略号收尾。
fn bounded(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_string();
    }
    let mut end = max.saturating_sub('…'.len_utf8());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}

fn send_frame(relay: &Relay, frame: Value) {
    if relay.tx.receiver_count() > 0 {
        let _ = relay.tx.send(Arc::from(frame.to_string()));
    }
}

/// 对话事件的抄送口：`conversation_chat` 与 `codex_chat` 发往主窗口的同一份事件。
/// 记忆回执属于桌面内部状态，不发给手机。
pub(crate) fn publish_event(run_id: &str, provider_id: &str, kind: &str, data: &Value) {
    if matches!(kind, "memory" | "memory_saved") {
        return;
    }
    let relay = relay();
    let Ok(mut table) = relay.table.lock() else {
        return;
    };
    table.apply(run_id, provider_id, kind, data);
    let seq = table.next_seq();
    // 持锁发送：保证事件顺序与快照序号一致（见模块说明）。
    send_frame(
        relay,
        json!({
            "t": "ev",
            "seq": seq,
            "runId": run_id,
            "providerId": provider_id,
            "kind": kind,
            "data": data,
        }),
    );
}

/// 桌面开始一轮对话（无论谁发起）时登记快照，手机据此显示"正在进行"并接上事件流。
/// 返回是否为新登记：重复的运行 ID 不覆盖已有快照，启动失败时也不能删别人的。
pub(crate) fn run_registered(
    run_id: &str,
    project_id: &str,
    provider_id: &str,
    thread_id: &str,
    prompt: &str,
) -> bool {
    if crate::codex_chat::validate_run_id(run_id).is_err() {
        return false;
    }
    let snapshot = RunSnapshot {
        run_id: run_id.to_string(),
        project_id: bounded(project_id, 200),
        provider_id: bounded(provider_id, 32),
        thread_id: bounded(thread_id, 200),
        prompt: bounded(prompt.trim(), PROMPT_PREVIEW_CAP),
        status: "starting",
        text: String::new(),
        text_truncated: false,
        notice: String::new(),
        approval: None,
        started_at_ms: now_ms(),
    };
    let relay = relay();
    let Ok(mut table) = relay.table.lock() else {
        return false;
    };
    if !table.register(snapshot.clone()) {
        return false;
    }
    let seq = table.next_seq();
    send_frame(relay, json!({ "t": "run", "seq": seq, "run": snapshot }));
    true
}

/// 启动失败（后端拒绝、CLI 起不来）：主窗口自己在本地处理错误，手机只能从这里得知。
pub(crate) fn run_start_failed(run_id: &str, provider_id: &str, registered: bool, error: &str) {
    if registered {
        publish_event(
            run_id,
            provider_id,
            "error",
            &json!({ "message": bounded(error, REJECT_MESSAGE_CAP) }),
        );
    }
}

/// 主窗口拒绝手机的请求（项目正忙、助手未安装、会话已超窗……）时，把原因转成
/// 这一轮的错误事件发回手机。已经开始的运行不接受拒绝，免得把活着的一轮标成失败。
pub(crate) fn reject(run_id: &str, provider_id: &str, message: &str) -> Result<(), String> {
    crate::codex_chat::validate_run_id(run_id)?;
    if !PROVIDERS.iter().any(|(id, _)| *id == provider_id) {
        return Err("未知的助手".into());
    }
    let started = relay()
        .table
        .lock()
        .map(|table| table.contains(run_id))
        .unwrap_or(true);
    if started {
        return Ok(());
    }
    let message: String = message.chars().filter(|ch| !ch.is_control()).collect();
    let message = if message.trim().is_empty() {
        "电脑端没有接受这次请求".to_string()
    } else {
        bounded(message.trim(), REJECT_MESSAGE_CAP)
    };
    publish_event(run_id, provider_id, "error", &json!({ "message": message }));
    Ok(())
}

fn hello_frame() -> String {
    let table = relay().table.lock();
    match table {
        Ok(table) => json!({ "t": "hello", "seq": table.seq, "runs": table.runs }).to_string(),
        Err(_) => json!({ "t": "hello", "seq": 0, "runs": [] }).to_string(),
    }
}

// ===== 手机发来的指令 =====

#[derive(Debug, PartialEq)]
enum PhoneCommand {
    Send {
        run_id: String,
        project_id: String,
        provider_id: String,
        thread_id: String,
        prompt: String,
        mode: String,
    },
    Cancel {
        run_id: String,
    },
    Ping,
}

/// 解析失败时带上能对应到手机那一轮的运行 ID（可能为空），好让手机把错误落到正确的位置。
fn parse_phone_command(txt: &str) -> Result<PhoneCommand, (String, String)> {
    if txt.len() > CHAT_WS_MAX {
        return Err((String::new(), "指令过长".into()));
    }
    let value: Value =
        serde_json::from_str(txt).map_err(|_| (String::new(), "指令格式不对".to_string()))?;
    let field = |name: &str| {
        value
            .get(name)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let run_id = field("runId");
    match value.get("t").and_then(Value::as_str) {
        Some("ping") => Ok(PhoneCommand::Ping),
        Some("cancel") => {
            crate::codex_chat::validate_run_id(&run_id).map_err(|error| (String::new(), error))?;
            Ok(PhoneCommand::Cancel { run_id })
        }
        Some("send") => {
            crate::codex_chat::validate_run_id(&run_id).map_err(|error| (String::new(), error))?;
            let fail = |message: &str| (run_id.clone(), message.to_string());
            let project_id = field("projectId");
            if project_id.is_empty() || project_id.len() > 200 {
                return Err(fail("项目标识无效"));
            }
            let provider_id = field("providerId");
            if !PROVIDERS.iter().any(|(id, _)| *id == provider_id) {
                return Err(fail("未知的助手"));
            }
            let thread_id = field("threadId");
            if !valid_session_id(&thread_id, true) {
                return Err(fail("会话标识无效"));
            }
            let prompt = crate::codex_chat::validate_prompt(&field("prompt"))
                .map_err(|error| (run_id.clone(), error))?;
            let mode = field("mode");
            if !mode.is_empty()
                && !crate::conversation_modes::modes_for(&provider_id)
                    .iter()
                    .any(|entry| entry.id == mode)
            {
                return Err(fail("这个权限档位不可用"));
            }
            Ok(PhoneCommand::Send {
                run_id,
                project_id,
                provider_id,
                thread_id,
                prompt,
                mode,
            })
        }
        _ => Err((run_id, "不认识的指令".into())),
    }
}

/// 会话 ID 只做形状把关（真正的归属复核在桌面发送前和后端启动时各做一次）：
/// 有界、无空白与控制字符、不以 `-` 开头（防止被当成 CLI 选项）。
fn valid_session_id(value: &str, allow_empty: bool) -> bool {
    if value.is_empty() {
        return allow_empty;
    }
    value.len() <= 200
        && !value.starts_with('-')
        && !value
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace())
}

fn main_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "电脑端窗口没有打开".to_string())
}

fn dispatch(command: PhoneCommand) -> Result<(), String> {
    let app = APP.get().ok_or("电脑端还没准备好")?;
    match command {
        PhoneCommand::Ping => Ok(()),
        PhoneCommand::Cancel { run_id } => main_window(app)?
            .emit(
                "remote-conversation-command",
                json!({ "type": "cancel", "runId": run_id }),
            )
            .map_err(|error| error.to_string()),
        PhoneCommand::Send {
            run_id,
            project_id,
            provider_id,
            thread_id,
            prompt,
            mode,
        } => {
            let project =
                project_record(app, &project_id).ok_or("找不到这个项目，请在手机上刷新")?;
            main_window(app)?
                .emit(
                    "remote-conversation-command",
                    json!({
                        "type": "send",
                        "runId": run_id,
                        "projectId": project_id,
                        "providerId": provider_id,
                        "threadId": thread_id,
                        "prompt": prompt,
                        "mode": mode,
                    }),
                )
                .map_err(|error| error.to_string())?;
            // 对外触发执行的事件值得留痕；消息正文属于用户内容，不入日志。
            crate::log_info!(
                "手机远程发起对话：{} · {}{}",
                project.name,
                provider_id,
                if mode.is_empty() {
                    String::new()
                } else {
                    format!(" · {mode}")
                }
            );
            Ok(())
        }
    }
}

// ===== 数据接口 =====

struct ProjectRecord {
    id: String,
    name: String,
    group: String,
    path: String,
}

fn project_records(app: &AppHandle) -> Vec<ProjectRecord> {
    let Some(state) = app.try_state::<Mutex<crate::AppState>>() else {
        return Vec::new();
    };
    let Ok(state) = state.lock() else {
        return Vec::new();
    };
    state
        .projects
        .iter()
        .filter(|project| !project.local_path.trim().is_empty())
        .map(|project| ProjectRecord {
            id: project.id.clone(),
            name: project.name.clone(),
            group: project.group.clone(),
            path: project.local_path.clone(),
        })
        .collect()
}

fn project_record(app: &AppHandle, project_id: &str) -> Option<ProjectRecord> {
    project_records(app)
        .into_iter()
        .find(|project| project.id == project_id)
}

fn provider_binary(id: &str) -> Option<&'static str> {
    if id == "codex" {
        Some("codex")
    } else {
        crate::conversation_chat::provider_binary(id)
    }
}

/// 本机装了哪几家：和桌面一样只信登记的可执行文件名，结果缓存 60 秒。
fn installed_providers() -> Vec<String> {
    if let Ok(cache) = INSTALLED.lock() {
        if let Some((at, ids)) = cache.as_ref() {
            if at.elapsed() < INSTALLED_TTL {
                return ids.clone();
            }
        }
    }
    let names: Vec<String> = PROVIDERS
        .iter()
        .filter_map(|(id, _)| provider_binary(id).map(str::to_string))
        .collect();
    let found = crate::cli_detect::list_installed_cli_names(&names);
    let ids: Vec<String> = PROVIDERS
        .iter()
        .filter(|(id, _)| provider_binary(id).is_some_and(|bin| found.iter().any(|f| f == bin)))
        .map(|(id, _)| id.to_string())
        .collect();
    if let Ok(mut cache) = INSTALLED.lock() {
        *cache = Some((Instant::now(), ids.clone()));
    }
    ids
}

fn error_response(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

fn authorized(
    hub: &RemoteHub,
    query: &HashMap<String, String>,
) -> Result<&'static AppHandle, (StatusCode, &'static str)> {
    if !crate::remote::token_ok(hub, query) {
        return Err((StatusCode::UNAUTHORIZED, "PIN 错误"));
    }
    APP.get()
        .ok_or((StatusCode::SERVICE_UNAVAILABLE, "电脑端还没准备好"))
}

pub(crate) fn routes() -> Router<RemoteHub> {
    Router::new()
        .route("/api/chat/bootstrap", get(bootstrap))
        .route("/api/chat/history", get(history))
        .route("/api/chat/transcript", get(transcript))
        .route("/api/chat/ws", get(chat_ws))
}

/// 手机首屏需要的一切：项目（不含本机路径）、本机可用的助手与各自的权限档位。
async fn bootstrap(
    State(hub): State<RemoteHub>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let app = match authorized(&hub, &q) {
        Ok(app) => app,
        Err((status, message)) => return error_response(status, message),
    };
    let projects: Vec<Value> = project_records(app)
        .into_iter()
        .map(|project| json!({ "id": project.id, "name": project.name, "group": project.group }))
        .collect();
    let installed = tokio::task::spawn_blocking(installed_providers)
        .await
        .unwrap_or_default();
    let providers: Vec<Value> = PROVIDERS
        .iter()
        .filter(|(id, _)| installed.iter().any(|found| found == id))
        .map(|(id, label)| {
            json!({
                "id": id,
                "label": label,
                "modes": crate::conversation_modes::modes_for(id),
            })
        })
        .collect();
    Json(json!({ "projects": projects, "providers": providers })).into_response()
}

fn flatten_history(
    history: crate::project_sessions::ProjectHistory,
    titles: &crate::session_titles::SessionTitles,
) -> Vec<Value> {
    let mut sessions: Vec<(u64, Value)> = history
        .groups
        .into_iter()
        .flat_map(|group| {
            let label = group.label;
            group.sessions.into_iter().map(move |session| {
                let custom = titles
                    .get(&format!("{}:{}", session.tool, session.id))
                    .cloned()
                    .unwrap_or_default();
                let title = if custom.trim().is_empty() {
                    session.title
                } else {
                    custom
                };
                (
                    session.at_ms,
                    json!({
                        "id": session.id,
                        "tool": session.tool,
                        "label": label,
                        "title": bounded(&title, 300),
                        "preview": bounded(&session.preview, 400),
                        "atMs": session.at_ms,
                        "band": session.budget.band,
                        "blocks": session.budget.blocks,
                        "estTokens": session.budget.est_tokens,
                    }),
                )
            })
        })
        .collect();
    sessions.sort_by_key(|session| std::cmp::Reverse(session.0));
    sessions
        .into_iter()
        .take(HISTORY_LIMIT)
        .map(|(_, session)| session)
        .collect()
}

async fn history(
    State(hub): State<RemoteHub>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let app = match authorized(&hub, &q) {
        Ok(app) => app,
        Err((status, message)) => return error_response(status, message),
    };
    let project_id = q.get("project").cloned().unwrap_or_default();
    let Some(project) = project_record(app, &project_id) else {
        return error_response(StatusCode::NOT_FOUND, "找不到这个项目");
    };
    let result = tokio::task::spawn_blocking(move || {
        let history = crate::project_sessions::list_project_history(&project.path)?;
        Ok::<_, String>(flatten_history(history, &crate::session_titles::load()))
    })
    .await;
    match result {
        Ok(Ok(sessions)) => Json(json!({ "sessions": sessions })).into_response(),
        Ok(Err(error)) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &error),
        Err(_) => error_response(StatusCode::INTERNAL_SERVER_ERROR, "读取历史失败"),
    }
}

/// 手机只看文字：图片换成数量；从最新往回装，总量与单条都有上限。
fn phone_transcript(preview: crate::project_sessions::ConversationTranscriptPreview) -> Value {
    let mut budget = TRANSCRIPT_BUDGET;
    let mut truncated = preview.truncated;
    let mut messages = Vec::new();
    for message in preview.messages.into_iter().rev() {
        let text = bounded(&message.text, TRANSCRIPT_MESSAGE_CAP);
        if text.len() > budget {
            truncated = true;
            break;
        }
        budget -= text.len();
        messages.push(json!({
            "role": message.role,
            "text": text,
            "images": message.attachments.len(),
        }));
    }
    messages.reverse();
    json!({
        "sourceTool": preview.source_tool,
        "sourceId": preview.source_id,
        "title": bounded(&preview.source_title, 300),
        "atMs": preview.source_at_ms,
        "messages": messages,
        "truncated": truncated,
    })
}

async fn transcript(
    State(hub): State<RemoteHub>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let app = match authorized(&hub, &q) {
        Ok(app) => app,
        Err((status, message)) => return error_response(status, message),
    };
    let get = |name: &str| q.get(name).cloned().unwrap_or_default();
    let (project_id, tool, id) = (get("project"), get("tool"), get("id"));
    if !PROVIDERS.iter().any(|(provider, _)| *provider == tool) || !valid_session_id(&id, false) {
        return error_response(StatusCode::BAD_REQUEST, "会话标识无效");
    }
    let Some(project) = project_record(app, &project_id) else {
        return error_response(StatusCode::NOT_FOUND, "找不到这个项目");
    };
    let result = tokio::task::spawn_blocking(move || {
        crate::project_sessions::preview_conversation_transcript(&project.path, &tool, &id)
    })
    .await;
    match result {
        Ok(Ok(preview)) => Json(phone_transcript(preview)).into_response(),
        Ok(Err(error)) => error_response(StatusCode::NOT_FOUND, &error),
        Err(_) => error_response(StatusCode::INTERNAL_SERVER_ERROR, "读取对话失败"),
    }
}

// ===== WebSocket：事件下行 + 指令上行 =====

async fn chat_ws(
    ws: WebSocketUpgrade,
    State(hub): State<RemoteHub>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if let Err((status, message)) = authorized(&hub, &q) {
        return error_response(status, message);
    }
    ws.max_message_size(CHAT_WS_MAX)
        .max_frame_size(CHAT_WS_MAX)
        .on_upgrade(move |socket| chat_socket(socket, hub))
}

async fn chat_socket(mut socket: WebSocket, hub: RemoteHub) {
    // 先订阅再取快照：快照之前的事件由手机按序号丢弃（见模块说明）。
    let mut frames = relay().tx.subscribe();
    let mut shutdown = hub.subscribe_shutdown();
    if socket.send(Message::Text(hello_frame())).await.is_err() {
        return;
    }
    loop {
        tokio::select! {
            frame = frames.recv() => match frame {
                Ok(frame) => {
                    if socket.send(Message::Text(frame.to_string())).await.is_err() {
                        break;
                    }
                }
                // 手机跟不上丢了一段：重发快照，让它按新序号重建正在进行的几轮。
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    if socket.send(Message::Text(hello_frame())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            inbound = socket.recv() => match inbound {
                Some(Ok(Message::Text(txt))) => {
                    if let Some(reply) = handle_phone_text(&txt) {
                        if socket.send(Message::Text(reply)).await.is_err() {
                            break;
                        }
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
            // 桌面停止手机远程：已连上的对话通道一并断开。
            _ = shutdown.recv() => {
                let _ = socket.send(Message::Close(None)).await;
                break;
            }
        }
    }
}

fn handle_phone_text(txt: &str) -> Option<String> {
    let command = match parse_phone_command(txt) {
        Ok(command) => command,
        Err((run_id, message)) => {
            return Some(json!({ "t": "reject", "runId": run_id, "message": message }).to_string())
        }
    };
    if command == PhoneCommand::Ping {
        return Some(json!({ "t": "pong" }).to_string());
    }
    let run_id = match &command {
        PhoneCommand::Send { run_id, .. } | PhoneCommand::Cancel { run_id } => run_id.clone(),
        PhoneCommand::Ping => String::new(),
    };
    match dispatch(command) {
        Ok(()) => None,
        Err(message) => {
            Some(json!({ "t": "reject", "runId": run_id, "message": message }).to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(run_id: &str) -> RunSnapshot {
        RunSnapshot {
            run_id: run_id.into(),
            project_id: "p1".into(),
            provider_id: "claude".into(),
            thread_id: String::new(),
            prompt: "列出文件".into(),
            status: "starting",
            text: String::new(),
            text_truncated: false,
            notice: String::new(),
            approval: None,
            started_at_ms: 1,
        }
    }

    #[test]
    fn snapshot_follows_stream_and_terminal_events_remove_it() {
        let mut table = RunTable::default();
        assert!(table.register(snapshot("chat-a")));
        assert!(
            !table.register(snapshot("chat-a")),
            "重复登记不能覆盖已有快照"
        );
        table.apply("chat-a", "claude", "thread", &json!({ "threadId": "t-1" }));
        table.apply("chat-a", "claude", "turn", &json!({}));
        table.apply(
            "chat-a",
            "claude",
            "assistant_delta",
            &json!({ "text": "你好" }),
        );
        table.apply(
            "chat-a",
            "claude",
            "assistant_delta",
            &json!({ "text": "，世界" }),
        );
        // 错家事件不改快照。
        table.apply(
            "chat-a",
            "codex",
            "assistant_delta",
            &json!({ "text": "串台" }),
        );
        let run = &table.runs[0];
        assert_eq!(run.thread_id, "t-1");
        assert_eq!(run.status, "running");
        assert_eq!(run.text, "你好，世界");
        table.apply(
            "chat-a",
            "claude",
            "assistant_message",
            &json!({ "text": "最终回复" }),
        );
        assert_eq!(table.runs[0].text, "最终回复");
        table.apply(
            "chat-a",
            "claude",
            "completed",
            &json!({ "status": "completed" }),
        );
        assert!(table.runs.is_empty());
    }

    #[test]
    fn snapshot_tracks_only_the_pending_approval() {
        let mut table = RunTable::default();
        table.register(snapshot("chat-a"));
        table.apply(
            "chat-a",
            "claude",
            "approval",
            &json!({ "approvalId": "ap-2" }),
        );
        table.apply(
            "chat-a",
            "claude",
            "approval_resolved",
            &json!({ "approvalId": "ap-1" }),
        );
        assert!(
            table.runs[0].approval.is_some(),
            "迟到的旧答复不能抹掉新请求"
        );
        table.apply(
            "chat-a",
            "claude",
            "approval_resolved",
            &json!({ "approvalId": "ap-2" }),
        );
        assert!(table.runs[0].approval.is_none());
    }

    #[test]
    fn snapshot_text_is_bounded() {
        let mut table = RunTable::default();
        table.register(snapshot("chat-a"));
        let chunk = "x".repeat(SNAPSHOT_TEXT_CAP);
        table.apply(
            "chat-a",
            "claude",
            "assistant_delta",
            &json!({ "text": chunk }),
        );
        table.apply(
            "chat-a",
            "claude",
            "assistant_delta",
            &json!({ "text": "y" }),
        );
        assert_eq!(table.runs[0].text.len(), SNAPSHOT_TEXT_CAP);
        assert!(table.runs[0].text_truncated);
    }

    #[test]
    fn run_table_keeps_a_bounded_number_of_runs() {
        let mut table = RunTable::default();
        for index in 0..(MAX_RUNS + 3) {
            table.register(snapshot(&format!("chat-{index}")));
        }
        assert_eq!(table.runs.len(), MAX_RUNS);
        assert_eq!(table.runs[0].run_id, "chat-3");
    }

    #[test]
    fn phone_send_command_is_validated() {
        let ok = json!({
            "t": "send", "runId": "chat-1", "projectId": "p1", "providerId": "claude",
            "threadId": "", "prompt": "  列出当前目录  ", "mode": "",
        });
        assert_eq!(
            parse_phone_command(&ok.to_string()),
            Ok(PhoneCommand::Send {
                run_id: "chat-1".into(),
                project_id: "p1".into(),
                provider_id: "claude".into(),
                thread_id: String::new(),
                prompt: "列出当前目录".into(),
                mode: String::new(),
            })
        );
        let with = |key: &str, value: Value| {
            let mut frame = ok.clone();
            frame[key] = value;
            parse_phone_command(&frame.to_string())
        };
        assert!(matches!(with("providerId", json!("bash")), Err((id, _)) if id == "chat-1"));
        assert!(with("runId", json!("chat 1; rm")).is_err());
        assert!(
            with("threadId", json!("--resume")).is_err(),
            "不能被当成 CLI 选项"
        );
        assert!(with("threadId", json!("a b")).is_err());
        assert!(with("prompt", json!("   ")).is_err());
        assert!(with(
            "prompt",
            json!("x".repeat(crate::codex_chat::MAX_PROMPT_BYTES + 1))
        )
        .is_err());
        assert!(
            with("mode", json!("yolo-anything")).is_err(),
            "只认后端登记的档位"
        );
        assert!(with("projectId", json!("")).is_err());
    }

    #[test]
    fn phone_cancel_and_ping_are_parsed() {
        assert_eq!(
            parse_phone_command(r#"{"t":"cancel","runId":"chat-9"}"#),
            Ok(PhoneCommand::Cancel {
                run_id: "chat-9".into()
            })
        );
        assert_eq!(
            parse_phone_command(r#"{"t":"ping"}"#),
            Ok(PhoneCommand::Ping)
        );
        assert!(parse_phone_command(r#"{"t":"cancel","runId":""}"#).is_err());
        assert!(parse_phone_command(r#"{"t":"exec","cmd":"ls"}"#).is_err());
        assert!(parse_phone_command("not-json").is_err());
    }

    #[test]
    fn history_is_merged_newest_first_with_custom_titles() {
        use crate::project_sessions::{ProjectHistory, ProjectHistoryGroup, ProjectHistorySession};
        use crate::session_budget::SessionBudget;
        let session = |id: &str, tool: &str, at_ms: u64| ProjectHistorySession {
            id: id.into(),
            tool: tool.into(),
            title: format!("{id} 原标题"),
            preview: "预览".into(),
            at_ms,
            budget: SessionBudget::unknown(),
        };
        let history = ProjectHistory {
            groups: vec![
                ProjectHistoryGroup {
                    tool: "claude".into(),
                    label: "Claude".into(),
                    sessions: vec![session("c1", "claude", 10), session("c2", "claude", 30)],
                },
                ProjectHistoryGroup {
                    tool: "codex".into(),
                    label: "Codex".into(),
                    sessions: vec![session("x1", "codex", 20)],
                },
            ],
        };
        let mut titles = crate::session_titles::SessionTitles::new();
        titles.insert("codex:x1".into(), "改过的名字".into());
        let flat = flatten_history(history, &titles);
        let ids: Vec<&str> = flat.iter().map(|s| s["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["c2", "x1", "c1"]);
        assert_eq!(flat[1]["title"], "改过的名字");
        assert_eq!(flat[1]["label"], "Codex");
    }

    #[test]
    fn transcript_keeps_newest_messages_within_budget() {
        use crate::project_sessions::{
            ConversationTranscriptMessage, ConversationTranscriptPreview,
        };
        let message = |text: String| ConversationTranscriptMessage {
            role: "assistant".into(),
            text,
            attachments: Vec::new(),
        };
        let big = "a".repeat(TRANSCRIPT_MESSAGE_CAP);
        let count = TRANSCRIPT_BUDGET / TRANSCRIPT_MESSAGE_CAP + 4;
        let mut messages: Vec<_> = (0..count).map(|_| message(big.clone())).collect();
        messages.push(message("最新一条".into()));
        let value = phone_transcript(ConversationTranscriptPreview {
            source_tool: "claude".into(),
            source_id: "s1".into(),
            source_title: "标题".into(),
            source_at_ms: 1,
            messages,
            truncated: false,
        });
        let kept = value["messages"].as_array().unwrap();
        assert!(kept.len() < count + 1);
        assert_eq!(kept.last().unwrap()["text"], "最新一条");
        assert_eq!(value["truncated"], true);
    }

    #[test]
    fn bounded_respects_utf8_boundaries() {
        let text = "中文字符".repeat(10);
        let cut = bounded(&text, 10);
        assert!(cut.len() <= 10);
        assert!(cut.ends_with('…'));
        assert_eq!(bounded("短", 10), "短");
    }
}
