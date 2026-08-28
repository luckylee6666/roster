//! 普通用户对话工作台的多 CLI 路由与无头结构化适配器。
//!
//! 前端只能选择这里登记的 provider id，不能传可执行文件、参数或 cwd。Codex 继续
//! 使用专用 app-server 适配器；其他已验证工具使用各自的结构化无头输出。所有运行
//! 共用 `CodexChatState` 的并发、同项目互斥和进程组取消边界。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use crate::codex_chat::{ActiveRun, CodexChatStartInput, CodexChatState};

const MAX_PROTOCOL_LINE_BYTES: usize = 1024 * 1024;
const MAX_PROTOCOL_MESSAGES: usize = 16_384;
const MAX_PROTOCOL_TURN_BYTES: usize = 64 * 1024 * 1024;
const MAX_ASSISTANT_TURN_BYTES: usize = 2 * 1024 * 1024;
const MAX_NORMALIZED_EVENTS: usize = 4_096;
const MAX_ACTIVITY_EVENTS: usize = 1_024;
const STDERR_TAIL_BYTES: usize = 4_096;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);
const TURN_TIMEOUT: Duration = Duration::from_secs(60 * 60);

pub type ConversationChatState = CodexChatState;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HeadlessProtocol {
    AnthropicMessages,
    GeminiStream,
    OpenCodeJson,
    QwenStream,
}

#[derive(Clone, Copy, Debug)]
struct ProviderSpec {
    id: &'static str,
    label: &'static str,
    binary: &'static str,
    protocol: HeadlessProtocol,
}

const HEADLESS_PROVIDERS: [ProviderSpec; 7] = [
    ProviderSpec {
        id: "claude",
        label: "Claude",
        binary: "claude",
        protocol: HeadlessProtocol::AnthropicMessages,
    },
    ProviderSpec {
        id: "grok",
        label: "Grok",
        binary: "grok",
        protocol: HeadlessProtocol::AnthropicMessages,
    },
    ProviderSpec {
        id: "gemini",
        label: "Gemini",
        binary: "gemini",
        protocol: HeadlessProtocol::GeminiStream,
    },
    ProviderSpec {
        id: "agy",
        label: "agy",
        binary: "agy",
        protocol: HeadlessProtocol::AnthropicMessages,
    },
    ProviderSpec {
        id: "opencode",
        label: "OpenCode",
        binary: "opencode",
        protocol: HeadlessProtocol::OpenCodeJson,
    },
    ProviderSpec {
        id: "qwen",
        label: "Qwen",
        binary: "qwen",
        protocol: HeadlessProtocol::QwenStream,
    },
    ProviderSpec {
        id: "mimo",
        label: "MiMo Code",
        binary: "mimo",
        protocol: HeadlessProtocol::OpenCodeJson,
    },
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationChatStartInput {
    pub project_id: String,
    pub provider_id: String,
    pub run_id: String,
    #[serde(default)]
    pub thread_id: String,
    pub prompt: String,
    /// 各家 CLI 自己的权限模式 ID，空串表示用这家最保守的一档。
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub handoff_provider_id: String,
    #[serde(default)]
    pub handoff_session_id: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: String,
    #[serde(default)]
    pub attachments: Vec<ConversationAttachmentInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationAttachmentInput {
    pub id: String,
    pub mime: String,
    pub data_base64: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationChatStartResult {
    pub run_id: String,
    pub provider_id: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ConversationChatEvent {
    run_id: String,
    provider_id: String,
    kind: String,
    data: Value,
}

fn provider_spec(id: &str) -> Option<&'static ProviderSpec> {
    HEADLESS_PROVIDERS.iter().find(|provider| provider.id == id)
}

fn provider_label(id: &str) -> &'static str {
    match id {
        "claude" => "Claude",
        "grok" => "Grok",
        "codex" => "Codex",
        "opencode" => "OpenCode",
        "gemini" => "Gemini",
        "agy" => "agy",
        "qwen" => "Qwen",
        "mimo" => "MiMo Code",
        _ => "CLI",
    }
}

fn emit(app: &AppHandle, run_id: &str, provider_id: &str, kind: &str, data: Value) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit(
            "conversation-chat-event",
            ConversationChatEvent {
                run_id: run_id.to_string(),
                provider_id: provider_id.to_string(),
                kind: kind.to_string(),
                data,
            },
        );
    }
}

fn bounded_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    const ELLIPSIS: &str = "…";
    let mut end = max_bytes.saturating_sub(ELLIPSIS.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{}", &value[..end], ELLIPSIS)
}

fn safe_event_id(value: &str, fallback: &str) -> String {
    let value = value.trim();
    if !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        value.to_string()
    } else {
        fallback.to_string()
    }
}

