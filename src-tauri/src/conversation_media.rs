use base64::Engine;
use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_CONVERSATION_MEDIA_BYTES: u64 = 16 * 1024 * 1024;
const MAX_CONVERSATION_LINK_FILE_BYTES: u64 = 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_MEDIA_SOURCE_CHARS: usize = 4096;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationAttachment {
    pub kind: String,
    pub mime_type: String,
    pub data_url: String,
    pub alt: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMedia {
    pub kind: String,
    pub mime_type: String,
    pub data_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationFilePreview {
    pub name: String,
    pub path: String,
    pub content: String,
    pub truncated: bool,
    pub kind: String,
    pub line: Option<u32>,
}

fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else if bytes.starts_with(b"\x00\x00\x01\x00") {
        Some("image/x-icon")
    } else if bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && matches!(&bytes[8..12], b"avif" | b"avis")
    {
        Some("image/avif")
    } else {
        None
    }
}

fn media_type(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if let Some(mime) = image_mime(bytes) {
        return Some(("image", mime));
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return Some(("video", "video/mp4"));
    }
    if bytes.starts_with(b"\x1a\x45\xdf\xa3") {
        return Some(("video", "video/webm"));
    }
    None
}

fn read_bounded_regular_file(
    file: fs::File,
    max_bytes: u64,
    too_large: &str,
) -> Result<Vec<u8>, String> {
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("路径不是普通文件".into());
    }
    if metadata.len() > max_bytes {
        return Err(too_large.into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize + 1);
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > max_bytes {
        return Err(too_large.into());
    }
    Ok(bytes)
}

#[cfg(not(any(unix, windows)))]
fn bounded_regular_file(path: &Path, max_bytes: u64, too_large: &str) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("媒体路径不能是符号链接".into());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    let file = options.open(path).map_err(|error| error.to_string())?;
    read_bounded_regular_file(file, max_bytes, too_large)
}

#[cfg(windows)]
fn bounded_project_regular_file(
    project: &Path,
    target: &Path,
    max_bytes: u64,
    too_large: &str,
) -> Result<Vec<u8>, String> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
    };

    fn comparable_path(path: &Path) -> String {
        let value = path.to_string_lossy().replace('/', "\\");
        let value = if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{rest}")
        } else if let Some(rest) = value.strip_prefix(r"\\?\") {
            rest.to_string()
        } else {
            value
        };
        value.trim_end_matches('\\').to_lowercase()
    }

    let file = fs::File::open(target).map_err(|_| "媒体路径无法安全读取".to_string())?;

    // Parent junctions and symlinks are resolved by CreateFile. Ask Windows
    // for the path of the handle that was actually opened, then verify that
    // path against the already-canonical project root. This closes the gap
    // where a parent is replaced between canonicalize and open.
    let mut buffer = vec![0u16; 32_768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle() as HANDLE,
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    } as usize;
    if length == 0 || length >= buffer.len() {
        return Err("媒体路径无法安全读取".into());
    }
    buffer.truncate(length);
    let final_path = PathBuf::from(std::ffi::OsString::from_wide(&buffer));
    let project = comparable_path(project);
    let final_path = comparable_path(&final_path);
    let project_prefix = format!("{project}\\");
    if final_path != project && !final_path.starts_with(&project_prefix) {
        return Err("只能显示当前项目目录中的媒体".into());
    }

    read_bounded_regular_file(file, max_bytes, too_large)
}

