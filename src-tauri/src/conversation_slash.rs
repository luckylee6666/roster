//! 对话工作台斜杠补全：按当前项目动态发现本机 CLI 已加载的 skills / 自定义命令。
//! 前端只传项目 ID 和静态 provider ID；路径与可执行文件都由后端解析。

use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MAX_COMMANDS: usize = 80;
const MAX_MODELS: usize = 40;
const MAX_EFFORTS: usize = 8;
const MAX_SKILL_FILE_BYTES: usize = 64 * 1024;
const MAX_INSPECT_BYTES: usize = 2 * 1024 * 1024;
const MAX_MODEL_LIST_BYTES: usize = 64 * 1024;
const MAX_EFFORT_LIST_BYTES: usize = 16 * 1024;
const MAX_CODEX_MODELS_CACHE_BYTES: usize = 512 * 1024;
const MAX_SCANNED_FILES: usize = 240;
const INSPECT_TIMEOUT: Duration = Duration::from_secs(8);
const MODEL_LIST_TIMEOUT: Duration = Duration::from_secs(5);
const EFFORT_LIST_TIMEOUT: Duration = Duration::from_secs(4);
const MAX_SLASH_ARGS_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSlashCommand {
    pub id: String,
    pub title: String,
    pub hint: String,
    pub takes_args: bool,
    pub action: String,
    pub source: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSlashList {
    pub commands: Vec<ConversationSlashCommand>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConversationSlashKind {
    Skill,
    Command,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConversationSlashInvocation {
    pub id: String,
    pub args: String,
    pub kind: ConversationSlashKind,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationModel {
    pub id: String,
    pub label: String,
    pub current: bool,
    /// 这个模型支持的推理强度。各家 CLI 大多问不出来，问得出来的（Codex 的
    /// models_cache）才填；空表示"不知道"，前端就不按模型过滤。
    pub efforts: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationModelList {
    pub models: Vec<ConversationModel>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationEffort {
    pub id: String,
    pub label: String,
    pub current: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationEffortList {
    pub efforts: Vec<ConversationEffort>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InspectReport {
    #[serde(default)]
    skills: Vec<InspectSkill>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InspectSkill {
    name: Option<String>,
    description: Option<String>,
    #[serde(default)]
    user_invocable: Option<bool>,
    invocable_as: Option<String>,
    compatibility_status: Option<String>,
}

pub fn list_models(provider_id: &str, project_path: &str) -> Result<ConversationModelList, String> {
    let provider = normalize_provider(provider_id)?;
    let cwd = crate::codex_chat::validate_project_path(project_path)?;
    let models = match provider {
        "codex" => parse_codex_models_cache(&read_codex_models_cache().unwrap_or_default()).0,
        "claude" => {
            let raw = capture_cli_help("claude", &cwd).unwrap_or_default();
            parse_help_model_aliases(&raw)
        }
        _ => {
            let Some(args) = model_list_args(provider) else {
                return Ok(ConversationModelList { models: Vec::new() });
            };
            let Ok(binary) = crate::cli_detect::resolve_registered_cli_bin(provider) else {
                return Ok(ConversationModelList { models: Vec::new() });
            };
            let raw = run_cli_output(
                &binary,
                args,
                &cwd,
                MODEL_LIST_TIMEOUT,
                MAX_MODEL_LIST_BYTES,
                false,
                true,
            )
            .unwrap_or_default();
            parse_cli_models(&raw)
        }
    };
    Ok(ConversationModelList { models })
}

/// 只有真正提供「列出模型」子命令的 CLI 才会被调用。
/// Claude / Codex 把多余参数当成 prompt，不能对它们跑 `models`。
fn model_list_args(provider: &str) -> Option<&'static [&'static str]> {
    match provider {
        "grok" | "agy" | "opencode" | "mimo" => Some(&["models"]),
        _ => None,
    }
}

pub fn list_efforts(
    provider_id: &str,
    project_path: &str,
) -> Result<ConversationEffortList, String> {
    let provider = normalize_provider(provider_id)?;
    let cwd = crate::codex_chat::validate_project_path(project_path)?;
    let efforts = match provider {
        "codex" => parse_codex_models_cache(&read_codex_models_cache().unwrap_or_default()).1,
        "claude" | "grok" => {
            let Ok(binary) = crate::cli_detect::resolve_registered_cli_bin(provider) else {
                return Ok(ConversationEffortList {
                    efforts: Vec::new(),
                });
            };
            let raw = run_cli_output(
                &binary,
                &["--effort", "__roster_probe__"],
                &cwd,
                EFFORT_LIST_TIMEOUT,
                MAX_EFFORT_LIST_BYTES,
                false,
                true,
            )
            .unwrap_or_default();
            parse_cli_efforts(&raw)
        }
        "agy" => {
            let raw = capture_cli_help("agy", &cwd).unwrap_or_default();
            parse_cli_efforts(&raw)
        }
        "opencode" | "mimo" => {
            let Ok(binary) = crate::cli_detect::resolve_registered_cli_bin(provider) else {
                return Ok(ConversationEffortList {
                    efforts: Vec::new(),
                });
            };
            let raw = run_cli_output(
                &binary,
                &["run", "--help"],
                &cwd,
                EFFORT_LIST_TIMEOUT,
                MAX_EFFORT_LIST_BYTES,
                false,
                true,
            )
            .unwrap_or_default();
            parse_variant_efforts(&raw)
        }
        _ => Vec::new(),
    };
    Ok(ConversationEffortList { efforts })
}

fn capture_cli_help(provider: &str, cwd: &Path) -> Option<String> {
    let binary = crate::cli_detect::resolve_registered_cli_bin(provider).ok()?;
    let args: &[&str] = if provider == "agy" {
        &["-h"]
    } else {
        &["--help"]
    };
    run_cli_output(
        &binary,
        args,
        cwd,
        EFFORT_LIST_TIMEOUT,
        MAX_MODEL_LIST_BYTES,
        false,
        true,
    )
}

pub fn list_slash_commands(
    provider_id: &str,
    project_path: &str,
) -> Result<ConversationSlashList, String> {
    let provider = normalize_provider(provider_id)?;
    let cwd = crate::codex_chat::validate_project_path(project_path)?;
    let home = dirs::home_dir().ok_or_else(|| "找不到用户目录".to_string())?;
    let mut commands = Vec::new();
    if provider == "grok" {
        if let Some(from_inspect) = grok_inspect_commands(&cwd) {
            commands = from_inspect;
        }
    }
    if commands.is_empty() {
        commands = scan_provider_commands(provider, &cwd, &home);
    }
    commands.truncate(MAX_COMMANDS);
    Ok(ConversationSlashList { commands })
}

pub fn resolve_slash_invocation(
    provider_id: &str,
    project_path: &str,
    prompt: &str,
) -> Result<Option<ConversationSlashInvocation>, String> {
    if prompt.contains(['\r', '\n']) {
        return Ok(None);
    }
    let Some(body) = prompt.strip_prefix('/') else {
        return Ok(None);
    };
    let (id, args) = body
        .split_once(char::is_whitespace)
        .map(|(id, args)| (id, args.trim()))
        .unwrap_or((body, ""));
    if !valid_command_id(id)
        || args.len() > MAX_SLASH_ARGS_BYTES
        || args.chars().any(|ch| ch.is_control() && ch != '\t')
    {
        return Ok(None);
    }
    let list = list_slash_commands(provider_id, project_path)?;
    Ok(list
        .commands
        .into_iter()
        .find(|command| command.id == id)
        .map(|command| ConversationSlashInvocation {
            id: command.id,
            args: args.to_string(),
            kind: if command.source == "command" {
                ConversationSlashKind::Command
            } else {
                ConversationSlashKind::Skill
            },
        }))
}

fn normalize_provider(id: &str) -> Result<&'static str, String> {
    match id.trim().to_ascii_lowercase().as_str() {
        "claude" => Ok("claude"),
        "grok" => Ok("grok"),
        "codex" => Ok("codex"),
        "agy" => Ok("agy"),
        "opencode" => Ok("opencode"),
        "qwen" => Ok("qwen"),
        "mimo" => Ok("mimo"),
        _ => Err("这个 CLI 还未接入对话模式".into()),
    }
}

fn valid_command_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    matches!(bytes, [first, rest @ ..]
        if (1..=64).contains(&bytes.len())
            && first.is_ascii_alphanumeric()
            && rest.iter().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-' | b'.' | b'/')
            })
            && !value.split('/').any(|part| part.is_empty() || matches!(part, "." | "..")))
}

fn command_from_parts(id: &str, title: &str, source: &str) -> Option<ConversationSlashCommand> {
    let id = id.trim();
    if !valid_command_id(id) {
        return None;
    }
    let title = title.trim().chars().take(80).collect::<String>();
    Some(ConversationSlashCommand {
        hint: format!("/{id}"),
        id: id.to_string(),
        title: if title.is_empty() {
            id.to_string()
        } else {
            title
        },
        takes_args: true,
        action: "skill".into(),
        source: source.chars().take(32).collect(),
    })
}

pub fn commands_from_grok_inspect_json(raw: &str) -> Vec<ConversationSlashCommand> {
    let Ok(report) = serde_json::from_str::<InspectReport>(raw) else {
        return Vec::new();
    };
    let mut commands = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for skill in report.skills {
        if skill.user_invocable == Some(false) {
            continue;
        }
        if skill
            .compatibility_status
            .as_deref()
            .is_some_and(|status| status != "enabled")
        {
            continue;
        }
        let id = skill
            .invocable_as
            .as_deref()
            .or(skill.name.as_deref())
            .unwrap_or("");
        let Some(command) =
            command_from_parts(id, skill.description.as_deref().unwrap_or(""), "inspect")
        else {
            continue;
        };
        if seen.insert(command.id.clone()) {
            commands.push(command);
        }
        if commands.len() >= MAX_COMMANDS {
            break;
        }
    }
    commands
}

fn grok_inspect_commands(cwd: &Path) -> Option<Vec<ConversationSlashCommand>> {
    let binary = crate::cli_detect::resolve_registered_cli_bin("grok").ok()?;
    let raw = run_cli_stdout(
        &binary,
        &["inspect", "--json"],
        cwd,
        INSPECT_TIMEOUT,
        MAX_INSPECT_BYTES,
    )?;
    let commands = commands_from_grok_inspect_json(&raw);
    if commands.is_empty() {
        None
    } else {
        Some(commands)
    }
}

pub fn parse_cli_models(raw: &str) -> Vec<ConversationModel> {
    let trimmed = raw.trim();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        let from_json = parse_cli_models_json(trimmed);
        if !from_json.is_empty() {
            return from_json;
        }
    }
    let glued = parse_glued_model_lines(trimmed);
    if glued.len() >= 2 {
        return glued;
    }
    parse_cli_models_text(trimmed)
}

pub fn parse_glued_model_lines(raw: &str) -> Vec<ConversationModel> {
    let mut ids: Vec<(String, String, bool)> = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Some(split_at) = trimmed.char_indices().find_map(|(index, ch)| {
            if index == 0 || !ch.is_ascii_uppercase() {
                return None;
            }
            let prev = trimmed.as_bytes().get(index.saturating_sub(1)).copied()?;
            (prev.is_ascii_alphanumeric() || prev == b'-' || prev == b']').then_some(index)
        }) else {
            continue;
        };
        let Some(id) = normalize_model_id(&trimmed[..split_at]) else {
            continue;
        };
        let label = trimmed[split_at..].trim();
        let label = if label.is_empty() {
            id.clone()
        } else {
            label.chars().take(80).collect()
        };
        ids.push((id, label, false));
    }
    finish_models(ids)
}

pub fn parse_help_model_aliases(raw: &str) -> Vec<ConversationModel> {
    let section = flag_help_section(raw, "--model");
    let mut ids: Vec<(String, String, bool)> = Vec::new();
    let mut rest = section;
    while let Some(start) = rest.find('\'') {
        rest = &rest[start + 1..];
        let Some(end) = rest.find('\'') else {
            break;
        };
        let token = &rest[..end];
        rest = &rest[end + 1..];
        if let Some(id) = normalize_model_id(token) {
            ids.push((id.clone(), id, false));
        }
    }
    finish_models(ids)
}

fn flag_help_section<'a>(help: &'a str, flag: &str) -> &'a str {
    let Some(start) = help.find(flag) else {
        return "";
    };
    let rest = &help[start..];
    let rel = rest[flag.len()..]
        .find("\n  --")
        .map(|index| flag.len() + index)
        .unwrap_or(rest.len());
    &rest[..rel.min(1_200)]
}

