use crate::project_memory::{find_git_root, normalize_project_cwd};
use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};

pub const ORCHESTRA_DIR: &str = ".vibe/orchestra";
const GITIGNORE_COMMENT: &str = "# Roster — 协作会话";
const GITIGNORE_ENTRY: &str = ".vibe/";
const README: &str = "这是 Roster 的协作会话目录。\n大脑写 plan.md，干活的人写 inbox/<工具>.md。不要提交这个目录。\n";

const ALLOWED_FILES: &[&str] = &[
    "goal.md",
    "plan.md",
    "README.md",
    "inbox/claude.md",
    "inbox/codex.md",
    "inbox/grok.md",
    "inbox/opencode.md",
    "inbox/gemini.md",
    "inbox/agy.md",
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestraState {
    pub project_path: String,
    pub directory: String,
    pub goal_path: String,
    pub plan_path: String,
}

fn require_cwd(project_path: &str) -> Result<PathBuf, String> {
    let cwd = normalize_project_cwd(project_path);
    if cwd.is_empty() {
        return Err("项目路径无效".into());
    }
    let path = PathBuf::from(&cwd);
    if !path.is_dir() {
        return Err("项目目录不存在".into());
    }
    Ok(path)
}

fn allowed_relative(name: &str) -> Option<&'static str> {
    ALLOWED_FILES
        .iter()
        .copied()
        .find(|item| *item == name.trim())
}

fn orchestra_file(project_dir: &Path, name: &str) -> Result<PathBuf, String> {
    let relative = allowed_relative(name).ok_or_else(|| "非法协作文件".to_string())?;
    let path = project_dir.join(ORCHESTRA_DIR).join(relative);
    if path.components().any(|component| matches!(component, Component::ParentDir)) {
        return Err("非法协作路径".into());
    }
    Ok(path)
}

pub fn ensure_orchestra_gitignore(existing: &str) -> String {
    let has_entry = existing.lines().any(|line| {
        let trimmed = line.trim();
        trimmed == GITIGNORE_ENTRY || trimmed == ".vibe" || trimmed == ".vibe/**"
    });
    if has_entry {
        if existing.is_empty() || existing.ends_with('\n') {
            return existing.to_string();
        }
        return format!("{existing}\n");
    }
    let prefix = existing.trim_end();
    if prefix.is_empty() {
        format!("{GITIGNORE_COMMENT}\n{GITIGNORE_ENTRY}\n")
    } else {
        format!("{prefix}\n\n{GITIGNORE_COMMENT}\n{GITIGNORE_ENTRY}\n")
    }
}

fn ensure_gitignore(project_dir: &Path) -> Result<(), String> {
    let Some(git_root) = find_git_root(project_dir) else {
        return Ok(());
    };
    let path = git_root.join(".gitignore");
    let current = if path.exists() {
        fs::read_to_string(&path).map_err(|error| format!("读取 .gitignore 失败：{error}"))?
    } else {
        String::new()
    };
    let next = ensure_orchestra_gitignore(&current);
    if next != current {
        fs::write(&path, next).map_err(|error| format!("写入 .gitignore 失败：{error}"))?;
    }
    Ok(())
}

fn write_if_missing(path: &Path, content: &str) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, content).map_err(|error| error.to_string())
}

pub fn ensure_orchestra(project_path: &str) -> Result<OrchestraState, String> {
    let project_dir = require_cwd(project_path)?;
    let directory = project_dir.join(ORCHESTRA_DIR);
    fs::create_dir_all(directory.join("inbox")).map_err(|error| error.to_string())?;
    write_if_missing(&directory.join("README.md"), README)?;
    write_if_missing(&directory.join("plan.md"), "")?;
    ensure_gitignore(&project_dir)?;
    Ok(OrchestraState {
        project_path: normalize_project_cwd(project_path),
        directory: directory.to_string_lossy().into_owned(),
        goal_path: directory.join("goal.md").to_string_lossy().into_owned(),
        plan_path: directory.join("plan.md").to_string_lossy().into_owned(),
    })
}

pub fn write_orchestra_file(project_path: &str, name: &str, content: &str) -> Result<OrchestraState, String> {
    let state = ensure_orchestra(project_path)?;
    let project_dir = PathBuf::from(&state.project_path);
    let path = orchestra_file(&project_dir, name)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    if content.as_bytes().contains(&0) {
        return Err("协作文件不能包含 NUL".into());
    }
    if content.len() > 512 * 1024 {
        return Err("协作文件太大".into());
    }
    fs::write(&path, content).map_err(|error| error.to_string())?;
    Ok(state)
}

pub fn read_orchestra_file(project_path: &str, name: &str) -> Result<String, String> {
    let project_dir = require_cwd(project_path)?;
    let path = orchestra_file(&project_dir, name)?;
    if !path.is_file() {
        return Ok(String::new());
    }
    fs::read_to_string(path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gitignore_is_idempotent_and_accepts_existing_vibe_entry() {
        let first = ensure_orchestra_gitignore("node_modules\n");
        assert!(first.contains(".vibe/"));
        assert_eq!(first, ensure_orchestra_gitignore(&first));
        assert_eq!(
            ensure_orchestra_gitignore("dist\n.vibe/\n"),
            "dist\n.vibe/\n"
        );
    }

    #[test]
    fn writes_goal_and_rejects_path_escape() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("app");
        fs::create_dir_all(project.join(".git")).unwrap();
        let cwd = project.to_str().unwrap();
        write_orchestra_file(cwd, "goal.md", "修好协作会话").unwrap();
        assert_eq!(read_orchestra_file(cwd, "goal.md").unwrap(), "修好协作会话");
        assert!(project.join(".vibe/orchestra/plan.md").is_file());
        let ignore = fs::read_to_string(project.join(".gitignore")).unwrap();
        assert!(ignore.contains(".vibe/"));
        assert!(write_orchestra_file(cwd, "../secret.md", "nope").is_err());
        assert!(write_orchestra_file(cwd, "inbox/../goal.md", "nope").is_err());
    }
}
