use crate::project_memory::{find_git_root, normalize_project_cwd};
use serde::Serialize;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::ffi::CString;
#[cfg(any(not(unix), test))]
use std::fs;
#[cfg(unix)]
use std::io::{Seek, SeekFrom};
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

pub const ORCHESTRA_DIR: &str = ".vibe/orchestra";
const GITIGNORE_COMMENT: &str = "# Roster — 协作会话";
const GITIGNORE_ENTRY: &str = ".vibe/";
const README: &str = "这是 Roster 的协作会话目录。\n大脑写 plan.md，干活的人写 inbox/<工具>.md。不要提交这个目录。\n";
const MAX_FILE_SIZE: usize = 512 * 1024;

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

fn valid_inbox_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    matches!(bytes, [first, rest @ ..]
        if bytes.len() <= 32
            && first.is_ascii_lowercase()
            && rest
                .iter()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')))
}

fn allowed_relative(name: &str) -> Option<String> {
    if matches!(name, "goal.md" | "plan.md" | "README.md") {
        return Some(name.to_string());
    }
    let id = name.strip_prefix("inbox/")?.strip_suffix(".md")?;
    valid_inbox_id(id).then(|| name.to_string())
}

fn target_parts(relative: &str) -> (bool, &str) {
    relative
        .strip_prefix("inbox/")
        .map_or((false, relative), |filename| (true, filename))
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
    update_gitignore_file(&git_root)
}

#[cfg(unix)]
fn update_gitignore_file(git_root: &Path) -> Result<(), String> {
    let root = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC)
        .open(git_root)
        .map_err(|error| format!("打开 Git 根目录失败：{error}"))?;
    let mut current = String::new();
    match open_file_at(&root, ".gitignore", libc::O_RDONLY) {
        Ok(mut file) => {
            require_regular_file(&file)?;
            file.read_to_string(&mut current)
                .map_err(|error| format!("读取 .gitignore 失败：{error}"))?;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!(".gitignore 含符号链接或无法打开：{error}")),
    }
    let next = ensure_orchestra_gitignore(&current);
    if next != current {
        let mut file = open_file_at(&root, ".gitignore", libc::O_WRONLY | libc::O_CREAT)
            .map_err(|error| format!(".gitignore 含符号链接或无法打开：{error}"))?;
        require_regular_file(&file)?;
        require_single_link(&file, ".gitignore")?;
        file.set_len(0)
            .map_err(|error| format!("写入 .gitignore 失败：{error}"))?;
        file.seek(SeekFrom::Start(0))
            .map_err(|error| format!("写入 .gitignore 失败：{error}"))?;
        file.write_all(next.as_bytes())
            .map_err(|error| format!("写入 .gitignore 失败：{error}"))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn update_gitignore_file(git_root: &Path) -> Result<(), String> {
    let path = git_root.join(".gitignore");
    let current = if require_safe_target(&path, true)? {
        fs::read_to_string(&path).map_err(|error| format!("读取 .gitignore 失败：{error}"))?
    } else {
        String::new()
    };
    let next = ensure_orchestra_gitignore(&current);
    if next != current {
        require_safe_target(&path, true)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|error| format!("写入 .gitignore 失败：{error}"))?;
        if !file
            .metadata()
            .map_err(|error| format!("读取 .gitignore 信息失败：{error}"))?
            .is_file()
        {
            return Err(".gitignore 不是普通文件".into());
        }
        file.set_len(0)
            .map_err(|error| format!("写入 .gitignore 失败：{error}"))?;
        file.write_all(next.as_bytes())
            .map_err(|error| format!("写入 .gitignore 失败：{error}"))?;
    }
    Ok(())
}

fn validate_content(content: &str) -> Result<(), String> {
    if content.as_bytes().contains(&0) {
        return Err("协作文件不能包含 NUL".into());
    }
    if content.len() > MAX_FILE_SIZE {
        return Err("协作文件太大".into());
    }
    Ok(())
}

fn decode_content(bytes: Vec<u8>) -> Result<String, String> {
    if bytes.len() > MAX_FILE_SIZE {
        return Err("协作文件太大".into());
    }
    if bytes.contains(&0) {
        return Err("协作文件不能包含 NUL".into());
    }
    String::from_utf8(bytes).map_err(|error| format!("协作文件不是 UTF-8：{error}"))
}

