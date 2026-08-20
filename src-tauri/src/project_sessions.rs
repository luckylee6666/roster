use crate::project_memory::encode_claude_project_dir;
use serde::Serialize;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_SESSIONS_PER_TOOL: usize = 12;
const CLAUDE_TITLE_READ_LIMIT: u64 = 96 * 1024;
const PREVIEW_LIST_LIMIT: usize = 80;
const PREVIEW_BODY_LIMIT: usize = 2400;
const PREVIEW_FILE_READ_LIMIT: u64 = 128 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectHistorySession {
    pub id: String,
    pub tool: String,
    pub title: String,
    pub preview: String,
    pub at_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectHistoryPreview {
    pub id: String,
    pub tool: String,
    pub title: String,
    pub at_ms: u64,
    pub body: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectHistoryGroup {
    pub tool: String,
    pub label: String,
    pub sessions: Vec<ProjectHistorySession>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectHistory {
    pub groups: Vec<ProjectHistoryGroup>,
}

pub fn encode_grok_cwd(cwd: &str) -> String {
    let mut out = String::with_capacity(cwd.len() * 3);
    for byte in cwd.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn parse_rfc3339_ms(value: &str) -> Option<u64> {
    chrono::DateTime::parse_from_rfc3339(value.trim())
        .ok()
        .map(|time| time.timestamp_millis().max(0) as u64)
}

fn preview_excerpt(text: &str, limit: usize) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return String::new();
    }
    if collapsed.chars().count() <= limit {
        collapsed
    } else {
        format!("{}…", collapsed.chars().take(limit).collect::<String>())
    }
}

fn preview_title(text: &str) -> String {
    let excerpt = preview_excerpt(text, 36);
    if excerpt.is_empty() {
        "未命名会话".into()
    } else {
        excerpt
    }
}

fn history_session(id: impl Into<String>, tool: &str, raw: &str, at_ms: u64) -> ProjectHistorySession {
    ProjectHistorySession {
        id: id.into(),
        tool: tool.into(),
        title: preview_title(raw),
        preview: preview_excerpt(raw, PREVIEW_LIST_LIMIT),
        at_ms,
    }
}

fn preview_body(parts: &[String]) -> String {
    preview_excerpt(&parts.join("\n\n"), PREVIEW_BODY_LIMIT)
}

fn user_text_from_claude_message(value: &serde_json::Value) -> Option<String> {
    let content = value.get("message")?.get("content")?;
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    let mut parts = Vec::new();
    for item in content.as_array()? {
        if item.get("type").and_then(|value| value.as_str()) == Some("text") {
            if let Some(text) = item.get("text").and_then(|value| value.as_str()) {
                parts.push(text);
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" "))
    }
}

fn is_noise_user_text(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.is_empty()
        || trimmed.starts_with("<command-name>")
        || trimmed.starts_with("<command-message>")
        || trimmed.starts_with("<local-command")
}

fn claude_jsonl_cwd(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    for _ in 0..8 {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 {
            break;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim_end()) else {
            continue;
        };
        if let Some(session_cwd) = value.get("cwd").and_then(|item| item.as_str()) {
            if !session_cwd.trim().is_empty() {
                return Some(session_cwd.to_string());
            }
        }
    }
    None
}

fn claude_file_matches_cwd(path: &Path, cwd: &str, allow_missing: bool) -> bool {
    match claude_jsonl_cwd(path) {
        Some(session_cwd) => same_project_cwd(&session_cwd, cwd),
        None => allow_missing,
    }
}

fn is_encoded_claude_dir(dir: &Path, cwd: &str) -> bool {
    dir.file_name().and_then(|name| name.to_str()) == Some(encode_claude_project_dir(cwd).as_str())
}

fn dir_has_matching_claude_cwd(dir: &Path, cwd: &str) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let path = entry.path();
        path.extension().and_then(|ext| ext.to_str()) == Some("jsonl")
            && claude_file_matches_cwd(&path, cwd, false)
    })
}

fn claude_session_from_jsonl(path: &Path, cwd: &str, allow_missing_cwd: bool) -> Option<ProjectHistorySession> {
    if !claude_file_matches_cwd(path, cwd, allow_missing_cwd) {
        return None;
    }
    let id = path.file_stem()?.to_str()?.to_string();
    if id.is_empty() {
        return None;
    }
    let mut file = fs::File::open(path).ok()?;
    let mut buf = String::new();
    let _ = file
        .by_ref()
        .take(CLAUDE_TITLE_READ_LIMIT)
        .read_to_string(&mut buf);
    if buf.is_empty() {
        file.seek(SeekFrom::Start(0)).ok()?;
        let _ = file.take(8 * 1024).read_to_string(&mut buf);
    }
    let mut raw_title = String::new();
    for line in buf.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("type").and_then(|value| value.as_str()) != Some("user") {
            continue;
        }
        if value.get("isSidechain").and_then(|value| value.as_bool()) == Some(true) {
            continue;
        }
        let Some(text) = user_text_from_claude_message(&value) else {
            continue;
        };
        if is_noise_user_text(&text) {
            continue;
        }
        raw_title = text;
        break;
    }
    let at_ms = path
        .metadata()
        .and_then(|meta| meta.modified())
        .map(millis)
        .unwrap_or(0);
    Some(history_session(id, "claude", &raw_title, at_ms))
}

fn find_claude_project_dir(home: &Path, cwd: &str) -> Option<PathBuf> {
    let projects = home.join(".claude").join("projects");
    let encoded = projects.join(encode_claude_project_dir(cwd));
    if encoded.is_dir() && (dir_has_matching_claude_cwd(&encoded, cwd) || is_encoded_claude_dir(&encoded, cwd)) {
        return Some(encoded);
    }
    for entry in fs::read_dir(&projects).ok()?.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if dir_has_matching_claude_cwd(&path, cwd) {
            return Some(path);
        }
    }
    None
}

fn list_claude_sessions(home: &Path, cwd: &str) -> Vec<ProjectHistorySession> {
    let Some(dir) = find_claude_project_dir(home, cwd) else {
        return Vec::new();
    };
    let allow_missing = is_encoded_claude_dir(&dir, cwd);
    let mut sessions = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return sessions,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        if let Some(session) = claude_session_from_jsonl(&path, cwd, allow_missing) {
            sessions.push(session);
        }
    }
    sessions.sort_by_key(|session| std::cmp::Reverse(session.at_ms));
    sessions.truncate(MAX_SESSIONS_PER_TOOL);
    sessions
}

fn grok_home(home: &Path) -> PathBuf {
    std::env::var_os("GROK_HOME")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| home.join(".grok"))
}

fn find_grok_session_group(home: &Path, cwd: &str) -> Option<PathBuf> {
    let root = grok_home(home).join("sessions");
    let encoded = root.join(encode_grok_cwd(cwd));
    if encoded.is_dir() {
        return Some(encoded);
    }
    for entry in fs::read_dir(&root).ok()?.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if let Ok(text) = fs::read_to_string(path.join(".cwd")) {
            if text.trim() == cwd {
                return Some(path);
            }
        }
    }
    None
}

fn grok_session_from_dir(path: &Path) -> Option<ProjectHistorySession> {
    let id = path.file_name()?.to_str()?.to_string();
    if id.is_empty() || id.starts_with('.') {
        return None;
    }
    let summary_path = path.join("summary.json");
    if !summary_path.is_file() {
        return None;
    }
    let summary: serde_json::Value = serde_json::from_str(&fs::read_to_string(summary_path).ok()?).ok()?;
    if summary.get("session_kind").and_then(|value| value.as_str()) == Some("subagent") {
        return None;
    }
    let raw_title = summary
        .get("generated_title")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            summary
                .get("session_summary")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
        })
        .map(str::to_string)
        .unwrap_or_else(|| id.clone());
    let preview_source = summary
        .get("session_summary")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(raw_title.as_str());
    let at_ms = ["last_active_at", "updated_at", "created_at"]
        .iter()
        .find_map(|key| summary.get(*key).and_then(|value| value.as_str()).and_then(parse_rfc3339_ms))
        .or_else(|| path.metadata().and_then(|meta| meta.modified()).ok().map(millis))
        .unwrap_or(0);
    let mut session = history_session(id, "grok", &raw_title, at_ms);
    if !preview_source.is_empty() {
        session.preview = preview_excerpt(preview_source, PREVIEW_LIST_LIMIT);
    }
    Some(session)
}

fn list_grok_sessions(home: &Path, cwd: &str) -> Vec<ProjectHistorySession> {
    let Some(dir) = find_grok_session_group(home, cwd) else {
        return Vec::new();
    };
    let mut sessions = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return sessions,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if let Some(session) = grok_session_from_dir(&path) {
            sessions.push(session);
        }
    }
    sessions.sort_by_key(|session| std::cmp::Reverse(session.at_ms));
    sessions.truncate(MAX_SESSIONS_PER_TOOL);
    sessions
}

const CODEX_SCAN_LIMIT: usize = 600;

fn sorted_named_dirs(dir: &Path) -> Vec<PathBuf> {
    let mut dirs = fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    dirs.sort();
    dirs
}

fn same_project_cwd(left: &str, right: &str) -> bool {
    crate::project_memory::normalize_project_cwd(left)
        == crate::project_memory::normalize_project_cwd(right)
}

fn is_codex_subagent(payload: &serde_json::Value) -> bool {
    payload.get("thread_source").and_then(|value| value.as_str()) == Some("subagent")
        || payload.get("source").and_then(|value| value.get("subagent")).is_some()
}

fn is_noise_codex_text(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.is_empty()
        || trimmed.starts_with('<')
        || trimmed.starts_with("# AGENTS.md")
        || trimmed.starts_with("# CLAUDE.md")
}

fn first_codex_user_text(buf: &str) -> String {
    for line in buf.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("type").and_then(|value| value.as_str()) != Some("response_item") {
            continue;
        }
        let Some(payload) = value.get("payload") else { continue };
        if payload.get("type").and_then(|value| value.as_str()) != Some("message") {
            continue;
        }
        if payload.get("role").and_then(|value| value.as_str()) != Some("user") {
            continue;
        }
        for item in payload.get("content").and_then(|value| value.as_array()).into_iter().flatten() {
            if item.get("type").and_then(|value| value.as_str()) != Some("input_text") {
                continue;
            }
            let Some(text) = item.get("text").and_then(|value| value.as_str()) else {
                continue;
            };
            if is_noise_codex_text(text) {
                continue;
            }
            return text.to_string();
        }
    }
    String::new()
}

fn read_lossy_prefix(reader: &mut impl Read, limit: u64) -> String {
    let mut bytes = Vec::new();
    let _ = reader.take(limit).read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).into_owned()
}

