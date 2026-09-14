use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const WORKSPACE_MEMORY_LINK: &str = ".memory";
pub const MEMORY_POINTER_START: &str = "<!-- vibe-memory -->";
pub const MEMORY_POINTER_END: &str = "<!-- /vibe-memory -->";
const MEMORY_GITIGNORE_COMMENT: &str = "# Roster — 项目记忆窗口";
const MEMORY_POINTER_BODY: &str = "长期记忆只在 `.memory/`（指向 Claude 项目记忆，不进 Git）。\n读：先看 `.memory/MEMORY.md`。写：用户说「更新记忆」时改专题；否则写入 `.memory/inbox/`。\n不要把记忆写进本文件或仓库里的 `memory/`。";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryTopic {
    pub title: String,
    pub file: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMemoryState {
    pub mounted: bool,
    pub skipped: bool,
    pub project_path: String,
    pub memory_path: String,
    pub link_path: String,
    pub index_preview: String,
    pub topics: Vec<MemoryTopic>,
    pub topic_count: u32,
    pub inbox_count: u32,
    pub warning: String,
}

impl ProjectMemoryState {
    fn skipped(project_path: String, warning: impl Into<String>) -> Self {
        Self {
            mounted: false,
            skipped: true,
            project_path,
            memory_path: String::new(),
            link_path: String::new(),
            index_preview: String::new(),
            topics: Vec::new(),
            topic_count: 0,
            inbox_count: 0,
            warning: warning.into(),
        }
    }
}

pub fn normalize_project_cwd(cwd: &str) -> String {
    let trimmed = cwd.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let stripped = trimmed.trim_end_matches(['/', '\\']);
    if stripped.is_empty() {
        trimmed.to_string()
    } else {
        stripped.to_string()
    }
}

/// Claude Code 把项目路径编码成 `~/.claude/projects` 目录名：`/`、`\` 和 `.` 换成 `-`。
pub fn encode_claude_project_dir(cwd: &str) -> String {
    normalize_project_cwd(cwd)
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c == '.' {
                '-'
            } else {
                c
            }
        })
        .collect()
}

pub fn should_mount_project_memory(path: &Path, home: Option<&Path>) -> bool {
    if !path.is_dir() {
        return false;
    }
    if path.parent().is_none() {
        return false;
    }
    if let Some(home) = home {
        if path == home {
            return false;
        }
        if let (Ok(left), Ok(right)) = (path.canonicalize(), home.canonicalize()) {
            if left == right {
                return false;
            }
        }
    }
    true
}

pub fn memory_dir_for_project(home: &Path, cwd: &str) -> PathBuf {
    home.join(".claude")
        .join("projects")
        .join(encode_claude_project_dir(cwd))
        .join("memory")
}

pub(crate) fn resolve_memory_dir(home: &Path, project_dir: &Path, raw: &str) -> PathBuf {
    let mut candidates = vec![raw.to_string()];
    if let Ok(canon) = project_dir.canonicalize() {
        let normalized = normalize_project_cwd(&canon.to_string_lossy());
        if !normalized.is_empty() && !candidates.iter().any(|item| item == &normalized) {
            candidates.push(normalized);
        }
    }
    for cwd in &candidates {
        let project = home
            .join(".claude")
            .join("projects")
            .join(encode_claude_project_dir(cwd));
        if project.is_dir() || project.join("memory").is_dir() {
            return project.join("memory");
        }
    }
    memory_dir_for_project(home, raw)
}

/// 返回当前项目已经存在的 Claude 记忆目录，不创建目录或工作区链接。
/// 对话内文件预览用它把项目记忆作为项目根之外唯一额外允许的只读范围。
fn existing_memory_dir_with_home(project_path: &str, home: &Path) -> Option<PathBuf> {
    let raw = normalize_project_cwd(project_path);
    if raw.is_empty() {
        return None;
    }
    let project_dir = PathBuf::from(&raw);
    let memory = resolve_memory_dir(home, &project_dir, &raw);
    let canonical = memory.canonicalize().ok()?;
    canonical.is_dir().then_some(canonical)
}

