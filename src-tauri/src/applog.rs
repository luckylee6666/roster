//! 极简文件日志：追加到
//! `~/.vibe-coding-manage/logs/app.log`。
//!
//! 设计取舍：不引 tracing/log 等框架（工具体量小、保持少依赖）。零额外依赖，
//! 仅用已有的 chrono/dirs。超过 ~1MB 滚动一份（app.log → app.log.1，只留两份）。
//! 线程安全：全局 Mutex 串行写。同时回显 stderr，dev 模式终端可见。
//!
//! 安全红线：**绝不记录 token / 凭据 / 密码**。只记错误类型、HTTP 码、
//! 响应片段、生命周期事件等排查信息。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

/// 超过此大小滚动一次。
const MAX_BYTES: u64 = 1_000_000;

/// 串行化写入，避免多线程交错。
static WRITE_LOCK: Mutex<()> = Mutex::new(());

pub fn log_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".vibe-coding-manage")
        .join("logs")
}

pub fn log_path() -> PathBuf {
    log_dir().join("app.log")
}

fn write(level: &str, msg: &str) {
    // 锁中毒也要能继续写日志，绝不因日志本身 panic。
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());

    let dir = log_dir();
    let _ = fs::create_dir_all(&dir);
    let path = log_path();

    // 体积滚动：旧 .1 直接覆盖，只留两份。
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > MAX_BYTES {
            let _ = fs::rename(&path, dir.join("app.log.1"));
        }
    }

    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    // 单行化，避免多行消息打乱逐行日志。
    let one = msg.replace('\n', " ⏎ ");

    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "[{ts}] [{level}] {one}");
    }
    eprintln!("[{level}] {msg}");
}

pub fn info(msg: &str) {
    write("INFO", msg);
}
pub fn warn(msg: &str) {
    write("WARN", msg);
}
pub fn error(msg: &str) {
    write("ERROR", msg);
}

/// format! 风格的便捷宏：`log_info!("x={}", x)`。经 #[macro_export] 全 crate 可用。
#[macro_export]
macro_rules! log_info {
    ($($a:tt)*) => { $crate::applog::info(&format!($($a)*)) };
}
#[macro_export]
macro_rules! log_warn {
    ($($a:tt)*) => { $crate::applog::warn(&format!($($a)*)) };
}
#[macro_export]
macro_rules! log_error {
    ($($a:tt)*) => { $crate::applog::error(&format!($($a)*)) };
}
