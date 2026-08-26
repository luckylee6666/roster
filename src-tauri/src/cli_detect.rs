//! 探测本机已安装的 AI CLI：优先当前进程 PATH，登录壳只作兜底。

use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const CLI_PATH_BEGIN_MARKER: &str = "__ROSTER_CLI_PATH_BEGIN__";
const CLI_PATH_END_MARKER: &str = "__ROSTER_CLI_PATH_END__";
const CLI_RESOLVE_TIMEOUT: Duration = Duration::from_secs(5);
const CLI_RESOLVE_KILL_GRACE: Duration = Duration::from_millis(100);
const MAX_CLI_RESOLVE_OUTPUT_BYTES: usize = 256 * 1024;

pub fn is_safe_cli_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    (1..=32).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-' || *byte == b'_'
        })
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

fn cli_names_in_registry_order(
    allowed: &[String],
    current_path: impl IntoIterator<Item = String>,
    login_shell: impl IntoIterator<Item = String>,
) -> Vec<String> {
    let allowed_set: HashSet<&str> = allowed.iter().map(String::as_str).collect();
    let found = current_path
        .into_iter()
        .chain(login_shell)
        .filter(|name| allowed_set.contains(name.as_str()))
        .collect::<HashSet<_>>();
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

/// 解析一个已登记 CLI 的真实可执行文件路径。
///
/// 调用方仍需先确认该名称属于产品登记表；这里负责拒绝不安全名称，并通过用户的
/// 当前进程 PATH 优先、登录壳兜底解析命令。解析结果只接受绝对路径，最终返回规范化后的普通可执行文件。
pub(crate) fn resolve_registered_cli_bin(name: &str) -> Result<PathBuf, String> {
    if !is_safe_cli_name(name) {
        return Err("CLI 名称不合法".to_string());
    }

    #[cfg(windows)]
    let resolved = windows_resolve_cli_bin(name)?;
    #[cfg(not(windows))]
    let resolved = unix_resolve_cli_bin(name)?;

    validate_resolved_cli_path(&resolved)
}

fn parse_marked_cli_path_output(stdout: &str) -> Result<PathBuf, String> {
    let mut captured = None;
    let mut candidate = None;

    for line in stdout.lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.trim() == CLI_PATH_BEGIN_MARKER {
            candidate = Some(Vec::new());
            continue;
        }
        if line.trim() == CLI_PATH_END_MARKER {
            if let Some(lines) = candidate.take() {
                if lines.len() == 1 {
                    captured = lines.into_iter().next();
                }
            }
            continue;
        }
        if let Some(lines) = candidate.as_mut() {
            if !line.is_empty() {
                lines.push(line.to_string());
            }
        }
    }

    let path = PathBuf::from(captured.ok_or_else(|| "未找到可执行 CLI".to_string())?);
    if !path.is_absolute() {
        return Err("CLI 路径无效".to_string());
    }
    Ok(path)
}

fn validate_resolved_cli_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("CLI 路径无效".to_string());
    }
    let canonical = std::fs::canonicalize(path).map_err(|_| "CLI 路径无效".to_string())?;
    if !canonical.is_absolute() {
        return Err("CLI 路径无效".to_string());
    }
    let metadata = std::fs::metadata(&canonical).map_err(|_| "CLI 路径无效".to_string())?;
    if !metadata.is_file() {
        return Err("CLI 路径无效".to_string());
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o111 == 0 {
        return Err("CLI 不可执行".to_string());
    }
    Ok(canonical)
}

#[cfg(windows)]
fn windows_resolve_cli_bin(name: &str) -> Result<PathBuf, String> {
    let output = Command::new("where")
        .arg(name)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| "无法解析 CLI".to_string())?;
    if !output.status.success() {
        return Err("未找到可执行 CLI".to_string());
    }
    let stdout = String::from_utf8(output.stdout).map_err(|_| "CLI 路径无效".to_string())?;
    stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .find(|path| path.is_absolute())
        .ok_or_else(|| "CLI 路径无效".to_string())
}