pub fn existing_memory_dir(project_path: &str) -> Option<PathBuf> {
    existing_memory_dir_with_home(project_path, &dirs::home_dir()?)
}

fn memory_pointer_block() -> String {
    format!("{MEMORY_POINTER_START}\n{MEMORY_POINTER_BODY}\n{MEMORY_POINTER_END}\n")
}

pub fn remove_memory_pointer(existing: &str) -> String {
    if let (Some(start), Some(end)) = (
        existing.find(MEMORY_POINTER_START),
        existing.find(MEMORY_POINTER_END),
    ) {
        if end > start {
            let after = end + MEMORY_POINTER_END.len();
            let prefix = existing[..start].trim_end();
            let suffix = existing[after..].trim_start();
            if prefix.is_empty() && suffix.is_empty() {
                return String::new();
            }
            if prefix.is_empty() {
                return if suffix.ends_with('\n') {
                    suffix.to_string()
                } else {
                    format!("{suffix}\n")
                };
            }
            if suffix.is_empty() {
                return format!("{prefix}\n");
            }
            let mut out = format!("{prefix}\n\n{suffix}");
            if !out.ends_with('\n') {
                out.push('\n');
            }
            return out;
        }
    }
    existing.to_string()
}

pub fn upsert_memory_pointer(existing: &str) -> String {
    let block = memory_pointer_block().trim_end().to_string();
    if let (Some(start), Some(end)) = (
        existing.find(MEMORY_POINTER_START),
        existing.find(MEMORY_POINTER_END),
    ) {
        if end > start {
            let after = end + MEMORY_POINTER_END.len();
            let prefix = existing[..start].trim_end();
            let suffix = existing[after..].trim_start();
            let mut out = String::new();
            if !prefix.is_empty() {
                out.push_str(prefix);
                out.push_str("\n\n");
            }
            out.push_str(&block);
            out.push('\n');
            if !suffix.is_empty() {
                out.push('\n');
                out.push_str(suffix);
                if !suffix.ends_with('\n') {
                    out.push('\n');
                }
            }
            return out;
        }
    }
    let trimmed = existing.trim_end();
    if trimmed.is_empty() {
        format!("{block}\n")
    } else {
        format!("{trimmed}\n\n{block}\n")
    }
}

pub fn ensure_memory_gitignore(existing: &str) -> String {
    let has_link = existing
        .lines()
        .any(|line| line.trim() == WORKSPACE_MEMORY_LINK);
    if has_link {
        if existing.is_empty() || existing.ends_with('\n') {
            return existing.to_string();
        }
        return format!("{existing}\n");
    }
    let prefix = existing.trim_end();
    if prefix.is_empty() {
        format!("{MEMORY_GITIGNORE_COMMENT}\n{WORKSPACE_MEMORY_LINK}\n")
    } else {
        format!("{prefix}\n\n{MEMORY_GITIGNORE_COMMENT}\n{WORKSPACE_MEMORY_LINK}\n")
    }
}

fn parse_memory_topics(markdown: &str, limit: usize) -> Vec<MemoryTopic> {
    let mut topics = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in markdown.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("- [") else {
            continue;
        };
        let Some(title_end) = rest.find("](") else {
            continue;
        };
        let title = rest[..title_end].trim();
        let rest = &rest[title_end + 2..];
        let Some(file_end) = rest.find(')') else {
            continue;
        };
        let file = rest[..file_end].trim();
        if title.is_empty() || !seen.insert(file.to_string()) {
            continue;
        }
        topics.push(MemoryTopic {
            title: title.to_string(),
            file: file.to_string(),
        });
        if topics.len() >= limit {
            break;
        }
    }
    topics
}

fn index_preview(markdown: &str) -> String {
    let mut out = String::new();
    for line in markdown.lines() {
        if out.is_empty() && line.trim().is_empty() {
            continue;
        }
        out.push_str(line);
        out.push('\n');
        if out.chars().count() >= 500 {
            break;
        }
    }
    out.trim_end().to_string()
}

