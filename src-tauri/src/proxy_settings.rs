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
    if trimmed
        .chars()
        .any(|ch| ch.is_whitespace() || ch == '<' || ch == '>' || ch == '\\')
    {
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
    let hostport = hostport.split(['/', '?', '#']).next().unwrap_or("").trim();
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
    lower.starts_with("socks4://")
        || lower.starts_with("socks5://")
        || lower.starts_with("socks5h://")
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
            if socks
                && (key.eq_ignore_ascii_case("HTTP_PROXY")
                    || key.eq_ignore_ascii_case("HTTPS_PROXY"))
            {
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
        let mut text = String::from("# Roster terminal proxy\n");
        for (key, value) in env_pairs(settings) {
            text.push_str(&format!("$env:{key} = '{}'\n", value.replace('\'', "''")));
        }
        text
    };
    #[cfg(not(windows))]
    let body = {
        let mut text = String::from("# Roster terminal proxy\n");
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

/// 给不经过 PTY 的后台子进程应用同一套代理设置。对话工作台里的 Codex
/// app-server 走这条路径，避免“终端里能联网、对话里不能”的配置漂移。
pub fn apply_to_std_command(cmd: &mut std::process::Command) {
    let settings = load_settings();
    for (key, value) in env_pairs(&settings) {
        cmd.env(key, value);
    }
}

/// macOS HTTP clients can inherit System Settings while Codex's WebSocket
/// dialer only sees proxy environment variables. Bridge that gap for Codex
/// only, without overriding an explicit Roster/process proxy or touching TLS.
pub fn apply_codex_system_proxy(cmd: &mut std::process::Command) {
    #[cfg(target_os = "macos")]
    {
        let explicit = PROXY_ENV_KEYS.iter().any(|key| {
            !key.eq_ignore_ascii_case("NO_PROXY")
                && (std::env::var_os(key).is_some()
                    || cmd.get_envs().any(|(k, _)| k == std::ffi::OsStr::new(key)))
        });
        if explicit {
            return;
        }
        if let Some(output) = read_macos_proxy_settings() {
            if let Some(url) = macos_https_proxy(&output) {
                cmd.env("HTTPS_PROXY", &url).env("https_proxy", &url);
                // Preserve explicit bypass settings; always keep localhost IPC local.
                if std::env::var_os("NO_PROXY").is_none()
                    && std::env::var_os("no_proxy").is_none()
                    && !cmd
                        .get_envs()
                        .any(|(k, _)| k == "NO_PROXY" || k == "no_proxy")
                {
                    let bypass = macos_proxy_bypass(&output);
                    cmd.env("NO_PROXY", &bypass).env("no_proxy", &bypass);
                }
                crate::log_info!("Codex 后台连接沿用 macOS 系统 HTTPS 代理");
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = cmd;
}

#[cfg(any(target_os = "macos", test))]
fn macos_https_proxy(output: &str) -> Option<String> {
    let field = |name: &str| {
        output.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            (key.trim() == name).then(|| value.trim())
        })
    };
    if field("HTTPSEnable")? != "1" || field("ProxyAutoConfigEnable") == Some("1") {
        return None;
    }
    let host = field("HTTPSProxy")?;
    let port = field("HTTPSPort")?.parse::<u16>().ok().filter(|p| *p > 0)?;
    if host.is_empty()
        || host.len() > 253
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-:[]".contains(&b))
    {
        return None;
    }
    let host = if host.contains(':') || host.contains(['[', ']']) {
        let address = host
            .strip_prefix('[')
            .and_then(|h| h.strip_suffix(']'))
            .unwrap_or(host);
        format!("[{}]", address.parse::<std::net::Ipv6Addr>().ok()?)
    } else {
        host.to_string()
    };
    Some(format!("http://{host}:{port}"))
}

#[cfg(any(target_os = "macos", test))]
fn macos_proxy_bypass(output: &str) -> String {
    let mut entries = vec![DEFAULT_NO_PROXY.to_string()];
    let mut in_exceptions = false;
    for line in output.lines() {
        let line = line.trim();
        if line.starts_with("ExceptionsList :") {
            in_exceptions = true;
            continue;
        }
        if in_exceptions && line == "}" {
            in_exceptions = false;
        }
        if !in_exceptions {
            continue;
        }
        if let Some((index, host)) = line.split_once(':') {
            let host = host.trim();
            if index.trim().parse::<usize>().is_ok()
                && !host.is_empty()
                && host
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b".-:*[]/".contains(&b))
            {
                entries.push(host.to_string());
            }
        }
    }
    entries.join(",")
}

#[cfg(target_os = "macos")]
fn read_macos_proxy_settings() -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let mut child = Command::new("/usr/sbin/scutil")
        .arg("--proxy")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let mut bytes = Vec::new();
                child
                    .stdout
                    .take()?
                    .take(8193)
                    .read_to_end(&mut bytes)
                    .ok()?;
                return (bytes.len() <= 8192)
                    .then(|| String::from_utf8(bytes).ok())
                    .flatten();
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_proxy_bridge_requires_enabled_https_and_valid_endpoint() {
        let settings =
            "HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7897\nProxyAutoConfigEnable : 0";
        assert_eq!(
            macos_https_proxy(settings),
            Some("http://127.0.0.1:7897".into())
        );
        assert!(
            macos_https_proxy(&settings.replace("HTTPSEnable : 1", "HTTPSEnable : 0")).is_none()
        );
        assert!(macos_https_proxy(
            &settings.replace("ProxyAutoConfigEnable : 0", "ProxyAutoConfigEnable : 1")
        )
        .is_none());
        assert!(macos_https_proxy(&settings.replace("7897", "0")).is_none());
        assert!(macos_https_proxy(&settings.replace("127.0.0.1", "user:password@host")).is_none());
        assert!(macos_https_proxy(&settings.replace("127.0.0.1", "host/path")).is_none());
        assert!(macos_https_proxy(&settings.replace("127.0.0.1", "[invalid")).is_none());
        assert_eq!(
            macos_https_proxy(&settings.replace("127.0.0.1", "::1")),
            Some("http://[::1]:7897".into())
        );
    }

    #[test]
    fn macos_proxy_bridge_preserves_system_bypass_domains_and_networks() {
        let text = "ExceptionsList : <array> {\n0 : *.local\n1 : 10.0.0.0/8\n2 : <local>\n3 : host with spaces\n}\nHTTPSPort : 7897";
        assert_eq!(
            macos_proxy_bypass(text),
            "localhost,127.0.0.1,::1,*.local,10.0.0.0/8"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn codex_system_proxy_does_not_override_explicit_process_proxy() {
        let mut cmd = std::process::Command::new("codex");
        cmd.env("HTTPS_PROXY", "http://explicit.invalid:8080");
        cmd.env("NO_PROXY", "internal.invalid");
        apply_codex_system_proxy(&mut cmd);
        let env: std::collections::HashMap<_, _> = cmd.get_envs().collect();
        assert_eq!(
            env.get(std::ffi::OsStr::new("HTTPS_PROXY")),
            Some(&Some(std::ffi::OsStr::new("http://explicit.invalid:8080")))
        );
        assert_eq!(
            env.get(std::ffi::OsStr::new("NO_PROXY")),
            Some(&Some(std::ffi::OsStr::new("internal.invalid")))
        );
        assert_eq!(env.len(), 2);
    }

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