#[cfg(unix)]
struct OrchestraDirectories {
    directory: File,
    inbox: Option<File>,
}

#[cfg(unix)]
fn c_name(name: &str) -> Result<CString, String> {
    CString::new(name).map_err(|_| "非法协作路径".to_string())
}

#[cfg(unix)]
fn open_directory_at(parent: &File, name: &str, create: bool) -> Result<Option<File>, String> {
    let name = c_name(name)?;
    let open = || {
        // SAFETY: parent is an open directory descriptor and name is a NUL-free single component.
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            Err(io::Error::last_os_error())
        } else {
            // SAFETY: openat returned a new owned descriptor.
            Ok(unsafe { File::from_raw_fd(fd) })
        }
    };

    match open() {
        Ok(directory) => Ok(Some(directory)),
        Err(error) if error.kind() == io::ErrorKind::NotFound && !create => Ok(None),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            // SAFETY: parent and name have the same guarantees as the openat call above.
            let result = unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o755) };
            if result < 0 {
                let mkdir_error = io::Error::last_os_error();
                if mkdir_error.kind() != io::ErrorKind::AlreadyExists {
                    return Err(format!("创建协作目录失败：{mkdir_error}"));
                }
            }
            open()
                .map(Some)
                .map_err(|error| format!("协作目录含符号链接或不是目录：{error}"))
        }
        Err(error) => Err(format!("协作目录含符号链接或不是目录：{error}")),
    }
}

#[cfg(unix)]
fn open_orchestra_directories(
    project_dir: &Path,
    create: bool,
    include_inbox: bool,
) -> Result<Option<OrchestraDirectories>, String> {
    let project = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC)
        .open(project_dir)
        .map_err(|error| format!("打开项目目录失败：{error}"))?;
    let Some(vibe) = open_directory_at(&project, ".vibe", create)? else {
        return Ok(None);
    };
    let Some(directory) = open_directory_at(&vibe, "orchestra", create)? else {
        return Ok(None);
    };
    let inbox = if include_inbox {
        let Some(inbox) = open_directory_at(&directory, "inbox", create)? else {
            return Ok(None);
        };
        Some(inbox)
    } else {
        None
    };
    Ok(Some(OrchestraDirectories { directory, inbox }))
}

#[cfg(unix)]
fn target_directory(directories: &OrchestraDirectories, in_inbox: bool) -> Result<&File, String> {
    if in_inbox {
        directories
            .inbox
            .as_ref()
            .ok_or_else(|| "协作 inbox 不存在".to_string())
    } else {
        Ok(&directories.directory)
    }
}

#[cfg(unix)]
fn open_file_at(parent: &File, name: &str, flags: libc::c_int) -> io::Result<File> {
    let name = CString::new(name)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "文件名包含 NUL"))?;
    // SAFETY: parent is an open directory descriptor and name is a validated single component.
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            0o666,
        )
    };
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        // SAFETY: openat returned a new owned descriptor.
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}

#[cfg(unix)]
fn require_regular_file(file: &File) -> Result<(), String> {
    let metadata = file
        .metadata()
        .map_err(|error| format!("读取协作文件信息失败：{error}"))?;
    if metadata.is_file() {
        Ok(())
    } else {
        Err("协作文件不是普通文件".into())
    }
}