fn codex_session_from_jsonl(path: &Path, cwd: &str) -> Option<ProjectHistorySession> {
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut first = String::new();
    reader.read_line(&mut first).ok()?;
    let value: serde_json::Value = serde_json::from_str(first.trim_end()).ok()?;
    if value.get("type").and_then(|value| value.as_str()) != Some("session_meta") {
        return None;
    }
    let payload = value.get("payload")?;
    if is_codex_subagent(payload) {
        return None;
    }
    let session_cwd = payload.get("cwd").and_then(|value| value.as_str())?;
    if !same_project_cwd(session_cwd, cwd) {
        return None;
    }
    let id = payload
        .get("session_id")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())?
        .to_string();
    let at_ms = payload
        .get("timestamp")
        .and_then(|value| value.as_str())
        .and_then(parse_rfc3339_ms)
        .or_else(|| path.metadata().and_then(|meta| meta.modified()).ok().map(millis))
        .unwrap_or(0);
    Some(history_session(
        id,
        "codex",
        &first_codex_user_text(&read_lossy_prefix(&mut reader, 64 * 1024)),
        at_ms,
    ))
}

fn list_codex_sessions(home: &Path, cwd: &str) -> Vec<ProjectHistorySession> {
    let root = home.join(".codex").join("sessions");
    let mut sessions = Vec::new();
    let mut scanned = 0;
    for year in sorted_named_dirs(&root).into_iter().rev() {
        for month in sorted_named_dirs(&year).into_iter().rev() {
            for day in sorted_named_dirs(&month).into_iter().rev() {
                let mut files = fs::read_dir(&day)
                    .ok()
                    .into_iter()
                    .flatten()
                    .flatten()
                    .map(|entry| entry.path())
                    .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
                    .collect::<Vec<_>>();
                files.sort();
                for file in files.into_iter().rev() {
                    scanned += 1;
                    if scanned > CODEX_SCAN_LIMIT {
                        return finalize_sessions(sessions);
                    }
                    if let Some(session) = codex_session_from_jsonl(&file, cwd) {
                        sessions.push(session);
                        if sessions.len() >= MAX_SESSIONS_PER_TOOL {
                            return finalize_sessions(sessions);
                        }
                    }
                }
            }
        }
    }
    finalize_sessions(sessions)
}

fn finalize_sessions(mut sessions: Vec<ProjectHistorySession>) -> Vec<ProjectHistorySession> {
    sessions.sort_by_key(|session: &ProjectHistorySession| std::cmp::Reverse(session.at_ms));
    sessions.truncate(MAX_SESSIONS_PER_TOOL);
    sessions
}

fn opencode_db_paths(home: &Path) -> Vec<PathBuf> {
    let mut paths = vec![home.join(".local/share/opencode/opencode.db")];
    if let Some(dir) = dirs::data_dir() {
        paths.push(dir.join("opencode").join("opencode.db"));
    }
    if let Some(dir) = dirs::data_local_dir() {
        paths.push(dir.join("opencode").join("opencode.db"));
    }
    paths
}

fn list_opencode_sessions_from_db(db_path: &Path, cwd: &str) -> Vec<ProjectHistorySession> {
    let Ok(connection) = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) else {
        return Vec::new();
    };
    let normalized = crate::project_memory::normalize_project_cwd(cwd);
    if normalized.is_empty() {
        return Vec::new();
    }
    let slash = format!("{normalized}/");
    let backslash = format!("{normalized}\\");
    let Ok(mut statement) = connection.prepare(
        "SELECT id, title, time_updated, directory
         FROM session
         WHERE (parent_id IS NULL OR parent_id = '')
           AND directory IN (?1, ?2, ?3)
         ORDER BY time_updated DESC
         LIMIT ?4",
    ) else {
        return Vec::new();
    };
    let rows = statement.query_map(
        rusqlite::params![normalized, slash, backslash, MAX_SESSIONS_PER_TOOL as i64],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        },
    );
    let Ok(rows) = rows else {
        return Vec::new();
    };
    let mut sessions = Vec::new();
    for row in rows.flatten() {
        let (id, title, time_updated, directory) = row;
        if !same_project_cwd(&directory, cwd) {
            continue;
        }
        sessions.push(history_session(
            id,
            "opencode",
            &title,
            time_updated.max(0) as u64,
        ));
        if sessions.len() >= MAX_SESSIONS_PER_TOOL {
            break;
        }
    }
    sessions
}

fn list_opencode_sessions(home: &Path, cwd: &str) -> Vec<ProjectHistorySession> {
    for path in opencode_db_paths(home) {
        if path.is_file() {
            let sessions = list_opencode_sessions_from_db(&path, cwd);
            if !sessions.is_empty() || path.exists() {
                return sessions;
            }
        }
    }
    Vec::new()
}

fn mimo_db_paths(home: &Path) -> Vec<PathBuf> {
    let mut paths = vec![home.join(".local/share/mimocode/mimocode.db")];
    if let Some(dir) = dirs::data_dir() {
        paths.push(dir.join("mimocode").join("mimocode.db"));
    }
    if let Some(dir) = dirs::data_local_dir() {
        paths.push(dir.join("mimocode").join("mimocode.db"));
    }
    paths
}

fn list_mimo_sessions_from_db(db_path: &Path, cwd: &str) -> Vec<ProjectHistorySession> {
    let Ok(connection) = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) else {
        return Vec::new();
    };
    let normalized = crate::project_memory::normalize_project_cwd(cwd);
    if normalized.is_empty() {
        return Vec::new();
    }
    let slash = format!("{normalized}/");
    let backslash = format!("{normalized}\\");
    let Ok(mut statement) = connection.prepare(
        "SELECT id, title, time_updated, directory
         FROM session
         WHERE (parent_id IS NULL OR parent_id = '')
           AND directory IN (?1, ?2, ?3)
         ORDER BY time_updated DESC
         LIMIT ?4",
    ) else {
        return Vec::new();
    };
    let rows = statement.query_map(
        rusqlite::params![normalized, slash, backslash, MAX_SESSIONS_PER_TOOL as i64],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        },
    );
    let Ok(rows) = rows else {
        return Vec::new();
    };
    let mut sessions = Vec::new();
    for row in rows.flatten() {
        let (id, title, time_updated, directory) = row;
        if !same_project_cwd(&directory, cwd) {
            continue;
        }
        sessions.push(history_session(
            id,
            "mimo",
            &title,
            time_updated.max(0) as u64,
        ));
        if sessions.len() >= MAX_SESSIONS_PER_TOOL {
            break;
        }
    }
    sessions
}

fn list_mimo_sessions(home: &Path, cwd: &str) -> Vec<ProjectHistorySession> {
    for path in mimo_db_paths(home) {
        if path.is_file() {
            let sessions = list_mimo_sessions_from_db(&path, cwd);
            if !sessions.is_empty() || path.exists() {
                return sessions;
            }
        }
    }
    Vec::new()
}

fn gemini_first_user_text(value: &serde_json::Value) -> String {
    for message in value.get("messages").and_then(|value| value.as_array()).into_iter().flatten() {
        if message.get("type").and_then(|value| value.as_str()) != Some("user") {
            continue;
        }
        let content = message.get("content");
        if let Some(text) = content.and_then(|value| value.as_str()) {
            if !text.trim().is_empty() {
                return text.to_string();
            }
        }
        for item in content.and_then(|value| value.as_array()).into_iter().flatten() {
            if let Some(text) = item.get("text").and_then(|value| value.as_str()) {
                if !text.trim().is_empty() {
                    return text.to_string();
                }
            }
        }
    }
    String::new()
}

fn gemini_session_from_file(path: &Path) -> Option<ProjectHistorySession> {
    let raw = fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(raw.trim())
        .ok()
        .or_else(|| raw.lines().next().and_then(|line| serde_json::from_str(line).ok()))?;
    let at_ms = ["lastUpdated", "startTime"]
        .iter()
        .find_map(|key| value.get(*key).and_then(|item| item.as_str()).and_then(parse_rfc3339_ms))
        .or_else(|| path.metadata().and_then(|meta| meta.modified()).ok().map(millis))
        .unwrap_or(0);
    Some(history_session(
        path.to_string_lossy().into_owned(),
        "gemini",
        &gemini_first_user_text(&value),
        at_ms,
    ))
}

fn gemini_project_chat_dirs(home: &Path, cwd: &str) -> Vec<PathBuf> {
    let tmp = home.join(".gemini").join("tmp");
    let mut dirs = Vec::new();
    if let Ok(text) = fs::read_to_string(home.join(".gemini").join("projects.json")) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(slug) = value
                .get("projects")
                .and_then(|projects| projects.get(cwd))
                .and_then(|item| item.as_str())
            {
                let chats = tmp.join(slug).join("chats");
                if chats.is_dir() {
                    dirs.push(chats);
                }
            }
        }
    }
    if let Ok(entries) = fs::read_dir(&tmp) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let root = fs::read_to_string(path.join(".project_root")).unwrap_or_default();
            if !same_project_cwd(root.trim(), cwd) {
                continue;
            }
            let chats = path.join("chats");
            if chats.is_dir() && !dirs.iter().any(|existing| existing == &chats) {
                dirs.push(chats);
            }
        }
    }
    dirs
}

fn list_gemini_sessions(home: &Path, cwd: &str) -> Vec<ProjectHistorySession> {
    let mut sessions = Vec::new();
    for chats in gemini_project_chat_dirs(home, cwd) {
        let Ok(entries) = fs::read_dir(chats) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path.file_name().and_then(|value| value.to_str()).unwrap_or("");
            if !name.starts_with("session-") {
                continue;
            }
            if let Some(session) = gemini_session_from_file(&path) {
                sessions.push(session);
            }
        }
    }
    finalize_sessions(sessions)
}

fn qwen_first_user_text(value: &serde_json::Value) -> String {
    value
        .get("message")
        .and_then(|message| message.get("parts"))
        .and_then(|parts| parts.as_array())
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("text").and_then(|text| text.as_str()))
        .find(|text| !text.trim().is_empty())
        .unwrap_or("")
        .to_string()
}