/// Opens a canonical project-relative target through already-open directory FDs.
///
/// `canonicalize` is still used to establish that the requested path was in the
/// project at validation time, but it cannot protect a path lookup from a later
/// parent-directory swap.  Walking the canonical relative components with
/// `openat(..., O_NOFOLLOW)` makes every lookup stay below the root FD that we
/// opened, and rejects a symlink substituted at any level.
#[cfg(unix)]
fn bounded_project_regular_file(
    project: &Path,
    target: &Path,
    max_bytes: u64,
    too_large: &str,
) -> Result<Vec<u8>, String> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::OpenOptionsExt;

    fn open_directory_at(parent: &fs::File, name: &std::ffi::OsStr) -> Result<fs::File, String> {
        let name = CString::new(name.as_bytes()).map_err(|_| "媒体路径无效".to_string())?;
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY
                    | libc::O_DIRECTORY
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK
                    | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err("媒体路径无法安全读取".into());
        }
        // SAFETY: openat returned a new owned fd on success.
        Ok(unsafe { fs::File::from_raw_fd(fd) })
    }

    let relative = target
        .strip_prefix(project)
        .map_err(|_| "只能显示当前项目目录中的媒体".to_string())?;
    let components = relative
        .components()
        .map(|component| match component {
            std::path::Component::Normal(name) => Ok(name),
            _ => Err("媒体路径无效".to_string()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let (file_name, directories) = components
        .split_last()
        .ok_or_else(|| "媒体路径不是普通文件".to_string())?;

    // Open the canonical project itself component-by-component from `/` as
    // well. O_NOFOLLOW on only the final project directory would still allow
    // one of its ancestors to be exchanged for a symlink after validation.
    let mut root_options = fs::OpenOptions::new();
    root_options
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
    let mut directory = root_options
        .open(Path::new("/"))
        .map_err(|_| "项目目录无法安全读取".to_string())?;

    for component in project.components() {
        match component {
            std::path::Component::RootDir => {}
            std::path::Component::Normal(name) => {
                directory = open_directory_at(&directory, name)?;
            }
            _ => return Err("项目目录无法安全读取".into()),
        }
    }

    for name in directories {
        directory = open_directory_at(&directory, name)?;
    }

    let file_name = CString::new(file_name.as_bytes()).map_err(|_| "媒体路径无效".to_string())?;
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            file_name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err("媒体路径无法安全读取".into());
    }
    // SAFETY: openat returned a new owned fd on success.
    read_bounded_regular_file(unsafe { fs::File::from_raw_fd(fd) }, max_bytes, too_large)
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn percent_decode_path(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("媒体路径包含无效转义".into());
            }
            let high = hex(bytes[index + 1]).ok_or_else(|| "媒体路径包含无效转义".to_string())?;
            let low = hex(bytes[index + 2]).ok_or_else(|| "媒体路径包含无效转义".to_string())?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| "媒体路径不是有效 UTF-8".into())
}

fn resolve_project_media(project_path: &str, source: &str) -> Result<(PathBuf, PathBuf), String> {
    let source = source.trim();
    if source.is_empty()
        || source.chars().count() > MAX_MEDIA_SOURCE_CHARS
        || source.chars().any(char::is_control)
    {
        return Err("媒体路径无效".into());
    }
    let raw = if let Some(file_path) = source.strip_prefix("file://") {
        file_path
    } else if source.contains("://") || source.starts_with("data:") || source.starts_with("blob:") {
        return Err("只允许读取当前项目中的本地媒体".into());
    } else {
        source
    };
    let decoded = percent_decode_path(raw)?;
    #[cfg(windows)]
    let decoded = decoded
        .strip_prefix('/')
        .filter(|value| value.as_bytes().get(1) == Some(&b':'))
        .unwrap_or(&decoded)
        .to_string();
    let project = fs::canonicalize(project_path).map_err(|_| "项目目录不存在".to_string())?;
    if !project.is_dir() {
        return Err("项目路径不是目录".into());
    }
    let candidate = PathBuf::from(decoded);
    let candidate = if candidate.is_absolute() {
        candidate
    } else {
        project.join(candidate)
    };
    let target = fs::canonicalize(candidate).map_err(|_| "媒体文件不存在".to_string())?;
    if !target.starts_with(&project) {
        return Err("只能显示当前项目目录中的媒体".into());
    }
    Ok((project, target))
}

fn split_line_hint(source: &str) -> (&str, Option<u32>) {
    if let Some((path, line)) = source.rsplit_once("#L") {
        if !line.is_empty() && line.bytes().all(|byte| byte.is_ascii_digit()) {
            return (path, line.parse().ok().filter(|line| *line > 0));
        }
    }
    if let Some((path, line)) = source.rsplit_once(':') {
        if !line.is_empty() && line.bytes().all(|byte| byte.is_ascii_digit()) {
            return (path, line.parse().ok().filter(|line| *line > 0));
        }
    }
    (source, None)
}

fn has_unsupported_link_scheme(source: &str) -> bool {
    let Some((scheme, _)) = source.split_once(':') else {
        return false;
    };
    if scheme.len() == 1 && scheme.as_bytes()[0].is_ascii_alphabetic() {
        return false;
    }
    !scheme.is_empty()
        && scheme.as_bytes()[0].is_ascii_alphabetic()
        && scheme
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
}