fn read_protocol_line<R: BufRead>(reader: &mut R) -> Result<Option<String>, String> {
    let mut line = Vec::new();
    loop {
        let (take, complete) = {
            let available = reader
                .fill_buf()
                .map_err(|_| "读取 CLI 结构化响应失败".to_string())?;
            if available.is_empty() {
                if line.is_empty() {
                    return Ok(None);
                }
                (0, true)
            } else if let Some(index) = available.iter().position(|byte| *byte == b'\n') {
                if line.len().saturating_add(index) > MAX_PROTOCOL_LINE_BYTES {
                    return Err("CLI 返回的单条结构化消息过大，已停止处理".into());
                }
                line.extend_from_slice(&available[..index]);
                (index + 1, true)
            } else {
                if line.len().saturating_add(available.len()) > MAX_PROTOCOL_LINE_BYTES {
                    return Err("CLI 返回的单条结构化消息过大，已停止处理".into());
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

fn extract_text_content(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_string();
    }
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("")
}

#[derive(Default)]
struct ParsedLine {
    session_id: Option<String>,
    assistant_delta: Option<String>,
    fallback_answer: Option<String>,
    activities: Vec<Value>,
    plan: Option<Vec<Value>>,
    notice: Option<String>,
    error: Option<String>,
}

/// Codex is not the only CLI that plans out loud: the Anthropic-style stream
/// carries the same information in its todo tool call. Only the step text and a
/// coarse status cross the boundary — never the raw tool input.
fn plan_items_from_todo_tool(name: &str, input: &Value) -> Option<Vec<Value>> {
    if !name.eq_ignore_ascii_case("todowrite") && !name.eq_ignore_ascii_case("todo_write") {
        return None;
    }
    let todos = input.get("todos").and_then(Value::as_array)?;
    let items = todos
        .iter()
        .take(32)
        .filter_map(|todo| {
            let text = todo
                .get("content")
                .or_else(|| todo.get("activeForm"))
                .or_else(|| todo.get("task"))
                .and_then(Value::as_str)?;
            let text = bounded_utf8(text, 500);
            if text.is_empty() {
                return None;
            }
            let status = match todo.get("status").and_then(Value::as_str) {
                Some("completed") | Some("done") => "completed",
                Some("in_progress") | Some("inProgress") | Some("active") => "inProgress",
                _ => "pending",
            };
            Some(json!({ "step": text, "status": status }))
        })
        .collect::<Vec<_>>();
    Some(items)
}

fn tool_activity(id: &str, name: &str, status: &str) -> Value {
    let normalized = name.to_ascii_lowercase();
    let (kind, title) = if normalized.contains("write")
        || normalized.contains("edit")
        || normalized.contains("replace")
        || normalized.contains("patch")
    {
        ("file", "更新项目文件")
    } else if normalized.contains("search") || normalized.contains("web") {
        ("search", "搜索资料")
    } else if normalized.contains("read") || normalized.contains("list") {
        ("file", "读取项目文件")
    } else {
        ("tool", "使用工具")
    };
    json!({
        "id": safe_event_id(id, "tool"),
        "type": kind,
        "status": status,
        "title": title,
    })
}

fn parse_anthropic_line(value: &Value) -> ParsedLine {
    let mut parsed = ParsedLine {
        session_id: value
            .get("session_id")
            .or_else(|| value.get("sessionId"))
            .and_then(Value::as_str)
            .map(str::to_string),
        ..ParsedLine::default()
    };
    match value.get("type").and_then(Value::as_str).unwrap_or("") {
        "assistant" => {
            let content = value.pointer("/message/content").unwrap_or(&Value::Null);
            let text = extract_text_content(content);
            if !text.is_empty() {
                parsed.assistant_delta = Some(text);
            }
            for block in content.as_array().into_iter().flatten() {
                if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                    continue;
                }
                let id = block.get("id").and_then(Value::as_str).unwrap_or("tool");
                let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                let input = block.get("input").unwrap_or(&Value::Null);
                if let Some(items) = plan_items_from_todo_tool(name, input) {
                    // The todo call becomes the plan, not a file-write activity:
                    // `tool_activity` would otherwise read "TodoWrite" as a write.
                    parsed.plan = Some(items);
                    continue;
                }
                parsed
                    .activities
                    .push(tool_activity(id, name, "inProgress"));
            }
        }
        "user" => {
            let content = value.pointer("/message/content").unwrap_or(&Value::Null);
            for block in content.as_array().into_iter().flatten() {
                if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                    continue;
                }
                let id = block
                    .get("tool_use_id")
                    .or_else(|| block.get("toolUseId"))
                    .and_then(Value::as_str)
                    .unwrap_or("tool");
                let status = if block.get("is_error").and_then(Value::as_bool) == Some(true) {
                    "failed"
                } else {
                    "completed"
                };
                parsed.activities.push(tool_activity(id, "tool", status));
            }
        }
        "stream_event" => {
            let event = value.get("event").unwrap_or(&Value::Null);
            if event.get("type").and_then(Value::as_str) == Some("content_block_delta")
                && event.pointer("/delta/type").and_then(Value::as_str) == Some("text_delta")
            {
                parsed.assistant_delta = event
                    .pointer("/delta/text")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
        }
        "result" => {
            parsed.fallback_answer = value
                .get("result")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .map(str::to_string);
            if value.get("is_error").and_then(Value::as_bool) == Some(true)
                || value.get("subtype").and_then(Value::as_str) == Some("error")
            {
                parsed.error = value
                    .get("result")
                    .and_then(Value::as_str)
                    .map(|text| bounded_utf8(text, 2_000))
                    .or_else(|| Some("CLI 处理失败".to_string()));
            }
        }
        "error" => {
            parsed.error = value
                .get("message")
                .or_else(|| value.pointer("/error/message"))
                .and_then(Value::as_str)
                .map(|text| bounded_utf8(text, 2_000));
        }
        _ => {}
    }
    parsed
}

fn parse_gemini_line(value: &Value) -> ParsedLine {
    let mut parsed = ParsedLine {
        session_id: value
            .get("session_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        ..ParsedLine::default()
    };
    match value.get("type").and_then(Value::as_str).unwrap_or("") {
        "message" if value.get("role").and_then(Value::as_str) == Some("assistant") => {
            let text = extract_text_content(value.get("content").unwrap_or(&Value::Null));
            if !text.is_empty() {
                parsed.assistant_delta = Some(text);
            }
        }
        "tool_use" => {
            let id = value
                .get("tool_id")
                .and_then(Value::as_str)
                .unwrap_or("tool");
            let name = value
                .get("tool_name")
                .and_then(Value::as_str)
                .unwrap_or("tool");
            parsed
                .activities
                .push(tool_activity(id, name, "inProgress"));
        }
        "tool_result" => {
            let id = value
                .get("tool_id")
                .and_then(Value::as_str)
                .unwrap_or("tool");
            let status = if value.get("status").and_then(Value::as_str) == Some("success") {
                "completed"
            } else {
                "failed"
            };
            parsed.activities.push(tool_activity(id, "tool", status));
        }
        "error" => {
            let message = value
                .get("message")
                .and_then(Value::as_str)
                .map(|text| bounded_utf8(text, 2_000));
            if value.get("severity").and_then(Value::as_str) == Some("warning") {
                parsed.notice = message;
            } else {
                parsed.error = message;
            }
        }
        "result" if value.get("status").and_then(Value::as_str) == Some("error") => {
            parsed.error = Some("Gemini 处理失败".to_string());
        }
        _ => {}
    }
    parsed
}

fn first_string<'a>(value: &'a Value, pointers: &[&str]) -> Option<&'a str> {
    pointers
        .iter()
        .find_map(|pointer| value.pointer(pointer).and_then(Value::as_str))
}

// OpenCode and MiMo Code use the same public `run --format json` event family.
// Keep this deliberately narrow: only public assistant text and a coarse tool
// state cross the backend boundary, never inputs, paths, command arguments, or
// model reasoning.
fn parse_opencode_line(value: &Value) -> ParsedLine {
    let mut parsed = ParsedLine {
        session_id: first_string(
            value,
            &["/sessionID", "/sessionId", "/session_id", "/session/id"],
        )
        .map(str::to_string),
        ..ParsedLine::default()
    };
    match value.get("type").and_then(Value::as_str).unwrap_or("") {
        "text" => {
            parsed.assistant_delta = first_string(value, &["/part/text", "/text"])
                .filter(|text| !text.is_empty())
                .map(str::to_string);
        }
        "message" | "assistant" => {
            let content = value
                .pointer("/message/content")
                .or_else(|| value.get("content"))
                .unwrap_or(&Value::Null);
            let text = extract_text_content(content);
            if !text.is_empty() {
                parsed.assistant_delta = Some(text);
            }
        }
        "tool_use" | "tool" => {
            let id = first_string(value, &["/part/id", "/tool_id", "/id"]).unwrap_or("tool");
            let name = first_string(value, &["/part/tool", "/part/name", "/tool_name", "/name"])
                .unwrap_or("tool");
            let status = match first_string(value, &["/part/state/status", "/status"]) {
                Some("completed" | "success") => "completed",
                Some("error" | "failed") => "failed",
                _ => "inProgress",
            };
            parsed.activities.push(tool_activity(id, name, status));
        }
        "tool_result" => {
            let id = first_string(value, &["/part/id", "/tool_id", "/id"]).unwrap_or("tool");
            let status = if value.get("status").and_then(Value::as_str) == Some("success") {
                "completed"
            } else {
                "failed"
            };
            parsed.activities.push(tool_activity(id, "tool", status));
        }
        "error" => {
            parsed.error = first_string(value, &["/message", "/error/message", "/error"])
                .filter(|text| !text.is_empty())
                .map(|text| bounded_utf8(text, 2_000));
        }
        _ => {}
    }
    parsed
}

fn parse_qwen_line(value: &Value) -> ParsedLine {
    // Qwen's stream-json is intentionally parsed as the public portions of
    // both its message stream and its OpenAI/Anthropic-compatible deltas.
    // `--include-partial-messages` emits both deltas and a final full assistant
    // message. Keep that full message only as a fallback so the UI never shows
    // the same answer twice. Subagent messages stay behind the backend boundary.
    if value
        .get("parent_tool_use_id")
        .is_some_and(|parent| !parent.is_null())
    {
        return ParsedLine {
            session_id: value
                .get("session_id")
                .and_then(Value::as_str)
                .map(str::to_string),
            ..ParsedLine::default()
        };
    }
    let mut parsed = parse_anthropic_line(value);
    let is_full_assistant = value.get("type").and_then(Value::as_str) == Some("assistant");
    if is_full_assistant {
        if let Some(text) = parsed.assistant_delta.take() {
            parsed.fallback_answer = Some(text);
        }
    }
    let gemini = parse_gemini_line(value);
    let opencode = parse_opencode_line(value);
    if parsed.session_id.is_none() {
        parsed.session_id = gemini.session_id.or(opencode.session_id);
    }
    if parsed.assistant_delta.is_none() && !is_full_assistant {
        parsed.assistant_delta = gemini.assistant_delta.or(opencode.assistant_delta);
    }
    if parsed.activities.is_empty() {
        parsed.activities = if gemini.activities.is_empty() {
            opencode.activities
        } else {
            gemini.activities
        };
    }
    if parsed.notice.is_none() {
        parsed.notice = gemini.notice;
    }
    if parsed.error.is_none() {
        parsed.error = gemini.error.or(opencode.error);
    }
    parsed
}

fn parse_line(protocol: HeadlessProtocol, value: &Value) -> ParsedLine {
    match protocol {
        HeadlessProtocol::AnthropicMessages => parse_anthropic_line(value),
        HeadlessProtocol::GeminiStream => parse_gemini_line(value),
        HeadlessProtocol::OpenCodeJson => parse_opencode_line(value),
        HeadlessProtocol::QwenStream => parse_qwen_line(value),
    }
}

fn validate_model(value: &str) -> Result<String, String> {
    let model = value.trim();
    if model.is_empty() {
        return Ok(String::new());
    }
    crate::conversation_slash::normalize_model_id(model).ok_or_else(|| "模型名称不合法".into())
}

fn validate_effort(value: &str) -> Result<String, String> {
    let effort = value.trim();
    if effort.is_empty() {
        return Ok(String::new());
    }
    crate::conversation_slash::normalize_effort_id(effort).ok_or_else(|| "推理强度不合法".into())
}

fn resolve_requested_slash(
    provider_id: &str,
    project_path: &str,
    prompt: &str,
    has_handoff: bool,
) -> Result<Option<crate::conversation_slash::ConversationSlashInvocation>, String> {
    let slash_requested = looks_like_slash_command(prompt);
    if slash_requested && has_handoff {
        return Err("交接消息暂不能同时执行 / 命令，请先完成交接再运行命令".into());
    }
    let slash = if has_handoff {
        None
    } else {
        crate::conversation_slash::resolve_slash_invocation(provider_id, project_path, prompt)?
    };
    if slash_requested && slash.is_none() {
        return Err("这个 / 命令不属于当前项目或当前 CLI，请从命令菜单重新选择".into());
    }
    Ok(slash)
}

fn looks_like_slash_command(prompt: &str) -> bool {
    if prompt.contains(['\r', '\n']) {
        return false;
    }
    let Some(body) = prompt.strip_prefix('/') else {
        return false;
    };
    let id = body
        .split_once(char::is_whitespace)
        .map(|(id, _)| id)
        .unwrap_or(body);
    // Registered namespaced commands are still resolved first. An unknown
    // token containing another slash is more likely an absolute path such as
    // `/etc/hosts`, so it remains ordinary user text instead of being rejected.
    !id.is_empty()
        && !id.contains('/')
        && id.len() <= 64
        && id.bytes().enumerate().all(|(index, byte)| {
            if index == 0 {
                byte.is_ascii_alphanumeric()
            } else {
                byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-' | b'.')
            }
        })
}

const MAX_ATTACHMENTS: usize = 4;
const MAX_ATTACHMENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_PASTE_FILES: usize = 64;

fn attachment_extension(mime: &str) -> Option<&'static str> {
    match mime.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

/// 粘贴图片落盘到指定目录，返回稳定路径。各家无头 CLI 都没有原生图片
/// 传参，统一靠提示里的本机路径让 CLI 用读文件能力查看。
pub(crate) fn prepare_attachments(
    inputs: &[ConversationAttachmentInput],
    dir: &std::path::Path,
) -> Result<Vec<std::path::PathBuf>, String> {
    if inputs.is_empty() {
        return Ok(Vec::new());
    }
    if inputs.len() > MAX_ATTACHMENTS {
        return Err(format!("一条消息最多附带 {MAX_ATTACHMENTS} 张图片"));
    }
    use base64::Engine as _;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let mut paths = Vec::new();
    std::fs::create_dir_all(dir).map_err(|_| "无法创建图片保存目录".to_string())?;
    for (index, input) in inputs.iter().enumerate() {
        let extension = attachment_extension(&input.mime)
            .ok_or_else(|| "只支持 PNG、JPEG、GIF、WebP 图片".to_string())?;
        let id_ok = !input.id.is_empty()
            && input.id.len() <= 64
            && input
                .id
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'));
        if !id_ok {
            return Err("图片标识不合法".into());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(input.data_base64.trim())
            .map_err(|_| "图片数据不是有效的 Base64".to_string())?;
        if bytes.is_empty() || bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err("单张图片不能超过 8MB".into());
        }
        let path = dir.join(format!("paste-{stamp}-{index}-{}.{extension}", input.id));
        std::fs::write(&path, &bytes).map_err(|_| "图片保存失败".to_string())?;
        paths.push(path);
    }
    prune_paste_files(dir, MAX_PASTE_FILES);
    Ok(paths)
}

fn prune_paste_files(dir: &std::path::Path, keep: usize) {
    let mut entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries.filter_map(|entry| entry.ok()).collect::<Vec<_>>(),
        Err(_) => return,
    };
    if entries.len() <= keep {
        return;
    }
    entries.sort_by_key(|entry| {
        entry
            .metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(std::time::UNIX_EPOCH)
    });
    for entry in entries.iter().take(entries.len() - keep) {
        let _ = std::fs::remove_file(entry.path());
    }
}

fn prompt_with_attachments(
    prompt: &str,
    paths: &[std::path::PathBuf],
    provider_id: &str,
) -> String {
    if paths.is_empty() {
        return prompt.to_string();
    }
    if provider_id == "gemini" {
        // Gemini CLI 原生支持 @路径 引用图片。
        let refs = paths
            .iter()
            .map(|path| format!("@{}", path.display()))
            .collect::<Vec<_>>()
            .join(" ");
        return format!("{prompt}\n\n{refs}");
    }
    let list = paths
        .iter()
        .map(|path| format!("- {}", path.display()))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "{prompt}\n\n[图片附件] 用户在本条消息粘贴了图片，已保存到本机路径；请先用读文件工具查看图片，再结合图片回答：\n{list}"
    )
}

fn codex_prompt_for_slash(
    prompt: String,
    slash: Option<&crate::conversation_slash::ConversationSlashInvocation>,
) -> String {
    slash
        .map(|invocation| {
            if invocation.args.is_empty() {
                format!("${}", invocation.id)
            } else {
                format!("${} {}", invocation.id, invocation.args)
            }
        })
        .unwrap_or(prompt)
}

