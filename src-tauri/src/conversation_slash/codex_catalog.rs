//! Read-only Codex discovery. No thread/session/turn is ever created here.

use super::{parse_codex_model_items, parse_codex_models_cache, read_codex_models_cache};
use super::{ConversationEffort, ConversationModel};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};

type Catalog = (Vec<ConversationModel>, Vec<ConversationEffort>);
const CACHE_TTL: Duration = Duration::from_secs(30);
const ERROR_TTL: Duration = Duration::from_secs(2);
const PROBE_TIMEOUT: Duration = Duration::from_secs(12);
const CACHE_WAIT_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_LINE_BYTES: usize = 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 8 * 1024 * 1024;
const MAX_MESSAGES: usize = 128;
const PAGE_SIZE: usize = 20;
const MAX_PAGES: usize = 8;
const MAX_CURSOR_BYTES: usize = 1024;
const MAX_CACHED_PROJECTS: usize = 4;

struct CacheEntry {
    cwd: PathBuf,
    at: Instant,
    result: Result<Catalog, String>,
}

pub(super) fn catalog(cwd: &Path) -> Result<Catalog, String> {
    static CACHE: OnceLock<Mutex<Vec<CacheEntry>>> = OnceLock::new();
    let disk = read_codex_models_cache();
    catalog_with(
        CACHE.get_or_init(|| Mutex::new(Vec::new())),
        cwd,
        disk.as_deref(),
        || {
            let bin = crate::cli_detect::resolve_registered_cli_bin("codex")
                .map_err(|_| "未找到 Codex CLI，请确认已安装后重试".to_string())?;
            let mut command = Command::new(bin);
            command
                .args([
                    "app-server",
                    "--stdio",
                    "-c",
                    crate::codex_chat::NATIVE_PROVIDER_CONFIG,
                ])
                .args([
                    "-c",
                    &format!(
                        "model_provider=\"{}\"",
                        crate::codex_chat::NATIVE_PROVIDER_ID
                    ),
                ])
                .current_dir(cwd);
            crate::proxy_settings::apply_to_std_command(&mut command);
            crate::proxy_settings::apply_codex_system_proxy(&mut command);
            probe(command, PROBE_TIMEOUT)
        },
    )
}

fn catalog_with(
    cache: &Mutex<Vec<CacheEntry>>,
    cwd: &Path,
    disk: Option<&str>,
    discover: impl FnOnce() -> Result<Catalog, String>,
) -> Result<Catalog, String> {
    if let Some(raw) = disk {
        let catalog = parse_codex_models_cache(raw);
        if !catalog.0.is_empty() {
            return Ok(catalog);
        }
    }
    // The lock covers the bounded probe: concurrent model/effort requests share
    // one process, including a short cached failure. Keep a bounded project set.
    let wait_deadline = Instant::now() + CACHE_WAIT_TIMEOUT;
    let mut entries = loop {
        match cache.try_lock() {
            Ok(entries) => break entries,
            Err(std::sync::TryLockError::Poisoned(poisoned)) => break poisoned.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) if Instant::now() < wait_deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(std::sync::TryLockError::WouldBlock) => {
                return Err("Codex 模型查询繁忙，请稍后重试".into());
            }
        }
    };
    entries.retain(|entry| {
        entry.at.elapsed()
            < if entry.result.is_ok() {
                CACHE_TTL
            } else {
                ERROR_TTL
            }
    });
    if let Some(entry) = entries.iter().find(|entry| entry.cwd == cwd) {
        return entry.result.clone();
    }
    let result = discover().and_then(|catalog| {
        if catalog.0.is_empty() {
            Err("Codex 未返回可选模型，请检查 CLI 登录与配置后重试".to_string())
        } else {
            Ok(catalog)
        }
    });
    if entries.len() >= MAX_CACHED_PROJECTS {
        entries.remove(0);
    }
    entries.push(CacheEntry {
        cwd: cwd.to_path_buf(),
        at: Instant::now(),
        result: result.clone(),
    });
    result
}