fn parse_cli_models_json(raw: &str) -> Vec<ConversationModel> {
    let mut ids: Vec<(String, String, bool)> = Vec::new();
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) {
        let default = value
            .get("default")
            .or_else(|| value.get("defaultModel"))
            .and_then(serde_json::Value::as_str)
            .and_then(normalize_model_id);
        let list = if let Some(models) = value.get("models") {
            models
        } else {
            &value
        };
        if let Some(items) = list.as_array() {
            for item in items {
                match item {
                    serde_json::Value::String(id) => {
                        if let Some(id) = normalize_model_id(id) {
                            ids.push((id.clone(), id, false));
                        }
                    }
                    serde_json::Value::Object(map) => {
                        let id = map
                            .get("id")
                            .or_else(|| map.get("name"))
                            .or_else(|| map.get("model"))
                            .and_then(serde_json::Value::as_str)
                            .and_then(normalize_model_id);
                        let label = map
                            .get("label")
                            .or_else(|| map.get("title"))
                            .or_else(|| map.get("displayName"))
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("")
                            .trim();
                        if let Some(id) = id {
                            let label = if label.is_empty() {
                                id.clone()
                            } else {
                                label.chars().take(80).collect()
                            };
                            ids.push((id, label, false));
                        }
                    }
                    _ => {}
                }
            }
        }
        if let Some(default) = default {
            for item in &mut ids {
                if item.0 == default {
                    item.2 = true;
                }
            }
        }
    }
    finish_models(ids)
}

