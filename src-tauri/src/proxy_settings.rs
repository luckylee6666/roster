use portable_pty::CommandBuilder;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

const DEFAULT_NO_PROXY: &str = "localhost,127.0.0.1,::1";
const PROXY_ENV_KEYS: &[&str] = &[
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProxySettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub no_proxy: String,
}

pub struct ProxySettingsLock(pub Mutex<()>);

fn settings_path() -> PathBuf {
    crate::data_dir().join("proxy-settings.json")
}

fn allowed_scheme(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("socks5://")
        || lower.starts_with("socks5h://")
        || lower.starts_with("socks4://")
}

pub fn normalize_proxy_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if trimmed.chars().any(|ch| ch.is_whitespace() || ch == '<' || ch == '>' || ch == '\\') {
        return Err("代理地址含有非法字符".into());
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    if !allowed_scheme(&with_scheme) {
        return Err("只支持 http、https、socks5、socks5h、socks4 代理".into());
    }
    let rest = with_scheme
        .split_once("://")
        .map(|(_, host)| host)
        .unwrap_or("");
    let host = rest.split('@').next_back().unwrap_or("");
    if !proxy_host_ok(host) {
        return Err("代理地址缺少主机".into());
    }
    Ok(with_scheme.trim_end_matches('/').to_string())
}

fn proxy_host_ok(hostport: &str) -> bool {
    let hostport = hostport
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .trim();
    if hostport.is_empty() || hostport.starts_with('/') {
        return false;
    }
    if hostport.starts_with('[') {
        return hostport.contains(']');
    }
    if let Some((host, port)) = hostport.rsplit_once(':') {
        return !host.is_empty() && !port.is_empty() && port.chars().all(|ch| ch.is_ascii_digit());
    }
    true
}

pub fn normalize_no_proxy(raw: &str) -> String {
    let joined = raw
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(",");
    if joined.is_empty() {
        DEFAULT_NO_PROXY.into()
    } else {
        joined
    }
}

pub fn normalize_settings(raw: ProxySettings) -> Result<ProxySettings, String> {
    let parsed = normalize_proxy_url(&raw.url);
    if raw.enabled {
        let url = parsed?;
        if url.is_empty() {
            return Err("启用代理时需要填写地址".into());
        }
        return Ok(ProxySettings {
            enabled: true,
            url,
            no_proxy: normalize_no_proxy(&raw.no_proxy),
        });
    }
    Ok(ProxySettings {
        enabled: false,
        url: parsed.unwrap_or_default(),
        no_proxy: normalize_no_proxy(&raw.no_proxy),
    })
}

fn is_socks_proxy(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("socks4://") || lower.starts_with("socks5://") || lower.starts_with("socks5h://")
}

fn env_pairs(settings: &ProxySettings) -> Vec<(&'static str, String)> {
    if !settings.enabled || settings.url.is_empty() {
        return Vec::new();
    }
    let socks = is_socks_proxy(&settings.url);
    PROXY_ENV_KEYS
        .iter()
        .filter_map(|key| {
            if key.eq_ignore_ascii_case("NO_PROXY") {
                return Some((*key, settings.no_proxy.clone()));
            }
            if socks && (key.eq_ignore_ascii_case("HTTP_PROXY") || key.eq_ignore_ascii_case("HTTPS_PROXY")) {
                return None;
            }
            Some((*key, settings.url.clone()))
        })
        .collect()
}

fn posix_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn env_file_path() -> PathBuf {
    #[cfg(windows)]
    {
        crate::data_dir().join("proxy-env.ps1")
    }
    #[cfg(not(windows))]
    {
        crate::data_dir().join("proxy-env.sh")
    }
}

