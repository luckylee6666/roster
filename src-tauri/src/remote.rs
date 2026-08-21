// 内嵌远程服务：手机端（局域网）通过浏览器访问，镜像并控制桌面已开的终端会话。
//
// 数据流：PTY ←→ RemoteHub（会话表 + 滚动缓存 + 广播通道）←→ WebSocket ←→ 手机 xterm.js
// 桌面窗口仍走 Tauri 事件，手机走这里的 WS，两边订阅同一批会话，互不影响。
//
// 安全：服务绑定 0.0.0.0 但要求 6 位 PIN（启动时随机生成，桌面 UI 展示），
// 连续猜错会触发指数退避锁定（见 AuthGuard），比对用定长比较避免时序侧信道。
// 这一层暴露的是「在本机跑 shell」的能力，PIN 是最低门槛，远程场景（Tailscale）务必保留。
// 关闭面板会调用 stop()：清空 PIN、断开所有已连接会话、停止监听，下次打开才重新暴露。

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use base64::Engine;
use portable_pty::{Child, MasterPty};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

/// 连续错误 PIN 达到这个次数后开始锁定，防止暴力枚举 6 位 PIN。
const MAX_AUTH_FAILS: u32 = 5;
/// 每多失败一次翻倍的基础锁定时长；封顶见下方 `.min(...)`。
const LOCKOUT_BASE: Duration = Duration::from_secs(30);
const LOCKOUT_CAP: Duration = Duration::from_secs(15 * 60);

/// 鉴权失败计数 + 锁定状态：所有请求共享（不区分来源 IP），
/// 因为这一层只挡「猜 PIN」，不是多用户系统，全局锁定足够也更简单。
#[derive(Default)]
struct AuthGuard {
    fails: u32,
    locked_until: Option<Instant>,
}

/// 定长比较，避免字节级提前退出泄露 PIN 前缀的时序信息。
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// 单个会话的滚动缓存上限（字节）。手机连上时回放最近这么多输出，避免黑屏。
const SCROLLBACK_CAP: usize = 256 * 1024;
/// WebSocket JSON 帧和其中单次终端键入的硬上限，避免已认证客户端用大帧耗尽内存。
const MAX_WS_MESSAGE_SIZE: usize = 64 * 1024;
const MAX_TERMINAL_INPUT_SIZE: usize = 32 * 1024;

/// 一个活跃的伪终端会话：保留 master（resize）、writer（写入键入）、child（kill）。
pub struct PtySession {
    pub master: Box<dyn MasterPty + Send>,
    /// Arc<Mutex<>>：让写入在锁外进行，一个会话的阻塞写不至于攥着全局 sessions 锁楔死其它会话。
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub child: Box<dyn Child + Send + Sync>,
}