pub fn parse_cli_models_text(raw: &str) -> Vec<ConversationModel> {
    let mut default_id = None;
    let mut ids: Vec<(String, String, bool)> = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("Default model:") {
            default_id = rest.split_whitespace().next().and_then(normalize_model_id);
            continue;
        }
        if trimmed.ends_with(':') {
            continue;
        }
        let mut token = trimmed;
        if token.starts_with('*') || token.starts_with('-') || token.starts_with('•') {
            token = token[token.chars().next().map(|ch| ch.len_utf8()).unwrap_or(1)..].trim();
        }
        if let Some((head, rest)) = token.split_once(['.', ')', ':']) {
            if head.chars().all(|ch| ch.is_ascii_digit()) {
                token = rest.trim();
            }
        }
        if token.split_whitespace().count() >= 4 {
            continue;
        }
        let first = token.split_whitespace().next().unwrap_or("");
        let first = first.trim_end_matches([',', ';', ')']);
        if first.chars().any(|ch| ch.is_ascii_uppercase()) {
            continue;
        }
        let Some(id) = normalize_model_id(first) else {
            continue;
        };
        let current = trimmed.contains("(default)") || default_id.as_deref() == Some(id.as_str());
        ids.push((id.clone(), id, current));
    }
    if let Some(default) = default_id {
        for item in &mut ids {
            if item.0 == default {
                item.2 = true;
            }
        }
    }
    finish_models(ids)
}

fn finish_models(ids: Vec<(String, String, bool)>) -> Vec<ConversationModel> {
    let mut seen = std::collections::HashSet::new();
    let mut models = Vec::new();
    for (id, label, current) in ids {
        if !seen.insert(id.clone()) {
            continue;
        }
        models.push(ConversationModel {
            id,
            label,
            current,
            efforts: Vec::new(),
        });
        if models.len() >= MAX_MODELS {
            break;
        }
    }
    models
}

pub fn parse_cli_efforts(raw: &str) -> Vec<ConversationEffort> {
    let lowered = raw.to_ascii_lowercase();
    let rest = if let Some(index) = lowered.find("use one of:") {
        &raw[index + "use one of:".len()..]
    } else if let Some(index) = lowered.find("valid values:") {
        &raw[index + "valid values:".len()..]
    } else if let Some(index) = lowered.find("(low") {
        &raw[index..]
    } else {
        return Vec::new();
    };
    let list = rest.split(['\n', ';']).next().unwrap_or(rest);
    finish_efforts(
        list.split([',', '|', '/', '(', ')'])
            .filter_map(normalize_effort_id)
            .map(|id| (id.clone(), effort_label(&id), false)),
    )
}

pub fn parse_variant_efforts(raw: &str) -> Vec<ConversationEffort> {
    let section = flag_help_section(raw, "--variant");
    let lowered = section.to_ascii_lowercase();
    let Some(index) = lowered.find("e.g.") else {
        return Vec::new();
    };
    let examples = &section[index + "e.g.".len()..];
    let examples = examples.split(')').next().unwrap_or(examples);
    finish_efforts(
        examples
            .split(|ch: char| ch == ',' || ch.is_whitespace())
            .filter_map(normalize_effort_id)
            .map(|id| (id.clone(), effort_label(&id), false)),
    )
}

fn finish_efforts(
    ids: impl IntoIterator<Item = (String, String, bool)>,
) -> Vec<ConversationEffort> {
    let mut seen = std::collections::HashSet::new();
    let mut efforts = Vec::new();
    for (id, label, current) in ids {
        if !seen.insert(id.clone()) {
            continue;
        }
        efforts.push(ConversationEffort { id, label, current });
        if efforts.len() >= MAX_EFFORTS {
            break;
        }
    }
    efforts
}