struct ProbeChild {
    child: Child,
    tree: crate::codex_chat::ProcessTreeGuard,
}

impl Drop for ProbeChild {
    fn drop(&mut self) {
        self.tree.terminate();
        crate::codex_chat::stop_child(&mut self.child, false);
    }
}

fn probe(mut command: Command, timeout: Duration) -> Result<Catalog, String> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "无法启动 Codex 模型查询，请检查 CLI 安装与配置".to_string())?;
    let tree = match crate::codex_chat::register_process_tree(&child) {
        Ok(tree) => tree,
        Err(_) => {
            crate::codex_chat::stop_child(&mut child, false);
            return Err("无法安全启动 Codex 模型查询".to_string());
        }
    };
    let mut owned = ProbeChild { child, tree };
    let stdin = owned.child.stdin.take().ok_or("无法写入 Codex 模型查询")?;
    let stdout = owned.child.stdout.take().ok_or("无法读取 Codex 模型查询")?;
    let (tx, rx) = mpsc::sync_channel(1);
    // Both pipe writes and reads live behind the same wall-clock deadline.
    // Cleanup kills the entire tree even when a descendant retains the pipes;
    // never join a blocked reader on the caller's timeout path.
    std::thread::Builder::new()
        .name("codex-model-catalog".into())
        .spawn(move || {
            let result = discover_protocol(stdin, BufReader::new(stdout));
            let _ = tx.send(result);
        })
        .map_err(|_| "无法启动 Codex 模型查询读取器".to_string())?;
    rx.recv_timeout(timeout).map_err(|error| match error {
        mpsc::RecvTimeoutError::Timeout => {
            "Codex 模型查询超时，请检查 CLI 登录与网络后重试".to_string()
        }
        mpsc::RecvTimeoutError::Disconnected => "Codex 模型查询意外中断，请重试".to_string(),
    })?
}

#[derive(Default)]
struct ReadBudget {
    bytes: usize,
    messages: usize,
}

fn read_line(reader: &mut impl BufRead, budget: &mut ReadBudget) -> Result<String, String> {
    let mut line = Vec::new();
    loop {
        let available = reader
            .fill_buf()
            .map_err(|_| "无法读取 Codex 模型查询响应")?;
        if available.is_empty() {
            return Err("Codex 模型查询服务提前退出，请检查 CLI 登录与配置后重试".into());
        }
        let length = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |position| position + 1);
        if line.len().saturating_add(length) > MAX_LINE_BYTES
            || budget.bytes.saturating_add(length) > MAX_TOTAL_BYTES
        {
            return Err("Codex 模型查询响应超过大小限制".into());
        }
        let complete = available[length - 1] == b'\n';
        line.extend_from_slice(&available[..length]);
        budget.bytes += length;
        reader.consume(length);
        if complete {
            budget.messages += 1;
            if budget.messages > MAX_MESSAGES {
                return Err("Codex 模型查询响应过多".into());
            }
            return String::from_utf8(line).map_err(|_| "Codex 模型查询响应编码无效".into());
        }
    }
}

fn response(reader: &mut impl BufRead, budget: &mut ReadBudget, id: u64) -> Result<Value, String> {
    loop {
        let line = read_line(reader, budget)?;
        if line.trim().is_empty() {
            continue;
        }
        let message: Value =
            serde_json::from_str(&line).map_err(|_| "Codex 模型查询返回了无效 JSON".to_string())?;
        if message.get("method").is_some() && message.get("id").is_some() {
            return Err("Codex 模型查询请求了不支持的交互".into());
        }
        if message.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        // Never expose raw error messages: a custom provider can put secrets,
        // URLs, auth values, or arbitrary configuration into protocol errors.
        if message.get("error").is_some() {
            return Err("Codex 模型查询失败，请检查 CLI 登录与配置后重试".into());
        }
        return message
            .get("result")
            .filter(|result| result.is_object())
            .cloned()
            .ok_or_else(|| "Codex 模型查询响应缺少结果".into());
    }
}