pub fn write_env_file(settings: &ProxySettings) -> Result<PathBuf, String> {
    let path = env_file_path();
    if !settings.enabled || settings.url.is_empty() {
        let _ = std::fs::remove_file(&path);
        return Ok(path);
    }
    #[cfg(windows)]
    let body = {
        let mut text = String::from("# Vibe Coding Manager terminal proxy\n");
        for (key, value) in env_pairs(settings) {
            text.push_str(&format!(
                "$env:{key} = '{}'\n",
                value.replace('\'', "''")
            ));
        }
        text
    };
    #[cfg(not(windows))]
    let body = {
        let mut text = String::from("# Vibe Coding Manager terminal proxy\n");
        for (key, value) in env_pairs(settings) {
            text.push_str(&format!("export {key}={}\n", posix_single_quote(&value)));
        }
        text
    };
    crate::atomic_write(&path, body.as_bytes()).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(path)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyShellHook {
    pub enabled: bool,
    pub command: String,
}

pub fn shell_hook() -> ProxyShellHook {
    let settings = load_settings();
    if !settings.enabled || settings.url.is_empty() {
        let _ = std::fs::remove_file(env_file_path());
        return ProxyShellHook {
            enabled: false,
            command: String::new(),
        };
    }
    match write_env_file(&settings) {
        Ok(path) => ProxyShellHook {
            enabled: true,
            command: {
                #[cfg(windows)]
                {
                    format!(". '{}'", path.display().to_string().replace('\'', "''"))
                }
                #[cfg(not(windows))]
                {
                    format!(". {}", posix_single_quote(&path.to_string_lossy()))
                }
            },
        },
        Err(_) => ProxyShellHook {
            enabled: false,
            command: String::new(),
        },
    }
}

pub fn redact_proxy_url(url: &str) -> String {
    if let Some((scheme, rest)) = url.split_once("://") {
        if let Some((_, host)) = rest.split_once('@') {
            return format!("{scheme}://***@{host}");
        }
    }
    url.to_string()
}

pub fn load_settings() -> ProxySettings {
    let loaded = crate::load_json_or_backup::<ProxySettings>(&settings_path());
    normalize_settings(loaded).unwrap_or_default()
}

pub fn save_settings(raw: ProxySettings) -> Result<ProxySettings, String> {
    let settings = normalize_settings(raw)?;
    let data = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    crate::atomic_write(&settings_path(), data.as_bytes()).map_err(|error| {
        crate::log_error!("写 proxy-settings.json 失败：{error}");
        error.to_string()
    })?;
    let _ = write_env_file(&settings);
    Ok(settings)
}

pub fn apply_to_command(cmd: &mut CommandBuilder) {
    let settings = load_settings();
    for (key, value) in env_pairs(&settings) {
        cmd.env(key, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_host_port_and_rejects_bad_schemes() {
        assert_eq!(
            normalize_proxy_url("127.0.0.1:7890").unwrap(),
            "http://127.0.0.1:7890"
        );
        assert_eq!(
            normalize_proxy_url("socks5://127.0.0.1:7891").unwrap(),
            "socks5://127.0.0.1:7891"
        );
        assert!(normalize_proxy_url("javascript:alert(1)").is_err());
        assert!(normalize_proxy_url("file:///tmp").is_err());
        assert!(normalize_settings(ProxySettings {
            enabled: true,
            url: String::new(),
            no_proxy: String::new(),
        })
        .is_err());
        let off = normalize_settings(ProxySettings {
            enabled: false,
            url: "not a url".into(),
            no_proxy: String::new(),
        })
        .unwrap();
        assert!(!off.enabled);
        assert!(off.url.is_empty());
        let socks = env_pairs(&ProxySettings {
            enabled: true,
            url: "socks5://127.0.0.1:7891".into(),
            no_proxy: DEFAULT_NO_PROXY.into(),
        });
        let keys: Vec<_> = socks.iter().map(|(key, _)| *key).collect();
        assert!(keys.contains(&"ALL_PROXY"));
        assert!(!keys.contains(&"HTTP_PROXY"));
    }

    #[test]
    fn redacts_userinfo_from_proxy_url() {
        assert_eq!(
            redact_proxy_url("http://user:secret@127.0.0.1:7890"),
            "http://***@127.0.0.1:7890"
        );
    }
}