pub fn parse_codex_models_cache(raw: &str) -> (Vec<ConversationModel>, Vec<ConversationEffort>) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return (Vec::new(), Vec::new());
    };
    let mut models: Vec<(String, String, bool)> = Vec::new();
    let mut effort_ids = Vec::new();
    let mut effort_seen = std::collections::HashSet::new();
    let mut per_model: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    let Some(items) = value.get("models").and_then(serde_json::Value::as_array) else {
        return (Vec::new(), Vec::new());
    };
    for item in items {
        let visibility = item
            .get("visibility")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("list");
        if visibility == "hide" {
            continue;
        }
        let Some(id) = item
            .get("slug")
            .or_else(|| item.get("id"))
            .and_then(serde_json::Value::as_str)
            .and_then(normalize_model_id)
        else {
            continue;
        };
        let label = item
            .get("display_name")
            .or_else(|| item.get("displayName"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .trim();
        let label = if label.is_empty() {
            id.clone()
        } else {
            label.chars().take(80).collect()
        };
        let mut mine = Vec::new();
        if let Some(levels) = item
            .get("supported_reasoning_levels")
            .and_then(serde_json::Value::as_array)
        {
            for level in levels {
                if let Some(effort) = level
                    .get("effort")
                    .and_then(serde_json::Value::as_str)
                    .and_then(normalize_effort_id)
                {
                    if !mine.contains(&effort) {
                        mine.push(effort.clone());
                    }
                    if effort_seen.insert(effort.clone()) {
                        effort_ids.push(effort);
                    }
                }
            }
        }
        per_model.insert(id.clone(), mine);
        models.push((id, label, false));
    }
    const ORDER: [&str; 6] = ["low", "medium", "high", "xhigh", "max", "ultra"];
    effort_ids.sort_by_key(|id| ORDER.iter().position(|item| *item == id).unwrap_or(100));
    let mut models = finish_models(models);
    for model in &mut models {
        model.efforts = per_model.remove(&model.id).unwrap_or_default();
    }
    (
        models,
        finish_efforts(
            effort_ids
                .into_iter()
                .map(|id| (id.clone(), effort_label(&id), false)),
        ),
    )
}

fn read_codex_models_cache() -> Option<String> {
    let path = dirs::home_dir()?.join(".codex/models_cache.json");
    let meta = fs::symlink_metadata(&path).ok()?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return None;
    }
    if meta.len() > MAX_CODEX_MODELS_CACHE_BYTES as u64 {
        return None;
    }
    let file = File::open(&path).ok()?;
    let mut buf = Vec::new();
    file.take((MAX_CODEX_MODELS_CACHE_BYTES + 1) as u64)
        .read_to_end(&mut buf)
        .ok()?;
    if buf.len() > MAX_CODEX_MODELS_CACHE_BYTES || buf.contains(&0) {
        return None;
    }
    String::from_utf8(buf).ok()
}

pub fn normalize_effort_id(value: &str) -> Option<String> {
    let value = value
        .trim()
        .trim_end_matches(['.', ';'])
        .to_ascii_lowercase();
    if value.is_empty() || value.len() > 16 || value.starts_with('-') {
        return None;
    }
    if !value.chars().next()?.is_ascii_alphabetic() {
        return None;
    }
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    {
        return None;
    }
    Some(value)
}

fn effort_label(id: &str) -> String {
    match id {
        "xhigh" => "最高".to_string(),
        "high" => "高".to_string(),
        "medium" => "中".to_string(),
        "low" => "低".to_string(),
        "minimal" => "最低".to_string(),
        "max" => "最大".to_string(),
        "ultra" => "极限".to_string(),
        _ => id.to_string(),
    }
}

pub fn normalize_model_id(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 80 || value.starts_with('-') {
        return None;
    }
    if !value.chars().next()?.is_ascii_alphanumeric() {
        return None;
    }
    if !value.chars().all(|ch| {
        ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '+' | '-' | '[' | ']' | '/')
    }) {
        return None;
    }
    Some(value.to_string())
}

fn run_cli_stdout(
    binary: &Path,
    args: &[&str],
    cwd: &Path,
    timeout: Duration,
    max_bytes: usize,
) -> Option<String> {
    run_cli_output(binary, args, cwd, timeout, max_bytes, true, false)
}

fn run_cli_output(
    binary: &Path,
    args: &[&str],
    cwd: &Path,
    timeout: Duration,
    max_bytes: usize,
    require_success: bool,
    include_stderr: bool,
) -> Option<String> {
    // Do not use pipes here. A CLI can fill a pipe before it exits, or leave a
    // descendant holding the write end after the leader exits; either case can
    // otherwise keep this blocking probe stuck forever. Temporary files let us
    // reap the whole process group before bounded reads.
    let mut stdout = tempfile::tempfile().ok()?;
    let stdout_for_child = stdout.try_clone().ok()?;
    let mut stderr = include_stderr.then(tempfile::tempfile).transpose().ok()?;
    let stderr_for_child = stderr.as_ref().and_then(|file| file.try_clone().ok());
    if include_stderr && stderr_for_child.is_none() {
        return None;
    }

    let mut command = Command::new(binary);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_for_child))
        .stderr(stderr_for_child.map_or_else(Stdio::null, Stdio::from));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
        // Keep a noisy probe from filling its temporary output file before the
        // polling timeout fires. Descendants inherit this limit as well.
        let output_limit = max_bytes.saturating_add(1) as libc::rlim_t;
        unsafe {
            command.pre_exec(move || {
                let limit = libc::rlimit {
                    rlim_cur: output_limit,
                    rlim_max: output_limit,
                };
                if libc::setrlimit(libc::RLIMIT_FSIZE, &limit) == 0 {
                    Ok(())
                } else {
                    Err(std::io::Error::last_os_error())
                }
            });
        }
    }
    let mut child = command.spawn().ok()?;
    let process_tree = match crate::codex_chat::register_process_tree(&child) {
        Ok(process_tree) => process_tree,
        Err(_) => {
            terminate_group(&mut child);
            let _ = child.wait();
            return None;
        }
    };
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                process_tree.terminate();
                terminate_group(&mut child);
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => {
                process_tree.terminate();
                terminate_group(&mut child);
                let _ = child.wait();
                return None;
            }
        }
    };
    // The leader may already be reaped while a background descendant still
    // owns these files. It must not outlive this bounded discovery probe.
    process_tree.terminate();
    terminate_group(&mut child);

    let mut bytes = Vec::new();
    stdout.seek(SeekFrom::Start(0)).ok()?;
    stdout
        .take((max_bytes + 1) as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    if let Some(stderr) = stderr.as_mut() {
        let mut stderr_bytes = Vec::new();
        stderr.seek(SeekFrom::Start(0)).ok()?;
        stderr
            .take((max_bytes + 1) as u64)
            .read_to_end(&mut stderr_bytes)
            .ok()?;
        if !stderr_bytes.is_empty() {
            if !bytes.is_empty() {
                bytes.push(b'\n');
            }
            bytes.extend(stderr_bytes);
        }
    }
    let limit = if include_stderr {
        max_bytes.saturating_mul(2)
    } else {
        max_bytes
    };
    if (require_success && !status.success()) || bytes.len() > limit {
        return None;
    }
    String::from_utf8(bytes).ok()
}