fn push_model_args(command: &mut Command, spec_id: &str, model: &str) {
    if model.is_empty() {
        return;
    }
    match spec_id {
        "grok" | "gemini" => {
            command.args(["-m", model]);
        }
        _ => {
            command.args(["--model", model]);
        }
    }
}

fn push_effort_args(command: &mut Command, spec_id: &str, effort: &str) {
    if effort.is_empty() {
        return;
    }
    match spec_id {
        "grok" | "claude" | "agy" => {
            command.args(["--effort", effort]);
        }
        "opencode" | "mimo" => {
            command.args(["--variant", effort]);
        }
        _ => {}
    }
}

fn summarize_cli_stderr(raw: &str) -> Option<String> {
    raw.lines()
        .map(str::trim)
        .find(|line| {
            let lower = line.to_ascii_lowercase();
            let compact = lower
                .chars()
                .filter(|ch| ch.is_ascii_alphanumeric())
                .collect::<String>();
            let contains_secret_key = lower
                .split(|ch: char| ch.is_ascii_whitespace() || matches!(ch, ':' | '=' | '"' | '\''))
                .any(|part| part == "sk" || part.starts_with("sk-") || part.starts_with("sk_"));
            !line.is_empty()
                && line.chars().any(|ch| ch.is_alphabetic())
                && !compact.contains("token")
                && !compact.contains("bearer")
                && !compact.contains("password")
                && !compact.contains("apikey")
                && !contains_secret_key
        })
        .map(|line| bounded_utf8(line, 400))
}

fn drain_stderr_tail(mut reader: impl Read, limit: usize) -> String {
    let mut tail = Vec::with_capacity(limit);
    let mut chunk = [0u8; 8 * 1024];
    loop {
        let read = match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        if limit == 0 {
            continue;
        }
        if read >= limit {
            tail.clear();
            tail.extend_from_slice(&chunk[read - limit..read]);
            continue;
        }
        let overflow = tail.len().saturating_add(read).saturating_sub(limit);
        if overflow > 0 {
            tail.drain(..overflow);
        }
        tail.extend_from_slice(&chunk[..read]);
    }
    String::from_utf8_lossy(&tail).into_owned()
}

fn spawn_stderr_tail_drain(
    mut stderr: std::process::ChildStderr,
    buf: Arc<Mutex<String>>,
    done: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        let text = drain_stderr_tail(&mut stderr, STDERR_TAIL_BYTES);
        if let Ok(mut slot) = buf.lock() {
            *slot = text;
        }
        done.store(true, Ordering::SeqCst);
    });
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn provider_command(
    spec: &ProviderSpec,
    binary: PathBuf,
    cwd: &Path,
    prompt: &str,
    thread_id: &str,
    allow_write: bool,
    model: &str,
    effort: &str,
) -> Command {
    // 测试按"要不要写"取这家对应的那一档，省得每个用例都写死模式名。
    let modes = crate::conversation_modes::modes_for(spec.id);
    let mode = modes
        .iter()
        .find(|entry| entry.writes == allow_write)
        .copied()
        .unwrap_or_else(|| crate::conversation_modes::default_mode(spec.id));
    provider_command_with_slash(
        spec, binary, cwd, prompt, thread_id, mode, model, effort, None,
    )
}

#[allow(clippy::too_many_arguments)]
fn provider_command_with_slash(
    spec: &ProviderSpec,
    binary: PathBuf,
    // agy 是项目注册制的，不认进程 cwd，必须显式 --add-dir 绑定，所以这里要拿到它。
    cwd: &Path,
    prompt: &str,
    thread_id: &str,
    mode: crate::conversation_modes::ConversationMode,
    model: &str,
    effort: &str,
    slash: Option<&crate::conversation_slash::ConversationSlashInvocation>,
) -> Command {
    let allow_write = mode.writes;
    let mut command = Command::new(binary);
    match spec.id {
        "claude" => {
            command.args(["--print", "--output-format", "stream-json", "--verbose"]);
            if slash.is_none() {
                command.args(["--safe-mode", "--disable-slash-commands"]);
            }
            command.args([
                "--strict-mcp-config",
                "--permission-mode",
                mode.id,
                "--disallowedTools",
                "WebSearch,WebFetch",
            ]);
            if !thread_id.is_empty() {
                command.args(["--resume", thread_id]);
            }
            push_model_args(&mut command, spec.id, model);
            push_effort_args(&mut command, spec.id, effort);
            command.args(["--", prompt]);
        }
        "grok" => {
            command.args([
                "--output-format",
                "streaming-messages-json",
                // 实测：Grok 的 --sandbox 收的是 ~/.grok/sandbox.toml 里的 profile 名，
                // 不是 Codex 那种固定枚举。`workspace-write` 并不存在，Grok 会拒绝启动；
                // 内建的可写基础 profile 叫 `workspace`。另外无头下 `acceptEdits` 仍会
                // 发审批请求而没人应答，最终变成 User cancelled，只有 `auto` 能自我批准。
                "--permission-mode",
                mode.id,
                "--disable-web-search",
                "--no-subagents",
            ]);
            // Grok 的沙箱 profile 是会话级的，创建时钉死：拿另一个 profile 续接会被
            // 直接拒（"cannot resume this session under sandbox profile ... it was
            // created with ..."），连 --fork-session 也绕不过，检查发生在分叉之前。
            //
            // 所以只在新建会话时给 profile，续接一律省掉 --sandbox 沿用原来的。新会话
            // 固定用可写的 `workspace`，好让同一条对话之后还能切到写入档；这一轮到底
            // 能不能改文件，由 --permission-mode 决定——实测 workspace 沙箱下的 plan
            // 档同样拒绝写入。这与 Claude 的做法一致：只读同样是靠它自己的 plan 档。
            if thread_id.is_empty() {
                command.args(["--sandbox", "workspace"]);
            } else {
                command.args(["--resume", thread_id]);
            }
            push_model_args(&mut command, spec.id, model);
            push_effort_args(&mut command, spec.id, effort);
            command.args(["--single", prompt]);
        }
        "gemini" => {
            command.args([
                "--output-format",
                "stream-json",
                "--approval-mode",
                mode.id,
                "--sandbox",
            ]);
            if !thread_id.is_empty() {
                command.args(["--session-file", thread_id]);
            }
            push_model_args(&mut command, spec.id, model);
            command.args(["--prompt", prompt]);
        }
        "agy" => {
            // 实测两处一定会踩的坑：
            // 1. prompt 必须附在 --print 上。写成 `--print ... -- <prompt>` 会被
            //    直接拒（exit 2，"Attach the prompt to the flag"），一轮都跑不起来。
            // 2. 必须用 --add-dir 绑定项目目录。agy 是项目注册制的，不认进程 cwd；
            //    不绑就在 ~/.gemini/antigravity-cli/scratch/ 里干活，碰不到用户项目。
            //
            // 另外：--disable-slash-commands 会让 `--mode plan` 不生效（agy 自己会
            // warning）。目前安全属性仍然成立——实测 agy 默认档同样不写文件——但这
            // 是巧合不是保证，改这里前先重测只读档到底写不写。
            command.arg(format!("--print={prompt}"));
            command.args([
                "--output-format",
                "stream-json",
                "--mode",
                mode.id,
                "--sandbox",
                "--add-dir",
            ]);
            command.arg(cwd);
            if slash.is_none() {
                command.arg("--disable-slash-commands");
            }
            if !thread_id.is_empty() {
                command.args(["--conversation", thread_id]);
            }
            push_model_args(&mut command, spec.id, model);
            push_effort_args(&mut command, spec.id, effort);
        }
        "opencode" | "mimo" => {
            // `--pure` disables third-party plugins. Do not use the dangerous
            // auto-approval flags. The built-in plan agent supplies the
            // read-only policy; an explicitly writable turn keeps the default
            // build agent without bypassing its permission rules.
            command.args(["run", "--format", "json", "--pure"]);
            if !allow_write {
                command.args(["--agent", "plan"]);
            }
            if !thread_id.is_empty() {
                command.args(["--session", thread_id]);
            }
            push_model_args(&mut command, spec.id, model);
            push_effort_args(&mut command, spec.id, effort);
            if let Some(invocation) = slash {
                if invocation.kind == crate::conversation_slash::ConversationSlashKind::Command {
                    command.args(["--command", &invocation.id]);
                    if !invocation.args.is_empty() {
                        // `run` accepts free-form message arguments. The option
                        // terminator keeps text such as `--model foo` from being
                        // reinterpreted as an OpenCode/MiMo process flag.
                        command.args(["--", &invocation.args]);
                    }
                } else {
                    let skill_prompt = if invocation.args.is_empty() {
                        format!("Use the locally installed skill named '{}'.", invocation.id)
                    } else {
                        format!(
                            "Use the locally installed skill named '{}'. User request: {}",
                            invocation.id, invocation.args
                        )
                    };
                    command.args(["--", &skill_prompt]);
                }
            } else {
                command.args(["--", prompt]);
            }
        }
        "qwen" => {
            // Safe mode excludes local customization/MCP-style extensions and
            // sandbox requests Qwen's own isolated execution boundary.
            command.args([
                "--prompt",
                prompt,
                "--output-format",
                "stream-json",
                "--include-partial-messages",
                "--approval-mode",
                mode.id,
                "--sandbox",
            ]);
            if slash.is_none() {
                command.arg("--safe-mode");
            }
            if !thread_id.is_empty() {
                command.args(["--resume", thread_id]);
            }
            push_model_args(&mut command, spec.id, model);
        }
        _ => unreachable!("provider registry controls command construction"),
    }
    command
}

fn validate_session_for_project(
    project_path: &str,
    provider_id: &str,
    session_id: &str,
) -> Result<String, String> {
    let home = dirs::home_dir().ok_or_else(|| "找不到用户目录".to_string())?;
    validate_session_for_project_with_home(project_path, provider_id, session_id, &home)
}