fn seed_memory_index() -> String {
    format!(
        "# 项目记忆索引\n\n正本在本目录。工作区里的 `{WORKSPACE_MEMORY_LINK}` 只是指向这里的窗口，不要在仓库另建 `memory/`。\n\n- 读：先看本索引，再打开专题\n- 写：只有用户说「更新记忆」时改专题；否则写入 `inbox/`\n- 不要把记忆写进仓库的 `CLAUDE.md` / `AGENTS.md`\n"
    )
}

fn count_inbox(memory_dir: &Path) -> u32 {
    let inbox = memory_dir.join("inbox");
    let entries = match fs::read_dir(inbox) {
        Ok(entries) => entries,
        Err(_) => return 0,
    };
    entries
        .flatten()
        .filter(|entry| {
            entry
                .file_type()
                .map(|kind| kind.is_file())
                .unwrap_or(false)
        })
        .count() as u32
}

/// 读普通文件；符号链接、目录、特殊文件都返回 None。项目目录来自任意仓库，
/// `CLAUDE.md` / `.gitignore` 可能是恶意链接，不能顺着它读写项目外文件。
fn read_regular_file(path: &Path) -> Option<String> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    fs::read_to_string(path).ok()
}

/// 写前拒绝符号链接与多硬链接：同一个仓库里的 `CLAUDE.md` / `.gitignore`
/// 被做成链接时，不能顺链写到项目外（orchestra.rs 已有同款防线）。
fn write_if_changed(path: &Path, next: &str) -> io::Result<()> {
    use std::io::{Read, Write};
    if let Ok(meta) = path.symlink_metadata() {
        if meta.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "目标是符号链接，未修改",
            ));
        }
        if !meta.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "目标不是普通文件，未修改",
            ));
        }
        // 原地写入年代 read-only 会自然失败；改成原子替换后目录可写就能换掉它，
        // 这里显式保留「只读文件不动」的语义。
        if meta.permissions().readonly() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "目标文件只读，未修改",
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if meta.nlink() > 1 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "目标有多个硬链接，未修改",
                ));
            }
        }
    }
    let mut options = fs::OpenOptions::new();
    // 只读打开、不 create：缺文件时走下面的新建分支，不先建出一个空文件再替换。
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut current = String::new();
    match options.open(path) {
        Ok(mut file) => {
            file.read_to_string(&mut current)?;
            if current == next {
                return Ok(());
            }
            // 复用编辑器同款原子替换：同目录临时文件 + 落盘同步 + 替换前复核内容，
            // 崩溃时不再留下半截文件，并保留权限/所有者/ACL/扩展属性。
            crate::atomic_replace_file(path, next.as_bytes(), current.as_bytes())
                .map_err(io::Error::other)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            // 新建（例如仓库还没有 .gitignore）：没有原文件可复制元数据，同样走
            // 同目录临时文件 + 原子替换，避免留下半截内容。
            let parent = path
                .parent()
                .ok_or_else(|| io::Error::other("无法确定文件所在目录"))?;
            let mut temp = tempfile::Builder::new()
                .prefix(".roster-memory-")
                .tempfile_in(parent)?;
            temp.write_all(next.as_bytes())?;
            temp.as_file().sync_all()?;
            temp.persist(path).map_err(|error| error.error)?;
            Ok(())
        }
        Err(error) => Err(error),
    }
}

fn create_dir_symlink(target: &Path, link: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link)
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(target, link)
    }
}

fn remove_dir_symlink(link: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        fs::remove_dir(link)
    }
    #[cfg(not(windows))]
    {
        fs::remove_file(link)
    }
}