fn terminate_group(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        let process_id = child.id();
        signal_group(process_id, libc::SIGTERM);
        let deadline = Instant::now() + Duration::from_millis(100);
        while group_exists(process_id) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        if group_exists(process_id) {
            signal_group(process_id, libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
}

#[cfg(unix)]
fn signal_group(process_id: u32, signal: libc::c_int) {
    let Ok(process_group_id) = i32::try_from(process_id) else {
        return;
    };
    unsafe {
        libc::kill(-process_group_id, signal);
    }
}

#[cfg(unix)]
fn group_exists(process_id: u32) -> bool {
    let Ok(process_group_id) = i32::try_from(process_id) else {
        return false;
    };
    unsafe {
        libc::kill(-process_group_id, 0) == 0
            || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
}

fn scan_provider_commands(
    provider: &str,
    project: &Path,
    home: &Path,
) -> Vec<ConversationSlashCommand> {
    let project = project
        .canonicalize()
        .unwrap_or_else(|_| project.to_path_buf());
    let home = home.canonicalize().unwrap_or_else(|_| home.to_path_buf());
    let mut commands = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut scanned = 0;
    for root in skill_roots(provider, &project, &home) {
        collect_from_root(
            provider,
            &root,
            &project,
            &home,
            &mut commands,
            &mut seen,
            &mut scanned,
        );
        if commands.len() >= MAX_COMMANDS || scanned >= MAX_SCANNED_FILES {
            break;
        }
    }
    commands
}

fn skill_roots(provider: &str, project: &Path, home: &Path) -> Vec<PathBuf> {
    match provider {
        "grok" => vec![
            project.join(".grok/skills"),
            project.join(".agents/skills"),
            home.join(".grok/skills"),
            home.join(".agents/skills"),
        ],
        "claude" | "agy" => vec![
            project.join(".claude/commands"),
            project.join(".claude/skills"),
            home.join(".claude/commands"),
            home.join(".claude/skills"),
        ],
        "codex" => vec![
            project.join(".agents/skills"),
            project.join(".codex/skills"),
            home.join(".agents/skills"),
            home.join(".codex/skills"),
        ],
        "opencode" => vec![
            project.join(".opencode/commands"),
            project.join(".opencode/skills"),
            project.join(".agents/skills"),
            project.join(".claude/skills"),
            home.join(".config/opencode/commands"),
            home.join(".config/opencode/skills"),
            home.join(".agents/skills"),
            home.join(".claude/skills"),
        ],
        "qwen" => vec![
            project.join(".qwen/commands"),
            project.join(".qwen/skills"),
            home.join(".qwen/commands"),
            home.join(".qwen/skills"),
        ],
        "mimo" => vec![
            project.join(".mimocode/command"),
            project.join(".mimocode/commands"),
            project.join(".mimocode/skills"),
            project.join(".claude/commands"),
            project.join(".claude/skills"),
            project.join(".agents/skills"),
            home.join(".config/mimocode/command"),
            home.join(".config/mimocode/commands"),
            home.join(".config/mimocode/skills"),
            home.join(".claude/commands"),
            home.join(".claude/skills"),
            home.join(".agents/skills"),
        ],
        _ => Vec::new(),
    }
}

fn path_is_allowed(path: &Path, project: &Path, home: &Path) -> bool {
    let Ok(canonical) = path.canonicalize() else {
        return false;
    };
    canonical.starts_with(project) || canonical.starts_with(home)
}

fn collect_from_root(
    provider: &str,
    root: &Path,
    project: &Path,
    home: &Path,
    commands: &mut Vec<ConversationSlashCommand>,
    seen: &mut std::collections::HashSet<String>,
    scanned: &mut usize,
) {
    let Ok(meta) = fs::symlink_metadata(root) else {
        return;
    };
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return;
    }
    if !path_is_allowed(root, project, home) {
        return;
    }
    let skill_root = root.file_name().and_then(|name| name.to_str()) == Some("skills");
    let scan_root = CommandScanRoot {
        provider,
        path: root,
        skill_root,
    };
    walk_dir(&scan_root, root, 0, commands, seen, scanned);
}

struct CommandScanRoot<'a> {
    provider: &'a str,
    path: &'a Path,
    skill_root: bool,
}

fn walk_dir(
    scan_root: &CommandScanRoot<'_>,
    dir: &Path,
    depth: usize,
    commands: &mut Vec<ConversationSlashCommand>,
    seen: &mut std::collections::HashSet<String>,
    scanned: &mut usize,
) {
    if depth > 3 || commands.len() >= MAX_COMMANDS || *scanned >= MAX_SCANNED_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if commands.len() >= MAX_COMMANDS || *scanned >= MAX_SCANNED_FILES {
            return;
        }
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            walk_dir(scan_root, &path, depth + 1, commands, seen, scanned);
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        *scanned += 1;
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let command = if scan_root.skill_root && name.eq_ignore_ascii_case("skill.md") {
            read_skill_command(&path)
        } else if !scan_root.skill_root && name.ends_with(".md") {
            command_id_from_path(scan_root.provider, scan_root.path, &path)
                .and_then(|id| read_markdown_command(&path, &id))
        } else if !scan_root.skill_root && name.ends_with(".toml") {
            command_id_from_path(scan_root.provider, scan_root.path, &path)
                .and_then(|id| read_toml_command(&path, &id))
        } else {
            None
        };
        if let Some(command) = command {
            if seen.insert(command.id.clone()) {
                commands.push(command);
            }
        }
    }
}