fn read_link_file_with_memory_root(
    project_path: &str,
    memory_root: Option<PathBuf>,
    source: &str,
    base_path: Option<&str>,
) -> Result<ConversationFilePreview, String> {
    let source = source.trim();
    if source.is_empty()
        || source.chars().count() > MAX_MEDIA_SOURCE_CHARS
        || source.chars().any(char::is_control)
    {
        return Err("文件链接无效".into());
    }
    let raw = source.strip_prefix("file://").unwrap_or(source);
    let decoded = percent_decode_path(raw)?;
    let (decoded, line) = split_line_hint(&decoded);
    if has_unsupported_link_scheme(decoded) {
        return Err("只支持本地文件链接".into());
    }
    #[cfg(windows)]
    let decoded = decoded
        .strip_prefix('/')
        .filter(|value| value.as_bytes().get(1) == Some(&b':'))
        .unwrap_or(decoded);

    let project = fs::canonicalize(project_path).map_err(|_| "项目目录不存在".to_string())?;
    if !project.is_dir() {
        return Err("项目路径不是目录".into());
    }
    let memory_root = memory_root
        .and_then(|path| path.canonicalize().ok())
        .filter(|path| path.is_dir());
    let base = base_path
        .map(|path| {
            if path.is_empty() || path.len() > 16_384 || path.chars().any(char::is_control) {
                return Err("预览来源路径无效".to_string());
            }
            let base = fs::canonicalize(path).map_err(|_| "预览来源文件不存在".to_string())?;
            if !base.is_file()
                || !(base.starts_with(&project)
                    || memory_root
                        .as_ref()
                        .is_some_and(|root| base.starts_with(root)))
            {
                return Err("预览来源不属于当前项目或其记忆目录".to_string());
            }
            Ok(base)
        })
        .transpose()?;
    let requested = PathBuf::from(decoded);
    let candidates = if requested.is_absolute() {
        vec![requested]
    } else if let Some(base) = base {
        // Once a document is open, links are relative to that document only.
        // Never fall back to another root and accidentally open a namesake.
        vec![base.parent().ok_or("预览来源路径无效")?.join(&requested)]
    } else {
        let mut candidates = vec![project.join(&requested)];
        if let Some(memory) = memory_root.as_ref() {
            candidates.push(memory.join(&requested));
        }
        candidates
    };

    let mut outside_allowed_root = false;
    let mut selected = None;
    for candidate in candidates {
        let Ok(target) = candidate.canonicalize() else {
            continue;
        };
        let root = if target.starts_with(&project) {
            Some(project.clone())
        } else {
            memory_root
                .as_ref()
                .filter(|memory| target.starts_with(memory.as_path()))
                .cloned()
        };
        if let Some(root) = root {
            selected = Some((root, target));
            break;
        }
        outside_allowed_root = true;
    }
    let (root, target) = selected.ok_or_else(|| {
        if outside_allowed_root {
            "只能预览当前项目或该项目 Claude 记忆目录中的文件".to_string()
        } else {
            "链接指向的本地文件不存在".to_string()
        }
    })?;

    #[cfg(any(unix, windows))]
    let bytes = bounded_project_regular_file(
        &root,
        &target,
        MAX_CONVERSATION_LINK_FILE_BYTES,
        "文件超过 1MB，无法在会话中预览",
    )?;
    #[cfg(not(any(unix, windows)))]
    let bytes = bounded_regular_file(
        &target,
        MAX_CONVERSATION_LINK_FILE_BYTES,
        "文件超过 1MB，无法在会话中预览",
    )?;
    if bytes.contains(&0) {
        return Err("这是二进制文件，无法在会话中预览".into());
    }
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "文件名不是有效 UTF-8".to_string())?
        .to_string();
    let kind = match target
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("md" | "markdown" | "mdx") => "markdown",
        _ => "text",
    };
    Ok(ConversationFilePreview {
        name,
        path: target.to_string_lossy().to_string(),
        content: String::from_utf8_lossy(&bytes).to_string(),
        truncated: false,
        kind: kind.into(),
        line,
    })
}

pub fn read_link_file(
    project_path: &str,
    source: &str,
    base_path: Option<&str>,
) -> Result<ConversationFilePreview, String> {
    read_link_file_with_memory_root(
        project_path,
        crate::project_memory::existing_memory_dir(project_path),
        source,
        base_path,
    )
}