impl Drop for PtySession {
    fn drop(&mut self) {
        // 任何错误路径、覆盖或显式清理只要释放会话，都必须回收子进程。
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// 会话元信息，供手机端列表展示（桌面那边叫「人物」/标签名）。
#[derive(Clone, Serialize)]
pub struct SessionMeta {
    pub id: String,
    pub name: String,
    pub tool: String,
}

/// 一段终端输出（base64，避免切断转义序列 / 多字节字符）。
#[derive(Clone)]
pub struct OutputMsg {
    pub id: String,
    pub data: String,
}

/// 所有终端状态的单一持有者，被 Tauri 托管的 TerminalState 与 axum 服务共享（克隆即共享 Arc）。
#[derive(Clone)]
pub struct RemoteHub {
    pub sessions: Arc<Mutex<HashMap<String, PtySession>>>,
    pub metas: Arc<Mutex<HashMap<String, SessionMeta>>>,
    pub scrollback: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    pub output_tx: broadcast::Sender<OutputMsg>,
    pub exit_tx: broadcast::Sender<String>,
    pub token: Arc<Mutex<String>>,
    pub port: u16,
    /// axum 服务是否已起。按需启动：用户首次打开「手机远程」面板才监听端口，
    /// 关闭面板时 `stop()` 会把这个复位，允许下次重新按需启动（新 PIN、新监听）。
    started: Arc<AtomicBool>,
    auth: Arc<Mutex<AuthGuard>>,
    /// 广播一次即：(1) 通知 axum accept 循环优雅关闭，不再接受新连接；
    /// (2) 所有正在桥接的 WS 会话各自收到信号后主动断开——两者共用一个信号，
    /// 保证「停止」是真的停止，而不是只关掉了监听、留着已连上的手机继续用。
    shutdown_tx: broadcast::Sender<()>,
}

impl RemoteHub {
    pub fn new(port: u16) -> Self {
        let (output_tx, _) = broadcast::channel(2048);
        let (exit_tx, _) = broadcast::channel(64);
        let (shutdown_tx, _) = broadcast::channel(8);
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            metas: Arc::new(Mutex::new(HashMap::new())),
            scrollback: Arc::new(Mutex::new(HashMap::new())),
            output_tx,
            exit_tx,
            token: Arc::new(Mutex::new(String::new())),
            port,
            started: Arc::new(AtomicBool::new(false)),
            auth: Arc::new(Mutex::new(AuthGuard::default())),
            shutdown_tx,
        }
    }

    /// 首次调用返回 true（并把状态置为已启动），之后恒返回 false，直到 `stop()` 复位。
    pub fn start_if_needed(&self) -> bool {
        self.started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// 真正停止手机端服务：清空 PIN（旧 PIN 立即失效）、复位启动状态（允许下次重新
    /// 生成新 PIN 并监听）、广播关闭信号（accept 循环停止 + 所有已连接的手机会话断开）。
    pub fn stop(&self) {
        self.started.store(false, Ordering::SeqCst);
        if let Ok(mut t) = self.token.lock() {
            t.clear();
        }
        if let Ok(mut g) = self.auth.lock() {
            *g = AuthGuard::default();
        }
        let _ = self.shutdown_tx.send(());
    }

    /// 由 reader 线程调用：把一段输出同时广播给 WS 客户端并追加进滚动缓存。
    /// `encoded` 由调用方算好（与桌面事件复用同一次 base64，避免对同一块编码两遍）。
    pub fn publish(&self, id: &str, raw: &[u8], encoded: String) {
        // 没有订阅者时 send 返回 Err，忽略即可。
        let _ = self.output_tx.send(OutputMsg {
            id: id.to_string(),
            data: encoded,
        });
        if let Ok(mut sb) = self.scrollback.lock() {
            let buf = sb.entry(id.to_string()).or_default();
            buf.extend_from_slice(raw);
            if buf.len() > SCROLLBACK_CAP {
                let drop = buf.len() - SCROLLBACK_CAP;
                buf.drain(0..drop);
            }
        }
    }

    /// 从所有表里移除一个会话（sessions / metas / scrollback），返回被移除的 PtySession（若有）。
    /// 手动关闭和 PTY 自行 EOF 两条路径都走这里，避免「删了 A 表忘了 B 表」式泄漏。
    /// 锁逐个获取、各自即刻释放，不嵌套——与文件内其他用法一致，无死锁风险。
    pub fn cleanup_session(&self, id: &str) -> Option<PtySession> {
        if let Ok(mut sb) = self.scrollback.lock() {
            sb.remove(id);
        }
        if let Ok(mut m) = self.metas.lock() {
            m.remove(id);
        }
        self.sessions.lock().ok().and_then(|mut s| s.remove(id))
    }

    /// 由 reader 线程在 EOF 时调用：广播退出并清理该会话（含 sessions，防 PtySession 泄漏）。
    pub fn mark_exit(&self, id: &str) {
        let _ = self.exit_tx.send(id.to_string());
        // PtySession::drop 统一 kill/wait，覆盖 EOF、手动关闭和中途失败路径。
        drop(self.cleanup_session(id));
    }
}

/// 在独立线程里起一个 tokio 运行时跑 axum 服务（不依赖 Tauri 的异步运行时）。
pub fn spawn_server(hub: RemoteHub) {
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                eprintln!("[remote] 运行时启动失败: {e}");
                return;
            }
        };
        rt.block_on(async move {
            let port = hub.port;
            let mut shutdown_rx = hub.shutdown_tx.subscribe();
            let app = Router::new()
                .route("/", get(serve_index))
                .route("/vendor/xterm.css", get(serve_xterm_css))
                .route("/vendor/xterm.js", get(serve_xterm_js))
                .route("/vendor/addon-fit.js", get(serve_fit_js))
                .route("/api/sessions", get(list_sessions))
                .route("/ws", get(ws_handler))
                .with_state(hub);
            match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
                Ok(listener) => {
                    println!("[remote] 手机端服务监听 0.0.0.0:{port}");
                    let serve = axum::serve(listener, app).with_graceful_shutdown(async move {
                        let _ = shutdown_rx.recv().await;
                    });
                    if let Err(e) = serve.await {
                        eprintln!("[remote] 服务退出: {e}");
                    }
                    println!("[remote] 手机端服务已停止");
                }
                Err(e) => eprintln!("[remote] 端口 {port} 绑定失败: {e}"),
            }
        });
    });
}

// ===== 静态资源（编译期嵌入二进制，离线可用，不走 CDN）=====

fn asset(content_type: &'static str, body: &'static str) -> Response {
    ([(header::CONTENT_TYPE, content_type)], body).into_response()
}