fn link_points_to(link: &Path, target: &Path) -> bool {
    let Ok(dest) = fs::read_link(link) else {
        return false;
    };
    if dest == target {
        return true;
    }
    match (
        link.parent().unwrap_or(link).join(&dest).canonicalize(),
        target.canonicalize(),
    ) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn ensure_workspace_link(project_dir: &Path, memory_dir: &Path) -> Result<(), String> {
    let link = project_dir.join(WORKSPACE_MEMORY_LINK);
    if let Ok(meta) = link.symlink_metadata() {
        if meta.file_type().is_symlink() {
            if link_points_to(&link, memory_dir) {
                return Ok(());
            }
            remove_dir_symlink(&link).map_err(|e| format!("无法更新 .memory 链接：{e}"))?;
        } else if meta.is_dir() {
            let empty = fs::read_dir(&link)
                .map_err(|e| format!("无法读取已有 .memory 目录：{e}"))?
                .next()
                .is_none();
            if !empty {
                return Err("项目里的 .memory 已是非空目录，未覆盖".into());
            }
            fs::remove_dir(&link).map_err(|e| format!("无法替换空的 .memory 目录：{e}"))?;
        } else {
            return Err("项目里的 .memory 已存在且不是链接，未覆盖".into());
        }
    }
    create_dir_symlink(memory_dir, &link).map_err(|e| format!("创建 .memory 链接失败：{e}"))
}

fn upsert_instruction_file(path: &Path) -> Result<(), String> {
    let current = read_regular_file(path)
        .ok_or_else(|| format!("{} 不是可安全写入的普通文件，未修改", path.display()))?;
    let next = upsert_memory_pointer(&current);
    write_if_changed(path, &next).map_err(|e| format!("写入 {} 失败：{e}", path.display()))
}

fn ensure_instruction_pointers(project_dir: &Path) -> Result<(), String> {
    for name in ["CLAUDE.md", "AGENTS.md"] {
        let path = project_dir.join(name);
        // symlink_metadata 对链接返回 symlink 而不是 file：链接一律跳过。
        if fs::symlink_metadata(&path)
            .map(|meta| meta.is_file())
            .unwrap_or(false)
        {
            upsert_instruction_file(&path)?;
        }
    }
    Ok(())
}

pub(crate) fn find_git_root(start: &Path) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    loop {
        if current.join(".git").exists() {
            return Some(current);
        }
        if !current.pop() {
            return None;
        }
    }
}

fn ensure_gitignore(project_dir: &Path) -> Result<(), String> {
    let Some(git_root) = find_git_root(project_dir) else {
        return Ok(());
    };
    let path = git_root.join(".gitignore");
    let current = match fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_file() => {
            fs::read_to_string(&path).map_err(|e| format!("读取 .gitignore 失败：{e}"))?
        }
        // 链接、目录或特殊文件：不碰，避免顺着链接写到项目外。
        Ok(_) => return Ok(()),
        Err(_) => String::new(),
    };
    let next = ensure_memory_gitignore(&current);
    write_if_changed(&path, &next).map_err(|e| format!("写入 .gitignore 失败：{e}"))
}

fn collect_state(project_dir: &Path, memory_dir: &Path, warning: String) -> ProjectMemoryState {
    let index = memory_dir.join("MEMORY.md");
    let markdown = fs::read_to_string(index).unwrap_or_default();
    let topics = parse_memory_topics(&markdown, 12);
    let topic_count = if topics.is_empty() {
        fs::read_dir(memory_dir)
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|entry| {
                        entry.path().extension().and_then(|ext| ext.to_str()) == Some("md")
                            && entry.file_name() != "MEMORY.md"
                    })
                    .count() as u32
            })
            .unwrap_or(0)
    } else {
        topics.len() as u32
    };
    ProjectMemoryState {
        mounted: true,
        skipped: false,
        project_path: project_dir.to_string_lossy().into_owned(),
        memory_path: memory_dir.to_string_lossy().into_owned(),
        link_path: project_dir
            .join(WORKSPACE_MEMORY_LINK)
            .to_string_lossy()
            .into_owned(),
        index_preview: index_preview(&markdown),
        topics,
        topic_count,
        inbox_count: count_inbox(memory_dir),
        warning,
    }
}