#[cfg(not(windows))]
fn unix_resolve_cli_bin(name: &str) -> Result<PathBuf, String> {
    // Tauri inherits the terminal/launcher PATH that started it. Prefer that
    // deterministic environment: a login shell may run arbitrary profile
    // code, reset PATH, or fail under a GUI/dev-process environment even when
    // the already-running application can execute the CLI just fine.
    if let Some(path) = unix_cli_on_current_path(name) {
        return Ok(path);
    }

    // Login shell is only a fallback for tools supplied by nvm/Homebrew etc.
    // that were not present in the process environment at application start.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let script = "printf '%s\\n' '__ROSTER_CLI_PATH_BEGIN__'; \
                  command -v \"$1\" 2>/dev/null; \
                  roster_cli_status=$?; \
                  printf '%s\\n' '__ROSTER_CLI_PATH_END__'; \
                  exit $roster_cli_status";
    let mut command = Command::new(shell);
    command
        .args(["-ilc", script, "roster-cli-resolve", name])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let output = unix_output_with_timeout(&mut command, CLI_RESOLVE_TIMEOUT)?;
    if !output.status.success() {
        return Err("未找到可执行 CLI".to_string());
    }
    let stdout = String::from_utf8(output.stdout).map_err(|_| "CLI 路径无效".to_string())?;
    parse_marked_cli_path_output(&stdout)
}

/// Finds a safely-named executable on an explicitly supplied PATH. Relative
/// entries are deliberately ignored: accepting them would make the executable
/// depend on the current directory of the GUI process.
#[cfg(not(windows))]
fn unix_cli_on_path(name: &str, path: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    if !is_safe_cli_name(name) {
        return None;
    }
    std::env::split_paths(path?)
        .filter(|directory| directory.is_absolute())
        .map(|directory| directory.join(name))
        .find_map(|candidate| validate_resolved_cli_path(&candidate).ok())
}

#[cfg(not(windows))]
fn unix_cli_on_current_path(name: &str) -> Option<PathBuf> {
    unix_cli_on_path(name, std::env::var_os("PATH").as_deref())
}

