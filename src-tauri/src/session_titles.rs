//! 会话别名。各 CLI 自己生成的标题多半是第一句话，用户想给重要会话另起个名。
//!
//! 只存 Roster 自己的一层映射，不改任何 CLI 的历史文件。条目数、标题长度和
//! 键的形状都有上限，损坏或超量的条目直接丢掉，不让这张表长成无底洞。

use std::collections::BTreeMap;
use std::path::PathBuf;

const MAX_ENTRIES: usize = 500;
const MAX_TITLE_CHARS: usize = 80;
const MAX_ID_CHARS: usize = 200;

pub type SessionTitles = BTreeMap<String, String>;

fn store_path() -> PathBuf {
    crate::data_dir().join("session-titles.json")
}

fn valid_tool(tool: &str) -> bool {
    !tool.is_empty()
        && tool.len() <= 32
        && tool
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' || ch == '_')
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.chars().count() <= MAX_ID_CHARS
        && !id.chars().any(|ch| ch.is_control() || ch == '\u{0}')
}

fn entry_key(tool: &str, id: &str) -> Result<String, String> {
    let tool = tool.trim().to_ascii_lowercase();
    let id = id.trim();
    if !valid_tool(&tool) || !valid_id(id) {
        return Err("会话标识无效".into());
    }
    Ok(format!("{tool}:{id}"))
}

fn clean_title(title: &str) -> String {
    title
        .chars()
        .filter(|ch| !ch.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(MAX_TITLE_CHARS)
        .collect()
}

pub fn load() -> SessionTitles {
    let raw: SessionTitles = crate::load_json_or_backup(&store_path());
    raw.into_iter()
        .filter(|(key, title)| {
            key.split_once(':')
                .is_some_and(|(tool, id)| valid_tool(tool) && valid_id(id))
                && !title.trim().is_empty()
        })
        .map(|(key, title)| (key, clean_title(&title)))
        .take(MAX_ENTRIES)
        .collect()
}

/// 空标题表示恢复成 CLI 自己的标题。返回保存后的整张表。
pub fn set(tool: &str, id: &str, title: &str) -> Result<SessionTitles, String> {
    let key = entry_key(tool, id)?;
    let mut titles = load();
    let cleaned = clean_title(title);
    if cleaned.is_empty() {
        titles.remove(&key);
    } else {
        if !titles.contains_key(&key) && titles.len() >= MAX_ENTRIES {
            return Err(format!("最多只能重命名 {MAX_ENTRIES} 条会话"));
        }
        titles.insert(key, cleaned);
    }
    let data = serde_json::to_string_pretty(&titles).map_err(|error| error.to_string())?;
    crate::atomic_write(&store_path(), data.as_bytes()).map_err(|error| {
        crate::log_error!("写 session-titles.json 失败：{error}");
        error.to_string()
    })?;
    Ok(titles)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bad_keys_and_bounds_titles() {
        assert!(entry_key("claude", "abc").is_ok());
        assert!(entry_key("CLAUDE", " abc ").is_ok(), "工具名大小写归一");
        assert!(entry_key("", "abc").is_err());
        assert!(entry_key("cl aude", "abc").is_err());
        assert!(entry_key("claude", "").is_err());
        assert!(entry_key("claude", "a\u{0}b").is_err());
        assert!(entry_key("claude", &"x".repeat(201)).is_err());

        assert_eq!(clean_title("  改\u{0}好的名字  "), "改好的名字");
        assert_eq!(
            clean_title(&"名".repeat(200)).chars().count(),
            MAX_TITLE_CHARS
        );
        assert_eq!(clean_title("   "), "");
    }
}