pub fn ensure_project_memory_with_home(
    project_path: &str,
    home: &Path,
) -> Result<ProjectMemoryState, String> {
    let raw = normalize_project_cwd(project_path);
    if raw.is_empty() {
        return Ok(ProjectMemoryState::skipped(
            String::new(),
            "空白终端没有项目目录",
        ));
    }
    let project_dir = PathBuf::from(&raw);
    if !should_mount_project_memory(&project_dir, Some(home)) {
        return Ok(ProjectMemoryState::skipped(
            raw,
            "主目录或根目录不挂载项目记忆",
        ));
    }

    let memory_dir = resolve_memory_dir(home, &project_dir, &raw);
    fs::create_dir_all(memory_dir.join("inbox")).map_err(|e| format!("创建记忆目录失败：{e}"))?;

    let index = memory_dir.join("MEMORY.md");
    if !index.exists() {
        fs::write(&index, seed_memory_index()).map_err(|e| format!("创建 MEMORY.md 失败：{e}"))?;
    }

    if let Err(err) = ensure_workspace_link(&project_dir, &memory_dir) {
        let mut state = collect_state(&project_dir, &memory_dir, err);
        state.mounted = false;
        return Ok(state);
    }

    let mut warning = String::new();
    if let Err(err) = ensure_gitignore(&project_dir) {
        warning = err;
    }
    if let Err(err) = ensure_instruction_pointers(&project_dir) {
        if warning.is_empty() {
            warning = err;
        }
    }

    let mut state = collect_state(&project_dir, &memory_dir, warning);
    state.mounted = project_dir
        .join(WORKSPACE_MEMORY_LINK)
        .symlink_metadata()
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false);
    if !state.mounted && state.warning.is_empty() {
        state.warning = "未能创建 .memory 链接".into();
    }
    Ok(state)
}

pub fn ensure_project_memory(project_path: &str) -> Result<ProjectMemoryState, String> {
    let home = dirs::home_dir().ok_or_else(|| "找不到用户主目录".to_string())?;
    ensure_project_memory_with_home(project_path, &home)
}

pub fn detach_project_memory(project_path: &str) -> Result<ProjectMemoryState, String> {
    let raw = normalize_project_cwd(project_path);
    if raw.is_empty() {
        return Ok(ProjectMemoryState::skipped(
            String::new(),
            "空白终端没有项目目录",
        ));
    }
    let project_dir = PathBuf::from(&raw);
    let link = project_dir.join(WORKSPACE_MEMORY_LINK);
    if let Ok(meta) = link.symlink_metadata() {
        if meta.file_type().is_symlink() {
            remove_dir_symlink(&link).map_err(|e| format!("移除 .memory 链接失败：{e}"))?;
        }
    }
    remove_instruction_pointers(&project_dir)?;
    Ok(ProjectMemoryState::skipped(
        raw,
        "已关闭统一记忆，不再自动挂载",
    ))
}

