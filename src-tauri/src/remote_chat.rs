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
    http::{header, HeaderMap, HeaderValue, StatusCode},
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

/// 手机可选的助手：与对话工作台登记的九家一致，顺序即手机上的展示顺序。
const PROVIDERS: [(&str, &str); 9] = [
    ("claude", "Claude"),
    ("codex", "Codex"),
    ("grok", "Grok"),
    ("opencode", "OpenCode"),
    ("agy", "agy"),
    ("qwen", "Qwen"),
    ("mimo", "MiMo Code"),
    ("cmd", "cmd"),
    ("pi", "pi"),
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
const MEDIA_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const MEDIA_VIDEO_BYTES: usize = 16 * 1024 * 1024;
const MEDIA_CACHE_BYTES: usize = 32 * 1024 * 1024;
const MEDIA_CACHE_ITEMS: usize = 64;
const MEDIA_TTL: Duration = Duration::from_secs(10 * 60);
const FILE_SOURCE_CAP: usize = 4096;

static APP: OnceLock<AppHandle> = OnceLock::new();
static RELAY: OnceLock<Relay> = OnceLock::new();
static INSTALLED: Mutex<Option<(Instant, Vec<String>)>> = Mutex::new(None);
static MEDIA: OnceLock<Mutex<MediaCache>> = OnceLock::new();
static MEDIA_READS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// 应用启动时登记 AppHandle：手机的指令要转给主窗口，项目记录也在 Tauri 托管状态里。
pub(crate) fn install(app: AppHandle) {
    let _ = APP.set(app);
}

struct Relay {
    tx: broadcast::Sender<Arc<str>>,
    table: Mutex<RunTable>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PhoneAttachment {
    id: String,
    kind: String,
    mime_type: String,
    name: String,
}

struct CachedMedia {
    project_id: String,
    mime_type: String,
    name: String,
    bytes: Arc<[u8]>,
    expires_at: Instant,
}

#[derive(Default)]
struct MediaCache {
    items: std::collections::VecDeque<(String, CachedMedia)>,
    bytes: usize,
    epoch: u64,
    enabled: bool,
}

#[derive(Clone, Copy)]
struct CacheWriteContext {
    now: Instant,
    enabled: bool,
    expected_epoch: u64,
    current_epoch: u64,
}

fn media_cache() -> &'static Mutex<MediaCache> {
    MEDIA.get_or_init(|| Mutex::new(MediaCache::default()))
}

fn valid_image_mime(mime: &str) -> bool {
    matches!(
        mime,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    )
}

fn valid_media_mime(mime: &str) -> bool {
    valid_image_mime(mime) || matches!(mime, "video/mp4" | "video/webm")
}

fn media_magic_matches(mime: &str, bytes: &[u8]) -> bool {
    match mime {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        "video/mp4" => {
            bytes.len() >= 12
                && &bytes[4..8] == b"ftyp"
                && !matches!(
                    &bytes[8..12],
                    b"heic" | b"heix" | b"hevc" | b"hevx" | b"mif1" | b"msf1"
                )
        }
        "video/webm" => bytes.starts_with(b"\x1a\x45\xdf\xa3"),
        _ => false,
    }
}

fn opaque_media_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

impl MediaCache {
    fn enable_if_epoch(&mut self, expected_epoch: u64) -> bool {
        if self.epoch != expected_epoch {
            return false;
        }
        self.enabled = true;
        true
    }

    fn stop(&mut self) {
        self.enabled = false;
        self.epoch = self.epoch.wrapping_add(1);
        self.clear();
    }

    fn clear(&mut self) {
        self.items.clear();
        self.bytes = 0;
    }

    fn prune_expired(&mut self, now: Instant) {
        let mut kept = std::collections::VecDeque::with_capacity(self.items.len());
        while let Some((id, item)) = self.items.pop_front() {
            if item.expires_at > now {
                kept.push_back((id, item));
            } else {
                self.bytes = self.bytes.saturating_sub(item.bytes.len());
            }
        }
        self.items = kept;
    }

    fn insert(
        &mut self,
        id: String,
        project_id: &str,
        mime: &str,
        name: &str,
        bytes: Vec<u8>,
        now: Instant,
    ) -> Option<PhoneAttachment> {
        let cap = if mime.starts_with("video/") {
            MEDIA_VIDEO_BYTES
        } else {
            MEDIA_IMAGE_BYTES
        };
        if bytes.is_empty()
            || bytes.len() > cap
            || !valid_media_mime(mime)
            || !media_magic_matches(mime, &bytes)
        {
            return None;
        }
        self.prune_expired(now);
        while self.items.len() >= MEDIA_CACHE_ITEMS
            || self.bytes.saturating_add(bytes.len()) > MEDIA_CACHE_BYTES
        {
            let (_, old) = self.items.pop_front()?;
            self.bytes = self.bytes.saturating_sub(old.bytes.len());
        }
        let kind = if mime.starts_with("video/") {
            "video"
        } else {
            "image"
        };
        self.bytes += bytes.len();
        self.items.push_back((
            id.clone(),
            CachedMedia {
                project_id: project_id.to_string(),
                mime_type: mime.to_string(),
                name: bounded(name, 160),
                bytes: Arc::from(bytes),
                expires_at: now + MEDIA_TTL,
            },
        ));
        Some(PhoneAttachment {
            id,
            kind: kind.into(),
            mime_type: mime.into(),
            name: bounded(name, 160),
        })
    }

    fn get(
        &mut self,
        project_id: &str,
        id: &str,
        now: Instant,
    ) -> Option<(String, String, Arc<[u8]>)> {
        self.prune_expired(now);
        if id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let (_, item) = self
            .items
            .iter()
            .find(|(key, item)| key == id && item.project_id == project_id)?;
        Some((
            item.mime_type.clone(),
            item.name.clone(),
            Arc::clone(&item.bytes),
        ))
    }
}

fn cache_media(
    expected_epoch: u64,
    project_id: &str,
    mime: &str,
    name: &str,
    bytes: Vec<u8>,
) -> Option<PhoneAttachment> {
    let mut cache = media_cache().lock().ok()?;
    let context = CacheWriteContext {
        now: Instant::now(),
        enabled: cache.enabled,
        expected_epoch,
        current_epoch: cache.epoch,
    };
    insert_if_epoch(
        &mut cache,
        opaque_media_id(),
        project_id,
        mime,
        name,
        bytes,
        context,
    )
}

fn insert_if_epoch(
    cache: &mut MediaCache,
    id: String,
    project_id: &str,
    mime: &str,
    name: &str,
    bytes: Vec<u8>,
    context: CacheWriteContext,
) -> Option<PhoneAttachment> {
    if !context.enabled || context.expected_epoch != context.current_epoch {
        return None;
    }
    cache.insert(id, project_id, mime, name, bytes, context.now)
}

fn decode_data_image(data_url: &str) -> Option<(String, Vec<u8>)> {
    let (header, encoded) = data_url.split_once(',')?;
    let mime = header.strip_prefix("data:")?.strip_suffix(";base64")?;
    if !valid_image_mime(mime) || encoded.len() > (MEDIA_IMAGE_BYTES * 4 / 3 + 8) {
        return None;
    }
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded).ok()?;
    if bytes.is_empty() || bytes.len() > MEDIA_IMAGE_BYTES || !media_magic_matches(mime, &bytes) {
        return None;
    }
    Some((mime.to_string(), bytes))
}

