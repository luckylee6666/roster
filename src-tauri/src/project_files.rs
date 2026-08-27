//! 对话输入框 `@` 引用用的项目文件清单。
//!
//! 扫描是有界的：深度、条目数、返回数都封顶，并跳过版本库、依赖和构建产物
//! 这类对用户没意义的大目录。不跟随目录符号链接，避免走出项目或绕圈。

use serde::Serialize;
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_DEPTH: usize = 6;
const MAX_SCANNED_ENTRIES: usize = 20_000;
const MAX_RESULTS: usize = 30;
const MAX_QUERY_CHARS: usize = 120;
const MAX_RELATIVE_CHARS: usize = 400;

const SKIPPED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "vendor",
    "__pycache__",
    ".venv",
    "venv",
    ".next",
    ".nuxt",
    ".cache",
    "coverage",
    ".gradle",
    "Pods",
    ".terraform",
];

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    /// 项目内相对路径，始终用 `/` 分隔，直接可以放进 prompt。
    pub path: String,
    pub name: String,
    pub depth: usize,
}

fn skipped_dir(name: &str) -> bool {
    if SKIPPED_DIRS.iter().any(|entry| entry == &name) {
        return true;
    }
    // 隐藏目录默认不进，`.github` 这类要找也能靠输入 `.` 之外的名字命中文件本身。
    name.starts_with('.') && name != "."
}

/// 命中规则：相对路径里包含查询串（忽略大小写）。空查询给项目根部的文件。
pub fn list_project_files(root: &str, query: &str) -> Result<Vec<ProjectFile>, String> {
    let root_path = fs::canonicalize(Path::new(root)).map_err(|error| error.to_string())?;
    if !root_path.is_dir() {
        return Err("项目路径不是目录".into());
    }
    let needle = query.trim().to_lowercase();
    if needle.chars().count() > MAX_QUERY_CHARS {
        return Err("搜索词过长".into());
    }

    let mut found: Vec<ProjectFile> = Vec::new();
    let mut scanned = 0usize;
    let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::new();
    queue.push_back((root_path.clone(), 0));

    while let Some((dir, depth)) = queue.pop_front() {
        if scanned >= MAX_SCANNED_ENTRIES || found.len() >= MAX_RESULTS {
            break;
        }
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            scanned += 1;
            if scanned >= MAX_SCANNED_ENTRIES || found.len() >= MAX_RESULTS {
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            // symlink_metadata：目录软链不进队列，文件软链也不跟随。
            let meta = match entry.path().symlink_metadata() {
                Ok(meta) => meta,
                Err(_) => continue,
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                if depth < MAX_DEPTH && !skipped_dir(&name) {
                    queue.push_back((entry.path(), depth + 1));
                }
                continue;
            }
            if !meta.is_file() || name.starts_with('.') {
                continue;
            }
            let relative = match entry.path().strip_prefix(&root_path) {
                Ok(rest) => rest.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            };
            if relative.chars().count() > MAX_RELATIVE_CHARS {
                continue;
            }
            if !needle.is_empty() && !relative.to_lowercase().contains(&needle) {
                continue;
            }
            found.push(ProjectFile {
                name,
                depth,
                path: relative,
            });
        }
    }

    found.sort_by(|left, right| {
        left.depth
            .cmp(&right.depth)
            .then_with(|| left.path.to_lowercase().cmp(&right.path.to_lowercase()))
    });
    found.truncate(MAX_RESULTS);
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_project_files_within_bounds_and_skips_heavy_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("README.md"), "hi").unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
        fs::create_dir_all(root.join("node_modules/left-pad")).unwrap();
        fs::write(root.join("node_modules/left-pad/index.js"), "x").unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/config"), "x").unwrap();
        fs::write(root.join(".env"), "SECRET=1").unwrap();

        let all = list_project_files(root.to_str().unwrap(), "").unwrap();
        let paths = all
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>();
        assert!(paths.contains(&"README.md"));
        assert!(paths.contains(&"src/main.rs"));
        assert!(
            !paths.iter().any(|path| path.contains("node_modules")),
            "依赖目录不参与"
        );
        assert!(!paths.iter().any(|path| path.contains(".git")));
        assert!(!paths.contains(&".env"), "隐藏文件不列出");

        let filtered = list_project_files(root.to_str().unwrap(), "MAIN").unwrap();
        assert_eq!(
            filtered
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            vec!["src/main.rs"],
            "忽略大小写按相对路径匹配"
        );

        assert!(list_project_files(root.to_str().unwrap(), &"x".repeat(200)).is_err());
        assert!(list_project_files(root.join("缺失").to_str().unwrap(), "").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlinked_directories_out_of_the_project() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "nope").unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escape")).unwrap();
        fs::write(dir.path().join("inside.txt"), "ok").unwrap();

        let files = list_project_files(dir.path().to_str().unwrap(), "").unwrap();
        let paths = files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>();
        assert_eq!(paths, vec!["inside.txt"]);
    }
}