#[cfg(unix)]
fn require_single_link(file: &File, label: &str) -> Result<(), String> {
    let metadata = file
        .metadata()
        .map_err(|error| format!("读取 {label} 信息失败：{error}"))?;
    if metadata.nlink() > 1 {
        Err(format!("{label} 存在多个硬链接，拒绝写入"))
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn write_if_missing(project_dir: &Path, relative: &str, content: &str) -> Result<(), String> {
    let (in_inbox, filename) = target_parts(relative);
    let directories = open_orchestra_directories(project_dir, true, in_inbox)?
        .ok_or_else(|| "无法创建协作目录".to_string())?;
    let parent = target_directory(&directories, in_inbox)?;
    match open_file_at(
        parent,
        filename,
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
    ) {
        Ok(mut file) => {
            require_regular_file(&file)?;
            require_single_link(&file, "协作文件")?;
            file.write_all(content.as_bytes())
                .map_err(|error| error.to_string())
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let file = open_file_at(parent, filename, libc::O_RDONLY)
                .map_err(|error| format!("协作文件含符号链接或无法打开：{error}"))?;
            require_regular_file(&file)?;
            require_single_link(&file, "协作文件")
        }
        Err(error) => Err(format!("创建协作文件失败：{error}")),
    }
}

#[cfg(unix)]
fn safe_write(project_dir: &Path, relative: &str, content: &str) -> Result<(), String> {
    let (in_inbox, filename) = target_parts(relative);
    let directories = open_orchestra_directories(project_dir, true, in_inbox)?
        .ok_or_else(|| "无法创建协作目录".to_string())?;
    let parent = target_directory(&directories, in_inbox)?;
    let mut file = open_file_at(parent, filename, libc::O_WRONLY | libc::O_CREAT)
        .map_err(|error| format!("协作文件含符号链接或无法打开：{error}"))?;
    require_regular_file(&file)?;
    require_single_link(&file, "协作文件")?;
    file.set_len(0).map_err(|error| error.to_string())?;
    file.write_all(content.as_bytes())
        .map_err(|error| error.to_string())
}

#[cfg(unix)]
fn safe_read(project_dir: &Path, relative: &str) -> Result<String, String> {
    let (in_inbox, filename) = target_parts(relative);
    let Some(directories) = open_orchestra_directories(project_dir, false, in_inbox)? else {
        return Ok(String::new());
    };
    let parent = target_directory(&directories, in_inbox)?;
    let file = match open_file_at(parent, filename, libc::O_RDONLY) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(format!("协作文件含符号链接或无法打开：{error}")),
    };
    require_regular_file(&file)?;
    if file.metadata().map_err(|error| error.to_string())?.len() > MAX_FILE_SIZE as u64 {
        return Err("协作文件太大".into());
    }
    let mut bytes = Vec::new();
    file.take((MAX_FILE_SIZE + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    decode_content(bytes)
}

#[cfg(not(unix))]
fn metadata_is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

#[cfg(not(unix))]
fn ensure_directory(path: &Path, create: bool) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata_is_link(&metadata) || !metadata.is_dir() => {
            Err("协作目录含符号链接或不是目录".into())
        }
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound && !create => Ok(false),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(|error| format!("创建协作目录失败：{error}"))?;
            let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
            if metadata_is_link(&metadata) || !metadata.is_dir() {
                Err("协作目录含符号链接或不是目录".into())
            } else {
                Ok(true)
            }
        }
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(not(unix))]
fn safe_directory_path(
    project_dir: &Path,
    create: bool,
    include_inbox: bool,
) -> Result<Option<PathBuf>, String> {
    let vibe = project_dir.join(".vibe");
    if !ensure_directory(&vibe, create)? {
        return Ok(None);
    }
    let directory = vibe.join("orchestra");
    if !ensure_directory(&directory, create)? {
        return Ok(None);
    }
    if include_inbox {
        let inbox = directory.join("inbox");
        if !ensure_directory(&inbox, create)? {
            return Ok(None);
        }
        Ok(Some(inbox))
    } else {
        Ok(Some(directory))
    }
}

#[cfg(not(unix))]
fn require_safe_target(path: &Path, allow_missing: bool) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata_is_link(&metadata) || !metadata.is_file() => {
            Err("协作文件含符号链接或不是普通文件".into())
        }
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound && allow_missing => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(not(unix))]
fn safe_target_path(
    project_dir: &Path,
    relative: &str,
    create: bool,
) -> Result<Option<PathBuf>, String> {
    let (in_inbox, filename) = target_parts(relative);
    Ok(safe_directory_path(project_dir, create, in_inbox)?.map(|parent| parent.join(filename)))
}