/// 用户自己拖进来或选中的图片：路径来自本人操作，所以允许符号链接，
/// 但仍然按普通文件、8MB 上限和魔数逐项校验，不认扩展名。
pub fn read_attachment_image(path: &str) -> Result<ConversationMedia, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_MEDIA_SOURCE_CHARS {
        return Err("图片路径无效".into());
    }
    if trimmed.chars().any(|ch| ch.is_control()) {
        return Err("图片路径无效".into());
    }
    let file = fs::File::open(Path::new(trimmed)).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("这不是一个普通文件".into());
    }
    if metadata.len() as usize > MAX_INLINE_IMAGE_BYTES {
        return Err("单张图片不能超过 8MB".into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize + 1);
    file.take(MAX_INLINE_IMAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > MAX_INLINE_IMAGE_BYTES {
        return Err("单张图片不能超过 8MB".into());
    }
    let mime = match image_mime(&bytes) {
        Some(mime @ ("image/png" | "image/jpeg" | "image/gif" | "image/webp")) => mime,
        _ => return Err("只支持 PNG、JPEG、GIF、WebP 图片".into()),
    };
    Ok(ConversationMedia {
        kind: "image".into(),
        mime_type: mime.into(),
        data_url: format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        ),
    })
}

pub fn read_project_media(project_path: &str, source: &str) -> Result<ConversationMedia, String> {
    let (project, target) = resolve_project_media(project_path, source)?;
    #[cfg(any(unix, windows))]
    let bytes = bounded_project_regular_file(
        &project,
        &target,
        MAX_CONVERSATION_MEDIA_BYTES,
        "媒体文件超过 16MB，无法在对话中显示",
    )?;
    #[cfg(not(any(unix, windows)))]
    let bytes = bounded_regular_file(
        &target,
        MAX_CONVERSATION_MEDIA_BYTES,
        "媒体文件超过 16MB，无法在对话中显示",
    )?;
    let (kind, mime_type) = media_type(&bytes).ok_or_else(|| "不支持这种媒体格式".to_string())?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(ConversationMedia {
        kind: kind.into(),
        mime_type: mime_type.into(),
        data_url: format!("data:{mime_type};base64,{encoded}"),
    })
}