fn command_id_from_path(provider: &str, root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let mut parts = relative
        .components()
        .map(|component| match component {
            std::path::Component::Normal(value) => value.to_str().map(str::to_string),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    let file_name = parts.pop()?;
    let stem = Path::new(&file_name).file_stem()?.to_str()?.to_string();
    if stem.is_empty() {
        return None;
    }
    parts.push(stem);
    let separator = if matches!(provider, "opencode" | "mimo") {
        "/"
    } else {
        ":"
    };
    let id = parts.join(separator);
    valid_command_id(&id).then_some(id)
}

fn read_bounded_file(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut buf = Vec::new();
    file.take((MAX_SKILL_FILE_BYTES + 1) as u64)
        .read_to_end(&mut buf)
        .ok()?;
    if buf.len() > MAX_SKILL_FILE_BYTES || buf.contains(&0) {
        return None;
    }
    String::from_utf8(buf).ok()
}

fn parse_frontmatter(text: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let trimmed = text.trim_start();
    let Some(body) = trimmed.strip_prefix("---") else {
        return map;
    };
    let body = body.strip_prefix('\n').unwrap_or(body);
    let Some(end) = body.find("\n---") else {
        return map;
    };
    for line in body[..end].lines() {
        let line = line.trim();
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase().replace('_', "-");
        let value = value
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .trim()
            .to_string();
        if !key.is_empty() {
            map.insert(key, value);
        }
    }
    map
}

fn is_invocable(fields: &std::collections::HashMap<String, String>) -> bool {
    !matches!(
        fields
            .get("user-invocable")
            .or_else(|| fields.get("userinvocable"))
            .map(String::as_str),
        Some("false" | "no" | "0")
    )
}

fn read_skill_command(path: &Path) -> Option<ConversationSlashCommand> {
    let text = read_bounded_file(path)?;
    let fields = parse_frontmatter(&text);
    if !is_invocable(&fields) {
        return None;
    }
    let fallback = path
        .parent()
        .and_then(|parent| parent.file_name())
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let id = fields
        .get("name")
        .map(String::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback);
    let title = fields
        .get("description")
        .or_else(|| fields.get("argument-hint"))
        .map(String::as_str)
        .unwrap_or(id);
    command_from_parts(id, title, "skill")
}

fn read_markdown_command(path: &Path, fallback: &str) -> Option<ConversationSlashCommand> {
    let text = read_bounded_file(path)?;
    let fields = parse_frontmatter(&text);
    if !is_invocable(&fields) {
        return None;
    }
    let id = fields
        .get("name")
        .cloned()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_string());
    let title = fields
        .get("description")
        .cloned()
        .unwrap_or_else(|| id.clone());
    command_from_parts(&id, &title, "command")
}

fn read_toml_command(path: &Path, fallback: &str) -> Option<ConversationSlashCommand> {
    let text = read_bounded_file(path)?;
    let mut description = String::new();
    let mut name = fallback.to_string();
    for line in text.lines().take(40) {
        let line = line.trim();
        if let Some(value) = line.strip_prefix("description") {
            if let Some(rest) = value.split_once('=') {
                description = rest
                    .1
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'')
                    .to_string();
            }
        }
        if let Some(value) = line.strip_prefix("name") {
            if let Some(rest) = value.split_once('=') {
                let parsed = rest
                    .1
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'')
                    .to_string();
                if !parsed.is_empty() {
                    name = parsed;
                }
            }
        }
    }
    command_from_parts(&name, &description, "command")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn grok_inspect_json_keeps_invocable_skills_and_qualified_names() {
        let raw = r#"{
            "skills": [
                {"name":"review","description":"审查改动","userInvocable":true},
                {"name":"hidden","description":"不出现","userInvocable":false},
                {"name":"code-review","description":"内置冲突","userInvocable":true,"invocableAs":"bundled:code-review"},
                {"name":"bad name","description":"非法"},
                {"name":"disabled","description":"关掉","userInvocable":true,"compatibilityStatus":"disabled"}
            ]
        }"#;
        let commands = commands_from_grok_inspect_json(raw);
        assert_eq!(
            commands
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["review", "bundled:code-review"]
        );
        assert_eq!(commands[0].title, "审查改动");
        assert_eq!(commands[0].action, "skill");
    }

    #[test]
    fn scans_skill_md_and_command_files_but_skips_disabled() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let project = root.path().join("project");
        fs::create_dir_all(project.join(".claude/skills/deploy")).unwrap();
        fs::create_dir_all(project.join(".claude/commands")).unwrap();
        fs::create_dir_all(home.join(".claude/skills/private")).unwrap();
        fs::write(
            project.join(".claude/skills/deploy/SKILL.md"),
            "---\nname: deploy\ndescription: 发布当前项目\nuser-invocable: true\n---\n",
        )
        .unwrap();
        fs::write(
            project.join(".claude/commands/review.md"),
            "---\ndescription: 看一眼 diff\n---\n",
        )
        .unwrap();
        fs::write(
            home.join(".claude/skills/private/SKILL.md"),
            "---\nname: secret\ndescription: 不该出现\nuser-invocable: false\n---\n",
        )
        .unwrap();
        let commands = scan_provider_commands("claude", &project, &home);
        let ids: Vec<_> = commands.iter().map(|item| item.id.as_str()).collect();
        assert!(ids.contains(&"deploy"));
        assert!(ids.contains(&"review"));
        assert!(!ids.contains(&"secret"));
    }

    #[test]
    fn nested_commands_keep_provider_namespace_and_skill_references_stay_hidden() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let project = root.path().join("project");
        fs::create_dir_all(project.join(".opencode/commands/team")).unwrap();
        fs::create_dir_all(project.join(".opencode/skills/review")).unwrap();
        fs::create_dir_all(project.join(".qwen/commands/git")).unwrap();
        fs::create_dir_all(home.join(".config/opencode/commands")).unwrap();
        fs::write(
            project.join(".opencode/commands/team/review.md"),
            "---\ndescription: 团队审查\n---\n",
        )
        .unwrap();
        fs::write(
            project.join(".opencode/commands/review.md"),
            "---\ndescription: 原生命令优先\n---\n",
        )
        .unwrap();
        fs::write(
            home.join(".config/opencode/commands/review.md"),
            "---\ndescription: 全局命令不应覆盖项目\n---\n",
        )
        .unwrap();
        fs::write(
            project.join(".opencode/skills/review/SKILL.md"),
            "---\nname: review\ndescription: 审查改动\n---\n",
        )
        .unwrap();
        fs::write(
            project.join(".opencode/skills/review/reference.md"),
            "---\nname: leaked-reference\n---\n",
        )
        .unwrap();
        fs::write(
            project.join(".qwen/commands/git/commit.md"),
            "---\ndescription: 提交改动\n---\n",
        )
        .unwrap();

        let opencode = scan_provider_commands("opencode", &project, &home);
        let opencode_ids = opencode
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>();
        assert!(opencode_ids.contains(&"team/review"));
        assert!(opencode_ids.contains(&"review"));
        assert!(!opencode_ids.contains(&"leaked-reference"));
        assert_eq!(
            opencode
                .iter()
                .find(|item| item.id == "review")
                .map(|item| item.source.as_str()),
            Some("command")
        );
        assert_eq!(
            opencode
                .iter()
                .find(|item| item.id == "review")
                .map(|item| item.title.as_str()),
            Some("原生命令优先")
        );

        let qwen = scan_provider_commands("qwen", &project, &home);
        assert!(qwen.iter().any(|item| item.id == "git:commit"));
    }

    #[cfg(unix)]
    #[test]
    fn skill_scan_does_not_follow_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let project = root.path().join("project");
        let outside = root.path().join("outside/SKILL.md");
        fs::create_dir_all(outside.parent().unwrap()).unwrap();
        fs::create_dir_all(project.join(".claude/skills")).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::write(&outside, "---\nname: leak\ndescription: 外面\n---\n").unwrap();
        std::os::unix::fs::symlink(
            outside.parent().unwrap(),
            project.join(".claude/skills/leak"),
        )
        .unwrap();
        let commands = scan_provider_commands("claude", &project, &home);
        assert!(commands.iter().all(|item| item.id != "leak"));
    }

    #[test]
    fn parses_grok_models_text_and_ignores_login_prose() {
        let models = parse_cli_models(
            "You are logged in with grok.com.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n",
        );
        assert_eq!(
            models
                .iter()
                .map(|item| (item.id.as_str(), item.current))
                .collect::<Vec<_>>(),
            [("grok-4.6", true), ("grok-4.5", false)]
        );
        let from_json =
            parse_cli_models(r#"{"default":"sonnet","models":["opus","sonnet","haiku"]}"#);
        assert_eq!(from_json[1].id, "sonnet");
        assert!(from_json[1].current);
        assert!(normalize_model_id("qwen3.8-max[1M]").is_some());
        assert!(normalize_model_id("opencode/gpt-5.6").is_some());
        assert!(normalize_model_id("--sandbox").is_none());
    }

    #[test]
    fn only_safe_models_subcommands_are_invoked() {
        assert_eq!(model_list_args("grok"), Some(&["models"][..]));
        assert_eq!(model_list_args("agy"), Some(&["models"][..]));
        assert_eq!(model_list_args("opencode"), Some(&["models"][..]));
        assert_eq!(model_list_args("mimo"), Some(&["models"][..]));
        assert_eq!(model_list_args("qwen"), None);
        assert_eq!(model_list_args("claude"), None);
        assert_eq!(model_list_args("codex"), None);
    }

    #[test]
    fn all_conversation_providers_accept_dynamic_slash_discovery() {
        for provider in ["claude", "grok", "codex", "opencode", "agy", "qwen", "mimo"] {
            assert_eq!(normalize_provider(provider).unwrap(), provider);
        }
        assert!(normalize_provider("../../bin/sh").is_err());
    }

    #[test]
    fn resolves_only_commands_rediscovered_for_the_same_provider_and_project() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        fs::create_dir_all(project.join(".qwen/commands")).unwrap();
        fs::write(
            project.join(".qwen/commands/roster-test-qwen-only-7f.md"),
            "---\ndescription: 审查当前改动\n---\n检查代码",
        )
        .unwrap();
        let project = project.to_string_lossy();
        let invocation =
            resolve_slash_invocation("qwen", &project, "/roster-test-qwen-only-7f 检查暂存区")
                .unwrap()
                .unwrap();
        assert_eq!(invocation.id, "roster-test-qwen-only-7f");
        assert_eq!(invocation.args, "检查暂存区");
        assert_eq!(invocation.kind, ConversationSlashKind::Command);
        assert!(resolve_slash_invocation("qwen", &project, "/missing 参数")
            .unwrap()
            .is_none());
        assert!(
            resolve_slash_invocation("qwen", &project, "/roster-test-qwen-only-7f\n参数")
                .unwrap()
                .is_none()
        );
        assert!(
            resolve_slash_invocation("opencode", &project, "/roster-test-qwen-only-7f 参数")
                .unwrap()
                .is_none()
        );
        assert!(resolve_slash_invocation(
            "qwen",
            &project,
            &format!(
                "/roster-test-qwen-only-7f {}",
                "a".repeat(MAX_SLASH_ARGS_BYTES + 1)
            ),
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn parses_grok_effort_levels_from_cli_error() {
        let efforts = parse_cli_efforts(
            "Error: --effort/--reasoning-effort: unknown effort level 'nope'; use one of: xhigh, high, medium, low\n",
        );
        assert_eq!(
            efforts
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["xhigh", "high", "medium", "low"]
        );
        assert_eq!(efforts[0].label, "最高");
        assert!(normalize_effort_id("HIGH").as_deref() == Some("high"));
        assert!(normalize_effort_id("--sandbox").is_none());
        assert!(parse_cli_efforts("unexpected argument --effort").is_empty());
        let claude = parse_cli_efforts(
            "Warning: Unknown --effort value 'nope' — ignoring it. Valid values: low, medium, high, xhigh, max.\n",
        );
        assert_eq!(
            claude
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["low", "medium", "high", "xhigh", "max"]
        );
        let agy = parse_cli_efforts(
            "  --effort  Reasoning effort for the current CLI session (low|medium|high)\n  --model  Model\n",
        );
        assert_eq!(
            agy.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(),
            ["low", "medium", "high"]
        );
        let variants = parse_variant_efforts(
            "  --variant  model variant (provider-specific reasoning effort, e.g., high, max, minimal)\n  --thinking  show thinking\n",
        );
        assert_eq!(
            variants
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["high", "max", "minimal"]
        );
        assert_eq!(variants[2].label, "最低");
    }

    #[test]
    fn parses_agy_glued_models_and_claude_help_aliases() {
        let models = parse_cli_models(
            "Fetching available models...\ngemini-3.7-flash-highGemini 3.7 Flash (High)\nclaude-sonnet-4-6Claude Sonnet 4.6 (Thinking)\ngpt-oss-120b-mediumGPT-OSS 120B (Medium)\n",
        );
        assert_eq!(
            models
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            [
                "gemini-3.7-flash-high",
                "claude-sonnet-4-6",
                "gpt-oss-120b-medium"
            ]
        );
        assert_eq!(models[1].label, "Claude Sonnet 4.6 (Thinking)");
        let aliases = parse_help_model_aliases(
            "  --model <model>  Provide an alias (e.g.\n                    'fable', 'opus', or 'sonnet') or a\n                    full name (e.g. 'claude-fable-5').\n  --name <name>  Set a display name\n",
        );
        assert_eq!(
            aliases
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["fable", "opus", "sonnet", "claude-fable-5"]
        );
    }

    #[test]
    fn parses_codex_models_cache_and_hides_internal_models() {
        let (models, efforts) = parse_codex_models_cache(
            r#"{
                "models": [
                    {"slug":"gpt-5.6-sol","display_name":"GPT-5.6-Sol","visibility":"list","supported_reasoning_levels":[{"effort":"low"},{"effort":"xhigh"},{"effort":"max"}]},
                    {"slug":"codex-auto-review","display_name":"hidden","visibility":"hide","supported_reasoning_levels":[{"effort":"ultra"}]}
                ]
            }"#,
        );
        assert_eq!(
            models
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["gpt-5.6-sol"]
        );
        assert_eq!(models[0].label, "GPT-5.6-Sol");
        assert_eq!(
            efforts
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["low", "xhigh", "max"]
        );
        assert!(!efforts.iter().any(|item| item.id == "ultra"));
    }

    #[cfg(unix)]
    #[test]
    fn cli_output_reads_large_stdout_without_pipe_deadlock() {
        let project = tempfile::tempdir().expect("temp project");
        let output = run_cli_output(
            Path::new("/bin/sh"),
            &["-c", "head -c 131072 /dev/zero | tr '\\000' x"],
            project.path(),
            Duration::from_secs(2),
            256 * 1024,
            true,
            false,
        )
        .expect("large output should finish before the timeout");
        assert_eq!(output.len(), 131_072);
        assert!(output.bytes().all(|byte| byte == b'x'));
    }

    #[cfg(unix)]
    #[test]
    fn cli_output_reaps_descendant_that_inherits_output_handles() {
        let project = tempfile::tempdir().expect("temp project");
        let leader_pid_path = project.path().join("leader.pid");
        let child_pid_path = project.path().join("child.pid");
        let script = format!(
            "printf '%s\\n' \"$$\" > '{leader}'; sleep 30 & child=$!; printf '%s\\n' \"$child\" > '{child}'; printf done",
            leader = leader_pid_path.display(),
            child = child_pid_path.display(),
        );
        let started = Instant::now();
        let output = run_cli_output(
            Path::new("/bin/sh"),
            &["-c", &script],
            project.path(),
            Duration::from_secs(2),
            16 * 1024,
            true,
            false,
        )
        .expect("leader exit must not wait for an inherited output handle");
        assert_eq!(output, "done");
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "descendant cleanup should be prompt"
        );
        let leader_pid = fs::read_to_string(&leader_pid_path)
            .expect("leader pid")
            .trim()
            .parse::<u32>()
            .expect("numeric leader pid");
        let child_pid = fs::read_to_string(&child_pid_path)
            .expect("child pid")
            .trim()
            .parse::<i32>()
            .expect("numeric child pid");
        let cleanup_deadline = Instant::now() + Duration::from_secs(1);
        while group_exists(leader_pid) && Instant::now() < cleanup_deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            !group_exists(leader_pid),
            "leader process group must be gone after the probe returns"
        );
        unsafe {
            assert_eq!(
                libc::kill(child_pid, 0),
                -1,
                "background descendant must be reaped"
            );
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ESRCH)
            );
        }
    }
}