#[cfg(not(unix))]
fn write_if_missing(project_dir: &Path, relative: &str, content: &str) -> Result<(), String> {
    let path = safe_target_path(project_dir, relative, true)?
        .ok_or_else(|| "无法创建协作目录".to_string())?;
    if require_safe_target(&path, true)? {
        return Ok(());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| format!("创建协作文件失败：{error}"))?;
    if !file
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("协作文件不是普通文件".into());
    }
    file.write_all(content.as_bytes())
        .map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn safe_write(project_dir: &Path, relative: &str, content: &str) -> Result<(), String> {
    let path = safe_target_path(project_dir, relative, true)?
        .ok_or_else(|| "无法创建协作目录".to_string())?;
    require_safe_target(&path, true)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|error| error.to_string())?;
    if !file
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("协作文件不是普通文件".into());
    }
    file.set_len(0).map_err(|error| error.to_string())?;
    file.write_all(content.as_bytes())
        .map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn safe_read(project_dir: &Path, relative: &str) -> Result<String, String> {
    let Some(path) = safe_target_path(project_dir, relative, false)? else {
        return Ok(String::new());
    };
    if !require_safe_target(&path, true)? {
        return Ok(String::new());
    }
    let file = File::open(&path).map_err(|error| error.to_string())?;
    if !file
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("协作文件不是普通文件".into());
    }
    let mut bytes = Vec::new();
    file.take((MAX_FILE_SIZE + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    decode_content(bytes)
}

pub fn ensure_orchestra(project_path: &str) -> Result<OrchestraState, String> {
    let project_dir = require_cwd(project_path)?;
    open_orchestra_directories_for_init(&project_dir)?;
    write_if_missing(&project_dir, "README.md", README)?;
    write_if_missing(&project_dir, "plan.md", "")?;
    ensure_gitignore(&project_dir)?;
    let directory = project_dir.join(ORCHESTRA_DIR);
    Ok(OrchestraState {
        project_path: normalize_project_cwd(project_path),
        directory: directory.to_string_lossy().into_owned(),
        goal_path: directory.join("goal.md").to_string_lossy().into_owned(),
        plan_path: directory.join("plan.md").to_string_lossy().into_owned(),
    })
}

#[cfg(unix)]
fn open_orchestra_directories_for_init(project_dir: &Path) -> Result<(), String> {
    open_orchestra_directories(project_dir, true, true)?
        .ok_or_else(|| "无法创建协作目录".to_string())?;
    Ok(())
}

#[cfg(not(unix))]
fn open_orchestra_directories_for_init(project_dir: &Path) -> Result<(), String> {
    safe_directory_path(project_dir, true, true)?.ok_or_else(|| "无法创建协作目录".to_string())?;
    Ok(())
}

pub fn write_orchestra_file(
    project_path: &str,
    name: &str,
    content: &str,
) -> Result<OrchestraState, String> {
    let relative = allowed_relative(name).ok_or_else(|| "非法协作文件".to_string())?;
    validate_content(content)?;
    let state = ensure_orchestra(project_path)?;
    safe_write(Path::new(&state.project_path), &relative, content)?;
    Ok(state)
}

pub fn read_orchestra_file(project_path: &str, name: &str) -> Result<String, String> {
    let relative = allowed_relative(name).ok_or_else(|| "非法协作文件".to_string())?;
    let project_dir = require_cwd(project_path)?;
    safe_read(&project_dir, &relative)
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

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_gitignore_without_modifying_external_file() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("app");
        fs::create_dir_all(project.join(".git")).unwrap();
        let external = root.path().join("external-ignore");
        fs::write(&external, "不得改动\n").unwrap();
        symlink(&external, project.join(".gitignore")).unwrap();

        assert!(ensure_orchestra(project.to_str().unwrap()).is_err());
        assert_eq!(fs::read_to_string(&external).unwrap(), "不得改动\n");
    }

    #[test]
    fn writes_goal_and_accepts_safe_dynamic_inbox_ids() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("app");
        fs::create_dir_all(project.join(".git")).unwrap();
        let cwd = project.to_str().unwrap();
        write_orchestra_file(cwd, "goal.md", "修好协作会话").unwrap();
        assert_eq!(read_orchestra_file(cwd, "goal.md").unwrap(), "修好协作会话");
        assert!(project.join(".vibe/orchestra/plan.md").is_file());
        let ignore = fs::read_to_string(project.join(".gitignore")).unwrap();
        assert!(ignore.contains(".vibe/"));
        for id in ["mimo", "future-cli", "worker_2"] {
            let name = format!("inbox/{id}.md");
            write_orchestra_file(cwd, &name, "已完成").unwrap();
            assert_eq!(read_orchestra_file(cwd, &name).unwrap(), "已完成");
        }
    }

    #[test]
    fn rejects_path_escape_and_unsafe_inbox_ids() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("app");
        fs::create_dir_all(&project).unwrap();
        let cwd = project.to_str().unwrap();
        for name in [
            "../secret.md",
            "inbox/../goal.md",
            "inbox/.md",
            "inbox/2worker.md",
            "inbox/UPPER.md",
            "inbox/nested/worker.md",
            "inbox/worker\\escape.md",
            "inbox/abcdefghijklmnopqrstuvwxyz1234567.md",
            " goal.md",
        ] {
            assert!(
                write_orchestra_file(cwd, name, "nope").is_err(),
                "unexpectedly allowed {name}"
            );
        }
    }

    #[test]
    fn rejects_oversized_and_nul_content_on_write_and_read() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("app");
        fs::create_dir_all(&project).unwrap();
        let cwd = project.to_str().unwrap();
        assert!(write_orchestra_file(cwd, "goal.md", "bad\0content").is_err());
        assert!(write_orchestra_file(cwd, "goal.md", &"x".repeat(MAX_FILE_SIZE + 1)).is_err());

        ensure_orchestra(cwd).unwrap();
        fs::write(project.join(".vibe/orchestra/goal.md"), b"bad\0content").unwrap();
        assert!(read_orchestra_file(cwd, "goal.md").is_err());
        fs::write(
            project.join(".vibe/orchestra/goal.md"),
            vec![b'x'; MAX_FILE_SIZE + 1],
        )
        .unwrap();
        assert!(read_orchestra_file(cwd, "goal.md").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_target_without_truncating_external_file() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("app");
        let directory = project.join(".vibe/orchestra");
        fs::create_dir_all(directory.join("inbox")).unwrap();
        let external = root.path().join("external.md");
        fs::write(&external, "不得改动").unwrap();
        symlink(&external, directory.join("plan.md")).unwrap();

        let cwd = project.to_str().unwrap();
        assert!(ensure_orchestra(cwd).is_err());
        assert!(write_orchestra_file(cwd, "plan.md", "").is_err());
        assert_eq!(fs::read_to_string(&external).unwrap(), "不得改动");

        fs::remove_file(directory.join("plan.md")).unwrap();
        fs::write(directory.join("plan.md"), "").unwrap();
        symlink(&external, directory.join("goal.md")).unwrap();
        assert!(write_orchestra_file(cwd, "goal.md", "nope").is_err());
        assert_eq!(fs::read_to_string(&external).unwrap(), "不得改动");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_hard_linked_targets_without_modifying_external_file() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("app");
        let directory = project.join(".vibe/orchestra");
        fs::create_dir_all(directory.join("inbox")).unwrap();
        let external = root.path().join("external.md");
        fs::write(&external, "不得改动").unwrap();
        fs::hard_link(&external, directory.join("plan.md")).unwrap();

        let cwd = project.to_str().unwrap();
        assert!(ensure_orchestra(cwd).is_err());
        assert_eq!(fs::read_to_string(&external).unwrap(), "不得改动");

        fs::remove_file(directory.join("plan.md")).unwrap();
        fs::write(directory.join("plan.md"), "").unwrap();
        fs::hard_link(&external, directory.join("goal.md")).unwrap();
        assert!(write_orchestra_file(cwd, "goal.md", "nope").is_err());
        assert_eq!(fs::read_to_string(&external).unwrap(), "不得改动");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_intermediate_directories_and_read_target() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("app");
        let external = root.path().join("external");
        fs::create_dir_all(external.join("orchestra/inbox")).unwrap();
        fs::create_dir_all(&project).unwrap();
        symlink(&external, project.join(".vibe")).unwrap();
        let cwd = project.to_str().unwrap();
        assert!(ensure_orchestra(cwd).is_err());
        assert!(!external.join("orchestra/README.md").exists());

        fs::remove_file(project.join(".vibe")).unwrap();
        let directory = project.join(".vibe/orchestra");
        fs::create_dir_all(&directory).unwrap();
        symlink(external.join("orchestra/inbox"), directory.join("inbox")).unwrap();
        assert!(write_orchestra_file(cwd, "inbox/worker.md", "nope").is_err());

        fs::remove_file(directory.join("inbox")).unwrap();
        fs::create_dir_all(directory.join("inbox")).unwrap();
        let external_file = root.path().join("outside-goal.md");
        fs::write(&external_file, "外部内容").unwrap();
        symlink(&external_file, directory.join("goal.md")).unwrap();
        assert!(read_orchestra_file(cwd, "goal.md").is_err());
    }
}