async fn serve_index() -> Response {
    // 页面禁缓存：开发期频繁改动，手机浏览器缓存旧版会导致「改了没生效」。
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store, must-revalidate"),
        ],
        include_str!("../mobile/index.html"),
    )
        .into_response()
}
async fn serve_xterm_css() -> Response {
    asset(
        "text/css; charset=utf-8",
        include_str!("../../src/vendor/xterm.css"),
    )
}
async fn serve_xterm_js() -> Response {
    asset(
        "application/javascript; charset=utf-8",
        include_str!("../../src/vendor/xterm.js"),
    )
}
async fn serve_fit_js() -> Response {
    asset(
        "application/javascript; charset=utf-8",
        include_str!("../../src/vendor/addon-fit.js"),
    )
}

// ===== 鉴权 + API =====

fn token_ok(hub: &RemoteHub, q: &HashMap<String, String>) -> bool {
    // 先比对 PIN（定长比较，无论如何都跑完，不泄露时序）。
    let want = hub.token.lock().map(|t| t.clone()).unwrap_or_default();
    let provided = q.get("token").map(|s| s.as_str()).unwrap_or("");
    let matched = !want.is_empty() && constant_time_eq(provided.as_bytes(), want.as_bytes());

    let mut guard = match hub.auth.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };

    // 正确 PIN 永远放行并清零——即便正处于锁定期也不能把合法用户挡在门外。
    // 否则 LAN 上任何人只要持续发错 PIN 就能让合法用户永久登不进来（持续拒绝服务），
    // 手机端拿旧 PIN 的重连循环也会把自己锁死。
    if matched {
        guard.fails = 0;
        guard.locked_until = None;
        return true;
    }

    // 错误 PIN：锁定期内直接拒绝，且不再累加（避免锁定期内的猜测把计数灌大）。
    if let Some(until) = guard.locked_until {
        if Instant::now() < until {
            return false;
        }
        // 锁定期已过：清除锁定但保留 fails，好让下一次失败在既有基础上继续升级退避。
        // （旧实现这里把 fails 清零，导致 extra 恒为 0、翻倍/封顶成了死代码，退避永远只有 30s。）
        guard.locked_until = None;
    }
    guard.fails = guard.fails.saturating_add(1);
    if guard.fails >= MAX_AUTH_FAILS {
        // 每多失败一次翻倍退避，封顶 15 分钟，挡住持续枚举。
        let extra = guard.fails - MAX_AUTH_FAILS;
        let backoff = LOCKOUT_BASE
            .saturating_mul(1u32 << extra.min(5))
            .min(LOCKOUT_CAP);
        guard.locked_until = Some(Instant::now() + backoff);
    }
    false
}

/// 列出当前活跃会话，供手机端选「人物」。需 PIN。
async fn list_sessions(
    State(hub): State<RemoteHub>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !token_ok(&hub, &q) {
        return (StatusCode::UNAUTHORIZED, "PIN 错误").into_response();
    }
    let metas: Vec<SessionMeta> = hub
        .metas
        .lock()
        .map(|m| m.values().cloned().collect())
        .unwrap_or_default();
    axum::Json(metas).into_response()
}

// ===== WebSocket：双向桥接一个会话 =====

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(hub): State<RemoteHub>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !token_ok(&hub, &q) {
        return (StatusCode::UNAUTHORIZED, "PIN 错误").into_response();
    }
    let id = match q.get("id") {
        Some(id) if !id.is_empty() => id.clone(),
        _ => return (StatusCode::BAD_REQUEST, "缺少会话 id").into_response(),
    };
    ws.max_message_size(MAX_WS_MESSAGE_SIZE)
        .max_frame_size(MAX_WS_MESSAGE_SIZE)
        .on_upgrade(move |socket| handle_socket(socket, hub, id))
}