fn qwen_session_from_jsonl(path: &Path, cwd: &str, allow_missing_cwd: bool) -> Option<ProjectHistorySession> {
    // qwen 的行式 jsonl 与 Claude 同款（每行带 cwd），复用其匹配逻辑
    if !claude_file_matches_cwd(path, cwd, allow_missing_cwd) {
        return None;
    }
    let id = path.file_stem()?.to_str()?.to_string();
    if id.is_empty() {
        return None;
    }
    let mut file = fs::File::open(path).ok()?;
    let mut buf = String::new();
    let _ = file
        .by_ref()
        .take(CLAUDE_TITLE_READ_LIMIT)
        .read_to_string(&mut buf);
    let mut raw_title = String::new();
    for line in buf.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("type").and_then(|value| value.as_str()) != Some("user") {
            continue;
        }
        let text = qwen_first_user_text(&value);
        if text.trim().is_empty() || is_noise_user_text(&text) {
            continue;
        }
        raw_title = text;
        break;
    }
    let at_ms = path
        .metadata()
        .and_then(|meta| meta.modified())
        .map(millis)
        .unwrap_or(0);
    Some(history_session(id, "qwen", &raw_title, at_ms))
}

fn find_qwen_project_dir(home: &Path, cwd: &str) -> Option<PathBuf> {
    let projects = home.join(".qwen").join("projects");
    let encoded = projects.join(encode_claude_project_dir(cwd));
    if encoded.is_dir() {
        return Some(encoded);
    }
    for entry in fs::read_dir(&projects).ok()?.flatten() {
        let path = entry.path();
        if path.is_dir() && dir_has_matching_claude_cwd(&path.join("chats"), cwd) {
            return Some(path);
        }
    }
    None
}

fn list_qwen_sessions(home: &Path, cwd: &str) -> Vec<ProjectHistorySession> {
    let Some(dir) = find_qwen_project_dir(home, cwd) else {
        return Vec::new();
    };
    let allow_missing = is_encoded_claude_dir(&dir, cwd);
    let mut sessions = Vec::new();
    let entries = match fs::read_dir(dir.join("chats")) {
        Ok(entries) => entries,
        Err(_) => return sessions,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        if let Some(session) = qwen_session_from_jsonl(&path, cwd, allow_missing) {
            sessions.push(session);
        }
    }
    sessions.sort_by_key(|session| std::cmp::Reverse(session.at_ms));
    sessions.truncate(MAX_SESSIONS_PER_TOOL);
    sessions
}

fn qwen_session_path(home: &Path, cwd: &str, session_id: &str) -> Result<PathBuf, String> {
    let id = require_component_id(session_id)?;
    let dir = find_qwen_project_dir(home, cwd).ok_or_else(|| "找不到这个 Qwen 会话".to_string())?;
    let path = dir.join("chats").join(format!("{id}.jsonl"));
    let allow_missing = is_encoded_claude_dir(&dir, cwd);
    if path.is_file() && is_within_dir(&dir, &path) && claude_file_matches_cwd(&path, cwd, allow_missing) {
        Ok(path)
    } else {
        Err("找不到这个 Qwen 会话".into())
    }
}

fn collect_qwen_preview_parts(buf: &str) -> Vec<String> {
    let mut parts = Vec::new();
    for line in buf.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let kind = value.get("type").and_then(|value| value.as_str()).unwrap_or("");
        if kind != "user" && kind != "assistant" {
            continue;
        }
        let text = value
            .get("message")
            .and_then(|message| message.get("parts"))
            .and_then(|parts| parts.as_array())
            .into_iter()
            .flatten()
            .filter_map(|item| item.get("text").and_then(|text| text.as_str()))
            .collect::<Vec<_>>()
            .join(" ");
        if !text.trim().is_empty() {
            parts.push(text);
            if parts.len() >= 8 {
                break;
            }
        }
    }
    parts
}

fn list_agy_sessions(home: &Path, cwd: &str) -> Vec<ProjectHistorySession> {
    let history = home.join(".gemini/antigravity-cli/history.jsonl");
    let mut by_id: std::collections::BTreeMap<String, (String, u64)> = std::collections::BTreeMap::new();
    if let Ok(text) = fs::read_to_string(&history) {
        for line in text.lines() {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            let Some(workspace) = value.get("workspace").and_then(|item| item.as_str()) else {
                continue;
            };
            if !same_project_cwd(workspace, cwd) {
                continue;
            }
            let Some(id) = value.get("conversationId").and_then(|item| item.as_str()).filter(|item| !item.is_empty()) else {
                continue;
            };
            let title = value
                .get("display")
                .and_then(|item| item.as_str())
                .unwrap_or("");
            let at_ms = value.get("timestamp").and_then(|item| item.as_u64()).unwrap_or(0);
            let entry = by_id.entry(id.to_string()).or_insert_with(|| (String::new(), 0));
            if entry.0.is_empty() && !title.trim().is_empty() {
                entry.0 = preview_title(title);
            }
            if at_ms > entry.1 {
                entry.1 = at_ms;
            }
        }
    }
    if let Ok(text) = fs::read_to_string(home.join(".gemini/antigravity-cli/cache/last_conversations.json")) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(id) = value.get(cwd).and_then(|item| item.as_str()) {
                by_id.entry(id.to_string()).or_insert_with(|| ("未命名会话".into(), 0));
            }
        }
    }
    let sessions = by_id
        .into_iter()
        .map(|(id, (title, at_ms))| history_session(id, "agy", &title, at_ms))
        .collect::<Vec<_>>();
    finalize_sessions(sessions)
}

fn push_group(groups: &mut Vec<ProjectHistoryGroup>, tool: &str, label: &str, sessions: Vec<ProjectHistorySession>) {
    if sessions.is_empty() {
        return;
    }
    groups.push(ProjectHistoryGroup {
        tool: tool.into(),
        label: label.into(),
        sessions,
    });
}

pub fn list_project_history_with_home(project_path: &str, home: &Path) -> ProjectHistory {
    let cwd = crate::project_memory::normalize_project_cwd(project_path);
    let mut groups = Vec::new();
    if cwd.is_empty() {
        return ProjectHistory { groups };
    }
    push_group(&mut groups, "claude", "Claude", list_claude_sessions(home, &cwd));
    push_group(&mut groups, "codex", "Codex", list_codex_sessions(home, &cwd));
    push_group(&mut groups, "grok", "Grok", list_grok_sessions(home, &cwd));
    push_group(&mut groups, "opencode", "OpenCode", list_opencode_sessions(home, &cwd));
    push_group(&mut groups, "gemini", "Gemini", list_gemini_sessions(home, &cwd));
    push_group(&mut groups, "agy", "agy", list_agy_sessions(home, &cwd));
    push_group(&mut groups, "qwen", "Qwen", list_qwen_sessions(home, &cwd));
    push_group(&mut groups, "mimo", "MiMo Code", list_mimo_sessions(home, &cwd));
    ProjectHistory { groups }
}

pub fn list_project_history(project_path: &str) -> Result<ProjectHistory, String> {
    let home = dirs::home_dir().ok_or_else(|| "找不到用户主目录".to_string())?;
    Ok(list_project_history_with_home(project_path, &home))
}

fn require_cwd(project_path: &str) -> Result<String, String> {
    let cwd = crate::project_memory::normalize_project_cwd(project_path);
    if cwd.is_empty() {
        return Err("项目路径无效".into());
    }
    Ok(cwd)
}

fn is_safe_component(id: &str) -> bool {
    let id = id.trim();
    !id.is_empty()
        && id.len() <= 200
        && !id.contains('\0')
        && !id.contains('/')
        && !id.contains('\\')
        && id != "."
        && id != ".."
}

fn has_parent_dir(path: &Path) -> bool {
    path.components().any(|component| matches!(component, Component::ParentDir))
}

fn is_within_dir(parent: &Path, child: &Path) -> bool {
    let Ok(parent) = parent.canonicalize() else {
        return false;
    };
    let Ok(child) = child.canonicalize() else {
        return false;
    };
    child.starts_with(&parent)
}

fn require_component_id(id: &str) -> Result<String, String> {
    let id = id.trim();
    if is_safe_component(id) {
        Ok(id.to_string())
    } else {
        Err("非法会话 ID".into())
    }
}

fn collect_claude_preview_parts(buf: &str) -> Vec<String> {
    let mut parts = Vec::new();
    for line in buf.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("type").and_then(|value| value.as_str()) != Some("user") {
            continue;
        }
        if value.get("isSidechain").and_then(|value| value.as_bool()) == Some(true) {
            continue;
        }
        let Some(text) = user_text_from_claude_message(&value) else {
            continue;
        };
        if is_noise_user_text(&text) {
            continue;
        }
        parts.push(text);
        if parts.len() >= 8 {
            break;
        }
    }
    parts
}

fn collect_codex_preview_parts(buf: &str) -> Vec<String> {
    let mut parts = Vec::new();
    for line in buf.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("type").and_then(|value| value.as_str()) != Some("response_item") {
            continue;
        }
        let Some(payload) = value.get("payload") else { continue };
        if payload.get("type").and_then(|value| value.as_str()) != Some("message") {
            continue;
        }
        if payload.get("role").and_then(|value| value.as_str()) != Some("user") {
            continue;
        }
        for item in payload.get("content").and_then(|value| value.as_array()).into_iter().flatten() {
            if item.get("type").and_then(|value| value.as_str()) != Some("input_text") {
                continue;
            }
            let Some(text) = item.get("text").and_then(|value| value.as_str()) else {
                continue;
            };
            if is_noise_codex_text(text) {
                continue;
            }
            parts.push(text.to_string());
            if parts.len() >= 8 {
                return parts;
            }
        }
    }
    parts
}

fn collect_gemini_preview_parts(value: &serde_json::Value) -> Vec<String> {
    let mut parts = Vec::new();
    for message in value.get("messages").and_then(|value| value.as_array()).into_iter().flatten() {
        if message.get("type").and_then(|value| value.as_str()) != Some("user") {
            continue;
        }
        let content = message.get("content");
        if let Some(text) = content.and_then(|value| value.as_str()) {
            if !text.trim().is_empty() {
                parts.push(text.to_string());
            }
        } else {
            for item in content.and_then(|value| value.as_array()).into_iter().flatten() {
                if let Some(text) = item.get("text").and_then(|value| value.as_str()) {
                    if !text.trim().is_empty() {
                        parts.push(text.to_string());
                    }
                }
            }
        }
        if parts.len() >= 8 {
            break;
        }
    }
    parts
}

fn grok_user_text(value: &serde_json::Value) -> Option<String> {
    if value.get("type").and_then(|item| item.as_str()) != Some("user") {
        return None;
    }
    let content = value.get("content")?;
    let mut parts = Vec::new();
    if let Some(text) = content.as_str() {
        parts.push(text.to_string());
    } else {
        for item in content.as_array()? {
            if item.get("type").and_then(|item| item.as_str()) == Some("text") {
                if let Some(text) = item.get("text").and_then(|item| item.as_str()) {
                    parts.push(text.to_string());
                }
            }
        }
    }
    if parts.is_empty() {
        return None;
    }
    let joined = parts.join(" ");
    if let Some(start) = joined.find("<user_query>") {
        let rest = &joined[start + "<user_query>".len()..];
        if let Some(end) = rest.find("</user_query>") {
            let inner = rest[..end].trim();
            if !inner.is_empty() {
                return Some(inner.to_string());
            }
        }
    }
    if joined.contains("This session is being continued") || joined.contains("<user_info>") {
        return None;
    }
    Some(joined)
}