fn cache_data_url(
    expected_epoch: u64,
    project_id: &str,
    name: &str,
    data_url: &str,
) -> Option<PhoneAttachment> {
    let (mime, bytes) = decode_data_image(data_url).or_else(|| {
        let (header, encoded) = data_url.split_once(',')?;
        let mime = header.strip_prefix("data:")?.strip_suffix(";base64")?;
        if !matches!(mime, "video/mp4" | "video/webm")
            || encoded.len() > (MEDIA_VIDEO_BYTES * 4 / 3 + 8)
        {
            return None;
        }
        let bytes =
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded).ok()?;
        (!bytes.is_empty() && bytes.len() <= MEDIA_VIDEO_BYTES && media_magic_matches(mime, &bytes))
            .then(|| (mime.to_string(), bytes))
    })?;
    cache_media(expected_epoch, project_id, &mime, name, bytes)
}

struct ReadPermit;
impl Drop for ReadPermit {
    fn drop(&mut self) {
        MEDIA_READS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

struct MediaBodyOwner {
    bytes: Arc<[u8]>,
    start: usize,
    end: usize,
    _permit: ReadPermit,
}

impl AsRef<[u8]> for MediaBodyOwner {
    fn as_ref(&self) -> &[u8] {
        &self.bytes[self.start..self.end]
    }
}

fn acquire_read_permit() -> Option<ReadPermit> {
    use std::sync::atomic::Ordering;
    loop {
        let current = MEDIA_READS.load(Ordering::SeqCst);
        if current >= 2 {
            return None;
        }
        if MEDIA_READS
            .compare_exchange(current, current + 1, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            return Some(ReadPermit);
        }
    }
}

fn cached_media(
    cache: &mut MediaCache,
    project_id: &str,
    id: &str,
) -> Option<(String, String, Arc<[u8]>)> {
    cache.get(project_id, id, Instant::now())
}

fn parse_byte_range(value: &str, length: usize) -> Option<(usize, usize)> {
    let spec = value.strip_prefix("bytes=")?;
    if spec.contains(',') || length == 0 {
        return None;
    }
    let (start, end) = spec.split_once('-')?;
    if start.is_empty() {
        let suffix = end.parse::<usize>().ok()?.min(length);
        return (suffix > 0).then_some((length - suffix, length - 1));
    }
    let start = start.parse::<usize>().ok()?;
    if start >= length {
        return None;
    }
    let end = if end.is_empty() {
        length - 1
    } else {
        end.parse::<usize>().ok()?.min(length - 1)
    };
    (end >= start).then_some((start, end))
}

pub(crate) fn clear_media_cache() {
    if let Ok(mut cache) = media_cache().lock() {
        cache.stop();
    }
    if let Ok(mut table) = relay().table.lock() {
        for run in &mut table.runs {
            run.attachments.clear();
            run.attachment_bytes = 0;
            run.image_ids.clear();
        }
    }
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
    attachments: Vec<PhoneAttachment>,
    #[serde(skip)]
    attachment_bytes: usize,
    #[serde(skip)]
    image_ids: std::collections::HashSet<String>,
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
fn should_relay_event(kind: &str) -> bool {
    !matches!(kind, "memory" | "memory_saved")
}

fn phone_image_event_data(
    table: &mut RunTable,
    cache: &mut MediaCache,
    run_id: &str,
    provider_id: &str,
    data: &Value,
    expected_epoch: u64,
) -> Option<Value> {
    let image_id = data
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 200 && !id.chars().any(char::is_control))?;
    let index = table
        .runs
        .iter()
        .position(|run| run.run_id == run_id && run.provider_id == provider_id)?;
    let run = &mut table.runs[index];
    if run.image_ids.contains(image_id) || run.attachments.len() >= 8 {
        return None;
    }
    let items = data.get("attachments")?.as_array()?;
    for item in items.iter().take(8) {
        if run.attachment_bytes >= MEDIA_IMAGE_BYTES {
            break;
        }
        let data_url = item.get("dataUrl")?.as_str()?;
        let (mime, bytes) = decode_data_image(data_url)?;
        if run.attachment_bytes.saturating_add(bytes.len()) > MEDIA_IMAGE_BYTES {
            continue;
        }
        let name = item
            .get("alt")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .unwrap_or("生成的图片");
        let size = bytes.len();
        let context = CacheWriteContext {
            now: Instant::now(),
            enabled: cache.enabled,
            expected_epoch,
            current_epoch: cache.epoch,
        };
        let meta = insert_if_epoch(
            cache,
            opaque_media_id(),
            &run.project_id,
            &mime,
            name,
            bytes,
            context,
        )?;
        run.attachment_bytes += size;
        run.attachments.push(meta.clone());
        run.image_ids.insert(image_id.to_string());
        return Some(json!({ "attachment": meta }));
    }
    None
}

pub(crate) fn publish_event(run_id: &str, provider_id: &str, kind: &str, data: &Value) {
    // Desktop raster results may be multi-MiB. Convert them to opaque metadata
    // before they reach the phone relay's 1024-frame control queue.
    if !should_relay_event(kind) {
        return;
    }
    let media_epoch = match media_cache().lock() {
        Ok(cache) => cache.epoch,
        Err(_) => return,
    };
    let relay = relay();
    let Ok(mut table) = relay.table.lock() else {
        return;
    };
    let outgoing = if kind == "assistant_image" {
        // Only active, correctly-bound runs may populate cache; raw image data never enters WS.
        let Ok(mut cache) = media_cache().lock() else {
            return;
        };
        if !cache.enabled || cache.epoch != media_epoch {
            return;
        }
        let Some(outgoing) = phone_image_event_data(
            &mut table,
            &mut cache,
            run_id,
            provider_id,
            data,
            media_epoch,
        ) else {
            return;
        };
        outgoing
    } else {
        table.apply(run_id, provider_id, kind, data);
        data.clone()
    };
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
            "data": outgoing,
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
        attachments: Vec::new(),
        attachment_bytes: 0,
        image_ids: std::collections::HashSet::new(),
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

// Check and publish under the snapshot lock, so a preparing cancellation cannot
// remove a running snapshot or race a registration between two lock operations.
fn pending_cancel_frame(table: &mut RunTable, run_id: &str, provider_id: &str) -> Option<Value> {
    if table.contains(run_id) {
        return None;
    }
    Some(json!({ "t": "ev", "seq": table.next_seq(), "runId": run_id,
        "providerId": provider_id, "kind": "cancelled", "data": {} }))
}

pub(crate) fn cancel_pending(run_id: &str, provider_id: &str) -> Result<(), String> {
    crate::codex_chat::validate_run_id(run_id)?;
    if !PROVIDERS.iter().any(|(id, _)| *id == provider_id) {
        return Err("未知的助手".into());
    }
    let relay = relay();
    let mut table = relay.table.lock().map_err(|_| "取消状态暂时不可用")?;
    if let Some(frame) = pending_cancel_frame(&mut table, run_id, provider_id) {
        send_frame(relay, frame);
    }
    Ok(())
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

fn authorized_epoch(
    hub: &RemoteHub,
    query: &HashMap<String, String>,
) -> Result<(&'static AppHandle, u64), (StatusCode, &'static str)> {
    let epoch = media_cache()
        .lock()
        .map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, "媒体服务暂不可用"))?
        .epoch;
    if !crate::remote::token_ok(hub, query) {
        return Err((StatusCode::UNAUTHORIZED, "PIN 错误"));
    }
    let mut cache = media_cache()
        .lock()
        .map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, "媒体服务暂不可用"))?;
    if !cache.enable_if_epoch(epoch) {
        return Err((StatusCode::UNAUTHORIZED, "PIN 已失效"));
    }
    let app = APP
        .get()
        .ok_or((StatusCode::SERVICE_UNAVAILABLE, "电脑端还没准备好"))?;
    Ok((app, epoch))
}