fn gemini_file_session_id(path: &Path) -> Option<String> {
    const GEMINI_SESSION_METADATA_READ_BYTES: u64 = 128 * 1024;
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let mut raw = String::new();
    std::fs::File::open(path)
        .ok()?
        .take(GEMINI_SESSION_METADATA_READ_BYTES)
        .read_to_string(&mut raw)
        .ok()?;
    let mut values = serde_json::from_str::<Value>(raw.trim())
        .ok()
        .into_iter()
        .chain(
            raw.lines()
                .filter_map(|line| serde_json::from_str(line).ok()),
        );
    values.find_map(|value| {
        value
            .get("sessionId")
            .or_else(|| value.get("session_id"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= 1_024)
            .map(str::to_string)
    })
}

fn validate_session_for_project_with_home(
    project_path: &str,
    provider_id: &str,
    session_id: &str,
    home: &Path,
) -> Result<String, String> {
    if session_id.is_empty() {
        return Ok(String::new());
    }
    if provider_id == "gemini" && !Path::new(session_id).is_absolute() {
        let history = crate::project_sessions::list_project_history_with_home(project_path, home);
        let matching_path = history
            .groups
            .iter()
            .find(|group| group.tool == "gemini")
            .into_iter()
            .flat_map(|group| &group.sessions)
            .find(|session| {
                gemini_file_session_id(Path::new(&session.id)).as_deref() == Some(session_id)
            })
            .map(|session| session.id.clone())
            .ok_or_else(|| "这个 Gemini 会话不属于当前项目，无法续接".to_string())?;
        crate::project_sessions::preview_project_session_with_home(
            project_path,
            provider_id,
            &matching_path,
            home,
        )
        .map_err(|_| "这个 Gemini 会话不属于当前项目，无法续接".to_string())?;
        std::fs::canonicalize(matching_path)
            .map_err(|_| "这个 Gemini 会话文件不可访问，无法续接".to_string())
            .map(|path| path.to_string_lossy().into_owned())
    } else if provider_id == "gemini" {
        crate::project_sessions::preview_project_session_with_home(
            project_path,
            provider_id,
            session_id,
            home,
        )
        .map_err(|_| "这个 Gemini 会话不属于当前项目，无法续接".to_string())?;
        std::fs::canonicalize(session_id)
            .map_err(|_| "这个 Gemini 会话文件不可访问，无法续接".to_string())
            .map(|path| path.to_string_lossy().into_owned())
    } else {
        crate::project_sessions::preview_project_session_with_home(
            project_path,
            provider_id,
            session_id,
            home,
        )
        .map_err(|_| {
            format!(
                "这个 {} 会话不属于当前项目，无法续接",
                provider_label(provider_id)
            )
        })?;
        Ok(session_id.to_string())
    }
}

fn handoff_prompt(
    project_path: &str,
    source_provider_id: &str,
    source_session_id: &str,
    target_provider_id: &str,
    user_prompt: &str,
) -> Result<String, String> {
    let home = dirs::home_dir().ok_or_else(|| "找不到用户目录".to_string())?;
    let preview = crate::project_sessions::preview_session_handoff_with_home(
        project_path,
        source_provider_id,
        source_session_id,
        &home,
    )
    .map_err(|error| format!("读取交接会话失败：{error}"))?;
    let header = format!(
        "以下是从 {} 交接给 {} 的最近对话。把它当作已发生的工作背景，不要声称自己亲自完成了其中的操作。\n\n",
        provider_label(source_provider_id),
        provider_label(target_provider_id)
    );
    let footer = format!("\n\n现在继续处理用户的新要求：\n{user_prompt}");
    let fixed_bytes = header.len().saturating_add(footer.len());
    if fixed_bytes >= crate::codex_chat::MAX_PROMPT_BYTES {
        return Err("交接说明和本次消息合计过长，请缩短消息后重试".into());
    }
    let mut remaining = crate::codex_chat::MAX_PROMPT_BYTES - fixed_bytes;
    let mut selected = Vec::new();
    for message in preview.messages.iter().rev() {
        let role = if message.role == "assistant" {
            "助手"
        } else {
            "用户"
        };
        let prefix = format!("{role}：");
        let cost = prefix
            .len()
            .saturating_add(message.text.len())
            .saturating_add(2);
        if cost <= remaining {
            selected.push(format!("{prefix}{}", message.text));
            remaining -= cost;
        } else if selected.is_empty() && remaining > prefix.len() + 16 {
            selected.push(format!(
                "{prefix}{}",
                bounded_utf8(&message.text, remaining - prefix.len() - 2)
            ));
            break;
        } else {
            break;
        }
    }
    selected.reverse();
    if selected.is_empty() {
        return Err("本次消息太长，已没有空间加入交接上下文，请缩短后重试".into());
    }
    Ok(format!("{header}{}{footer}", selected.join("\n\n")))
}

struct HeadlessContext {
    app: AppHandle,
    active: Arc<Mutex<std::collections::HashMap<String, ActiveRun>>>,
    process: Arc<Mutex<std::process::Child>>,
    process_tree: crate::codex_chat::ProcessTreeGuard,
    cancelled: Arc<AtomicBool>,
    started: Arc<AtomicBool>,
    finished: Arc<AtomicBool>,
    startup_timed_out: Arc<AtomicBool>,
    turn_timed_out: Arc<AtomicBool>,
    completion: Arc<(Mutex<bool>, Condvar)>,
    stderr: Arc<Mutex<String>>,
    stderr_done: Arc<AtomicBool>,
    run_id: String,
    provider_id: String,
    project_path: String,
    protocol: HeadlessProtocol,
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

fn run_headless(stdout: std::process::ChildStdout, context: HeadlessContext) {
    let HeadlessContext {
        app,
        active,
        process,
        process_tree,
        cancelled,
        started,
        finished,
        startup_timed_out,
        turn_timed_out,
        completion,
        stderr,
        stderr_done,
        run_id,
        provider_id,
        project_path,
        protocol,
    } = context;
    let mut reader = BufReader::new(stdout);
    let mut protocol_messages = 0usize;
    let mut protocol_bytes = 0usize;
    let mut assistant_bytes = 0usize;
    let mut normalized_events = 0usize;
    let mut activity_events = 0usize;
    let mut invalid_lines = 0usize;
    let mut fallback_answer = String::new();
    let mut reported_error = String::new();
    let mut last_thread_id = String::new();

    loop {
        if cancelled.load(Ordering::SeqCst)
            || startup_timed_out.load(Ordering::SeqCst)
            || turn_timed_out.load(Ordering::SeqCst)
        {
            break;
        }
        let line = match read_protocol_line(&mut reader) {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(error) => {
                reported_error = error;
                break;
            }
        };
        protocol_messages = protocol_messages.saturating_add(1);
        protocol_bytes = protocol_bytes.saturating_add(line.len());
        if protocol_messages > MAX_PROTOCOL_MESSAGES || protocol_bytes > MAX_PROTOCOL_TURN_BYTES {
            reported_error = "CLI 返回的结构化消息过多，已停止处理".to_string();
            break;
        }
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            invalid_lines = invalid_lines.saturating_add(1);
            if invalid_lines > 8 {
                reported_error = "CLI 没有返回可识别的结构化数据".to_string();
                break;
            }
            continue;
        };
        started.store(true, Ordering::SeqCst);
        let parsed = parse_line(protocol, &value);
        if let Some(error) = parsed.error.filter(|text| !text.is_empty()) {
            reported_error = error;
            break;
        }
        if let Some(session_id) = parsed.session_id.filter(|id| !id.is_empty()) {
            let session_id = bounded_utf8(&session_id, 1_024);
            if session_id != last_thread_id {
                normalized_events = normalized_events.saturating_add(1);
                if normalized_events > MAX_NORMALIZED_EVENTS {
                    reported_error = "CLI 返回的标准化事件过多，已停止处理".to_string();
                    break;
                }
                emit(
                    &app,
                    &run_id,
                    &provider_id,
                    "thread",
                    json!({ "threadId": session_id }),
                );
                last_thread_id = session_id;
            }
        }
        if let Some(text) = parsed.assistant_delta.filter(|text| !text.is_empty()) {
            assistant_bytes = assistant_bytes.saturating_add(text.len());
            normalized_events = normalized_events.saturating_add(1);
            if assistant_bytes > MAX_ASSISTANT_TURN_BYTES
                || normalized_events > MAX_NORMALIZED_EVENTS
            {
                reported_error = "CLI 回复过长，已停止处理".to_string();
                break;
            }
            emit(
                &app,
                &run_id,
                &provider_id,
                "assistant_delta",
                json!({ "text": text }),
            );
        }
        if let Some(text) = parsed.fallback_answer.filter(|text| !text.is_empty()) {
            fallback_answer = text;
        }
        if let Some(items) = parsed.plan {
            normalized_events = normalized_events.saturating_add(1);
            if normalized_events > MAX_NORMALIZED_EVENTS {
                reported_error = "CLI 返回的标准化事件过多，已停止处理".to_string();
                break;
            }
            emit(
                &app,
                &run_id,
                &provider_id,
                "plan",
                json!({ "items": items }),
            );
        }
        for activity in parsed.activities {
            activity_events = activity_events.saturating_add(1);
            normalized_events = normalized_events.saturating_add(1);
            if activity_events > MAX_ACTIVITY_EVENTS || normalized_events > MAX_NORMALIZED_EVENTS {
                reported_error = "CLI 返回的标准化事件过多，已停止处理".to_string();
                break;
            }
            emit(&app, &run_id, &provider_id, "activity", activity);
        }
        if !reported_error.is_empty() {
            break;
        }
        if let Some(notice) = parsed.notice.filter(|text| !text.is_empty()) {
            normalized_events = normalized_events.saturating_add(1);
            if normalized_events > MAX_NORMALIZED_EVENTS {
                reported_error = "CLI 返回的标准化事件过多，已停止处理".to_string();
                break;
            }
            emit(
                &app,
                &run_id,
                &provider_id,
                "notice",
                json!({ "message": notice }),
            );
        }
    }

    drop(reader);
    // Some CLIs close stdout before their process tree exits. Never hold the
    // child mutex across a blocking wait: cancellation and timeout watchdogs
    // need the same lock in order to stop that process tree promptly.
    let success = loop {
        let should_stop = cancelled.load(Ordering::SeqCst)
            || startup_timed_out.load(Ordering::SeqCst)
            || turn_timed_out.load(Ordering::SeqCst)
            || !reported_error.is_empty();
        if should_stop {
            process_tree.terminate();
            if let Ok(mut child) = process.lock() {
                crate::codex_chat::stop_child(&mut child, false);
            }
            break false;
        }
        let status = match process.lock() {
            Ok(mut child) => match child.try_wait() {
                Ok(Some(status)) => {
                    // The leader may have exited while a tool it spawned still
                    // belongs to this run's process group. Reap that group
                    // before publishing completion or permitting a resume.
                    process_tree.terminate();
                    crate::codex_chat::stop_child(&mut child, false);
                    Some(status)
                }
                Ok(None) => None,
                Err(_) => break false,
            },
            Err(_) => break false,
        };
        if let Some(status) = status {
            break status.success();
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    process_tree.terminate();
    if let Ok(mut runs) = active.lock() {
        runs.remove(&run_id);
    }
    mark_finished(&finished, &completion);

    if cancelled.load(Ordering::SeqCst) {
        emit(&app, &run_id, &provider_id, "cancelled", json!({}));
    } else if startup_timed_out.load(Ordering::SeqCst) {
        emit(
            &app,
            &run_id,
            &provider_id,
            "error",
            json!({ "message": format!("{} 对话服务启动超时，请确认已登录后重试", provider_label(&provider_id)) }),
        );
    } else if turn_timed_out.load(Ordering::SeqCst) {
        emit(
            &app,
            &run_id,
            &provider_id,
            "error",
            json!({ "message": format!("{} 对话处理超时（最长 60 分钟），已停止", provider_label(&provider_id)) }),
        );
    } else if !reported_error.is_empty() {
        emit(
            &app,
            &run_id,
            &provider_id,
            "error",
            json!({ "message": bounded_utf8(&reported_error, 2_000) }),
        );
    } else if !success {
        let deadline = Instant::now() + Duration::from_millis(200);
        while !stderr_done.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let detail = stderr
            .lock()
            .ok()
            .and_then(|text| summarize_cli_stderr(&text));
        let message = match detail {
            Some(detail) => format!("{} 退出：{detail}", provider_label(&provider_id)),
            None => format!(
                "{} 后台进程退出，请确认 CLI 已安装并已登录",
                provider_label(&provider_id)
            ),
        };
        emit(
            &app,
            &run_id,
            &provider_id,
            "error",
            json!({ "message": message }),
        );
    } else {
        // Gemini stream-json reports a UUID while the history UI identifies a
        // session by its canonical file path.  Once the process has exited the
        // file is expected to be durable, so safely resolve it again and give
        // the UI the canonical identity for selection and deletion state.
        if provider_id == "gemini" && !last_thread_id.is_empty() {
            if let Ok(session_file) =
                validate_session_for_project(&project_path, &provider_id, &last_thread_id)
            {
                let session_file = bounded_utf8(&session_file, 1_024);
                if session_file != last_thread_id && normalized_events < MAX_NORMALIZED_EVENTS {
                    emit(
                        &app,
                        &run_id,
                        &provider_id,
                        "thread",
                        json!({ "threadId": session_file }),
                    );
                }
            }
        }
        if assistant_bytes == 0 && !fallback_answer.is_empty() {
            emit(
                &app,
                &run_id,
                &provider_id,
                "assistant_message",
                json!({ "text": bounded_utf8(&fallback_answer, MAX_ASSISTANT_TURN_BYTES) }),
            );
        }
        emit(
            &app,
            &run_id,
            &provider_id,
            "completed",
            json!({ "status": "completed" }),
        );
    }
}

fn run_headless_guarded(stdout: std::process::ChildStdout, context: HeadlessContext) {
    let app = context.app.clone();
    let active = context.active.clone();
    let process = context.process.clone();
    let process_tree = context.process_tree.clone();
    let cancelled = context.cancelled.clone();
    let finished = context.finished.clone();
    let completion = context.completion.clone();
    let run_id = context.run_id.clone();
    let provider_id = context.provider_id.clone();
    if catch_unwind(AssertUnwindSafe(|| run_headless(stdout, context))).is_ok() {
        return;
    }

    process_tree.terminate();
    {
        let mut child = match process.lock() {
            Ok(child) => child,
            Err(poisoned) => poisoned.into_inner(),
        };
        crate::codex_chat::stop_child(&mut child, false);
    }
    match active.lock() {
        Ok(mut runs) => {
            runs.remove(&run_id);
        }
        Err(poisoned) => {
            poisoned.into_inner().remove(&run_id);
        }
    }
    let already_finished = finished.swap(true, Ordering::SeqCst);
    let (lock, wake) = &*completion;
    match lock.lock() {
        Ok(mut done) => *done = true,
        Err(poisoned) => *poisoned.into_inner() = true,
    }
    wake.notify_all();
    if already_finished {
        return;
    }
    if cancelled.load(Ordering::SeqCst) {
        emit(&app, &run_id, &provider_id, "cancelled", json!({}));
    } else {
        emit(
            &app,
            &run_id,
            &provider_id,
            "error",
            json!({ "message": format!("{} 处理异常，已安全停止", provider_label(&provider_id)) }),
        );
    }
}

struct HeadlessStart {
    project_id: String,
    run_id: String,
    thread_id: String,
    prompt: String,
    mode: crate::conversation_modes::ConversationMode,
    model: String,
    effort: String,
    slash: Option<crate::conversation_slash::ConversationSlashInvocation>,
    cwd: PathBuf,
}

fn start_headless(
    app: AppHandle,
    state: &ConversationChatState,
    spec: &ProviderSpec,
    request: HeadlessStart,
) -> Result<ConversationChatStartResult, String> {
    let HeadlessStart {
        project_id,
        run_id,
        thread_id,
        prompt,
        mode,
        model,
        effort,
        slash,
        cwd,
    } = request;
    let cancelled = crate::codex_chat::reserve_run(state, &project_id, &run_id)?;
    let binary = match crate::cli_detect::resolve_registered_cli_bin(spec.binary) {
        Ok(binary) => binary,
        Err(error) => {
            crate::codex_chat::release_run(state, &run_id);
            return Err(error);
        }
    };
    let mut command = provider_command_with_slash(
        spec,
        binary,
        &cwd,
        &prompt,
        &thread_id,
        mode,
        &model,
        &effort,
        slash.as_ref(),
    );
    command
        .current_dir(&cwd)
        .stdin(Stdio::null())
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
        Err(_) => {
            crate::codex_chat::release_run(state, &run_id);
            return Err(format!("启动 {} 对话服务失败", spec.label));
        }
    };
    let process_tree = match crate::codex_chat::register_process_tree(&child) {
        Ok(process_tree) => process_tree,
        Err(error) => {
            crate::codex_chat::stop_child(&mut child, false);
            crate::codex_chat::release_run(state, &run_id);
            return Err(error);
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            process_tree.terminate();
            crate::codex_chat::stop_child(&mut child, false);
            crate::codex_chat::release_run(state, &run_id);
            return Err(format!("无法读取 {} 对话服务", spec.label));
        }
    };
    let stderr_buf = Arc::new(Mutex::new(String::new()));
    let stderr_done = Arc::new(AtomicBool::new(false));
    if let Some(stderr) = child.stderr.take() {
        spawn_stderr_tail_drain(stderr, stderr_buf.clone(), stderr_done.clone());
    } else {
        stderr_done.store(true, Ordering::SeqCst);
    }
    let process = Arc::new(Mutex::new(child));
    let started = Arc::new(AtomicBool::new(false));
    let finished = Arc::new(AtomicBool::new(false));
    let startup_timed_out = Arc::new(AtomicBool::new(false));
    let turn_timed_out = Arc::new(AtomicBool::new(false));
    let completion = Arc::new((Mutex::new(false), Condvar::new()));
    let cancelled_during_start = match crate::codex_chat::bind_reserved_process(
        state,
        &run_id,
        process.clone(),
        process_tree.clone(),
    ) {
        Ok(cancelled) => cancelled,
        Err(error) => {
            process_tree.terminate();
            if let Ok(mut child) = process.lock() {
                crate::codex_chat::stop_child(&mut child, false);
            }
            crate::codex_chat::release_run(state, &run_id);
            return Err(error);
        }
    };
    if cancelled_during_start {
        process_tree.terminate();
        if let Ok(mut child) = process.lock() {
            crate::codex_chat::stop_child(&mut child, false);
        }
        crate::codex_chat::release_run(state, &run_id);
        return Err("对话启动已取消".into());
    }
    let context = HeadlessContext {
        app,
        active: state.active.clone(),
        process: process.clone(),
        process_tree: process_tree.clone(),
        cancelled: cancelled.clone(),
        started: started.clone(),
        finished: finished.clone(),
        startup_timed_out: startup_timed_out.clone(),
        turn_timed_out: turn_timed_out.clone(),
        completion: completion.clone(),
        stderr: stderr_buf,
        stderr_done,
        run_id: run_id.clone(),
        provider_id: spec.id.to_string(),
        project_path: cwd.to_string_lossy().into_owned(),
        protocol: spec.protocol,
    };
    std::thread::spawn(move || run_headless_guarded(stdout, context));
    let startup_completion = completion.clone();
    let startup_process = process.clone();
    let startup_process_tree = process_tree.clone();
    let startup_cancelled = cancelled.clone();
    std::thread::spawn(move || {
        if wait_for_completion(&startup_completion, STARTUP_TIMEOUT)
            || started.load(Ordering::SeqCst)
            || startup_cancelled.load(Ordering::SeqCst)
        {
            return;
        }
        startup_timed_out.store(true, Ordering::SeqCst);
        startup_process_tree.terminate();
        if let Ok(mut child) = startup_process.lock() {
            crate::codex_chat::stop_child(&mut child, false);
        }
    });
    std::thread::spawn(move || {
        if wait_for_completion(&completion, TURN_TIMEOUT) || cancelled.load(Ordering::SeqCst) {
            return;
        }
        turn_timed_out.store(true, Ordering::SeqCst);
        process_tree.terminate();
        if let Ok(mut child) = process.lock() {
            crate::codex_chat::stop_child(&mut child, false);
        }
    });
    Ok(ConversationChatStartResult {
        run_id,
        provider_id: spec.id.to_string(),
    })
}

pub fn start(
    app: AppHandle,
    state: &ConversationChatState,
    project_path: &str,
    input: ConversationChatStartInput,
) -> Result<ConversationChatStartResult, String> {
    let ConversationChatStartInput {
        project_id,
        provider_id,
        run_id,
        thread_id,
        prompt,
        mode,
        handoff_provider_id,
        handoff_session_id,
        model,
        effort,
        attachments,
    } = input;
    crate::codex_chat::validate_run_id(&run_id)?;
    // 模式必须是这家自己有的档，不认就拒，不退回成"给个写入权限算了"。
    let mode = crate::conversation_modes::resolve(&provider_id, &mode)?;
    let allow_write = mode.writes;
    if mode.unsandboxed {
        // 不开沙箱的轮次要留痕：出事时得能查出是哪个项目、哪一档跑的。
        crate::log_warn!("对话以无沙箱模式启动：{provider_id} / {}", mode.id);
    }
    let prompt = crate::codex_chat::validate_prompt(&prompt)?;
    let model = validate_model(&model)?;
    let effort = validate_effort(&effort)?;
    let cwd = crate::codex_chat::validate_project_path(project_path)?;
    let canonical_project_path = cwd.to_string_lossy().into_owned();

    if provider_id != "codex" && provider_spec(&provider_id).is_none() {
        return Err("这个 CLI 还未接入对话模式".into());
    }
    let thread_id =
        validate_session_for_project(&canonical_project_path, &provider_id, &thread_id)?;
    if handoff_provider_id.is_empty() != handoff_session_id.is_empty() {
        return Err("交接来源不完整，请重新打开历史对话".into());
    }
    if !handoff_provider_id.is_empty() && handoff_provider_id == provider_id {
        return Err("同一 CLI 应直接续接会话，不需要交接".into());
    }
    let slash = resolve_requested_slash(
        &provider_id,
        &canonical_project_path,
        &prompt,
        !handoff_provider_id.is_empty(),
    )?;
    let prompt = if handoff_provider_id.is_empty() {
        prompt
    } else {
        handoff_prompt(
            &canonical_project_path,
            &handoff_provider_id,
            &handoff_session_id,
            &provider_id,
            &prompt,
        )?
    };
    crate::codex_chat::validate_prompt(&prompt)?;
    let attachment_paths = prepare_attachments(
        &attachments,
        &crate::data_dir().join("media").join("pastes"),
    )?;
    if !attachment_paths.is_empty() && slash.is_some() {
        return Err("执行 / 命令时暂不支持图片附件；请去掉图片直接发送，或先执行命令".into());
    }
    let prompt = prompt_with_attachments(&prompt, &attachment_paths, &provider_id);
    crate::codex_chat::validate_prompt(&prompt)?;

    if provider_id == "codex" {
        let prompt = codex_prompt_for_slash(prompt, slash.as_ref());
        let result = crate::codex_chat::start(
            app,
            state,
            &canonical_project_path,
            CodexChatStartInput {
                project_id,
                run_id: run_id.clone(),
                thread_id,
                prompt,
                allow_write,
                mode: mode.id.to_string(),
                model,
                effort,
            },
        )?;
        return Ok(ConversationChatStartResult {
            run_id: result.run_id,
            provider_id,
        });
    }

    let spec = provider_spec(&provider_id).expect("provider checked above");
    start_headless(
        app,
        state,
        spec,
        HeadlessStart {
            // Project mutual exclusion is keyed by canonical path, not the
            // mutable frontend record ID. This prevents duplicate records for
            // the same directory from running concurrently.
            project_id: canonical_project_path.clone(),
            run_id,
            thread_id,
            prompt,
            mode,
            model,
            effort,
            slash,
            cwd,
        },
    )
}

pub fn cancel(state: &ConversationChatState, run_id: &str) -> Result<(), String> {
    crate::codex_chat::cancel(state, run_id)
}

/// 把用户对一条审批请求的答复送回正在等待的那一轮。目前只有 Codex 的
/// 「请求批准」档会走到这里；其余 CLI 的无头协议还没有双向审批通道。
pub fn approve(
    state: &ConversationChatState,
    run_id: &str,
    approval_id: &str,
    decision: &str,
) -> Result<(), String> {
    crate::codex_chat::approve(state, run_id, approval_id, decision)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn provider_registry_only_accepts_registered_headless_clis() {
        assert!(provider_spec("claude").is_some());
        assert!(provider_spec("gemini").is_some());
        assert!(provider_spec("qwen").is_some());
        assert!(provider_spec("opencode").is_some());
        assert!(provider_spec("mimo").is_some());
        assert!(provider_spec("../../bin/sh").is_none());
    }

    #[test]
    fn write_modes_use_values_each_cli_actually_accepts_headless() {
        // 本机实测固化：Grok 的 --sandbox 收的是自定义 profile 名，`workspace-write`
        // 不存在会拒绝启动；无头下 `acceptEdits` 也无法自我批准，只有 `auto` 能写。
        let fake = PathBuf::from("/bin/echo");
        let grok = provider_command(
            provider_spec("grok").unwrap(),
            fake.clone(),
            Path::new("/tmp/proj"),
            "写点东西",
            "",
            true,
            "",
            "",
        );
        let grok_args = grok
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(
            grok_args
                .windows(2)
                .any(|pair| pair == ["--sandbox", "workspace"]),
            "Grok 写入必须用内建的 workspace profile"
        );
        assert!(
            !grok_args.iter().any(|arg| arg == "workspace-write"),
            "workspace-write 不是 Grok 的 profile"
        );
        assert!(
            grok_args
                .windows(2)
                .any(|pair| pair == ["--permission-mode", "auto"]),
            "无头下只有 auto 能自我批准"
        );

        // 新建的只读会话同样拿可写的 workspace profile：这一轮写不写得了由
        // permission-mode 说了算（实测 workspace + plan 拒绝写入），这样之后在
        // 同一条对话里切到 auto 才不会被沙箱挡死。
        let fresh_read_only = provider_command(
            provider_spec("grok").unwrap(),
            fake.clone(),
            Path::new("/tmp/proj"),
            "看看就好",
            "",
            false,
            "",
            "",
        );
        let fresh_args = fresh_read_only
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(
            fresh_args
                .windows(2)
                .any(|pair| pair == ["--sandbox", "workspace"]),
            "新会话固定用 workspace profile"
        );
        assert!(
            fresh_args
                .windows(2)
                .any(|pair| pair == ["--permission-mode", "plan"]),
            "只读这一轮由 plan 档保证"
        );

        // 续接：Grok 的沙箱 profile 在会话创建时钉死，换一个 profile 续接会被直接
        // 拒绝（--fork-session 也绕不过）。所以续接一律不带 --sandbox，沿用原来的；
        // 这一轮能不能改文件仍由 --permission-mode 决定。
        for allow_write in [false, true] {
            let resumed = provider_command(
                provider_spec("grok").unwrap(),
                fake.clone(),
                Path::new("/tmp/proj"),
                "接着写",
                "01a04392-905f-7a71-9d2b-23a9277acd6b",
                allow_write,
                "",
                "",
            );
            let args = resumed
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            assert!(
                !args.iter().any(|arg| arg == "--sandbox"),
                "续接不能再传 --sandbox，否则 Grok 直接拒绝开工"
            );
            assert!(
                args.windows(2)
                    .any(|pair| pair == ["--resume", "01a04392-905f-7a71-9d2b-23a9277acd6b"]),
                "续接要带上会话 ID"
            );
            assert!(
                args.windows(2).any(|pair| pair[0] == "--permission-mode"),
                "档位仍然每轮都传"
            );
        }

        // 传下去的永远是模式表里的原生取值，不是 Roster 自己编的词。
        for id in ["claude", "gemini", "qwen", "agy"] {
            let spec = provider_spec(id).unwrap();
            for mode in crate::conversation_modes::modes_for(id) {
                let command = provider_command_with_slash(
                    spec,
                    fake.clone(),
                    Path::new("/tmp/proj"),
                    "你好",
                    "",
                    *mode,
                    "",
                    "",
                    None,
                );
                let args = command
                    .get_args()
                    .map(|arg| arg.to_string_lossy().into_owned())
                    .collect::<Vec<_>>();
                assert!(
                    args.iter().any(|arg| arg == mode.id),
                    "{id} 的 {} 模式没有原样传下去",
                    mode.id
                );
            }
        }
    }

    #[test]
    fn agy_attaches_the_prompt_and_binds_the_project_directory() {
        // 两处都是实测踩出来的，不是照文档写的：
        // 1. prompt 必须附在 --print 上，写成 `-- <prompt>` 会 exit 2，一轮都跑不起来。
        // 2. agy 不认进程 cwd，不用 --add-dir 绑定就会在
        //    ~/.gemini/antigravity-cli/scratch/ 里写文件，碰不到用户项目。
        let command = provider_command(
            provider_spec("agy").unwrap(),
            PathBuf::from("/bin/echo"),
            Path::new("/tmp/my-project"),
            "创建 a.txt",
            "",
            true,
            "",
            "",
        );
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(
            args.iter().any(|arg| arg == "--print=创建 a.txt"),
            "prompt 必须附在 --print 上，实际参数：{args:?}"
        );
        assert!(
            !args.iter().any(|arg| arg == "--"),
            "不能再用 `--` 传 prompt，agy 会直接拒"
        );
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--add-dir", "/tmp/my-project"]),
            "必须绑定项目目录，否则写到 agy 自己的 scratch 里"
        );
        // 写入档仍然用 agy 自己的取值，不自造。
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--mode", "accept-edits"]),
            "写入档用 agy 自己的 accept-edits"
        );
    }

    #[test]
    fn provider_commands_use_structured_output_and_explicit_permission_modes() {
        let fake = PathBuf::from("/bin/echo");
        let cases = [
            ("claude", "stream-json", "plan"),
            // Grok 的只读靠 --permission-mode plan，不再靠 --sandbox：沙箱 profile
            // 是会话级的，钉死后换不了，会挡住同一条对话里切到写入档。
            ("grok", "streaming-messages-json", "plan"),
            ("gemini", "stream-json", "plan"),
            ("agy", "stream-json", "plan"),
            ("qwen", "stream-json", "plan"),
            ("opencode", "json", "plan"),
            ("mimo", "json", "plan"),
        ];
        for (id, format, permission) in cases {
            let spec = provider_spec(id).unwrap();
            let command = provider_command(
                spec,
                fake.clone(),
                Path::new("/tmp/proj"),
                "你好 ; $()",
                "",
                false,
                "",
                "",
            );
            let args = command
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            assert!(args.iter().any(|arg| arg == format), "{id} 缺结构化输出");
            assert!(args.iter().any(|arg| arg == permission), "{id} 缺只读模式");
            // agy 的 prompt 附在 --print 上（它拒绝 `-- <prompt>`），其余按独立参数传。
            let prompt_passed = if id == "agy" {
                args.iter().any(|arg| arg == "--print=你好 ; $()")
            } else {
                args.iter().any(|arg| arg == "你好 ; $()")
            };
            assert!(prompt_passed, "{id} prompt 未按参数传递");
        }

        let claude = provider_command(
            provider_spec("claude").unwrap(),
            fake.clone(),
            Path::new("/tmp/proj"),
            "检查项目",
            "",
            false,
            "",
            "",
        );
        let claude_args = claude
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        for flag in [
            "--safe-mode",
            "--disable-slash-commands",
            "--strict-mcp-config",
        ] {
            assert!(claude_args.iter().any(|arg| arg == flag));
        }

        let gemini = provider_command(
            provider_spec("gemini").unwrap(),
            fake.clone(),
            Path::new("/tmp/proj"),
            "检查项目",
            "",
            false,
            "",
            "",
        );
        assert!(gemini
            .get_args()
            .any(|arg| arg.to_string_lossy() == "--sandbox"));

        let qwen = provider_command(
            provider_spec("qwen").unwrap(),
            fake.clone(),
            Path::new("/tmp/proj"),
            "检查项目",
            "qwen-session",
            false,
            "qwen3-coder",
            "",
        );
        let qwen_args = qwen
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(qwen_args
            .windows(2)
            .any(|pair| pair == ["--resume", "qwen-session"]));
        assert!(qwen_args
            .windows(2)
            .any(|pair| pair == ["--model", "qwen3-coder"]));
        assert!(qwen_args.iter().any(|arg| arg == "--sandbox"));
        assert!(qwen_args
            .iter()
            .any(|arg| arg == "--include-partial-messages"));

        for id in ["opencode", "mimo"] {
            let command = provider_command(
                provider_spec(id).unwrap(),
                fake.clone(),
                Path::new("/tmp/proj"),
                "检查项目",
                "session-1",
                true,
                "provider-model",
                "",
            );
            let args = command
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            assert!(args
                .windows(2)
                .any(|pair| pair == ["--session", "session-1"]));
            assert!(args
                .windows(2)
                .any(|pair| pair == ["--model", "provider-model"]));
            assert!(args.iter().any(|arg| arg == "--pure"));
            assert!(!args.iter().any(|arg| arg == "plan"));
            for dangerous in [
                "--auto",
                "--never-ask",
                "--trust",
                "--dangerously-skip-permissions",
                "--yolo",
            ] {
                assert!(
                    !args.iter().any(|arg| arg == dangerous),
                    "{id} 不得启用 {dangerous}"
                );
            }
        }

        let grok = provider_command(
            provider_spec("grok").unwrap(),
            fake,
            Path::new("/tmp/proj"),
            "检查项目",
            "",
            false,
            "grok-4",
            "high",
        );
        let grok_args = grok
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(grok_args.windows(2).any(|pair| pair == ["-m", "grok-4"]));
        assert!(grok_args
            .windows(2)
            .any(|pair| pair == ["--effort", "high"]));
        let claude_effort = provider_command(
            provider_spec("claude").unwrap(),
            PathBuf::from("/bin/echo"),
            Path::new("/tmp/proj"),
            "检查项目",
            "",
            false,
            "sonnet",
            "xhigh",
        );
        let claude_effort_args = claude_effort
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(claude_effort_args
            .windows(2)
            .any(|pair| pair == ["--model", "sonnet"]));
        assert!(claude_effort_args
            .windows(2)
            .any(|pair| pair == ["--effort", "xhigh"]));
        assert!(validate_model("").is_ok());
        assert!(validate_model("gpt-5.4-mini").is_ok());
        assert!(validate_model("opencode/gpt-5.6").is_ok());
        assert!(validate_model("--sandbox").is_err());
        assert!(validate_model("a b").is_err());
        assert!(validate_effort("").is_ok());
        assert!(validate_effort("xhigh").is_ok());
        assert!(validate_effort("--sandbox").is_err());
    }

    #[test]
    fn positional_prompts_are_protected_by_option_terminators() {
        for id in ["claude", "agy", "opencode", "mimo"] {
            let command = provider_command(
                provider_spec(id).unwrap(),
                PathBuf::from("/bin/echo"),
                Path::new("/tmp/proj"),
                "--help 只是用户文本",
                "",
                false,
                "",
                "",
            );
            let args = command
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            // 要守的性质是"用户文本永远不会被当成选项解析"。多数 CLI 用 `--`
            // 终结符达成；agy 达不成——它明确拒绝 `-- <prompt>` 这种写法，改用
            // `--print=<prompt>` 把文本附在选项上，同样不可能被解析成独立选项。
            if id == "agy" {
                assert!(
                    args.iter().any(|arg| arg == "--print=--help 只是用户文本"),
                    "agy 必须把 prompt 附在 --print 上"
                );
                assert!(
                    !args.iter().any(|arg| arg == "--help 只是用户文本"),
                    "agy 不能让用户文本成为独立参数"
                );
            } else {
                assert!(
                    args.windows(2)
                        .any(|pair| pair == ["--", "--help 只是用户文本"]),
                    "{id} 必须用 -- 保护位置 prompt"
                );
            }
        }
    }

    #[test]
    fn verified_slash_commands_use_each_provider_native_path() {
        let fake = PathBuf::from("/bin/echo");
        let command_invocation = crate::conversation_slash::ConversationSlashInvocation {
            id: "team/review".into(),
            args: "--model 不应成为进程参数".into(),
            kind: crate::conversation_slash::ConversationSlashKind::Command,
        };
        let skill_invocation = crate::conversation_slash::ConversationSlashInvocation {
            id: "review".into(),
            args: "检查暂存区".into(),
            kind: crate::conversation_slash::ConversationSlashKind::Skill,
        };

        let opencode = provider_command_with_slash(
            provider_spec("opencode").unwrap(),
            fake.clone(),
            Path::new("/tmp/proj"),
            "/team/review 检查暂存区",
            "",
            crate::conversation_modes::default_mode("opencode"),
            "",
            "high",
            Some(&command_invocation),
        );
        let opencode_args = opencode
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(opencode_args
            .windows(2)
            .any(|pair| pair == ["--command", "team/review"]));
        assert!(opencode_args
            .windows(2)
            .any(|pair| pair == ["--variant", "high"]));
        assert!(opencode_args
            .windows(2)
            .any(|pair| pair == ["--agent", "plan"]));
        assert!(opencode_args
            .windows(2)
            .any(|pair| pair == ["--", "--model 不应成为进程参数"]));

        let opencode_skill = provider_command_with_slash(
            provider_spec("opencode").unwrap(),
            fake.clone(),
            Path::new("/tmp/proj"),
            "/review 检查暂存区",
            "",
            crate::conversation_modes::default_mode("opencode"),
            "",
            "",
            Some(&skill_invocation),
        );
        let opencode_skill_args = opencode_skill
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(!opencode_skill_args.iter().any(|arg| arg == "--command"));
        assert!(opencode_skill_args
            .iter()
            .any(|arg| arg.contains("locally installed skill named 'review'")));

        let mimo = provider_command_with_slash(
            provider_spec("mimo").unwrap(),
            fake.clone(),
            Path::new("/tmp/proj"),
            "/review 检查暂存区",
            "",
            crate::conversation_modes::default_mode("mimo"),
            "",
            "max",
            Some(&skill_invocation),
        );
        let mimo_args = mimo
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(!mimo_args.iter().any(|arg| arg == "--command"));
        assert!(mimo_args
            .iter()
            .any(|arg| arg.contains("locally installed skill named 'review'")));
        assert!(mimo_args
            .windows(2)
            .any(|pair| pair == ["--variant", "max"]));

        let mimo_command = provider_command_with_slash(
            provider_spec("mimo").unwrap(),
            fake.clone(),
            Path::new("/tmp/proj"),
            "/team/review --model 不应成为进程参数",
            "",
            crate::conversation_modes::default_mode("mimo"),
            "",
            "",
            Some(&command_invocation),
        );
        let mimo_command_args = mimo_command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(mimo_command_args
            .windows(2)
            .any(|pair| pair == ["--command", "team/review"]));
        assert!(mimo_command_args
            .windows(2)
            .any(|pair| pair == ["--", "--model 不应成为进程参数"]));

        for id in ["claude", "agy"] {
            let command = provider_command_with_slash(
                provider_spec(id).unwrap(),
                fake.clone(),
                Path::new("/tmp/proj"),
                "/review 检查暂存区",
                "",
                crate::conversation_modes::default_mode(id),
                "",
                "",
                Some(&skill_invocation),
            );
            let args = command
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            assert!(!args.iter().any(|arg| arg == "--disable-slash-commands"));
        }

        let qwen = provider_command_with_slash(
            provider_spec("qwen").unwrap(),
            fake,
            Path::new("/tmp/proj"),
            "/review 检查暂存区",
            "",
            crate::conversation_modes::default_mode("qwen"),
            "",
            "",
            Some(&skill_invocation),
        );
        let qwen_args = qwen
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(!qwen_args.iter().any(|arg| arg == "--safe-mode"));
        assert!(qwen_args
            .windows(2)
            .any(|pair| pair == ["--approval-mode", "plan"]));

        let gemini = provider_command_with_slash(
            provider_spec("gemini").unwrap(),
            PathBuf::from("/bin/echo"),
            Path::new("/tmp/proj"),
            "/review 检查暂存区",
            "",
            crate::conversation_modes::default_mode("gemini"),
            "",
            "",
            Some(&skill_invocation),
        );
        let gemini_args = gemini
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(gemini_args
            .windows(2)
            .any(|pair| pair == ["--prompt", "/review 检查暂存区"]));
        assert_eq!(
            codex_prompt_for_slash("原消息".into(), Some(&skill_invocation)),
            "$review 检查暂存区"
        );
    }

    #[test]
    fn slash_requests_are_revalidated_and_fail_closed() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        std::fs::create_dir_all(project.join(".qwen/commands")).unwrap();
        std::fs::write(
            project.join(".qwen/commands/roster-chat-test-f17.md"),
            "---\ndescription: 测试命令\n---\n",
        )
        .unwrap();
        let project = project.to_string_lossy();

        let invocation =
            resolve_requested_slash("qwen", &project, "/roster-chat-test-f17 参数", false)
                .unwrap()
                .unwrap();
        assert_eq!(invocation.id, "roster-chat-test-f17");
        assert_eq!(
            invocation.kind,
            crate::conversation_slash::ConversationSlashKind::Command
        );
        assert!(resolve_requested_slash("qwen", &project, "/missing 参数", false).is_err());
        assert!(
            resolve_requested_slash("qwen", &project, "/roster-chat-test-f17 参数", true,).is_err()
        );
        assert!(
            resolve_requested_slash("qwen", &project, "普通交接消息", true)
                .unwrap()
                .is_none()
        );
        assert!(
            resolve_requested_slash("qwen", &project, "/etc/hosts", false)
                .unwrap()
                .is_none()
        );
        assert!(
            resolve_requested_slash("qwen", &project, "/missing\n这是普通多行文本", false)
                .unwrap()
                .is_none()
        );
        assert!(
            resolve_requested_slash("qwen", &project, "/etc/hosts", true)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn stderr_is_fully_drained_but_only_safe_tail_is_retained() {
        let mut raw = vec![b'0'; 32 * 1024];
        raw.extend_from_slice(
            b"\nAPI_KEY=secret\nBearer private\nSK-private\npassword=hush\nsafe failure detail\n",
        );
        let tail = drain_stderr_tail(std::io::Cursor::new(raw), STDERR_TAIL_BYTES);
        assert!(tail.len() <= STDERR_TAIL_BYTES);
        assert!(tail.ends_with("safe failure detail\n"));
        assert_eq!(
            summarize_cli_stderr(&tail).as_deref(),
            Some("safe failure detail")
        );

        for secret in [
            "token=secret",
            "to-ken=secret",
            "apiKey=secret",
            "api-key=secret",
            "bearer secret",
            "Bearer\tsecret",
            "bearer:secret",
            "SK-secret",
            "sk_secret",
            "sk:secret",
            "PASSWORD=secret",
            "pass_word=secret",
        ] {
            assert!(summarize_cli_stderr(secret).is_none(), "未过滤 {secret}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn stderr_drain_keeps_cli_running_after_more_than_pipe_capacity() {
        let mut child = Command::new("/bin/sh")
            .args([
                "-c",
                "head -c 65536 /dev/zero >&2; printf '\\nsafe stderr tail\\n' >&2",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn noisy stderr fixture");
        let stderr = child.stderr.take().expect("fixture stderr");
        let tail = Arc::new(Mutex::new(String::new()));
        let done = Arc::new(AtomicBool::new(false));
        spawn_stderr_tail_drain(stderr, tail.clone(), done.clone());

        assert!(child.wait().expect("wait fixture").success());
        let deadline = Instant::now() + Duration::from_secs(1);
        while !done.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(done.load(Ordering::SeqCst), "stderr reader must reach EOF");
        let tail = tail.lock().expect("stderr tail");
        assert!(tail.len() <= STDERR_TAIL_BYTES);
        assert!(tail.ends_with("safe stderr tail\n"));
    }

    #[test]
    fn provider_labels_are_preserved_for_handoffs() {
        assert_eq!(provider_label("opencode"), "OpenCode");
        assert_eq!(provider_label("mimo"), "MiMo Code");
        assert_eq!(provider_label("qwen"), "Qwen");
    }

    #[test]
    fn parsers_only_forward_assistant_text_and_high_level_activity() {
        let claude = parse_anthropic_line(&json!({
            "type": "assistant",
            "session_id": "abc",
            "message": { "content": [
                { "type": "thinking", "thinking": "private" },
                { "type": "text", "text": "公开回答" }
            ] }
        }));
        assert_eq!(claude.session_id.as_deref(), Some("abc"));
        assert_eq!(claude.assistant_delta.as_deref(), Some("公开回答"));

        let gemini = parse_gemini_line(&json!({
            "type": "tool_use",
            "tool_id": "tool-1",
            "tool_name": "write_file",
            "parameters": { "path": "/secret", "content": "private" }
        }));
        let activity = gemini.activities.first().unwrap();
        assert_eq!(
            activity.get("title").and_then(Value::as_str),
            Some("更新项目文件")
        );
        assert!(activity.get("parameters").is_none());

        let opencode = parse_opencode_line(&json!({
            "type": "tool_use",
            "sessionID": "session-1",
            "part": {
                "id": "tool-1",
                "tool": "write_file",
                "input": { "path": "/secret" },
                "state": { "status": "completed", "output": "private" }
            }
        }));
        assert_eq!(opencode.session_id.as_deref(), Some("session-1"));
        assert_eq!(
            opencode
                .activities
                .first()
                .and_then(|activity| activity.get("title"))
                .and_then(Value::as_str),
            Some("更新项目文件")
        );
        assert_eq!(
            opencode
                .activities
                .first()
                .and_then(|activity| activity.get("status"))
                .and_then(Value::as_str),
            Some("completed")
        );
        assert!(opencode
            .activities
            .first()
            .and_then(|activity| activity.get("input"))
            .is_none());

        let claude_tool = parse_anthropic_line(&json!({
            "type": "assistant",
            "message": { "content": [{
                "type": "tool_use",
                "id": "tool-claude",
                "name": "write_file",
                "input": { "path": "/secret", "content": "private" }
            }] }
        }));
        let claude_activity = claude_tool.activities.first().unwrap();
        assert_eq!(
            claude_activity.get("title").and_then(Value::as_str),
            Some("更新项目文件")
        );
        assert!(claude_activity.get("input").is_none());

        let claude_plan = parse_anthropic_line(&json!({
            "type": "assistant",
            "message": { "content": [{
                "type": "tool_use",
                "id": "tool-todo",
                "name": "TodoWrite",
                "input": { "todos": [
                    { "content": "读代码", "status": "completed", "activeForm": "读代码中" },
                    { "content": "改实现", "status": "in_progress" },
                    { "content": "跑测试", "status": "pending" },
                    { "content": "", "status": "pending" }
                ] }
            }] }
        }));
        let plan = claude_plan.plan.expect("待办工具应转成处理步骤");
        assert_eq!(plan.len(), 3, "空步骤要丢掉");
        assert_eq!(plan[0].get("step").and_then(Value::as_str), Some("读代码"));
        assert_eq!(
            plan[0].get("status").and_then(Value::as_str),
            Some("completed")
        );
        assert_eq!(
            plan[1].get("status").and_then(Value::as_str),
            Some("inProgress")
        );
        assert_eq!(
            plan[2].get("status").and_then(Value::as_str),
            Some("pending")
        );
        assert!(
            claude_plan.activities.is_empty(),
            "待办工具只出处理步骤，不再被当成写文件的动态"
        );
        assert!(
            plan.iter().all(|item| item.get("todos").is_none()),
            "不得把原始工具参数带回前端"
        );

        let qwen_plan = parse_qwen_line(&json!({
            "type": "assistant",
            "message": { "content": [{
                "type": "tool_use",
                "id": "tool-todo",
                "name": "todo_write",
                "input": { "todos": [{ "content": "整理计划", "status": "active" }] }
            }] }
        }));
        assert_eq!(
            qwen_plan
                .plan
                .as_ref()
                .and_then(|items| items.first())
                .and_then(|item| item.get("status"))
                .and_then(Value::as_str),
            Some("inProgress")
        );

        let claude_result = parse_anthropic_line(&json!({
            "type": "user",
            "message": { "content": [{
                "type": "tool_result",
                "tool_use_id": "tool-claude",
                "is_error": true,
                "content": "private"
            }] }
        }));
        assert_eq!(
            claude_result
                .activities
                .first()
                .and_then(|activity| activity.get("status"))
                .and_then(Value::as_str),
            Some("failed")
        );

        let qwen = parse_qwen_line(&json!({
            "type": "message",
            "session_id": "qwen-session",
            "role": "assistant",
            "content": [{ "type": "text", "text": "公开回复" }]
        }));
        assert_eq!(qwen.session_id.as_deref(), Some("qwen-session"));
        assert_eq!(qwen.assistant_delta.as_deref(), Some("公开回复"));

        let qwen_full = parse_qwen_line(&json!({
            "type": "assistant",
            "session_id": "qwen-session",
            "parent_tool_use_id": null,
            "message": { "content": [{ "type": "text", "text": "完整回复" }] }
        }));
        assert!(qwen_full.assistant_delta.is_none());
        assert_eq!(qwen_full.fallback_answer.as_deref(), Some("完整回复"));

        let qwen_subagent = parse_qwen_line(&json!({
            "type": "stream_event",
            "session_id": "qwen-session",
            "parent_tool_use_id": "tool-parent",
            "event": {
                "type": "content_block_delta",
                "delta": { "type": "text_delta", "text": "内部回复" }
            }
        }));
        assert!(qwen_subagent.assistant_delta.is_none());
    }

    #[test]
    fn gemini_history_uses_verified_session_file_not_resume_uuid() {
        let spec = provider_spec("gemini").unwrap();
        let command = provider_command(
            spec,
            PathBuf::from("/bin/echo"),
            Path::new("/tmp/proj"),
            "继续",
            "/tmp/session-a1b2-c3.json",
            false,
            "",
            "",
        );
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(args
            .windows(2)
            .any(|pair| { pair == ["--session-file", "/tmp/session-a1b2-c3.json"] }));
        assert!(!args.iter().any(|arg| arg == "--resume"));
    }

    #[test]
    fn completion_wait_returns_immediately_after_finish_signal() {
        let completion = Arc::new((Mutex::new(true), Condvar::new()));
        assert!(wait_for_completion(&completion, Duration::from_secs(60)));
    }

    #[test]
    fn gemini_uuid_resolves_to_real_session_file_name_after_stream_json_upgrade() {
        let home = tempfile::tempdir().unwrap();
        let project = "/work/roster";
        let chats = home.path().join(".gemini/tmp/project-1/chats");
        std::fs::create_dir_all(&chats).unwrap();
        std::fs::write(
            home.path().join(".gemini/projects.json"),
            format!(r#"{{"projects":{{"{project}":"project-1"}}}}"#),
        )
        .unwrap();
        let file = chats.join("session-2026-08-24-0d9e8f7a.jsonl");
        std::fs::write(
            &file,
            r#"{"event":"start","sessionId":"0d9e8f7a-1111-2222-3333-444455556666"}
{"messages":[{"type":"user","content":"继续"}]}"#,
        )
        .unwrap();
        std::fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap()
            .write_all(&vec![b'x'; 1024 * 1024])
            .unwrap();
        assert_eq!(
            validate_session_for_project_with_home(
                project,
                "gemini",
                "0d9e8f7a-1111-2222-3333-444455556666",
                home.path(),
            )
            .unwrap(),
            std::fs::canonicalize(file).unwrap().to_string_lossy(),
        );
    }

    fn attachment_input(id: &str, mime: &str, bytes: &[u8]) -> ConversationAttachmentInput {
        use base64::Engine as _;
        ConversationAttachmentInput {
            id: id.to_string(),
            mime: mime.to_string(),
            data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        }
    }

    #[test]
    fn attachments_are_saved_with_stable_names_and_pruned() {
        let dir = tempfile::tempdir().unwrap();
        let inputs = vec![
            attachment_input("shot-1", "image/png", &[1, 2, 3]),
            attachment_input("shot_2", "image/jpeg", &[4, 5]),
        ];
        let paths = prepare_attachments(&inputs, dir.path()).unwrap();
        assert_eq!(paths.len(), 2);
        assert!(paths[0].extension().and_then(|ext| ext.to_str()) == Some("png"));
        assert!(paths[1].extension().and_then(|ext| ext.to_str()) == Some("jpg"));
        assert_eq!(std::fs::read(&paths[0]).unwrap(), vec![1, 2, 3]);

        for index in 0..70 {
            std::fs::write(dir.path().join(format!("paste-old-{index:03}.png")), b"x").unwrap();
        }
        let paths = prepare_attachments(&inputs[..1], dir.path()).unwrap();
        assert!(paths.len() == 1);
        let remaining = std::fs::read_dir(dir.path()).unwrap().count();
        assert!(remaining <= MAX_PASTE_FILES);
    }

    #[test]
    fn attachments_reject_unsupported_mime_size_and_count() {
        let dir = tempfile::tempdir().unwrap();
        let bad_mime = vec![attachment_input("a", "text/plain", b"hi")];
        assert!(prepare_attachments(&bad_mime, dir.path()).is_err());
        let empty = vec![attachment_input("a", "image/png", &[])];
        assert!(prepare_attachments(&empty, dir.path()).is_err());
        let oversized = vec![attachment_input(
            "a",
            "image/png",
            &vec![0u8; MAX_ATTACHMENT_BYTES + 1],
        )];
        assert!(prepare_attachments(&oversized, dir.path()).is_err());
        let too_many = vec![
            attachment_input("a", "image/png", &[1]),
            attachment_input("b", "image/png", &[1]),
            attachment_input("c", "image/png", &[1]),
            attachment_input("d", "image/png", &[1]),
            attachment_input("e", "image/png", &[1]),
        ];
        assert!(prepare_attachments(&too_many, dir.path()).is_err());
        let bad_id = vec![attachment_input("../evil", "image/png", &[1])];
        assert!(prepare_attachments(&bad_id, dir.path()).is_err());
    }

    #[test]
    fn prompt_hint_lists_paths_and_gemini_uses_at_refs() {
        let paths = vec![std::path::PathBuf::from("/tmp/paste-1.png")];
        let hint = prompt_with_attachments("看看这个", &paths, "claude");
        assert!(hint.contains("看看这个"));
        assert!(hint.contains("/tmp/paste-1.png"));
        assert!(hint.contains("[图片附件]"));
        let gemini = prompt_with_attachments("看看这个", &paths, "gemini");
        assert!(gemini.ends_with("@/tmp/paste-1.png"));
        assert_eq!(prompt_with_attachments("纯文本", &[], "claude"), "纯文本");
    }
}