async fn handle_socket(mut socket: WebSocket, hub: RemoteHub, id: String) {
    // 先订阅，再快照滚动缓存——宁可首屏重复一小段，也不丢中间产生的输出。
    let mut out_rx = hub.output_tx.subscribe();
    let mut exit_rx = hub.exit_tx.subscribe();
    let mut shutdown_rx = hub.shutdown_tx.subscribe();

    // 告知手机端 PTY 的真实尺寸：手机按此 cols/rows 镜像渲染（自动缩字号铺满宽度），
    // 不反过来改 PTY，桌面端尺寸不受影响。
    let size = hub
        .sessions
        .lock()
        .ok()
        .and_then(|s| s.get(&id).and_then(|p| p.master.get_size().ok()));
    if let Some(sz) = size {
        let frame = format!(
            "{{\"t\":\"size\",\"cols\":{},\"rows\":{}}}",
            sz.cols, sz.rows
        );
        if socket.send(Message::Text(frame)).await.is_err() {
            return;
        }
    }

    if !send_scrollback(&mut socket, &hub, &id, false).await {
        return;
    }

    loop {
        tokio::select! {
            out = out_rx.recv() => match out {
                Ok(msg) if msg.id == id => {
                    if socket.send(Message::Text(out_frame(&msg.data))).await.is_err() {
                        break;
                    }
                }
                Ok(_) => {}
                // Lagged：客户端跟不上丢了一段——这一段里可能含被切断的转义序列，
                // 光等重绘不一定自愈。重发「整屏复位 + 滚动缓存」让 xterm 状态回到一致。
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    if !send_scrollback(&mut socket, &hub, &id, true).await {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            ex = exit_rx.recv() => match ex {
                Ok(eid) if eid == id => {
                    let _ = socket.send(Message::Text("{\"t\":\"exit\"}".into())).await;
                    break;
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => break,
            },
            inbound = socket.recv() => match inbound {
                Some(Ok(Message::Text(txt))) => handle_client_msg(&hub, &id, &txt).await,
                Some(Ok(Message::Close(_))) | None => break,
                Some(Err(_)) => break,
                _ => {}
            },
            // 桌面端主动 stop()：把这个已经连上的手机会话也一并断开，
            // 不然只关监听端口，已建立的连接会继续用旧 PIN 对应的会话工作。
            _ = shutdown_rx.recv() => {
                let _ = socket.send(Message::Close(None)).await;
                break;
            }
        }
    }
}

fn out_frame(b64: &str) -> String {
    // {"t":"o","d":"<base64>"} —— 手裸拼 JSON，data 是 base64（无需转义）。
    format!("{{\"t\":\"o\",\"d\":\"{b64}\"}}")
}

/// 把会话的滚动缓存作为一个 'o' 帧发给客户端。`reset=true` 时在前面加 `\x1bc`
/// （xterm 整屏复位），用于 Lagged 后清掉残缺状态再重放，避免错乱画面残留。
/// 返回 false 表示 socket 已断，调用方应结束。
async fn send_scrollback(socket: &mut WebSocket, hub: &RemoteHub, id: &str, reset: bool) -> bool {
    let snap = hub
        .scrollback
        .lock()
        .ok()
        .and_then(|sb| sb.get(id).cloned());
    let buf = match snap {
        Some(b) if !b.is_empty() => b,
        _ => return true,
    };
    let payload = if reset {
        let mut v = Vec::with_capacity(buf.len() + 2);
        v.extend_from_slice(b"\x1bc");
        v.extend_from_slice(&buf);
        v
    } else {
        buf
    };
    let d = base64::engine::general_purpose::STANDARD.encode(&payload);
    socket.send(Message::Text(out_frame(&d))).await.is_ok()
}

fn parse_client_input(txt: &str) -> Option<String> {
    if txt.len() > MAX_WS_MESSAGE_SIZE {
        return None;
    }
    let v: serde_json::Value = match serde_json::from_str(txt) {
        Ok(v) => v,
        Err(_) => return None,
    };
    if v.get("t").and_then(|t| t.as_str()) != Some("i") {
        return None;
    }
    let data = v.get("d").and_then(|d| d.as_str())?;
    if data.len() > MAX_TERMINAL_INPUT_SIZE {
        return None;
    }
    Some(data.to_string())
}

/// 处理手机键入。解析/长度校验留在 async 线程，可能阻塞的 PTY 写入移到 blocking 池；
/// 每个 WebSocket 仍串行 await，避免同一客户端无限堆积后台写任务。
async fn handle_client_msg(hub: &RemoteHub, id: &str, txt: &str) {
    let Some(data) = parse_client_input(txt) else {
        return;
    };
    let writer = hub
        .sessions
        .lock()
        .ok()
        .and_then(|s| s.get(id).map(|p| p.writer.clone()));
    if let Some(writer) = writer {
        let _ = tokio::task::spawn_blocking(move || {
            if let Ok(mut w) = writer.lock() {
                let _ = w.write_all(data.as_bytes());
                let _ = w.flush();
            }
        })
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_input_accepts_small_input_only() {
        assert_eq!(
            parse_client_input(r#"{"t":"i","d":"ls\n"}"#).as_deref(),
            Some("ls\n")
        );
        assert_eq!(parse_client_input(r#"{"t":"r","cols":80}"#), None);
        assert_eq!(parse_client_input("not-json"), None);
    }

    #[test]
    fn client_input_rejects_oversized_data() {
        let data = "x".repeat(MAX_TERMINAL_INPUT_SIZE + 1);
        let frame = serde_json::json!({ "t": "i", "d": data }).to_string();
        assert_eq!(parse_client_input(&frame), None);
    }
}