fn authorized(
    hub: &RemoteHub,
    query: &HashMap<String, String>,
) -> Result<&'static AppHandle, (StatusCode, &'static str)> {
    authorized_epoch(hub, query).map(|(app, _)| app)
}

pub(crate) fn routes() -> Router<RemoteHub> {
    Router::new()
        .route("/api/chat/bootstrap", get(bootstrap))
        .route("/api/chat/history", get(history))
        .route("/api/chat/transcript", get(transcript))
        .route("/api/chat/media", get(media))
        .route("/api/chat/file", get(file_preview))
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
fn phone_transcript(
    preview: crate::project_sessions::ConversationTranscriptPreview,
    project_id: &str,
    cache: &mut MediaCache,
) -> Value {
    let mut budget = TRANSCRIPT_BUDGET;
    let mut truncated = preview.truncated;
    let mut messages = Vec::new();
    let mut image_budget = MEDIA_CACHE_BYTES;
    for message in preview.messages.into_iter().rev() {
        let text = bounded(&message.text, TRANSCRIPT_MESSAGE_CAP);
        if text.len() > budget {
            truncated = true;
            break;
        }
        budget -= text.len();
        let mut attachments = Vec::new();
        for (attachment_index, attachment) in message.attachments.iter().enumerate().take(8) {
            if image_budget == 0 {
                break;
            }
            let Some((mime, bytes)) = decode_data_image(&attachment.data_url) else {
                continue;
            };
            if bytes.len() > image_budget {
                continue;
            }
            image_budget = image_budget.saturating_sub(bytes.len());
            let name = if attachment.alt.trim().is_empty() {
                format!("会话图片 {}", attachment_index + 1)
            } else {
                attachment.alt.clone()
            };
            if let Some(meta) = cache.insert(
                opaque_media_id(),
                project_id,
                &mime,
                &name,
                bytes,
                Instant::now(),
            ) {
                attachments.push(meta);
            }
        }
        messages.push(json!({
            "role": message.role,
            "text": text,
            "images": message.attachments.len(),
            "attachments": attachments,
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
    let (app, epoch) = match authorized_epoch(&hub, &q) {
        Ok(auth) => auth,
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
    let Some(permit) = acquire_read_permit() else {
        return error_response(StatusCode::TOO_MANY_REQUESTS, "文件读取繁忙，请稍后重试");
    };
    let project_id_for_media = project_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let preview =
            crate::project_sessions::preview_conversation_transcript(&project.path, &tool, &id)?;
        let mut cache = media_cache()
            .lock()
            .map_err(|_| "媒体缓存暂不可用".to_string())?;
        if !cache.enabled || cache.epoch != epoch {
            return Err("PIN 已失效".into());
        }
        Ok::<_, String>(phone_transcript(preview, &project_id_for_media, &mut cache))
    })
    .await;
    match result {
        Ok(Ok(value)) if media_cache().lock().is_ok_and(|cache| cache.epoch == epoch) => {
            Json(value).into_response()
        }
        Ok(Ok(_)) => error_response(StatusCode::UNAUTHORIZED, "PIN 已失效"),
        Ok(Err(error)) => error_response(StatusCode::NOT_FOUND, &error),
        Err(_) => error_response(StatusCode::INTERNAL_SERVER_ERROR, "读取对话失败"),
    }
}

async fn media(
    State(hub): State<RemoteHub>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let (app, epoch) = match authorized_epoch(&hub, &q) {
        Ok(auth) => auth,
        Err((status, message)) => return error_response(status, message),
    };
    let project_id = q.get("project").cloned().unwrap_or_default();
    let id = q.get("id").cloned().unwrap_or_default();
    if project_record(app, &project_id).is_none() {
        return error_response(StatusCode::NOT_FOUND, "找不到这个项目");
    }
    let Some(permit) = acquire_read_permit() else {
        return error_response(StatusCode::TOO_MANY_REQUESTS, "媒体读取繁忙，请稍后重试");
    };
    let Ok(mut cache) = media_cache().lock() else {
        return error_response(StatusCode::SERVICE_UNAVAILABLE, "媒体服务暂不可用");
    };
    if !cache.enabled || cache.epoch != epoch {
        return error_response(StatusCode::UNAUTHORIZED, "PIN 已失效");
    }
    let Some((mime, _name, bytes)) = cached_media(&mut cache, &project_id, &id) else {
        return error_response(StatusCode::NOT_FOUND, "媒体已过期或不存在");
    };
    drop(cache);
    let length = bytes.len();
    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    let (status, start, end, content_range) = if let Some(range) = range {
        let Some((start, end)) = parse_byte_range(range, length) else {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{length}"))
                .header(header::CACHE_CONTROL, "no-store")
                .body(axum::body::Body::empty())
                .unwrap_or_else(|_| {
                    error_response(StatusCode::RANGE_NOT_SATISFIABLE, "媒体范围无效")
                });
        };
        (
            StatusCode::PARTIAL_CONTENT,
            start,
            end + 1,
            Some(format!("bytes {start}-{end}/{length}")),
        )
    } else {
        (StatusCode::OK, 0, length, None)
    };
    let mut builder = Response::builder()
        .status(status)
        .header(
            header::CONTENT_TYPE,
            HeaderValue::from_str(&mime)
                .unwrap_or(HeaderValue::from_static("application/octet-stream")),
        )
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff");
    if let Some(content_range) = content_range {
        builder = builder.header(header::CONTENT_RANGE, content_range);
    }
    let body_len = end - start;
    let owner = MediaBodyOwner {
        bytes,
        start,
        end,
        _permit: permit,
    };
    let body = axum::body::Body::from(axum::body::Bytes::from_owner(owner));
    builder
        .header(header::CONTENT_LENGTH, body_len)
        .body(body)
        .unwrap_or_else(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "无法返回媒体"))
}

async fn file_preview(
    State(hub): State<RemoteHub>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let (app, epoch) = match authorized_epoch(&hub, &q) {
        Ok(auth) => auth,
        Err((status, message)) => return error_response(status, message),
    };
    let project_id = q.get("project").cloned().unwrap_or_default();
    let source = q.get("source").cloned().unwrap_or_default();
    if source.is_empty() || source.len() > FILE_SOURCE_CAP || source.chars().any(char::is_control) {
        return error_response(StatusCode::BAD_REQUEST, "文件链接无效");
    }
    if source.contains("://") && !source.starts_with("file://") {
        return error_response(StatusCode::BAD_REQUEST, "只支持当前项目中的本地文件链接");
    }
    let Some(project) = project_record(app, &project_id) else {
        return error_response(StatusCode::NOT_FOUND, "找不到这个项目");
    };
    let Some(permit) = acquire_read_permit() else {
        return error_response(StatusCode::TOO_MANY_REQUESTS, "文件读取繁忙，请稍后重试");
    };
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let preview = crate::conversation_media::read_link_file(&project.path, &source, None)?;
        let mut response = json!({
            "name": bounded(&preview.name, 160),
            "kind": preview.kind,
            "content": preview.content,
            "truncated": preview.truncated,
            "line": preview.line,
            "mimeType": preview.mime_type,
        });
        if let Some(data_url) = preview.data_url {
            let attachment = cache_data_url(epoch, &project_id, &preview.name, &data_url)
                .ok_or_else(|| "媒体格式或大小不受支持".to_string())?;
            response["attachment"] = serde_json::to_value(attachment).unwrap_or(Value::Null);
        }
        Ok::<_, String>(response)
    })
    .await;
    match result {
        Ok(Ok(value)) if media_cache().lock().is_ok_and(|cache| cache.epoch == epoch) => {
            let mut response = Json(value).into_response();
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        Ok(Ok(_)) => error_response(StatusCode::UNAUTHORIZED, "PIN 已失效"),
        // Do not surface filesystem errors: some platform errors include absolute paths.
        Ok(Err(_)) => error_response(StatusCode::BAD_REQUEST, "文件无法安全读取或不支持预览"),
        Err(_) => error_response(StatusCode::INTERNAL_SERVER_ERROR, "读取文件预览失败"),
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

    #[test]
    fn large_desktop_images_do_not_enter_phone_control_queue() {
        assert!(
            should_relay_event("assistant_image"),
            "image events are relayed only after conversion to metadata"
        );
        assert!(!should_relay_event("memory"));
        assert!(should_relay_event("assistant_message"));
        assert!(should_relay_event("completed"));
    }

    #[test]
    fn image_event_drops_raw_data_and_ignores_wrong_run_or_provider() {
        let mut table = RunTable::default();
        table.register(snapshot("chat-image"));
        let mut cache = MediaCache {
            epoch: 7,
            ..MediaCache::default()
        };
        let data = json!({ "attachments": [{
            "kind": "image", "mimeType": "image/png", "alt": "generated",
            "dataUrl": "data:image/png;base64,iVBORw0KGgo="
        }], "id": "image-item-1" });
        assert!(
            phone_image_event_data(&mut table, &mut cache, "chat-image", "claude", &data, 7,)
                .is_none(),
            "关闭远程时不能缓存图片"
        );
        assert!(cache.enable_if_epoch(7));
        assert!(
            phone_image_event_data(&mut table, &mut cache, "other-run", "claude", &data, 7)
                .is_none()
        );
        assert!(
            phone_image_event_data(&mut table, &mut cache, "chat-image", "codex", &data, 7)
                .is_none()
        );
        let accepted =
            phone_image_event_data(&mut table, &mut cache, "chat-image", "claude", &data, 7)
                .unwrap();
        assert!(accepted.get("dataUrl").is_none());
        let id = accepted["attachment"]["id"].as_str().unwrap();
        assert_eq!(accepted["attachment"]["kind"], "image");
        assert_eq!(cache.get("p1", id, Instant::now()).unwrap().0, "image/png");
        assert!(cache.get("other-project", id, Instant::now()).is_none());
        assert!(
            phone_image_event_data(&mut table, &mut cache, "chat-image", "claude", &data, 7)
                .is_none()
        );
        assert_eq!(cache.items.len(), 1, "duplicate data.id is ignored");
        assert_eq!(table.runs[0].attachments.len(), 1);
    }

    #[test]
    fn preparing_cancel_reports_terminal_event_without_removing_active_runs() {
        let mut table = RunTable::default();
        table.register(snapshot("chat-active"));
        let frame = pending_cancel_frame(&mut table, "chat-preparing", "claude").unwrap();
        assert_eq!(frame["kind"], "cancelled");
        assert_eq!(frame["runId"], "chat-preparing");
        assert_eq!(frame["providerId"], "claude");
        assert_eq!(table.runs.len(), 1);
        let seq = table.seq;
        assert!(pending_cancel_frame(&mut table, "chat-active", "claude").is_none());
        assert_eq!(table.seq, seq);
        assert!(table.contains("chat-active"));
        assert!(cancel_pending("invalid id", "claude").is_err());
        assert!(cancel_pending("chat-valid", "unknown").is_err());
    }

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
            attachments: Vec::new(),
            attachment_bytes: 0,
            image_ids: std::collections::HashSet::new(),
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
        let value = phone_transcript(
            ConversationTranscriptPreview {
                source_tool: "claude".into(),
                source_id: "s1".into(),
                source_title: "标题".into(),
                source_at_ms: 1,
                messages,
                truncated: false,
            },
            "p1",
            &mut MediaCache::default(),
        );
        let kept = value["messages"].as_array().unwrap();
        assert!(kept.len() < count + 1);
        assert_eq!(kept.last().unwrap()["text"], "最新一条");
        assert_eq!(value["truncated"], true);
    }

    #[test]
    fn phone_transcript_caches_historical_raster_and_returns_metadata_only() {
        use crate::project_sessions::{
            ConversationTranscriptMessage, ConversationTranscriptPreview,
        };
        let preview = ConversationTranscriptPreview {
            source_tool: "codex".into(),
            source_id: "session-1".into(),
            source_title: "历史图片".into(),
            source_at_ms: 7,
            messages: vec![ConversationTranscriptMessage {
                role: "assistant".into(),
                text: "图片如下".into(),
                attachments: vec![crate::conversation_media::ConversationAttachment {
                    kind: "image".into(),
                    mime_type: "image/png".into(),
                    data_url: "data:image/png;base64,iVBORw0KGgo=".into(),
                    alt: "历史生成图".into(),
                }],
            }],
            truncated: false,
        };
        let mut cache = MediaCache::default();
        let value = phone_transcript(preview, "p1", &mut cache);
        let metadata = &value["messages"][0]["attachments"][0];
        assert_eq!(metadata["mimeType"], "image/png");
        assert!(metadata.get("dataUrl").is_none());
        let id = metadata["id"].as_str().unwrap();
        let (mime, name, bytes) = cache.get("p1", id, Instant::now()).unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(name, "历史生成图");
        assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
    }

    #[test]
    fn media_range_and_data_url_validation_are_bounded() {
        assert_eq!(parse_byte_range("bytes=2-4", 10), Some((2, 4)));
        assert_eq!(parse_byte_range("bytes=-3", 10), Some((7, 9)));
        assert_eq!(parse_byte_range("bytes=8-", 10), Some((8, 9)));
        assert_eq!(parse_byte_range("bytes=10-", 10), None);
        assert_eq!(parse_byte_range("bytes=0-1,4-5", 10), None);
        assert!(decode_data_image("data:image/svg+xml;base64,PHN2Zz4=").is_none());
        assert!(decode_data_image("https://example.test/image.png").is_none());
        assert!(decode_data_image("data:image/png;base64,AAAA").is_none());
        assert!(decode_data_image("data:image/png;base64,iVBORw0KGgo=").is_some());
        assert!(media_magic_matches("video/mp4", b"\0\0\0\x18ftypisom"));
        assert!(media_magic_matches("video/webm", b"\x1a\x45\xdf\xa3more"));
        assert!(!media_magic_matches("video/mp4", b"video"));
    }

    #[test]
    fn phone_attachment_serialization_contains_only_opaque_metadata() {
        let attachment = PhoneAttachment {
            id: "0123456789abcdef0123456789abcdef".into(),
            kind: "image".into(),
            mime_type: "image/png".into(),
            name: "生成图片".into(),
        };
        let value = serde_json::to_value(attachment).unwrap();
        assert_eq!(value["kind"], "image");
        assert!(value.get("dataUrl").is_none());
        assert!(value.get("path").is_none());
    }

    #[test]
    fn media_cache_enforces_ttl_count_quota_and_epoch() {
        let now = Instant::now();
        let png = b"\x89PNG\r\n\x1a\n".to_vec();
        let mut cache = MediaCache::default();
        let first = cache
            .insert(
                "00000000000000000000000000000001".into(),
                "p1",
                "image/png",
                "one",
                png.clone(),
                now,
            )
            .unwrap();
        assert!(cache
            .get("p1", &first.id, now + MEDIA_TTL + Duration::from_millis(1))
            .is_none());
        assert_eq!(cache.bytes, 0, "过期条目被裁掉并扣除配额");

        for n in 0..=MEDIA_CACHE_ITEMS {
            cache
                .insert(
                    format!("{n:032x}"),
                    "p1",
                    "image/png",
                    "small",
                    png.clone(),
                    now,
                )
                .unwrap();
        }
        assert_eq!(cache.items.len(), MEDIA_CACHE_ITEMS);
        assert!(cache.get("p1", &format!("{:032x}", 0), now).is_none());
        assert!(cache.bytes <= MEDIA_CACHE_BYTES);
        assert!(insert_if_epoch(
            &mut cache,
            "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".into(),
            "p1",
            "image/png",
            "stale",
            png.clone(),
            CacheWriteContext {
                now,
                enabled: true,
                expected_epoch: 4,
                current_epoch: 5
            },
        )
        .is_none());
        assert!(insert_if_epoch(
            &mut cache,
            "ffffffffffffffffffffffffffffffff".into(),
            "p1",
            "image/png",
            "new",
            png,
            CacheWriteContext {
                now,
                enabled: true,
                expected_epoch: 5,
                current_epoch: 5
            },
        )
        .is_some());

        cache.clear();
        assert_eq!(cache.bytes, 0);
        assert!(
            cache.items.is_empty(),
            "stop会清空缓存，restart不会复用旧opaque id"
        );
        assert!(
            insert_if_epoch(
                &mut cache,
                "11111111111111111111111111111111".into(),
                "p1",
                "image/png",
                "old request",
                b"\x89PNG\r\n\x1a\n".to_vec(),
                CacheWriteContext {
                    now,
                    enabled: true,
                    expected_epoch: 8,
                    current_epoch: 9
                },
            )
            .is_none(),
            "stop/restart之间的旧epoch请求不得重新填cache"
        );

        let mut bytes_cache = MediaCache::default();
        let mut oldest = String::new();
        for n in 0..5 {
            let mut large_png = vec![0; MEDIA_IMAGE_BYTES];
            large_png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
            let id = format!("{:032x}", 100 + n);
            if n == 0 {
                oldest = id.clone();
            }
            bytes_cache
                .insert(id, "p1", "image/png", "quota", large_png, now)
                .unwrap();
        }
        assert_eq!(bytes_cache.bytes, MEDIA_CACHE_BYTES);
        assert!(
            bytes_cache.get("p1", &oldest, now).is_none(),
            "字节配额满时淘汰最旧媒体"
        );
    }

    #[test]
    fn authorization_and_stop_share_one_media_lock_epoch() {
        use std::sync::Barrier;

        for _ in 0..32 {
            let cache = Arc::new(Mutex::new(MediaCache::default()));
            let barrier = Arc::new(Barrier::new(3));
            let auth_cache = Arc::clone(&cache);
            let auth_barrier = Arc::clone(&barrier);
            let auth = std::thread::spawn(move || {
                let captured_epoch = 0;
                auth_barrier.wait();
                auth_cache.lock().unwrap().enable_if_epoch(captured_epoch)
            });
            let stop_cache = Arc::clone(&cache);
            let stop_barrier = Arc::clone(&barrier);
            let stop = std::thread::spawn(move || {
                stop_barrier.wait();
                stop_cache.lock().unwrap().stop();
            });
            barrier.wait();
            let _ = auth.join().unwrap();
            stop.join().unwrap();
            let state = cache.lock().unwrap();
            assert!(!state.enabled);
            assert_eq!(state.epoch, 1);
        }
    }

    #[test]
    fn shared_media_body_keeps_read_permit_until_last_bytes_owner_drops() {
        let permit = acquire_read_permit().unwrap();
        let owner = MediaBodyOwner {
            bytes: Arc::from(b"png".as_slice()),
            start: 0,
            end: 3,
            _permit: permit,
        };
        let shared = axum::body::Bytes::from_owner(owner);
        let clone = shared.clone();
        drop(shared);
        let second = acquire_read_permit().unwrap();
        assert!(acquire_read_permit().is_none(), "body仍持有首个读取permit");
        drop(clone);
        let third = acquire_read_permit().unwrap();
        drop(second);
        drop(third);
        assert!(acquire_read_permit().is_some());
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