fn remove_instruction_pointers(project_dir: &Path) -> Result<(), String> {
    for name in ["CLAUDE.md", "AGENTS.md"] {
        let path = project_dir.join(name);
        // 链接/非普通文件一律不碰：detach 不能顺着链接改项目外文件。
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let current =
            fs::read_to_string(&path).map_err(|e| format!("读取 {} 失败：{e}", path.display()))?;
        let next = remove_memory_pointer(&current);
        write_if_changed(&path, &next).map_err(|e| format!("写入 {} 失败：{e}", path.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_home() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        fs::create_dir_all(&home).unwrap();
        (root, home)
    }

    #[test]
    fn encode_matches_claude_project_dir_rules() {
        assert_eq!(
            encode_claude_project_dir("/Users/lucky/git/smalltree/self/roster"),
            "-Users-lucky-git-smalltree-self-roster"
        );
        assert_eq!(
            encode_claude_project_dir("/Users/lucky/foo.bar/"),
            "-Users-lucky-foo-bar"
        );
    }

    #[test]
    fn pointer_and_gitignore_are_idempotent() {
        let first = upsert_memory_pointer("# 约束\n");
        let second = upsert_memory_pointer(&first);
        assert_eq!(first, second);
        assert!(first.contains(MEMORY_POINTER_START));
        let ignore = ensure_memory_gitignore("node_modules\n");
        assert_eq!(ignore, ensure_memory_gitignore(&ignore));
        assert!(ignore.contains(".memory\n"));
        let stripped = remove_memory_pointer(&first);
        assert!(!stripped.contains(MEMORY_POINTER_START));
        assert!(stripped.contains("# 约束"));
        assert_eq!(remove_memory_pointer(&stripped), stripped);
    }

    #[test]
    fn mounts_symlink_inbox_and_does_not_overwrite_index() {
        let (_root, home) = temp_home();
        let project = home.join("code").join("app");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("AGENTS.md"), "# 入口\n").unwrap();
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let memory = memory_dir_for_project(&home, &project.to_string_lossy());
        fs::create_dir_all(&memory).unwrap();
        fs::write(
            memory.join("MEMORY.md"),
            format!("# 已有索引 {unique}\n- [终端](builtin-terminal.md)\n"),
        )
        .unwrap();

        let state = ensure_project_memory_with_home(project.to_str().unwrap(), &home).unwrap();
        assert!(state.mounted);
        assert_eq!(state.topics.len(), 1);
        assert_eq!(state.topics[0].title, "终端");
        assert!(fs::read_to_string(memory.join("MEMORY.md"))
            .unwrap()
            .contains(&unique.to_string()));
        assert!(project
            .join(".memory")
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(memory.join("inbox").is_dir());
        let agents = fs::read_to_string(project.join("AGENTS.md")).unwrap();
        assert!(agents.contains(MEMORY_POINTER_START));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_instruction_files_and_gitignore_are_never_written_through() {
        let (root, home) = temp_home();
        let project = home.join("code").join("evil");
        fs::create_dir_all(project.join(".git")).unwrap();
        // 模拟恶意仓库：CLAUDE.md / .gitignore 指向项目外的真实文件。
        let outside_md = root.path().join("outside.md");
        let outside_ignore = root.path().join("outside-ignore");
        fs::write(&outside_md, "# 外部文件\n").unwrap();
        fs::write(&outside_ignore, "node_modules\n").unwrap();
        std::os::unix::fs::symlink(&outside_md, project.join("CLAUDE.md")).unwrap();
        std::os::unix::fs::symlink(&outside_ignore, project.join(".gitignore")).unwrap();

        ensure_project_memory_with_home(project.to_str().unwrap(), &home).unwrap();

        assert_eq!(
            fs::read_to_string(&outside_md).unwrap(),
            "# 外部文件\n",
            "符号链接的 CLAUDE.md 不能被写入"
        );
        assert_eq!(
            fs::read_to_string(&outside_ignore).unwrap(),
            "node_modules\n",
            "符号链接的 .gitignore 不能被写入"
        );
    }

    #[test]
    fn refuses_to_replace_nonempty_memory_directory() {
        let (_root, home) = temp_home();
        let project = home.join("code").join("keep");
        fs::create_dir_all(project.join(".memory")).unwrap();
        fs::write(project.join(".memory").join("note.md"), "keep").unwrap();
        fs::write(project.join("AGENTS.md"), "# 入口\n").unwrap();
        fs::create_dir_all(project.join(".git")).unwrap();
        let state = ensure_project_memory_with_home(project.to_str().unwrap(), &home).unwrap();
        assert!(!state.mounted);
        assert!(state.warning.contains("非空目录"));
        assert!(project.join(".memory").join("note.md").is_file());
        assert!(!project.join(".gitignore").exists());
        assert!(!fs::read_to_string(project.join("AGENTS.md"))
            .unwrap()
            .contains(MEMORY_POINTER_START));
    }

    #[test]
    fn mounts_without_creating_instruction_files() {
        let (_root, home) = temp_home();
        let project = home.join("code").join("bare");
        fs::create_dir_all(&project).unwrap();

        let state = ensure_project_memory_with_home(project.to_str().unwrap(), &home).unwrap();
        assert!(state.mounted);
        assert!(project
            .join(".memory")
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!project.join("CLAUDE.md").exists());
        assert!(!project.join("AGENTS.md").exists());
    }

    #[test]
    fn finds_existing_memory_without_creating_or_mounting_it() {
        let (_root, home) = temp_home();
        let project = home.join("code").join("preview");
        fs::create_dir_all(&project).unwrap();
        let memory = memory_dir_for_project(&home, project.to_str().unwrap());
        fs::create_dir_all(&memory).unwrap();
        fs::write(memory.join("MEMORY.md"), "# 记忆\n").unwrap();

        assert_eq!(
            existing_memory_dir_with_home(project.to_str().unwrap(), &home),
            Some(memory.canonicalize().unwrap())
        );
        assert!(!project.join(WORKSPACE_MEMORY_LINK).exists());
    }

    #[test]
    fn detach_removes_symlink_and_keeps_canonical_memory() {
        let (_root, home) = temp_home();
        let project = home.join("code").join("off");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("AGENTS.md"), "# 入口\n").unwrap();
        let mounted = ensure_project_memory_with_home(project.to_str().unwrap(), &home).unwrap();
        assert!(mounted.mounted);
        let memory = PathBuf::from(&mounted.memory_path);
        assert!(memory.join("MEMORY.md").is_file());
        assert!(fs::read_to_string(project.join("AGENTS.md"))
            .unwrap()
            .contains(MEMORY_POINTER_START));

        let detached = detach_project_memory(project.to_str().unwrap()).unwrap();
        assert!(!detached.mounted);
        assert!(detached.skipped);
        assert!(!project.join(".memory").exists());
        assert!(memory.join("MEMORY.md").is_file());
        assert!(!fs::read_to_string(project.join("AGENTS.md"))
            .unwrap()
            .contains(MEMORY_POINTER_START));
    }

    #[test]
    fn writes_gitignore_at_nearest_git_root() {
        let (_root, home) = temp_home();
        let git_root = home.join("repo");
        let project = git_root.join("apps").join("web");
        fs::create_dir_all(git_root.join(".git")).unwrap();
        fs::create_dir_all(&project).unwrap();

        let state = ensure_project_memory_with_home(project.to_str().unwrap(), &home).unwrap();
        assert!(state.mounted);
        let ignore = fs::read_to_string(git_root.join(".gitignore")).unwrap();
        assert!(ignore.contains(".memory\n"));
        assert!(!project.join(".gitignore").exists());
    }

    #[test]
    fn skips_home_directory() {
        let (_root, home) = temp_home();
        let state = ensure_project_memory_with_home(home.to_str().unwrap(), &home).unwrap();
        assert!(state.skipped);
        assert!(!state.mounted);
        assert!(!home.join(".memory").exists());
    }

    #[cfg(unix)]
    #[test]
    fn pointer_update_uses_atomic_replace_and_keeps_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let (root, _home) = temp_home();
        let path = root.path().join("CLAUDE.md");
        fs::write(&path, "# 约束\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();

        upsert_instruction_file(&path).unwrap();

        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains(MEMORY_POINTER_START));
        assert!(text.contains("# 约束"));
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "原子替换后要保留原文件权限");
    }

    #[test]
    fn atomic_replace_refuses_to_overwrite_concurrent_external_change() {
        // 模拟「读取后、替换前」别人改了文件：必须报错并保留对方的内容。
        let (root, _home) = temp_home();
        let path = root.path().join("CLAUDE.md");
        fs::write(&path, "# 约束\n").unwrap();
        let error =
            crate::atomic_replace_file(&path, b"next", "# 已被外部改写\n".as_bytes()).unwrap_err();
        assert!(error.contains("已被其他程序修改"), "{error}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "# 约束\n");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_update_readonly_instruction_file() {
        use std::os::unix::fs::PermissionsExt;
        let (root, _home) = temp_home();
        let path = root.path().join("CLAUDE.md");
        fs::write(&path, "# 约束\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();
        let error = upsert_instruction_file(&path).unwrap_err();
        assert!(error.contains("只读"), "{error}");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "# 约束\n");
    }
}