/// Login shells may execute arbitrary user profile code.  Do not let that make
/// a conversation start hang forever; on Unix the resolver is its own process
/// group so a timeout also reaps profile-spawned descendants. Stdout is a
/// bounded temporary file rather than a pipe: a profile's background child may
/// inherit stdout after its shell exits, which must not hold this call open.
#[cfg(not(windows))]
fn unix_output_with_timeout(command: &mut Command, timeout: Duration) -> Result<Output, String> {
    use std::os::unix::process::CommandExt;

    let mut stdout = tempfile::tempfile().map_err(|_| "无法解析 CLI".to_string())?;
    let stdout_for_child = stdout.try_clone().map_err(|_| "无法解析 CLI".to_string())?;
    command.process_group(0);
    // The temporary file avoids inherited-pipe EOF hangs. Apply an OS-enforced
    // file-size ceiling too, so a noisy profile cannot fill the file between
    // polling intervals (and its descendants inherit the same ceiling).
    unsafe {
        command.pre_exec(|| {
            let limit = libc::rlimit {
                rlim_cur: MAX_CLI_RESOLVE_OUTPUT_BYTES as libc::rlim_t,
                rlim_max: MAX_CLI_RESOLVE_OUTPUT_BYTES as libc::rlim_t,
            };
            if libc::setrlimit(libc::RLIMIT_FSIZE, &limit) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
    command.stdout(Stdio::from(stdout_for_child));
    let mut child = command.spawn().map_err(|_| "无法解析 CLI".to_string())?;
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|_| "无法解析 CLI".to_string())? {
            break status;
        }
        if Instant::now() >= deadline {
            terminate_resolver_group(&mut child);
            let _ = child.wait();
            return Err("解析 CLI 超时".to_string());
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    // A completed shell can still have profile descendants in its group. They
    // no longer need to run and must not outlive this bounded resolver.
    stop_resolver_group(child.id());
    stdout
        .seek(SeekFrom::Start(0))
        .map_err(|_| "无法解析 CLI".to_string())?;
    let mut bytes = Vec::with_capacity(MAX_CLI_RESOLVE_OUTPUT_BYTES.min(8 * 1024));
    let mut limited = stdout.take((MAX_CLI_RESOLVE_OUTPUT_BYTES + 1) as u64);
    limited
        .read_to_end(&mut bytes)
        .map_err(|_| "无法解析 CLI".to_string())?;
    if bytes.len() > MAX_CLI_RESOLVE_OUTPUT_BYTES {
        return Err("CLI 解析输出过大".to_string());
    }
    Ok(Output {
        status,
        stdout: bytes,
        stderr: Vec::new(),
    })
}

#[cfg(not(windows))]
fn signal_resolver_group(process_id: u32, signal: libc::c_int) {
    // The child was explicitly made a new process-group leader above.
    unsafe { libc::kill(-(process_id as i32), signal) };
}

#[cfg(not(windows))]
fn resolver_group_exists(process_id: u32) -> bool {
    let Ok(process_group_id) = i32::try_from(process_id) else {
        return false;
    };
    // We only probe the PGID immediately after observing its leader, before a
    // PID can realistically be recycled. ESRCH means the whole group is gone.
    unsafe {
        libc::kill(-process_group_id, 0) == 0
            || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
}

#[cfg(not(windows))]
fn stop_resolver_group(process_id: u32) {
    signal_resolver_group(process_id, libc::SIGTERM);
    if !resolver_group_exists(process_id) {
        return;
    }
    let deadline = Instant::now() + CLI_RESOLVE_KILL_GRACE;
    while Instant::now() < deadline {
        if !resolver_group_exists(process_id) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    if resolver_group_exists(process_id) {
        signal_resolver_group(process_id, libc::SIGKILL);
    }
}

#[cfg(not(windows))]
fn terminate_resolver_group(child: &mut std::process::Child) {
    let process_id = child.id();
    signal_resolver_group(process_id, libc::SIGTERM);
    let deadline = Instant::now() + CLI_RESOLVE_KILL_GRACE;
    while Instant::now() < deadline {
        if !resolver_group_exists(process_id) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    if resolver_group_exists(process_id) {
        signal_resolver_group(process_id, libc::SIGKILL);
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
    // Current PATH is the reliable fast path for the running Tauri process.
    // Only give a login shell the unresolved names, which keeps a broken
    // profile from turning a fully usable current PATH into an empty result.
    let found: HashSet<String> = allowed
        .iter()
        .filter(|name| unix_cli_on_current_path(name).is_some())
        .cloned()
        .collect();
    let unresolved = allowed
        .iter()
        .filter(|name| !found.contains(name.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if unresolved.is_empty() {
        return allowed.to_vec();
    }

    let mut script = String::from("printf '%s\\n' '__CLI_OK__';");
    for name in &unresolved {
        script.push_str(&format!(
            " if command -v {name} >/dev/null 2>&1; then printf '%s\\n' '{name}'; fi;"
        ));
    }
    script.push_str(" printf '%s\\n' '__CLI_END__'");
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut command = Command::new(shell);
    command
        .args(["-ilc", &script])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let output = unix_output_with_timeout(&mut command, CLI_RESOLVE_TIMEOUT);
    match output {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            cli_names_in_registry_order(
                allowed,
                found,
                parse_installed_cli_output(&stdout, &unresolved),
            )
        }
        // The current PATH remains authoritative even if a user profile hangs,
        // exits early, or produces unusable login-shell output.
        Err(_) => cli_names_in_registry_order(allowed, found, Vec::new()),
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
        let allowed = [
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

    #[test]
    fn current_path_results_survive_login_shell_failure_in_registry_order() {
        let allowed = vec![
            "claude".to_string(),
            "grok".to_string(),
            "codex".to_string(),
        ];
        assert_eq!(
            cli_names_in_registry_order(
                &allowed,
                vec!["codex".to_string(), "claude".to_string()],
                Vec::new(),
            ),
            vec!["claude".to_string(), "codex".to_string()]
        );
    }

    #[test]
    fn resolve_cli_rejects_unsafe_name_before_shell_lookup() {
        assert_eq!(
            resolve_registered_cli_bin("../codex"),
            Err("CLI 名称不合法".to_string())
        );
    }

    #[test]
    fn parse_cli_path_ignores_login_shell_marker_noise() {
        let stdout = "profile noise\n__ROSTER_CLI_PATH_END__\n\
                      __ROSTER_CLI_PATH_BEGIN__\nrelative-noise\nextra-noise\n\
                      __ROSTER_CLI_PATH_END__\n__ROSTER_CLI_PATH_BEGIN__\n\
                      /opt/homebrew/bin/codex\n__ROSTER_CLI_PATH_END__\ntrailing noise\n";
        assert_eq!(
            parse_marked_cli_path_output(stdout),
            Ok(PathBuf::from("/opt/homebrew/bin/codex"))
        );
    }

    #[test]
    fn parse_cli_path_rejects_relative_path() {
        let stdout = "__ROSTER_CLI_PATH_BEGIN__\n./codex\n__ROSTER_CLI_PATH_END__\n";
        assert_eq!(
            parse_marked_cli_path_output(stdout),
            Err("CLI 路径无效".to_string())
        );
    }

    #[test]
    fn validate_cli_path_accepts_current_executable() {
        let current = std::env::current_exe().expect("current test binary");
        assert_eq!(
            validate_resolved_cli_path(&current),
            std::fs::canonicalize(current).map_err(|_| "CLI 路径无效".to_string())
        );
    }

    #[cfg(unix)]
    #[test]
    fn current_path_is_preferred_and_keeps_registry_order_without_a_login_shell() {
        let root = tempfile::tempdir().expect("temporary PATH directory");
        let bin = root.path().join("bin");
        std::fs::create_dir(&bin).expect("create bin");
        for name in ["codex", "claude"] {
            let executable = bin.join(name);
            std::fs::write(&executable, "#!/bin/sh\nexit 0\n").expect("write executable");
            let mut permissions = std::fs::metadata(&executable)
                .expect("metadata")
                .permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&executable, permissions).expect("mark executable");
        }

        let path = std::env::join_paths([bin.as_path()]).expect("PATH");
        assert_eq!(
            unix_cli_on_path("codex", Some(path.as_os_str())),
            Some(std::fs::canonicalize(bin.join("codex")).expect("canonical codex"))
        );
        let allowed = [
            "claude".to_string(),
            "grok".to_string(),
            "codex".to_string(),
        ];
        let found = allowed
            .iter()
            .filter(|name| unix_cli_on_path(name, Some(path.as_os_str())).is_some())
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(found, vec!["claude".to_string(), "codex".to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn current_path_ignores_relative_entries() {
        let root = tempfile::tempdir().expect("temporary directory");
        let executable = root.path().join("codex");
        std::fs::write(&executable, "#!/bin/sh\nexit 0\n").expect("write executable");
        let mut permissions = std::fs::metadata(&executable)
            .expect("metadata")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&executable, permissions).expect("mark executable");
        assert_eq!(
            unix_cli_on_path("codex", Some(std::ffi::OsStr::new("."))),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_cli_uses_login_shell_positional_argument() {
        let resolved = resolve_registered_cli_bin("sh").expect("resolve sh from login shell");
        assert!(resolved.is_absolute());
        assert!(resolved.is_file());
    }

    #[cfg(unix)]
    #[test]
    fn resolver_timeout_reaps_hung_process_group() {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "trap '' TERM; while :; do sleep 1; done"])
            .stdout(Stdio::null());
        let started = Instant::now();
        assert_eq!(
            unix_output_with_timeout(&mut command, Duration::from_millis(50)),
            Err("解析 CLI 超时".to_string())
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[test]
    fn resolver_timeout_kills_term_ignoring_child_after_leader_exits() {
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "trap 'exit 0' TERM; (trap '' TERM; while :; do sleep 1; done) & wait",
        ]);
        let started = Instant::now();
        assert_eq!(
            unix_output_with_timeout(&mut command, Duration::from_millis(50)),
            Err("解析 CLI 超时".to_string())
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[test]
    fn resolver_does_not_wait_for_background_child_holding_stdout() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 30 & printf done; exit 0"]);
        let started = Instant::now();
        let output = unix_output_with_timeout(&mut command, Duration::from_secs(1)).unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"done");
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
