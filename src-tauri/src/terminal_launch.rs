//! Native interactive rotation launch. No shell is left to consume a prompt
//! after a failed CLI startup, and no untrusted command line comes from the UI.
use portable_pty::CommandBuilder;
use std::path::Path;

fn initial_args(tool: &str, prompt: &str, cwd: &str) -> Result<Vec<String>, String> {
    if !matches!(tool, "cmd" | "mimo" | "opencode") {
        return Err("该工具不支持原生初始消息启动".into());
    }
    if cwd.is_empty()
        || prompt.trim().is_empty()
        || prompt.len() > 16 * 1024
        || prompt.chars().any(char::is_control)
        || prompt.starts_with('-')
    {
        return Err("初始消息或项目目录无效".into());
    }
    Ok(if tool == "cmd" {
        vec!["--no-auto-update".into(), prompt.into()]
    } else {
        vec![cwd.into(), "--prompt".into(), prompt.into()]
    })
}

fn command_with_binary(binary: &Path, cwd: &str, args: Vec<String>) -> CommandBuilder {
    let mut command = CommandBuilder::new(binary);
    command.cwd(cwd);
    command.args(args);
    command
}

pub(crate) fn initial_cli_command(
    tool: &str,
    prompt: &str,
    cwd: &str,
) -> Result<CommandBuilder, String> {
    let args = initial_args(tool, prompt, cwd)?;
    let name = crate::conversation_chat::provider_binary(tool).ok_or("未登记的 CLI")?;
    let binary = crate::cli_detect::resolve_registered_cli_bin(name)?;
    // Batch files require cmd.exe's secondary string parsing. Fail closed on
    // Windows rather than quietly reintroducing a shell for this safe path.
    #[cfg(windows)]
    if !binary
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
    {
        return Err("原生初始消息需要 CLI 的 .exe 可执行文件，不能通过脚本包装器启动".into());
    }
    Ok(command_with_binary(&binary, cwd, args))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_prompt_is_one_argument_and_never_resume_or_bypass() {
        let prompt = "这是交接 'quoted' $HOME $(touch NEVER) `echo NEVER` ; &";
        for tool in ["cmd", "mimo", "opencode"] {
            let args = initial_args(tool, prompt, "/project").unwrap();
            assert_eq!(args.last().unwrap(), prompt);
            assert!(!args.iter().any(|arg| matches!(
                arg.as_str(),
                "--yolo" | "--session" | "--continue" | "--trust"
            )));
            let command =
                command_with_binary(Path::new("/registered/cli"), "/project", args.clone());
            assert_eq!(command.get_argv()[0], "/registered/cli");
            assert_eq!(command.get_argv().len(), args.len() + 1);
            assert_eq!(command.get_cwd().unwrap(), "/project");
            if tool != "cmd" {
                assert_eq!(&args[..2], ["/project", "--prompt"]);
            }
        }
    }

    #[test]
    fn rejects_unsupported_tool_flags_controls_and_oversize_before_resolving() {
        for tool in ["claude", "cmd --yolo", "cmdc", "../cmd", "sh"] {
            assert!(initial_args(tool, "任务", "/project").is_err());
        }
        for prompt in ["", " ", "--yolo", "a\nb", "a\0b"] {
            assert!(initial_args("cmd", prompt, "/project").is_err());
        }
        assert!(initial_args("cmd", &"中".repeat(6000), "/project").is_err());
        assert!(initial_args("cmd", "任务", "").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn immediate_cli_exit_closes_native_pty_without_a_fallback_shell() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("fake-cli");
        std::fs::write(
            &binary,
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$ROSTER_TEST_CAPTURE\"\nexit 23\n",
        )
        .unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let cwd = dir.path().to_str().unwrap();
        let prompt = "这是交接 'quoted' $(echo NEVER) ; echo NEVER";
        let mut command =
            command_with_binary(&binary, cwd, initial_args("cmd", prompt, cwd).unwrap());
        let capture = dir.path().join("argv.txt");
        command.env("ROSTER_TEST_CAPTURE", &capture);
        let pair = portable_pty::native_pty_system()
            .openpty(portable_pty::PtySize::default())
            .unwrap();
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let status = child.wait().unwrap();
        assert_eq!(status.exit_code(), 23);
        // A PTY can discard unread output on close; verify actual child argv
        // via a test-owned file rather than a racy post-exit read.
        let output = std::fs::read_to_string(capture).unwrap();
        assert_eq!(output, format!("--no-auto-update\n{prompt}\n"));
    }

    #[cfg(unix)]
    #[test]
    fn missing_cli_fails_spawn_instead_of_opening_a_shell() {
        let dir = tempfile::tempdir().unwrap();
        let command = command_with_binary(
            &dir.path().join("missing-cli"),
            dir.path().to_str().unwrap(),
            vec![],
        );
        let pair = portable_pty::native_pty_system()
            .openpty(portable_pty::PtySize::default())
            .unwrap();
        assert!(pair.slave.spawn_command(command).is_err());
    }
}