pub fn inline_image_attachment(
    data_url: &str,
    alt: &str,
    remaining_bytes: &mut usize,
) -> Option<ConversationAttachment> {
    let rest = data_url.strip_prefix("data:")?;
    let (metadata, encoded) = rest.split_once(',')?;
    let (declared_mime, encoding) = metadata.split_once(';')?;
    if encoding != "base64" || !declared_mime.starts_with("image/") {
        return None;
    }
    let estimated = encoded.len().saturating_mul(3) / 4;
    if estimated > MAX_INLINE_IMAGE_BYTES || estimated > *remaining_bytes {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.as_bytes())
        .ok()?;
    let detected_mime = image_mime(&bytes)?;
    if detected_mime != declared_mime || bytes.len() > *remaining_bytes {
        return None;
    }
    *remaining_bytes -= bytes.len();
    let alt = alt
        .chars()
        .filter(|ch| !ch.is_control())
        .take(160)
        .collect::<String>();
    Some(ConversationAttachment {
        kind: "image".into(),
        mime_type: detected_mime.into(),
        data_url: format!(
            "data:{detected_mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ),
        alt: if alt.trim().is_empty() {
            "会话图片".into()
        } else {
            alt
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversation_file_links_allow_project_and_its_memory_but_reject_other_roots() {
        let project = tempfile::tempdir().unwrap();
        let memory = tempfile::tempdir().unwrap();
        fs::create_dir_all(project.path().join("docs")).unwrap();
        fs::write(project.path().join("docs/readme.md"), "# 项目说明\n").unwrap();
        fs::write(memory.path().join("MEMORY.md"), "# 项目记忆索引\n").unwrap();
        fs::write(memory.path().join("wow3d.md"), "# WOW3D\n").unwrap();

        let project_file = read_link_file_with_memory_root(
            project.path().to_str().unwrap(),
            Some(memory.path().to_path_buf()),
            "docs/readme.md#L1",
            None,
        )
        .unwrap();
        assert_eq!(project_file.name, "readme.md");
        assert_eq!(project_file.kind, "markdown");
        assert_eq!(project_file.line, Some(1));
        assert_eq!(project_file.content, "# 项目说明\n");

        let memory_file = read_link_file_with_memory_root(
            project.path().to_str().unwrap(),
            Some(memory.path().to_path_buf()),
            memory.path().join("wow3d.md").to_str().unwrap(),
            None,
        )
        .unwrap();
        assert_eq!(memory_file.content, "# WOW3D\n");

        let relative_memory = read_link_file_with_memory_root(
            project.path().to_str().unwrap(),
            Some(memory.path().to_path_buf()),
            "MEMORY.md",
            None,
        )
        .unwrap();
        assert_eq!(relative_memory.content, "# 项目记忆索引\n");

        let outside = tempfile::NamedTempFile::new().unwrap();
        assert!(read_link_file_with_memory_root(
            project.path().to_str().unwrap(),
            Some(memory.path().to_path_buf()),
            outside.path().to_str().unwrap(),
            None,
        )
        .unwrap_err()
        .contains("只能预览"));
        assert!(read_link_file_with_memory_root(
            project.path().to_str().unwrap(),
            Some(memory.path().to_path_buf()),
            "https://example.com/secret.md",
            None,
        )
        .unwrap_err()
        .contains("本地文件"));
    }

    #[test]
    fn nested_file_links_use_document_directory_and_keep_scope() {
        let project = tempfile::tempdir().unwrap();
        let memory = tempfile::tempdir().unwrap();
        fs::create_dir(project.path().join("docs")).unwrap();
        let base = project.path().join("docs/README.md");
        fs::write(&base, "# Docs").unwrap();
        fs::write(project.path().join("guide.md"), "wrong root").unwrap();
        fs::write(project.path().join("docs/guide.md"), "correct sibling").unwrap();
        let preview = read_link_file_with_memory_root(
            project.path().to_str().unwrap(),
            Some(memory.path().into()),
            "guide.md:2",
            base.to_str(),
        )
        .unwrap();
        assert_eq!(preview.content, "correct sibling");
        assert_eq!(preview.line, Some(2));
        fs::remove_file(project.path().join("docs/guide.md")).unwrap();
        assert!(
            read_link_file_with_memory_root(
                project.path().to_str().unwrap(),
                None,
                "guide.md",
                base.to_str(),
            )
            .is_err(),
            "missing sibling must not fall back to root namesake"
        );
        let outside = tempfile::NamedTempFile::new().unwrap();
        assert!(read_link_file_with_memory_root(
            project.path().to_str().unwrap(),
            None,
            "guide.md",
            outside.path().to_str(),
        )
        .is_err());
        let memory_base = memory.path().join("MEMORY.md");
        fs::write(&memory_base, "index").unwrap();
        fs::write(memory.path().join("topic.md"), "memory sibling").unwrap();
        assert_eq!(
            read_link_file_with_memory_root(
                project.path().to_str().unwrap(),
                Some(memory.path().into()),
                "topic.md",
                memory_base.to_str(),
            )
            .unwrap()
            .content,
            "memory sibling"
        );
    }

    #[test]
    fn project_media_stays_inside_project_and_detects_video() {
        let project = tempfile::tempdir().unwrap();
        let video = project.path().join("preview.mp4");
        fs::write(&video, b"\0\0\0\x18ftypisomdemo").unwrap();
        let media = read_project_media(project.path().to_str().unwrap(), "preview.mp4").unwrap();
        assert_eq!(media.kind, "video");
        assert_eq!(media.mime_type, "video/mp4");

        let outside = tempfile::NamedTempFile::new().unwrap();
        assert!(read_project_media(
            project.path().to_str().unwrap(),
            outside.path().to_str().unwrap()
        )
        .is_err());
        assert!(read_project_media(project.path().to_str().unwrap(), "../outside.png").is_err());
        assert!(read_project_media(
            project.path().to_str().unwrap(),
            "https://example.com/a.png"
        )
        .is_err());
    }

    #[test]
    fn project_media_decodes_file_urls_but_rejects_encoded_escape_and_symlink() {
        let project = tempfile::tempdir().unwrap();
        let image = project.path().join("screen shot.png");
        fs::write(&image, b"\x89PNG\r\n\x1a\ndemo").unwrap();
        let encoded = image.to_string_lossy().replace(' ', "%20");
        let media = read_project_media(
            project.path().to_str().unwrap(),
            &format!("file://{encoded}"),
        )
        .unwrap();
        assert_eq!(media.mime_type, "image/png");

        let outside = tempfile::tempdir().unwrap();
        let outside_image = outside.path().join("outside.png");
        fs::write(&outside_image, b"\x89PNG\r\n\x1a\ndemo").unwrap();
        assert!(read_project_media(project.path().to_str().unwrap(), "..%2Foutside.png").is_err());

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink(&outside_image, project.path().join("outside-link.png")).unwrap();
            assert!(
                read_project_media(project.path().to_str().unwrap(), "outside-link.png").is_err()
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn project_media_rejects_parent_directory_swapped_to_symlink_after_validation() {
        use std::os::unix::fs::symlink;

        let project = tempfile::tempdir().unwrap();
        let safe_dir = project.path().join("screens");
        fs::create_dir(&safe_dir).unwrap();
        fs::write(safe_dir.join("preview.png"), b"\x89PNG\r\n\x1a\ndemo").unwrap();

        let (canonical_project, target) =
            resolve_project_media(project.path().to_str().unwrap(), "screens/preview.png").unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(
            outside.path().join("preview.png"),
            b"\x89PNG\r\n\x1a\noutside",
        )
        .unwrap();
        fs::rename(&safe_dir, project.path().join("screens-original")).unwrap();
        symlink(outside.path(), &safe_dir).unwrap();

        assert!(bounded_project_regular_file(
            &canonical_project,
            &target,
            MAX_CONVERSATION_MEDIA_BYTES,
            "媒体文件过大"
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn project_media_rejects_project_ancestor_swapped_to_symlink_after_validation() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let parent = root.path().join("parent");
        let project = parent.join("project");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("preview.png"), b"\x89PNG\r\n\x1a\ndemo").unwrap();
        let (canonical_project, target) =
            resolve_project_media(project.to_str().unwrap(), "preview.png").unwrap();

        let outside = tempfile::tempdir().unwrap();
        let replacement_project = outside.path().join("project");
        fs::create_dir(&replacement_project).unwrap();
        fs::write(
            replacement_project.join("preview.png"),
            b"\x89PNG\r\n\x1a\noutside",
        )
        .unwrap();
        fs::rename(&parent, root.path().join("parent-original")).unwrap();
        symlink(outside.path(), &parent).unwrap();

        assert!(bounded_project_regular_file(
            &canonical_project,
            &target,
            MAX_CONVERSATION_MEDIA_BYTES,
            "媒体文件过大"
        )
        .is_err());
    }

    #[test]
    fn project_media_rejects_oversized_and_unrecognized_files() {
        let project = tempfile::tempdir().unwrap();
        let oversized = project.path().join("large.png");
        fs::File::create(&oversized)
            .unwrap()
            .set_len(MAX_CONVERSATION_MEDIA_BYTES + 1)
            .unwrap();
        assert!(read_project_media(project.path().to_str().unwrap(), "large.png").is_err());

        fs::write(
            project.path().join("not-an-image.png"),
            b"not actually an image",
        )
        .unwrap();
        assert!(read_project_media(project.path().to_str().unwrap(), "not-an-image.png").is_err());
    }

    #[test]
    fn attachment_image_checks_type_size_and_kind() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("shot.png");
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.extend_from_slice(&[0u8; 32]);
        std::fs::write(&png, &bytes).unwrap();
        let media = read_attachment_image(png.to_str().unwrap()).unwrap();
        assert_eq!(media.kind, "image");
        assert_eq!(media.mime_type, "image/png");
        assert!(media.data_url.starts_with("data:image/png;base64,"));

        // 扩展名骗不过魔数
        let fake = dir.path().join("fake.png");
        std::fs::write(&fake, b"not an image at all").unwrap();
        assert!(read_attachment_image(fake.to_str().unwrap()).is_err());

        // 目录、空路径和控制字符一律拒绝
        assert!(read_attachment_image(dir.path().to_str().unwrap()).is_err());
        assert!(read_attachment_image("   ").is_err());
        assert!(read_attachment_image("/tmp/a\u{0}b.png").is_err());

        let oversized = dir.path().join("big.png");
        let mut huge = b"\x89PNG\r\n\x1a\n".to_vec();
        huge.resize(MAX_INLINE_IMAGE_BYTES + 2, 0);
        std::fs::write(&oversized, &huge).unwrap();
        assert!(read_attachment_image(oversized.to_str().unwrap()).is_err());
    }

    #[test]
    fn inline_image_requires_matching_magic_bytes() {
        let mut remaining = 1024;
        let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
        let attachment = inline_image_attachment(png, "截图", &mut remaining).unwrap();
        assert_eq!(attachment.mime_type, "image/png");
        assert!(remaining < 1024);

        let mut remaining = 1024;
        assert!(inline_image_attachment(
            "data:image/jpeg;base64,iVBORw0KGgoAAAANSUhEUg==",
            "伪装图片",
            &mut remaining
        )
        .is_none());
    }
}