fn collect_grok_preview_parts(path: &Path) -> Vec<String> {
    let mut parts = Vec::new();
    if let Ok(text) = fs::read_to_string(path.join("summary.json")) {
        if let Ok(summary) = serde_json::from_str::<serde_json::Value>(&text) {
            for key in ["generated_title", "session_summary"] {
                if let Some(value) = summary.get(key).and_then(|item| item.as_str()) {
                    if !value.trim().is_empty() {
                        parts.push(value.to_string());
                    }
                }
            }
        }
    }
    if let Ok(file) = fs::File::open(path.join("chat_history.jsonl")) {
        let mut reader = BufReader::new(file);
        let buf = read_lossy_prefix(&mut reader, PREVIEW_FILE_READ_LIMIT);
        for line in buf.lines() {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            if let Some(text) = grok_user_text(&value) {
                parts.push(text);
                if parts.len() >= 8 {
                    break;
                }
            }
        }
    }
    parts
}

fn claude_session_path(home: &Path, cwd: &str, session_id: &str) -> Result<PathBuf, String> {
    let id = require_component_id(session_id)?;
    let dir = find_claude_project_dir(home, cwd).ok_or_else(|| "找不到这个 Claude 会话".to_string())?;
    let path = dir.join(format!("{id}.jsonl"));
    let allow_missing = is_encoded_claude_dir(&dir, cwd);
    if path.is_file() && is_within_dir(&dir, &path) && claude_file_matches_cwd(&path, cwd, allow_missing) {
        Ok(path)
    } else {
        Err("找不到这个 Claude 会话".into())
    }
}

fn grok_session_dir(home: &Path, cwd: &str, session_id: &str) -> Result<PathBuf, String> {
    let id = require_component_id(session_id)?;
    let group = find_grok_session_group(home, cwd).ok_or_else(|| "找不到这个 Grok 会话".to_string())?;
    let path = group.join(id);
    if path.is_dir() && path.join("summary.json").is_file() && is_within_dir(&group, &path) {
        Ok(path)
    } else {
        Err("找不到这个 Grok 会话".into())
    }
}

fn codex_file_matches(path: &Path, cwd: &str, session_id: &str) -> bool {
    let Ok(file) = fs::File::open(path) else {
        return false;
    };
    let mut first = String::new();
    if BufReader::new(file).read_line(&mut first).is_err() {
        return false;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(first.trim_end()) else {
        return false;
    };
    if value.get("type").and_then(|item| item.as_str()) != Some("session_meta") {
        return false;
    }
    let Some(payload) = value.get("payload") else {
        return false;
    };
    if is_codex_subagent(payload) {
        return false;
    }
    let Some(session_cwd) = payload.get("cwd").and_then(|item| item.as_str()) else {
        return false;
    };
    if !same_project_cwd(session_cwd, cwd) {
        return false;
    }
    payload
        .get("session_id")
        .and_then(|item| item.as_str())
        == Some(session_id)
}

fn find_codex_session_path(home: &Path, cwd: &str, session_id: &str) -> Result<PathBuf, String> {
    let id = require_component_id(session_id)?;
    let root = home.join(".codex").join("sessions");
    let mut scanned = 0;
    for year in sorted_named_dirs(&root).into_iter().rev() {
        for month in sorted_named_dirs(&year).into_iter().rev() {
            for day in sorted_named_dirs(&month).into_iter().rev() {
                let mut files = fs::read_dir(&day)
                    .ok()
                    .into_iter()
                    .flatten()
                    .flatten()
                    .map(|entry| entry.path())
                    .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
                    .collect::<Vec<_>>();
                files.sort();
                for file in files.into_iter().rev() {
                    scanned += 1;
                    if scanned > CODEX_SCAN_LIMIT {
                        return Err("找不到这个 Codex 会话".into());
                    }
                    if codex_file_matches(&file, cwd, &id) {
                        return Ok(file);
                    }
                }
            }
        }
    }
    Err("找不到这个 Codex 会话".into())
}

fn resolve_gemini_session_file(home: &Path, cwd: &str, session_id: &str) -> Result<PathBuf, String> {
    let raw = session_id.trim();
    if raw.is_empty() || raw.len() > 1024 || raw.contains('\0') {
        return Err("非法会话 ID".into());
    }
    let candidate = PathBuf::from(raw);
    if has_parent_dir(&candidate) {
        return Err("非法会话路径".into());
    }
    let allowed = gemini_project_chat_dirs(home, cwd);
    if allowed.is_empty() {
        return Err("找不到这个 Gemini 会话".into());
    }
    let files = if candidate.is_absolute() {
        vec![candidate]
    } else {
        let name = candidate
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "非法会话 ID".to_string())?;
        if !name.starts_with("session-") || !is_safe_component(name) {
            return Err("非法会话 ID".into());
        }
        allowed.iter().map(|dir| dir.join(name)).collect()
    };
    for file in files {
        let name = file.file_name().and_then(|value| value.to_str()).unwrap_or("");
        if !name.starts_with("session-") || !file.is_file() {
            continue;
        }
        if allowed.iter().any(|dir| is_within_dir(dir, &file)) {
            return Ok(file);
        }
    }
    Err("找不到这个 Gemini 会话".into())
}

fn find_opencode_db(home: &Path) -> Option<PathBuf> {
    opencode_db_paths(home).into_iter().find(|path| path.is_file())
}

fn preview_opencode(home: &Path, cwd: &str, session_id: &str) -> Result<ProjectHistoryPreview, String> {
    let id = require_component_id(session_id)?;
    let db_path = find_opencode_db(home).ok_or_else(|| "找不到 OpenCode 会话库".to_string())?;
    let connection = rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|error| error.to_string())?;
    let normalized = crate::project_memory::normalize_project_cwd(cwd);
    let slash = format!("{normalized}/");
    let backslash = format!("{normalized}\\");
    let mut statement = connection
        .prepare(
            "SELECT title, time_updated, directory
             FROM session
             WHERE id = ?1
               AND (parent_id IS NULL OR parent_id = '')
               AND directory IN (?2, ?3, ?4)
             LIMIT 1",
        )
        .map_err(|error| error.to_string())?;
    let row = statement
        .query_row(
            rusqlite::params![id, normalized, slash, backslash],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(|_| "找不到这个 OpenCode 会话".to_string())?;
    let (title, time_updated, directory) = row;
    if !same_project_cwd(&directory, cwd) {
        return Err("找不到这个 OpenCode 会话".into());
    }
    Ok(ProjectHistoryPreview {
        id,
        tool: "opencode".into(),
        title: preview_title(&title),
        at_ms: time_updated.max(0) as u64,
        body: preview_excerpt(&title, PREVIEW_BODY_LIMIT),
    })
}

fn delete_opencode(home: &Path, cwd: &str, session_id: &str) -> Result<(), String> {
    let id = require_component_id(session_id)?;
    let db_path = find_opencode_db(home).ok_or_else(|| "找不到 OpenCode 会话库".to_string())?;
    let connection = rusqlite::Connection::open(&db_path).map_err(|error| error.to_string())?;
    let normalized = crate::project_memory::normalize_project_cwd(cwd);
    let slash = format!("{normalized}/");
    let backslash = format!("{normalized}\\");
    let deleted = connection
        .execute(
            "DELETE FROM session
             WHERE id = ?1
               AND (parent_id IS NULL OR parent_id = '')
               AND directory IN (?2, ?3, ?4)",
            rusqlite::params![id, normalized, slash, backslash],
        )
        .map_err(|error| error.to_string())?;
    if deleted == 0 {
        return Err("找不到这个 OpenCode 会话".into());
    }
    Ok(())
}

fn find_mimo_db(home: &Path) -> Option<PathBuf> {
    mimo_db_paths(home).into_iter().find(|path| path.is_file())
}

fn preview_mimo(home: &Path, cwd: &str, session_id: &str) -> Result<ProjectHistoryPreview, String> {
    let id = require_component_id(session_id)?;
    let db_path = find_mimo_db(home).ok_or_else(|| "找不到 MiMo Code 会话库".to_string())?;
    let connection = rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|error| error.to_string())?;
    let normalized = crate::project_memory::normalize_project_cwd(cwd);
    let slash = format!("{normalized}/");
    let backslash = format!("{normalized}\\");
    let mut statement = connection
        .prepare(
            "SELECT title, time_updated, directory
             FROM session
             WHERE id = ?1
               AND (parent_id IS NULL OR parent_id = '')
               AND directory IN (?2, ?3, ?4)
             LIMIT 1",
        )
        .map_err(|error| error.to_string())?;
    let row = statement
        .query_row(
            rusqlite::params![id, normalized, slash, backslash],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(|_| "找不到这个 MiMo Code 会话".to_string())?;
    let (title, time_updated, directory) = row;
    if !same_project_cwd(&directory, cwd) {
        return Err("找不到这个 MiMo Code 会话".into());
    }
    Ok(ProjectHistoryPreview {
        id,
        tool: "mimo".into(),
        title: preview_title(&title),
        at_ms: time_updated.max(0) as u64,
        body: preview_excerpt(&title, PREVIEW_BODY_LIMIT),
    })
}

fn mimo_table_has_column(
    connection: &rusqlite::Connection,
    table: &str,
    column: &str,
) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2
             )",
            rusqlite::params![table, column],
            |row| row.get::<_, i64>(0),
        )
        .map(|exists| exists != 0)
        .map_err(|error| error.to_string())
}