fn send(writer: &mut impl Write, value: Value) -> Result<(), String> {
    writeln!(writer, "{value}")
        .and_then(|()| writer.flush())
        .map_err(|_| "无法写入 Codex 模型查询请求".into())
}

fn discover_protocol(mut writer: impl Write, mut reader: impl BufRead) -> Result<Catalog, String> {
    let mut budget = ReadBudget::default();
    send(
        &mut writer,
        json!({"method":"initialize", "id":1, "params":{
            "clientInfo":{"name":"roster", "title":"Roster", "version":env!("CARGO_PKG_VERSION")}
        }}),
    )?;
    response(&mut reader, &mut budget, 1)?;
    send(&mut writer, json!({"method":"initialized", "params":{}}))?;
    let mut items = Vec::new();
    let mut cursor = None;
    let mut cursors = HashSet::new();
    for page in 0..MAX_PAGES {
        let id = page as u64 + 2;
        let mut params = json!({"limit":PAGE_SIZE, "includeHidden":false});
        if let Some(cursor) = cursor.take() {
            params["cursor"] = Value::String(cursor);
        }
        send(
            &mut writer,
            json!({"method":"model/list", "id":id, "params":params}),
        )?;
        let result = response(&mut reader, &mut budget, id)?;
        let data = result
            .get("data")
            .and_then(Value::as_array)
            .ok_or("Codex 模型查询返回了无效模型列表")?;
        if items.len().saturating_add(data.len()) > PAGE_SIZE * MAX_PAGES {
            return Err("Codex 模型查询返回的模型过多".into());
        }
        items.extend(data.iter().cloned());
        match result.get("nextCursor") {
            None | Some(Value::Null) => return Ok(parse_codex_model_items(&items)),
            Some(Value::String(next)) if !next.is_empty() && next.len() <= MAX_CURSOR_BYTES => {
                if !cursors.insert(next.clone()) {
                    return Err("Codex 模型查询分页游标重复".into());
                }
                cursor = Some(next.clone());
            }
            _ => return Err("Codex 模型查询返回了无效分页游标".into()),
        }
    }
    Err("Codex 模型查询超过分页限制".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};

    fn model() -> Value {
        json!({"id":"display-alias", "model":"dynamic-model", "displayName":"Dynamic Model",
            "isDefault":true, "defaultReasoningEffort":"high",
            "supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"high"}],
            "privateInstructions":"must never leave the backend"})
    }

    fn one_catalog() -> Catalog {
        parse_codex_model_items(&[model()])
    }

    fn protocol(messages: Vec<Value>) -> (Result<Catalog, String>, Vec<Value>) {
        let input = messages
            .into_iter()
            .map(|value| format!("{value}\n"))
            .collect::<String>();
        let mut output = Vec::new();
        let result = discover_protocol(&mut output, Cursor::new(input));
        let sent = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        (result, sent)
    }

    #[test]
    fn protocol_lists_only_models_and_preserves_dynamic_effort_defaults() {
        let (result, sent) = protocol(vec![
            json!({"id":1,"result":{}}),
            json!({"id":2,"result":{"data":[model(),{"model":"hidden-model","hidden":true,
                "supportedReasoningEfforts":[{"reasoningEffort":"secret"}]}],"nextCursor":"page-2"}}),
            json!({"id":3,"result":{"data":[{"id":"older-model","displayName":"Older",
                "supportedReasoningEfforts":[{"reasoningEffort":"future"}]}],"nextCursor":null}}),
        ]);
        let (models, efforts) = result.unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "dynamic-model");
        assert_eq!(models[0].efforts, ["low", "high"]);
        assert!(models[0].current);
        assert!(efforts
            .iter()
            .any(|effort| effort.id == "high" && effort.current));
        assert!(efforts.iter().any(|effort| effort.id == "future"));
        assert!(!efforts.iter().any(|effort| effort.id == "secret"));
        assert!(!serde_json::to_string(&models)
            .unwrap()
            .contains("privateInstructions"));
        assert_eq!(
            sent.iter()
                .map(|value| value["method"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["initialize", "initialized", "model/list", "model/list"]
        );
        assert_eq!(sent[2]["params"], json!({"limit":20,"includeHidden":false}));
        assert_eq!(sent[3]["params"]["cursor"], "page-2");
    }

    #[test]
    fn missing_bad_and_empty_disk_caches_fall_back_but_valid_cache_stays_fast() {
        for disk in [
            None,
            Some("not-json"),
            Some(r#"{"models":[]}"#),
            Some(r#"{"models":[{"slug":"hidden","visibility":"hide"}]}"#),
        ] {
            let cache = Mutex::new(Vec::new());
            let count = AtomicUsize::new(0);
            let result = catalog_with(&cache, Path::new("project"), disk, || {
                count.fetch_add(1, Ordering::SeqCst);
                Ok(one_catalog())
            })
            .unwrap();
            assert_eq!(result.0[0].id, "dynamic-model");
            assert_eq!(count.load(Ordering::SeqCst), 1);
        }
        let result = catalog_with(
            &Mutex::new(Vec::new()),
            Path::new("project"),
            Some(r#"{"models":[{"slug":"cached-model"}]}"#),
            || panic!("cache must avoid process startup"),
        )
        .unwrap();
        assert_eq!(result.0[0].id, "cached-model");
    }

    #[test]
    fn simultaneous_model_and_effort_requests_share_success_and_failure() {
        for fail in [false, true] {
            let cache = Arc::new(Mutex::new(Vec::new()));
            let count = Arc::new(AtomicUsize::new(0));
            let barrier = Arc::new(Barrier::new(3));
            let workers = (0..2)
                .map(|_| {
                    let (cache, count, barrier) = (cache.clone(), count.clone(), barrier.clone());
                    std::thread::spawn(move || {
                        barrier.wait();
                        catalog_with(&cache, Path::new("project"), None, || {
                            count.fetch_add(1, Ordering::SeqCst);
                            std::thread::sleep(Duration::from_millis(20));
                            if fail {
                                Err("fixture failure".into())
                            } else {
                                Ok(one_catalog())
                            }
                        })
                    })
                })
                .collect::<Vec<_>>();
            barrier.wait();
            for worker in workers {
                assert_eq!(worker.join().unwrap().is_err(), fail);
            }
            assert_eq!(count.load(Ordering::SeqCst), 1);
        }
    }

    #[test]
    fn failure_cache_expires_and_empty_live_catalog_is_an_explicit_error() {
        let cache = Mutex::new(Vec::new());
        assert!(catalog_with(&cache, Path::new("project"), None, || Ok((
            Vec::new(),
            Vec::new()
        )))
        .is_err());
        cache.lock().unwrap()[0].at = Instant::now() - ERROR_TTL;
        assert!(catalog_with(&cache, Path::new("project"), None, || Ok(one_catalog())).is_ok());
        // Projects can load different local CLI configuration.
        assert!(catalog_with(&cache, Path::new("other"), None, || Err(
            "other config".into()
        ))
        .is_err());
    }

    #[test]
    fn protocol_rejects_bad_pages_interactions_and_redacts_provider_errors() {
        for result in [
            json!({}),
            json!({"data":[],"nextCursor":5}),
            json!({"data":[],"nextCursor":"x".repeat(MAX_CURSOR_BYTES + 1)}),
            json!({"data":vec![model(); PAGE_SIZE * MAX_PAGES + 1]}),
        ] {
            assert!(protocol(vec![
                json!({"id":1,"result":{}}),
                json!({"id":2,"result":result})
            ])
            .0
            .is_err());
        }
        let error = protocol(vec![json!({"id":1,"error":{"message":"auth-secret"}})])
            .0
            .unwrap_err();
        assert!(!error.contains("auth-secret"));
        assert!(
            protocol(vec![json!({"id":1,"method":"execute/tool","params":{}})])
                .0
                .is_err()
        );
        let mut pages = vec![json!({"id":1,"result":{}})];
        for page in 0..MAX_PAGES {
            pages.push(
                json!({"id":page+2,"result":{"data":[],"nextCursor":format!("page-{page}")}}),
            );
        }
        assert!(protocol(pages).0.unwrap_err().contains("分页限制"));
        assert!(protocol(vec![
            json!({"id":1,"result":{}}),
            json!({"id":2,"result":{"data":[],"nextCursor":"same"}}),
            json!({"id":3,"result":{"data":[],"nextCursor":"same"}})
        ])
        .0
        .unwrap_err()
        .contains("游标重复"));
    }

    #[test]
    fn protocol_reader_bounds_lines_total_bytes_and_notifications() {
        assert!(read_line(
            &mut Cursor::new(vec![b'x'; MAX_LINE_BYTES + 1]),
            &mut ReadBudget::default()
        )
        .is_err());
        assert!(read_line(
            &mut Cursor::new("ok\n"),
            &mut ReadBudget {
                bytes: MAX_TOTAL_BYTES - 1,
                messages: 0
            }
        )
        .is_err());
        let input = "{}\n".repeat(MAX_MESSAGES + 1);
        assert!(
            response(&mut Cursor::new(input), &mut ReadBudget::default(), 1)
                .unwrap_err()
                .contains("过多")
        );
    }

    #[cfg(unix)]
    fn fake_command(dir: &Path, action: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                &format!(
                    r#"
            printf '%s\n' "$$" > "$FIXTURE_DIR/leader.pid"
            sleep 30 &
            printf '%s\n' "$!" > "$FIXTURE_DIR/child.pid"
            {action}
        "#
                ),
            ])
            .env("FIXTURE_DIR", dir);
        command
    }

    #[cfg(unix)]
    fn assert_reaped(dir: &Path) {
        for name in ["leader.pid", "child.pid"] {
            let pid = std::fs::read_to_string(dir.join(name))
                .unwrap()
                .trim()
                .parse::<i32>()
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(1);
            while unsafe { libc::kill(pid, 0) } == 0 && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "{name} must be reaped");
        }
    }

    #[cfg(unix)]
    #[test]
    fn probe_reaps_descendants_on_success_timeout_and_oversized_output() {
        for (action, expected) in [
            (
                r#"printf '%s\n' '{"id":1,"result":{}}' '{"id":2,"result":{"data":[{"model":"fake-model"}],"nextCursor":null}}'; wait"#,
                "success",
            ),
            ("wait", "超时"),
            ("head -c 2097152 /dev/zero", "大小限制"),
            (
                r#"printf '%s\n' '{"id":1,"error":{"message":"private fixture"}}'; wait"#,
                "查询失败",
            ),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let started = Instant::now();
            let result = probe(fake_command(dir.path(), action), Duration::from_millis(500));
            if expected == "success" {
                assert_eq!(result.unwrap().0[0].id, "fake-model");
            } else {
                assert!(result.unwrap_err().contains(expected));
            }
            assert!(started.elapsed() < Duration::from_secs(3));
            assert_reaped(dir.path());
        }
    }

    #[test]
    #[ignore = "只读人工验收：需要本机已安装并登录 Codex，不创建会话"]
    fn installed_codex_model_list_smoke() {
        let cwd = std::env::current_dir().unwrap();
        let (models, efforts) = catalog(&cwd).unwrap();
        assert!(!models.is_empty());
        eprintln!(
            "Codex model/list：{} 个模型，{} 档推理强度",
            models.len(),
            efforts.len()
        );
    }
}
