//! 探测本机已安装、可从登录壳 PATH 找到的 AI CLI。

use std::collections::HashSet;
use std::process::{Command, Stdio};

pub fn is_safe_cli_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    (1..=32).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-' || *byte == b'_')
}

pub fn filter_safe_cli_names(names: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    names
        .iter()
        .filter(|name| is_safe_cli_name(name) && seen.insert(name.as_str()))
        .cloned()
        .collect()
}

pub fn parse_installed_cli_output(stdout: &str, allowed: &[String]) -> Vec<String> {
    let allowed_set: HashSet<&str> = allowed.iter().map(String::as_str).collect();
    let mut found = HashSet::new();
    let mut capturing = false;
    for line in stdout.lines() {
        let text = line.trim();
        if text == "__CLI_OK__" {
            capturing = true;
            continue;
        }
        if text == "__CLI_END__" {
            break;
        }
        if capturing && allowed_set.contains(text) {
            found.insert(text.to_string());
        }
    }
    allowed
        .iter()
        .filter(|name| found.contains(name.as_str()))
        .cloned()
        .collect()
}

pub fn list_installed_cli_names(names: &[String]) -> Vec<String> {
    let allowed = filter_safe_cli_names(names);
    if allowed.is_empty() {
        return Vec::new();
    }
    #[cfg(windows)]
    {
        return allowed
            .into_iter()
            .filter(|name| windows_cli_on_path(name))
            .collect();
    }
    #[cfg(not(windows))]
    {
        unix_list_installed_clis(&allowed)
    }
}

#[cfg(windows)]
fn windows_cli_on_path(name: &str) -> bool {
    Command::new("where")
        .arg(name)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn unix_list_installed_clis(allowed: &[String]) -> Vec<String> {
    let mut script = String::from("printf '%s\\n' '__CLI_OK__';");
    for name in allowed {
        script.push_str(&format!(
            " if command -v {name} >/dev/null 2>&1; then printf '%s\\n' '{name}'; fi;"
        ));
    }
    script.push_str(" printf '%s\\n' '__CLI_END__'");
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let output = Command::new(shell)
        .args(["-ilc", &script])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();
    match output {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            parse_installed_cli_output(&stdout, allowed)
        }
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_cli_name_rejects_injection() {
        assert!(is_safe_cli_name("claude"));
        assert!(is_safe_cli_name("opencode"));
        assert!(!is_safe_cli_name(""));
        assert!(!is_safe_cli_name("Claude"));
        assert!(!is_safe_cli_name("foo;rm"));
        assert!(!is_safe_cli_name("../claude"));
        assert!(!is_safe_cli_name("claude && reboot"));
    }

    #[test]
    fn parse_output_uses_markers_and_keeps_registry_order() {
        let allowed = vec![
            "claude".to_string(),
            "grok".to_string(),
            "codex".to_string(),
        ];
        let stdout = "zsh noise\n__CLI_OK__\ncodex\nclaude\nnot-a-tool\n__CLI_END__\nbogus\n";
        assert_eq!(
            parse_installed_cli_output(stdout, &allowed),
            vec!["claude".to_string(), "codex".to_string()]
        );
    }

    #[test]
    fn filter_safe_names_drops_bad_and_duplicate() {
        let names = vec![
            "claude".to_string(),
            "claude".to_string(),
            "bad name".to_string(),
            "grok".to_string(),
        ];
        assert_eq!(
            filter_safe_cli_names(&names),
            vec!["claude".to_string(), "grok".to_string()]
        );
    }
}