fn delete_mimo(home: &Path, cwd: &str, session_id: &str) -> Result<(), String> {
    let id = require_component_id(session_id)?;
    let db_path = find_mimo_db(home).ok_or_else(|| "找不到 MiMo Code 会话库".to_string())?;
    let mut connection = rusqlite::Connection::open(&db_path).map_err(|error| error.to_string())?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|error| error.to_string())?;
    let normalized = crate::project_memory::normalize_project_cwd(cwd);
    let slash = format!("{normalized}/");
    let backslash = format!("{normalized}\\");
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let session_ids = {
        let mut statement = transaction
            .prepare(
            "WITH RECURSIVE target(id, depth) AS (
                 SELECT id, 0
                 FROM session
                 WHERE id = ?1
                   AND (parent_id IS NULL OR parent_id = '')
                   AND directory IN (?2, ?3, ?4)
                 UNION ALL
                 SELECT child.id, target.depth + 1
                 FROM session AS child
                 JOIN target ON child.parent_id = target.id
                 WHERE child.directory IN (?2, ?3, ?4)
             )
             SELECT id FROM target ORDER BY depth DESC",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(
                rusqlite::params![id, normalized, slash, backslash],
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    if session_ids.is_empty() {
        return Err("找不到这个 MiMo Code 会话".into());
    }

    let has_history_fts = mimo_table_has_column(&transaction, "history_fts", "session_id")?;
    let has_permission_parent =
        mimo_table_has_column(&transaction, "permission_grant", "parent_session_id")?;
    let has_permission_target = mimo_table_has_column(&transaction, "permission_grant", "target")?;
    let has_event = mimo_table_has_column(&transaction, "event", "aggregate_id")?;
    let has_event_sequence =
        mimo_table_has_column(&transaction, "event_sequence", "aggregate_id")?;

    for target_id in &session_ids {
        if has_history_fts {
            transaction
                .execute(
                    "DELETE FROM history_fts WHERE session_id = ?1",
                    rusqlite::params![target_id],
                )
                .map_err(|error| error.to_string())?;
        }
        match (has_permission_parent, has_permission_target) {
            (true, true) => {
                transaction
                    .execute(
                        "DELETE FROM permission_grant WHERE parent_session_id = ?1 OR target = ?1",
                        rusqlite::params![target_id],
                    )
                    .map_err(|error| error.to_string())?;
            }
            (true, false) => {
                transaction
                    .execute(
                        "DELETE FROM permission_grant WHERE parent_session_id = ?1",
                        rusqlite::params![target_id],
                    )
                    .map_err(|error| error.to_string())?;
            }
            (false, true) => {
                transaction
                    .execute(
                        "DELETE FROM permission_grant WHERE target = ?1",
                        rusqlite::params![target_id],
                    )
                    .map_err(|error| error.to_string())?;
            }
            (false, false) => {}
        }
        if has_event {
            transaction
                .execute(
                    "DELETE FROM event WHERE aggregate_id = ?1",
                    rusqlite::params![target_id],
                )
                .map_err(|error| error.to_string())?;
        }
        if has_event_sequence {
            transaction
                .execute(
                    "DELETE FROM event_sequence WHERE aggregate_id = ?1",
                    rusqlite::params![target_id],
                )
                .map_err(|error| error.to_string())?;
        }
    }

    for target_id in &session_ids {
        let deleted = transaction
            .execute(
                "DELETE FROM session
                 WHERE id = ?1 AND directory IN (?2, ?3, ?4)",
                rusqlite::params![target_id, normalized, slash, backslash],
            )
            .map_err(|error| error.to_string())?;
        if deleted != 1 {
            return Err("MiMo Code 会话在删除前发生变化".into());
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}

fn preview_agy(home: &Path, cwd: &str, session_id: &str) -> Result<ProjectHistoryPreview, String> {
    let id = require_component_id(session_id)?;
    let history = home.join(".gemini/antigravity-cli/history.jsonl");
    let mut parts = Vec::new();
    let mut at_ms = 0;
    if let Ok(text) = fs::read_to_string(&history) {
        for line in text.lines() {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            let Some(workspace) = value.get("workspace").and_then(|item| item.as_str()) else {
                continue;
            };
            if !same_project_cwd(workspace, cwd) {
                continue;
            }
            if value.get("conversationId").and_then(|item| item.as_str()) != Some(id.as_str()) {
                continue;
            }
            if let Some(display) = value.get("display").and_then(|item| item.as_str()) {
                if !display.trim().is_empty() {
                    parts.push(display.to_string());
                }
            }
            if let Some(stamp) = value.get("timestamp").and_then(|item| item.as_u64()) {
                at_ms = at_ms.max(stamp);
            }
        }
    }
    if parts.is_empty() {
        return Err("找不到这个 agy 会话".into());
    }
    Ok(ProjectHistoryPreview {
        id,
        tool: "agy".into(),
        title: preview_title(&parts[0]),
        at_ms,
        body: preview_body(&parts),
    })
}

fn atomic_write_text(path: &Path, content: &str) -> Result<(), String> {
    use std::io::Write;
    let parent = path.parent().ok_or_else(|| "无法确定文件所在目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut temp = tempfile::Builder::new()
        .prefix(".vcm-sess-")
        .tempfile_in(parent)
        .map_err(|error| error.to_string())?;
    temp.write_all(content.as_bytes()).map_err(|error| error.to_string())?;
    temp.flush().map_err(|error| error.to_string())?;
    temp.as_file().sync_all().map_err(|error| error.to_string())?;
    temp.persist(path).map_err(|error| error.error.to_string())?;
    Ok(())
}

fn delete_agy(home: &Path, cwd: &str, session_id: &str) -> Result<(), String> {
    let id = require_component_id(session_id)?;
    let history = home.join(".gemini/antigravity-cli/history.jsonl");
    let mut kept = Vec::new();
    let mut removed = false;
    if let Ok(text) = fs::read_to_string(&history) {
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
                kept.push(line.to_string());
                continue;
            };
            let same_id = value.get("conversationId").and_then(|item| item.as_str()) == Some(id.as_str());
            let same_cwd = value
                .get("workspace")
                .and_then(|item| item.as_str())
                .is_some_and(|workspace| same_project_cwd(workspace, cwd));
            if same_id && same_cwd {
                removed = true;
                continue;
            }
            kept.push(line.to_string());
        }
    }
    let cache = home.join(".gemini/antigravity-cli/cache/last_conversations.json");
    let cache_text = fs::read_to_string(&cache).ok();
    let next_cache = cache_text.as_deref().and_then(|text| {
        let mut value = serde_json::from_str::<serde_json::Value>(text).ok()?;
        let map = value.as_object_mut()?;
        if map.get(cwd).and_then(|item| item.as_str()) != Some(id.as_str()) {
            return None;
        }
        map.remove(cwd);
        serde_json::to_string_pretty(&value).ok()
    });
    if !removed && next_cache.is_none() {
        return Err("找不到这个 agy 会话".into());
    }
    if removed {
        let mut next = kept.join("\n");
        if !next.is_empty() {
            next.push('\n');
        }
        atomic_write_text(&history, &next)?;
    }
    if let Some(next) = next_cache {
        atomic_write_text(&cache, &next)?;
    }
    Ok(())
}

fn preview_result(session: ProjectHistorySession, body: String) -> ProjectHistoryPreview {
    ProjectHistoryPreview {
        id: session.id,
        tool: session.tool,
        title: session.title,
        at_ms: session.at_ms,
        body,
    }
}

pub fn preview_project_session_with_home(
    project_path: &str,
    tool: &str,
    session_id: &str,
    home: &Path,
) -> Result<ProjectHistoryPreview, String> {
    let cwd = require_cwd(project_path)?;
    match tool.trim() {
        "claude" => {
            let path = claude_session_path(home, &cwd, session_id)?;
            let session = claude_session_from_jsonl(&path, &cwd, true)
                .ok_or_else(|| "找不到这个 Claude 会话".to_string())?;
            let mut file = fs::File::open(&path).map_err(|error| error.to_string())?;
            let buf = read_lossy_prefix(&mut file, PREVIEW_FILE_READ_LIMIT);
            Ok(preview_result(session, preview_body(&collect_claude_preview_parts(&buf))))
        }
        "grok" => {
            let path = grok_session_dir(home, &cwd, session_id)?;
            let session = grok_session_from_dir(&path).ok_or_else(|| "找不到这个 Grok 会话".to_string())?;
            Ok(preview_result(session, preview_body(&collect_grok_preview_parts(&path))))
        }
        "codex" => {
            let path = find_codex_session_path(home, &cwd, session_id)?;
            let session = codex_session_from_jsonl(&path, &cwd)
                .ok_or_else(|| "找不到这个 Codex 会话".to_string())?;
            let file = fs::File::open(&path).map_err(|error| error.to_string())?;
            let mut reader = BufReader::new(file);
            let mut first = String::new();
            let _ = reader.read_line(&mut first);
            let buf = read_lossy_prefix(&mut reader, PREVIEW_FILE_READ_LIMIT);
            Ok(preview_result(session, preview_body(&collect_codex_preview_parts(&buf))))
        }
        "opencode" => preview_opencode(home, &cwd, session_id),
        "mimo" => preview_mimo(home, &cwd, session_id),
        "gemini" => {
            let path = resolve_gemini_session_file(home, &cwd, session_id)?;
            let session = gemini_session_from_file(&path).ok_or_else(|| "找不到这个 Gemini 会话".to_string())?;
            let raw = fs::read_to_string(&path).map_err(|error| error.to_string())?;
            let value = serde_json::from_str::<serde_json::Value>(raw.trim())
                .ok()
                .or_else(|| raw.lines().next().and_then(|line| serde_json::from_str(line).ok()))
                .unwrap_or(serde_json::Value::Null);
            Ok(preview_result(session, preview_body(&collect_gemini_preview_parts(&value))))
        }
        "agy" => preview_agy(home, &cwd, session_id),
        "qwen" => {
            let path = qwen_session_path(home, &cwd, session_id)?;
            let session = qwen_session_from_jsonl(&path, &cwd, true)
                .ok_or_else(|| "找不到这个 Qwen 会话".to_string())?;
            let mut file = fs::File::open(&path).map_err(|error| error.to_string())?;
            let buf = read_lossy_prefix(&mut file, PREVIEW_FILE_READ_LIMIT);
            Ok(preview_result(session, preview_body(&collect_qwen_preview_parts(&buf))))
        }
        _ => Err("还不支持预览这个工具的历史会话".into()),
    }
}

pub fn delete_project_session_with_home(
    project_path: &str,
    tool: &str,
    session_id: &str,
    home: &Path,
) -> Result<(), String> {
    let cwd = require_cwd(project_path)?;
    match tool.trim() {
        "claude" => {
            let path = claude_session_path(home, &cwd, session_id)?;
            fs::remove_file(path).map_err(|error| error.to_string())
        }
        "grok" => {
            let path = grok_session_dir(home, &cwd, session_id)?;
            fs::remove_dir_all(path).map_err(|error| error.to_string())
        }
        "codex" => {
            let path = find_codex_session_path(home, &cwd, session_id)?;
            fs::remove_file(path).map_err(|error| error.to_string())
        }
        "opencode" => delete_opencode(home, &cwd, session_id),
        "mimo" => delete_mimo(home, &cwd, session_id),
        "gemini" => {
            let path = resolve_gemini_session_file(home, &cwd, session_id)?;
            fs::remove_file(path).map_err(|error| error.to_string())
        }
        "agy" => delete_agy(home, &cwd, session_id),
        "qwen" => {
            let path = qwen_session_path(home, &cwd, session_id)?;
            fs::remove_file(&path).map_err(|error| error.to_string())?;
            // 伴生的运行时状态文件，删不掉无所谓
            let runtime = path.with_file_name(format!(
                "{}.runtime.json",
                path.file_stem().and_then(|stem| stem.to_str()).unwrap_or_default()
            ));
            if runtime.is_file() {
                let _ = fs::remove_file(runtime);
            }
            Ok(())
        }
        _ => Err("还不支持删除这个工具的历史会话".into()),
    }
}

pub fn preview_project_session(
    project_path: &str,
    tool: &str,
    session_id: &str,
) -> Result<ProjectHistoryPreview, String> {
    let home = dirs::home_dir().ok_or_else(|| "找不到用户主目录".to_string())?;
    preview_project_session_with_home(project_path, tool, session_id, &home)
}

pub fn delete_project_session(
    project_path: &str,
    tool: &str,
    session_id: &str,
) -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "找不到用户主目录".to_string())?;
    delete_project_session_with_home(project_path, tool, session_id, &home)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_home() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        fs::create_dir_all(&home).unwrap();
        (root, home)
    }

    #[test]
    fn grok_cwd_encoding_matches_on_disk_layout() {
        assert_eq!(
            encode_grok_cwd("/Users/lucky/git/app"),
            "%2FUsers%2Flucky%2Fgit%2Fapp"
        );
    }

    #[test]
    fn lists_claude_and_grok_sessions_and_skips_subagents() {
        let (_root, home) = temp_home();
        let cwd = "/Users/lucky/git/app";
        let claude_dir = home
            .join(".claude")
            .join("projects")
            .join(encode_claude_project_dir(cwd));
        fs::create_dir_all(&claude_dir).unwrap();
        fs::write(
            claude_dir.join("11111111-1111-1111-1111-111111111111.jsonl"),
            r#"{"type":"mode"}
{"type":"user","isSidechain":false,"message":{"role":"user","content":"修好分屏空窗格"}}
"#,
        )
        .unwrap();

        let grok_dir = home
            .join(".grok")
            .join("sessions")
            .join(encode_grok_cwd(cwd));
        fs::create_dir_all(grok_dir.join("sess-main")).unwrap();
        fs::write(
            grok_dir.join("sess-main").join("summary.json"),
            r#"{"generated_title":"Where AI Reads Memory From","last_active_at":"2026-08-13T06:43:07.801432Z"}"#,
        )
        .unwrap();
        fs::create_dir_all(grok_dir.join("sess-child")).unwrap();
        fs::write(
            grok_dir.join("sess-child").join("summary.json"),
            r#"{"session_kind":"subagent","generated_title":"Reviewer","last_active_at":"2026-08-13T06:35:48.624795Z"}"#,
        )
        .unwrap();

        let history = list_project_history_with_home(cwd, &home);
        assert_eq!(history.groups.len(), 2);
        assert_eq!(history.groups[0].tool, "claude");
        assert_eq!(history.groups[0].sessions[0].title, "修好分屏空窗格");
        assert_eq!(history.groups[1].tool, "grok");
        assert_eq!(history.groups[1].sessions.len(), 1);
        assert_eq!(history.groups[1].sessions[0].title, "Where AI Reads Memory From");
    }

    #[test]
    fn claude_list_and_delete_keep_colliding_encoded_dirs_apart() {
        let (_root, home) = temp_home();
        let cwd = "/Users/lucky/foo/bar";
        let other = "/Users/lucky/foo.bar";
        assert_eq!(encode_claude_project_dir(cwd), encode_claude_project_dir(other));
        let dir = home
            .join(".claude")
            .join("projects")
            .join(encode_claude_project_dir(cwd));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("sess-this.jsonl"),
            format!(
                "{}\n{}\n",
                r#"{"cwd":"/Users/lucky/foo/bar","type":"mode"}"#,
                r#"{"type":"user","isSidechain":false,"message":{"role":"user","content":"本项目会话"}}"#,
            ),
        )
        .unwrap();
        fs::write(
            dir.join("sess-other.jsonl"),
            format!(
                "{}\n{}\n",
                r#"{"cwd":"/Users/lucky/foo.bar","type":"mode"}"#,
                r#"{"type":"user","isSidechain":false,"message":{"role":"user","content":"撞名项目会话"}}"#,
            ),
        )
        .unwrap();

        let history = list_project_history_with_home(cwd, &home);
        let claude = history.groups.iter().find(|group| group.tool == "claude").unwrap();
        assert_eq!(claude.sessions.len(), 1);
        assert_eq!(claude.sessions[0].id, "sess-this");
        assert_eq!(claude.sessions[0].title, "本项目会话");
        assert!(delete_project_session_with_home(cwd, "claude", "sess-other", &home).is_err());
        delete_project_session_with_home(cwd, "claude", "sess-this", &home).unwrap();
        assert!(!dir.join("sess-this.jsonl").exists());
        assert!(dir.join("sess-other.jsonl").exists());
    }

    #[test]
    fn qwen_lists_previews_and_deletes_only_same_project() {
        let (_root, home) = temp_home();
        let cwd = "/Users/lucky/git/app";
        let chats = home
            .join(".qwen")
            .join("projects")
            .join(encode_claude_project_dir(cwd))
            .join("chats");
        fs::create_dir_all(&chats).unwrap();
        let id = "22222222-2222-2222-2222-222222222222";
        fs::write(
            chats.join(format!("{id}.jsonl")),
            format!(
                "{}\n{}\n",
                r#"{"cwd":"/Users/lucky/git/app","type":"user","message":{"role":"user","parts":[{"text":"部署到服务器"}]}}"#,
                r#"{"cwd":"/Users/lucky/git/app","type":"assistant","message":{"role":"model","parts":[{"text":"好的，先看部署方式"}]}}"#,
            ),
        )
        .unwrap();
        fs::write(chats.join(format!("{id}.runtime.json")), "{}").unwrap();
        let other_id = "33333333-3333-3333-3333-333333333333";
        fs::write(
            chats.join(format!("{other_id}.jsonl")),
            r#"{"cwd":"/Users/lucky/git.app","type":"user","message":{"role":"user","parts":[{"text":"撞名项目会话"}]}}
"#,
        )
        .unwrap();
        fs::write(chats.join(format!("{other_id}.runtime.json")), "{}").unwrap();

        let history = list_project_history_with_home(cwd, &home);
        let qwen = history.groups.iter().find(|group| group.tool == "qwen").unwrap();
        assert_eq!(qwen.sessions.len(), 1);
        assert_eq!(qwen.sessions[0].id, id);
        assert_eq!(qwen.sessions[0].title, "部署到服务器");

        let preview = preview_project_session_with_home(cwd, "qwen", id, &home).unwrap();
        assert!(preview.body.contains("部署到服务器"));
        assert!(preview.body.contains("好的，先看部署方式"));
        assert!(preview_project_session_with_home(cwd, "qwen", other_id, &home).is_err());
        assert!(delete_project_session_with_home(cwd, "qwen", other_id, &home).is_err());
        assert!(chats.join(format!("{other_id}.jsonl")).exists());
        assert!(chats.join(format!("{other_id}.runtime.json")).exists());

        delete_project_session_with_home(cwd, "qwen", id, &home).unwrap();
        assert!(!chats.join(format!("{id}.jsonl")).exists());
        assert!(!chats.join(format!("{id}.runtime.json")).exists());
    }

    #[test]
    fn mimo_lists_previews_and_deletes_only_same_project() {
        let (_root, home) = temp_home();
        let cwd = "/Users/lucky/git/app";
        let db_dir = home.join(".local/share/mimocode");
        fs::create_dir_all(&db_dir).unwrap();
        let db = db_dir.join("mimocode.db");
        let connection = rusqlite::Connection::open(&db).unwrap();
        connection
            .execute(
                "CREATE TABLE session (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    parent_id TEXT,
                    slug TEXT NOT NULL,
                    directory TEXT NOT NULL,
                    title TEXT NOT NULL,
                    version TEXT NOT NULL,
                    time_created INTEGER NOT NULL,
                    time_updated INTEGER NOT NULL
                )",
                [],
            )
            .unwrap();
        connection
            .execute(
                "CREATE TABLE message (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
                    data TEXT NOT NULL
                )",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
                 VALUES ('ses_old', 'p1', NULL, 'old', '/Users/lucky/git/app', '本项目旧会话', '1', 1, 100),
                        ('ses_latest', 'p1', NULL, 'latest', '/Users/lucky/git/app/', '本项目最新会话', '1', 1, 300),
                        ('ses_child', 'p1', 'ses_latest', 'child', '/Users/lucky/git/app', '子会话', '1', 1, 400),
                        ('ses_other', 'p2', NULL, 'other', '/Users/lucky/git/app-other', '别的项目', '1', 1, 500)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO message (id, session_id, data)
                 VALUES ('msg_latest', 'ses_latest', '{}'),
                        ('msg_child', 'ses_child', '{}'),
                        ('msg_other', 'ses_other', '{}')",
                [],
            )
            .unwrap();
        drop(connection);

        let history = list_project_history_with_home(cwd, &home);
        let mimo = history.groups.iter().find(|group| group.tool == "mimo").unwrap();
        assert_eq!(mimo.label, "MiMo Code");
        assert_eq!(mimo.sessions.len(), 2);
        assert_eq!(mimo.sessions[0].id, "ses_latest");
        assert_eq!(mimo.sessions[0].title, "本项目最新会话");
        assert_eq!(mimo.sessions[1].id, "ses_old");

        let preview = preview_project_session_with_home(cwd, "mimo", "ses_latest", &home).unwrap();
        assert_eq!(preview.tool, "mimo");
        assert_eq!(preview.title, "本项目最新会话");
        assert!(preview.body.contains("本项目最新会话"));
        assert!(preview_project_session_with_home(cwd, "mimo", "ses_other", &home).is_err());
        assert!(delete_project_session_with_home(cwd, "mimo", "ses_other", &home).is_err());

        // 旧版/最小 schema 没有辅助表时也能删除。
        delete_project_session_with_home(cwd, "mimo", "ses_old", &home).unwrap();

        let setup = rusqlite::Connection::open(&db).unwrap();
        setup
            .execute_batch(
                "CREATE TABLE history_fts (
                    part_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL
                 );
                 CREATE TABLE permission_grant (
                    parent_session_id TEXT NOT NULL,
                    target TEXT NOT NULL,
                    PRIMARY KEY (parent_session_id, target)
                 );
                 CREATE TABLE event_sequence (
                    aggregate_id TEXT PRIMARY KEY,
                    seq INTEGER NOT NULL
                 );
                 CREATE TABLE event (
                    id TEXT PRIMARY KEY,
                    aggregate_id TEXT NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE
                 );
                 CREATE TABLE external_import (
                    source TEXT NOT NULL,
                    source_key TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    PRIMARY KEY (source, source_key)
                 );
                 CREATE TABLE claude_import (
                    source_uuid TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL
                 );
                 CREATE TABLE inbox (
                    id TEXT PRIMARY KEY,
                    receiver_session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
                    sender_session_id TEXT
                 );
                 INSERT INTO history_fts (part_id, session_id)
                    VALUES ('part_latest', 'ses_latest'),
                           ('part_child', 'ses_child'),
                           ('part_other', 'ses_other');
                 INSERT INTO permission_grant (parent_session_id, target)
                    VALUES ('ses_latest', 'file'),
                           ('holder', 'ses_child'),
                           ('ses_other', 'other'),
                           ('holder', 'ses_other');
                 INSERT INTO event_sequence (aggregate_id, seq)
                    VALUES ('ses_latest', 1), ('ses_child', 1), ('ses_other', 1);
                 INSERT INTO event (id, aggregate_id)
                    VALUES ('event_latest', 'ses_latest'),
                           ('event_child', 'ses_child'),
                           ('event_other', 'ses_other');
                 INSERT INTO external_import (source, source_key, session_id)
                    VALUES ('external', 'latest', 'ses_latest');
                 INSERT INTO claude_import (source_uuid, session_id)
                    VALUES ('claude-latest', 'ses_latest');
                 INSERT INTO inbox (id, receiver_session_id, sender_session_id)
                    VALUES ('inbox-sender', 'ses_other', 'ses_latest');",
            )
            .unwrap();
        drop(setup);

        delete_project_session_with_home(cwd, "mimo", "ses_latest", &home).unwrap();
        let remaining = rusqlite::Connection::open(&db).unwrap();
        let old_count: i64 = remaining
            .query_row("SELECT COUNT(*) FROM session WHERE id = 'ses_old'", [], |row| row.get(0))
            .unwrap();
        let latest_count: i64 = remaining
            .query_row("SELECT COUNT(*) FROM session WHERE id = 'ses_latest'", [], |row| row.get(0))
            .unwrap();
        let child_count: i64 = remaining
            .query_row("SELECT COUNT(*) FROM session WHERE id = 'ses_child'", [], |row| row.get(0))
            .unwrap();
        let other_count: i64 = remaining
            .query_row("SELECT COUNT(*) FROM session WHERE id = 'ses_other'", [], |row| row.get(0))
            .unwrap();
        let deleted_message_count: i64 = remaining
            .query_row(
                "SELECT COUNT(*) FROM message WHERE id IN ('msg_latest', 'msg_child')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let other_message_count: i64 = remaining
            .query_row("SELECT COUNT(*) FROM message WHERE id = 'msg_other'", [], |row| row.get(0))
            .unwrap();
        let deleted_history_count: i64 = remaining
            .query_row(
                "SELECT COUNT(*) FROM history_fts WHERE session_id IN ('ses_latest', 'ses_child')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let other_history_count: i64 = remaining
            .query_row("SELECT COUNT(*) FROM history_fts WHERE session_id = 'ses_other'", [], |row| row.get(0))
            .unwrap();
        let deleted_permission_count: i64 = remaining
            .query_row(
                "SELECT COUNT(*) FROM permission_grant
                 WHERE parent_session_id IN ('ses_latest', 'ses_child')
                    OR target IN ('ses_latest', 'ses_child')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let other_permission_count: i64 = remaining
            .query_row(
                "SELECT COUNT(*) FROM permission_grant
                 WHERE parent_session_id = 'ses_other' OR target = 'ses_other'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let deleted_event_count: i64 = remaining
            .query_row(
                "SELECT COUNT(*) FROM event WHERE aggregate_id IN ('ses_latest', 'ses_child')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let deleted_sequence_count: i64 = remaining
            .query_row(
                "SELECT COUNT(*) FROM event_sequence WHERE aggregate_id IN ('ses_latest', 'ses_child')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let other_event_count: i64 = remaining
            .query_row("SELECT COUNT(*) FROM event WHERE aggregate_id = 'ses_other'", [], |row| row.get(0))
            .unwrap();
        let other_sequence_count: i64 = remaining
            .query_row(
                "SELECT COUNT(*) FROM event_sequence WHERE aggregate_id = 'ses_other'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let import_count: i64 = remaining
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM external_import WHERE session_id = 'ses_latest')
                    + (SELECT COUNT(*) FROM claude_import WHERE session_id = 'ses_latest')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let sender_inbox_count: i64 = remaining
            .query_row(
                "SELECT COUNT(*) FROM inbox
                 WHERE receiver_session_id = 'ses_other' AND sender_session_id = 'ses_latest'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(old_count, 0);
        assert_eq!(latest_count, 0);
        assert_eq!(child_count, 0);
        assert_eq!(other_count, 1);
        assert_eq!(deleted_message_count, 0);
        assert_eq!(other_message_count, 1);
        assert_eq!(deleted_history_count, 0);
        assert_eq!(other_history_count, 1);
        assert_eq!(deleted_permission_count, 0);
        assert_eq!(other_permission_count, 2);
        assert_eq!(deleted_event_count, 0);
        assert_eq!(deleted_sequence_count, 0);
        assert_eq!(other_event_count, 1);
        assert_eq!(other_sequence_count, 1);
        assert_eq!(import_count, 2);
        assert_eq!(sender_inbox_count, 1);
    }

    #[test]
    fn lists_codex_and_opencode_sessions_for_project_cwd() {
        let (_root, home) = temp_home();
        let cwd = "/Users/lucky/git/app";
        let day = home.join(".codex/sessions/2026/08/12");
        fs::create_dir_all(&day).unwrap();
        fs::write(
            day.join("rollout-2026-08-12T18-41-01-019ff58f-ad10-76e0-9f8a-84951c2dd09c.jsonl"),
            r#"{"type":"session_meta","payload":{"session_id":"019ff58f-ad10-76e0-9f8a-84951c2dd09c","cwd":"/Users/lucky/git/app","timestamp":"2026-08-12T10:41:01.737Z","thread_source":"user"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"打tag吧"}]}}
"#,
        )
        .unwrap();
        fs::write(
            day.join("rollout-2026-08-12T17-36-44-019ff554-d177-79d3-9179-a6d4aa80032e.jsonl"),
            r#"{"type":"session_meta","payload":{"session_id":"019ff554-d177-79d3-9179-a6d4aa80032e","cwd":"/Users/lucky/git/app","thread_source":"subagent","source":{"subagent":{}}}}
"#,
        )
        .unwrap();

        let db_dir = home.join(".local/share/opencode");
        fs::create_dir_all(&db_dir).unwrap();
        let db = db_dir.join("opencode.db");
        let connection = rusqlite::Connection::open(&db).unwrap();
        connection
            .execute(
                "CREATE TABLE session (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    parent_id TEXT,
                    slug TEXT NOT NULL,
                    directory TEXT NOT NULL,
                    title TEXT NOT NULL,
                    version TEXT NOT NULL,
                    cost REAL NOT NULL DEFAULT 0,
                    tokens_input INTEGER NOT NULL DEFAULT 0,
                    tokens_output INTEGER NOT NULL DEFAULT 0,
                    tokens_reasoning INTEGER NOT NULL DEFAULT 0,
                    tokens_cache_read INTEGER NOT NULL DEFAULT 0,
                    tokens_cache_write INTEGER NOT NULL DEFAULT 0,
                    time_created INTEGER NOT NULL,
                    time_updated INTEGER NOT NULL
                )",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
                 VALUES ('ses_main', 'p1', NULL, 's', '/Users/lucky/git/app', '检查当前项目问题', '1', 1, 200),
                        ('ses_child', 'p1', 'ses_main', 'c', '/Users/lucky/git/app', '子会话', '1', 1, 300),
                        ('ses_other', 'p2', NULL, 'o', '/tmp/other', '别的项目', '1', 1, 400)",
                [],
            )
            .unwrap();

        let history = list_project_history_with_home(cwd, &home);
        let tools: Vec<_> = history.groups.iter().map(|group| group.tool.as_str()).collect();
        assert!(tools.contains(&"codex"));
        assert!(tools.contains(&"opencode"));
        let codex = history.groups.iter().find(|group| group.tool == "codex").unwrap();
        assert_eq!(codex.sessions.len(), 1);
        assert_eq!(codex.sessions[0].id, "019ff58f-ad10-76e0-9f8a-84951c2dd09c");
        assert_eq!(codex.sessions[0].title, "打tag吧");
        let opencode = history.groups.iter().find(|group| group.tool == "opencode").unwrap();
        assert_eq!(opencode.sessions.len(), 1);
        assert_eq!(opencode.sessions[0].title, "检查当前项目问题");
    }

    #[test]
    fn lists_codex_session_when_jsonl_is_truncated_mid_utf8() {
        let (_root, home) = temp_home();
        let cwd = "/Users/lucky/git/app";
        let day = home.join(".codex/sessions/2026/08/13");
        fs::create_dir_all(&day).unwrap();
        let mut body = String::from(
            r#"{"type":"session_meta","payload":{"session_id":"019ff999-aaaa-bbbb-cccc-ddddeeeeffff","cwd":"/Users/lucky/git/app","timestamp":"2026-08-13T10:00:00.000Z","thread_source":"user"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":""#,
        );
        body.extend(std::iter::repeat_n('测', 30_000));
        body.push_str("\"}]}}\n");
        fs::write(day.join("rollout-huge.jsonl"), body).unwrap();

        let history = list_project_history_with_home(cwd, &home);
        let codex = history.groups.iter().find(|group| group.tool == "codex").unwrap();
        assert_eq!(codex.sessions.len(), 1);
        assert_eq!(codex.sessions[0].id, "019ff999-aaaa-bbbb-cccc-ddddeeeeffff");
    }

    #[test]
    fn lists_opencode_session_even_when_other_projects_are_newer() {
        let (_root, home) = temp_home();
        let cwd = "/Users/lucky/git/app";
        let db_dir = home.join(".local/share/opencode");
        fs::create_dir_all(&db_dir).unwrap();
        let db = db_dir.join("opencode.db");
        let connection = rusqlite::Connection::open(&db).unwrap();
        connection
            .execute(
                "CREATE TABLE session (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    parent_id TEXT,
                    slug TEXT NOT NULL,
                    directory TEXT NOT NULL,
                    title TEXT NOT NULL,
                    version TEXT NOT NULL,
                    cost REAL NOT NULL DEFAULT 0,
                    tokens_input INTEGER NOT NULL DEFAULT 0,
                    tokens_output INTEGER NOT NULL DEFAULT 0,
                    tokens_reasoning INTEGER NOT NULL DEFAULT 0,
                    tokens_cache_read INTEGER NOT NULL DEFAULT 0,
                    tokens_cache_write INTEGER NOT NULL DEFAULT 0,
                    time_created INTEGER NOT NULL,
                    time_updated INTEGER NOT NULL
                )",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
                 VALUES ('ses_old', 'p1', NULL, 's', '/Users/lucky/git/app/', '本项目旧会话', '1', 1, 10)",
                [],
            )
            .unwrap();
        for index in 0..90 {
            connection
                .execute(
                    "INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
                     VALUES (?1, 'other', NULL, 'o', '/tmp/other', '别的项目', '1', 1, ?2)",
                    rusqlite::params![format!("ses_other_{index}"), 1000 + index],
                )
                .unwrap();
        }

        let history = list_project_history_with_home(cwd, &home);
        let opencode = history.groups.iter().find(|group| group.tool == "opencode").unwrap();
        assert_eq!(opencode.sessions.len(), 1);
        assert_eq!(opencode.sessions[0].id, "ses_old");
        assert_eq!(opencode.sessions[0].title, "本项目旧会话");
    }

    #[test]
    fn lists_gemini_and_agy_sessions_for_project_cwd() {
        let (_root, home) = temp_home();
        let cwd = "/Users/lucky/git/app";
        let chats = home.join(".gemini/tmp/app/chats");
        fs::create_dir_all(&chats).unwrap();
        fs::write(home.join(".gemini/tmp/app/.project_root"), format!("{cwd}\n")).unwrap();
        fs::write(
            chats.join("session-2026-03-30T05-40-3fff92c9.json"),
            r#"{"sessionId":"3fff92c9-d623-4845-befd-8ff6a3d55272","lastUpdated":"2026-03-30T05:51:05.919Z","messages":[{"type":"user","content":[{"text":"你是哪个模型"}]}]}"#,
        )
        .unwrap();
        fs::create_dir_all(home.join(".gemini/antigravity-cli/cache")).unwrap();
        fs::write(
            home.join(".gemini/antigravity-cli/history.jsonl"),
            format!(
                "{}\n{}\n",
                r#"{"display":"你可以生成图片吗","timestamp":100,"workspace":"/Users/lucky/git/app","conversationId":"conv-1"}"#,
                r#"{"display":"第二句","timestamp":200,"workspace":"/Users/lucky/git/app","conversationId":"conv-1"}"#,
            ),
        )
        .unwrap();

        let history = list_project_history_with_home(cwd, &home);
        let gemini = history.groups.iter().find(|group| group.tool == "gemini").unwrap();
        assert_eq!(gemini.sessions.len(), 1);
        assert!(gemini.sessions[0].id.ends_with("session-2026-03-30T05-40-3fff92c9.json"));
        assert_eq!(gemini.sessions[0].title, "你是哪个模型");
        let agy = history.groups.iter().find(|group| group.tool == "agy").unwrap();
        assert_eq!(agy.sessions.len(), 1);
        assert_eq!(agy.sessions[0].id, "conv-1");
        assert_eq!(agy.sessions[0].title, "你可以生成图片吗");
        assert_eq!(agy.sessions[0].at_ms, 200);
    }

    #[test]
    fn preview_and_delete_keep_to_the_same_project() {
        let (_root, home) = temp_home();
        let cwd = "/Users/lucky/git/app";
        let other = "/tmp/other";
        let claude_dir = home
            .join(".claude")
            .join("projects")
            .join(encode_claude_project_dir(cwd));
        fs::create_dir_all(&claude_dir).unwrap();
        let claude_id = "11111111-1111-1111-1111-111111111111";
        fs::write(
            claude_dir.join(format!("{claude_id}.jsonl")),
            r#"{"type":"user","isSidechain":false,"message":{"role":"user","content":"修好分屏空窗格"}}
{"type":"user","isSidechain":false,"message":{"role":"user","content":"再补预览删除"}}
"#,
        )
        .unwrap();

        let grok_dir = home
            .join(".grok")
            .join("sessions")
            .join(encode_grok_cwd(cwd))
            .join("sess-main");
        fs::create_dir_all(&grok_dir).unwrap();
        fs::write(
            grok_dir.join("summary.json"),
            r#"{"generated_title":"Where AI Reads Memory From","session_summary":"记忆从 Claude 目录读","last_active_at":"2026-08-13T06:43:07.801432Z"}"#,
        )
        .unwrap();
        fs::write(
            grok_dir.join("chat_history.jsonl"),
            r#"{"type":"user","content":[{"type":"text","text":"<user_query>\n1+2+3 做下吧\n</user_query>"}]}
"#,
        )
        .unwrap();

        let day = home.join(".codex/sessions/2026/08/13");
        fs::create_dir_all(&day).unwrap();
        fs::write(
            day.join("rollout-keep.jsonl"),
            r#"{"type":"session_meta","payload":{"session_id":"keep-codex","cwd":"/Users/lucky/git/app","timestamp":"2026-08-13T10:00:00.000Z","thread_source":"user"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"留下这条"}]}}
"#,
        )
        .unwrap();
        fs::write(
            day.join("rollout-drop.jsonl"),
            r#"{"type":"session_meta","payload":{"session_id":"drop-codex","cwd":"/Users/lucky/git/app","timestamp":"2026-08-13T11:00:00.000Z","thread_source":"user"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"删掉这条"}]}}
"#,
        )
        .unwrap();

        let chats = home.join(".gemini/tmp/app/chats");
        fs::create_dir_all(&chats).unwrap();
        fs::write(home.join(".gemini/tmp/app/.project_root"), format!("{cwd}\n")).unwrap();
        fs::write(
            chats.join("session-keep.json"),
            r#"{"messages":[{"type":"user","content":[{"text":"留下 Gemini"}]}]}"#,
        )
        .unwrap();
        fs::write(
            chats.join("session-drop.json"),
            r#"{"messages":[{"type":"user","content":[{"text":"删掉 Gemini"}]}]}"#,
        )
        .unwrap();

        fs::create_dir_all(home.join(".gemini/antigravity-cli/cache")).unwrap();
        fs::write(
            home.join(".gemini/antigravity-cli/history.jsonl"),
            format!(
                "{}\n{}\n",
                r#"{"display":"本项目会话","timestamp":100,"workspace":"/Users/lucky/git/app","conversationId":"conv-1"}"#,
                r#"{"display":"别的项目","timestamp":200,"workspace":"/tmp/other","conversationId":"conv-2"}"#,
            ),
        )
        .unwrap();

        let preview = preview_project_session_with_home(cwd, "claude", claude_id, &home).unwrap();
        assert!(preview.body.contains("修好分屏空窗格"));
        assert!(preview.body.contains("再补预览删除"));
        let grok = preview_project_session_with_home(cwd, "grok", "sess-main", &home).unwrap();
        assert!(grok.body.contains("1+2+3 做下吧"));

        delete_project_session_with_home(cwd, "claude", claude_id, &home).unwrap();
        delete_project_session_with_home(cwd, "grok", "sess-main", &home).unwrap();
        delete_project_session_with_home(cwd, "codex", "drop-codex", &home).unwrap();
        delete_project_session_with_home(cwd, "gemini", chats.join("session-drop.json").to_str().unwrap(), &home).unwrap();
        delete_project_session_with_home(cwd, "agy", "conv-1", &home).unwrap();

        let history = list_project_history_with_home(cwd, &home);
        let tools: Vec<_> = history.groups.iter().map(|group| group.tool.as_str()).collect();
        assert!(!tools.contains(&"claude"));
        assert!(!tools.contains(&"grok"));
        let codex = history.groups.iter().find(|group| group.tool == "codex").unwrap();
        assert_eq!(codex.sessions.len(), 1);
        assert_eq!(codex.sessions[0].id, "keep-codex");
        let gemini = history.groups.iter().find(|group| group.tool == "gemini").unwrap();
        assert_eq!(gemini.sessions.len(), 1);
        assert!(gemini.sessions[0].id.ends_with("session-keep.json"));
        assert!(history.groups.iter().all(|group| group.tool != "agy"));
        let remaining_agy = fs::read_to_string(home.join(".gemini/antigravity-cli/history.jsonl")).unwrap();
        assert!(remaining_agy.contains("conv-2"));
        assert!(!remaining_agy.contains("conv-1"));

        assert!(delete_project_session_with_home(other, "claude", claude_id, &home).is_err());
        assert!(delete_project_session_with_home(cwd, "claude", "../secret", &home).is_err());
        assert!(delete_project_session_with_home(cwd, "gemini", "/tmp/session-drop.json", &home).is_err());
        assert!(delete_project_session_with_home(cwd, "gemini", "../../../.ssh/id_rsa", &home).is_err());
    }

    #[test]
    fn delete_opencode_session_only_for_matching_cwd() {
        let (_root, home) = temp_home();
        let cwd = "/Users/lucky/git/app";
        let db_dir = home.join(".local/share/opencode");
        fs::create_dir_all(&db_dir).unwrap();
        let db = db_dir.join("opencode.db");
        let connection = rusqlite::Connection::open(&db).unwrap();
        connection
            .execute(
                "CREATE TABLE session (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    parent_id TEXT,
                    slug TEXT NOT NULL,
                    directory TEXT NOT NULL,
                    title TEXT NOT NULL,
                    version TEXT NOT NULL,
                    time_created INTEGER NOT NULL,
                    time_updated INTEGER NOT NULL
                )",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
                 VALUES ('ses_main', 'p1', NULL, 's', '/Users/lucky/git/app', '本项目', '1', 1, 200),
                        ('ses_other', 'p2', NULL, 'o', '/tmp/other', '别的项目', '1', 1, 400)",
                [],
            )
            .unwrap();

        let preview = preview_project_session_with_home(cwd, "opencode", "ses_main", &home).unwrap();
        assert_eq!(preview.title, "本项目");
        delete_project_session_with_home(cwd, "opencode", "ses_main", &home).unwrap();
        assert!(delete_project_session_with_home(cwd, "opencode", "ses_other", &home).is_err());
        let history = list_project_history_with_home(cwd, &home);
        assert!(history.groups.iter().all(|group| group.tool != "opencode"));
        let leftover: i64 = rusqlite::Connection::open(&db)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM session WHERE id = 'ses_other'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(leftover, 1);
    }

}
