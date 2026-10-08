//! Project-scoped video streaming. Only loopback, opaque revocable tokens,
//! pinned file handles and positional reads; no whole-file/base64 allocation.
use axum::{
    body::{Body, Bytes},
    extract::{Path, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::Response,
    routing::get,
    Router,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs, io,
    path::Path as FsPath,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tokio::sync::{OnceCell, Semaphore};

const MAX_PREVIEWS: usize = 8;
const CHUNK: u64 = 64 * 1024;

struct Video {
    file: fs::File,
    size: u64,
    mime: &'static str,
    closed: AtomicBool,
}

#[derive(Clone)]
pub(crate) struct VideoPreviews {
    files: Arc<Mutex<HashMap<String, Arc<Video>>>>,
    port: Arc<OnceCell<u16>>,
    streams: Arc<Semaphore>,
    opening: Arc<Semaphore>,
}

impl Default for VideoPreviews {
    fn default() -> Self {
        Self {
            files: Arc::default(),
            port: Arc::default(),
            streams: Arc::new(Semaphore::new(8)),
            opening: Arc::new(Semaphore::new(4)),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VideoSource {
    token: String,
    url: String,
    mime_type: &'static str,
    size: u64,
}

#[cfg(unix)]
fn read_at(file: &fs::File, bytes: &mut [u8], offset: u64) -> io::Result<usize> {
    std::os::unix::fs::FileExt::read_at(file, bytes, offset)
}
#[cfg(windows)]
fn read_at(file: &fs::File, bytes: &mut [u8], offset: u64) -> io::Result<usize> {
    std::os::windows::fs::FileExt::seek_read(file, bytes, offset)
}

fn video_mime(extension: &str, bytes: &[u8]) -> Option<&'static str> {
    match extension {
        "mp4" | "m4v" | "mov"
            if bytes.len() >= 12
                && &bytes[4..8] == b"ftyp"
                && !matches!(
                    &bytes[8..12],
                    b"avif" | b"avis" | b"heic" | b"heix" | b"hevc" | b"hevx" | b"mif1" | b"msf1"
                ) =>
        {
            Some(if extension == "mov" {
                "video/quicktime"
            } else {
                "video/mp4"
            })
        }
        "mov" if bytes.len() >= 8 && matches!(&bytes[4..8], b"moov" | b"mdat" | b"wide") => {
            Some("video/quicktime")
        }
        "webm" if bytes.starts_with(b"\x1a\x45\xdf\xa3") => Some("video/webm"),
        "ogv" if bytes.starts_with(b"OggS") => Some("video/ogg"),
        _ => None,
    }
}

fn open_video(project: &str, path: &str) -> Result<Video, String> {
    if path.is_empty() || path.len() > 16384 || path.chars().any(char::is_control) {
        return Err("视频路径无效".into());
    }
    let root = fs::canonicalize(project).map_err(|_| "项目目录不可用")?;
    let candidate = if FsPath::new(path).is_absolute() {
        path.into()
    } else {
        root.join(path)
    };
    let target = fs::canonicalize(candidate).map_err(|_| "视频文件不存在")?;
    if !root.is_dir() || !target.starts_with(&root) {
        return Err("只能预览当前项目中的视频".into());
    }
    let file = crate::conversation_media::open_project_regular_file(&root, &target)?;
    let metadata = file.metadata().map_err(|_| "无法读取视频信息")?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err("这不是可播放的视频文件".into());
    }
    #[cfg(unix)]
    if std::os::unix::fs::MetadataExt::nlink(&metadata) != 1 {
        return Err("不能预览硬链接视频".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0
            || info.nNumberOfLinks != 1
        {
            return Err("无法安全读取视频文件".into());
        }
    }
    let extension = target
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mut signature = [0u8; 64];
    let length = read_at(&file, &mut signature, 0).map_err(|_| "视频无法读取")?;
    let mime = video_mime(&extension, &signature[..length])
        .ok_or("不支持的视频文件，请使用 MP4、MOV、WebM 或 OGV")?;
    Ok(Video {
        file,
        size: metadata.len(),
        mime,
        closed: AtomicBool::new(false),
    })
}

impl VideoPreviews {
    pub(crate) async fn open(&self, project: String, path: String) -> Result<VideoSource, String> {
        let _opening = self
            .opening
            .clone()
            .try_acquire_owned()
            .map_err(|_| "正在打开视频，请稍后重试")?;
        let video = tokio::task::spawn_blocking(move || open_video(&project, &path))
            .await
            .map_err(|_| "视频读取任务失败")??;
        let port = *self
            .port
            .get_or_try_init(|| async {
                let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
                    .await
                    .map_err(|_| "无法启动本地视频预览")?;
                let port = listener
                    .local_addr()
                    .map_err(|_| "无法读取本地预览地址")?
                    .port();
                let routes = Router::new()
                    .route("/video/:token", get(serve_video))
                    .with_state(self.clone());
                tokio::spawn(async move {
                    let _ = axum::serve(listener, routes).await;
                });
                Ok::<_, String>(port)
            })
            .await?;
        let token = uuid::Uuid::new_v4().simple().to_string();
        let source = VideoSource {
            url: format!("http://127.0.0.1:{port}/video/{token}"),
            token: token.clone(),
            mime_type: video.mime,
            size: video.size,
        };
        let mut files = self.files.lock().map_err(|_| "视频预览正在更新")?;
        if files.len() >= MAX_PREVIEWS {
            return Err("打开的视频过多，请关闭旧预览后重试".into());
        }
        files.insert(token, Arc::new(video));
        Ok(source)
    }

    pub(crate) fn close(&self, token: &str) {
        if let Ok(mut files) = self.files.lock() {
            if let Some(video) = files.remove(token) {
                video.closed.store(true, Ordering::Release);
            }
        }
    }
}

fn range(header: Option<&str>, size: u64) -> Result<(u64, u64, bool), ()> {
    let Some(header) = header else {
        return Ok((0, size, false));
    };
    if size == 0 || header.len() > 128 {
        return Err(());
    }
    let value = header.strip_prefix("bytes=").ok_or(())?;
    let (start, end) = value.split_once('-').ok_or(())?;
    let number = |s: &str| -> Result<u64, ()> {
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            return Err(());
        }
        s.parse().map_err(|_| ())
    };
    if start.is_empty() {
        let suffix = number(end)?.min(size);
        if suffix == 0 {
            return Err(());
        }
        return Ok((size - suffix, suffix, true));
    }
    let start = number(start)?;
    let end = if end.is_empty() {
        size - 1
    } else {
        number(end)?.min(size - 1)
    };
    if start >= size || end < start {
        return Err(());
    }
    Ok((start, end - start + 1, true))
}

async fn serve_video(
    State(state): State<VideoPreviews>,
    Path(token): Path<String>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    let fail = |status| {
        Response::builder()
            .status(status)
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::empty())
            .unwrap()
    };
    let expected_host = format!("127.0.0.1:{}", state.port.get().copied().unwrap_or(0));
    if headers.get(header::HOST).and_then(|h| h.to_str().ok()) != Some(expected_host.as_str()) {
        return fail(StatusCode::FORBIDDEN);
    }
    let video = state
        .files
        .lock()
        .ok()
        .and_then(|files| files.get(&token).cloned());
    let Some(video) = video.filter(|v| !v.closed.load(Ordering::Acquire)) else {
        return fail(StatusCode::NOT_FOUND);
    };
    let selected = if method == Method::HEAD {
        range(None, video.size)
    } else if let Some(value) = headers.get(header::RANGE) {
        value
            .to_str()
            .map_err(|_| ())
            .and_then(|s| range(Some(s), video.size))
    } else {
        range(None, video.size)
    };
    let Ok((offset, length, partial)) = selected else {
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{}", video.size))
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::empty())
            .unwrap();
    };
    let mut response = Response::builder()
        .status(if partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(header::CONTENT_TYPE, video.mime)
        .header(header::CONTENT_LENGTH, length)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer");
    if partial {
        response = response.header(
            header::CONTENT_RANGE,
            format!("bytes {}-{}/{}", offset, offset + length - 1, video.size),
        );
    }
    if method == Method::HEAD {
        return response.body(Body::empty()).unwrap();
    }
    let Ok(permit) = state.streams.clone().try_acquire_owned() else {
        return fail(StatusCode::TOO_MANY_REQUESTS);
    };
    let stream = futures_util::stream::try_unfold(
        (video, offset, length, permit),
        |(video, offset, remaining, permit)| async move {
            if remaining == 0 {
                return Ok::<_, io::Error>(None);
            }
            if video.closed.load(Ordering::Acquire) {
                return Err(io::Error::other("视频预览已关闭"));
            }
            let reader = video.clone();
            let bytes = tokio::task::spawn_blocking(move || {
                let mut bytes = vec![0; remaining.min(CHUNK) as usize];
                let n = read_at(&reader.file, &mut bytes, offset)?;
                if n == 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "视频文件已变化",
                    ));
                }
                bytes.truncate(n);
                Ok::<_, io::Error>(bytes)
            })
            .await
            .map_err(io::Error::other)??;
            let n = bytes.len() as u64;
            Ok(Some((
                Bytes::from(bytes),
                (video, offset + n, remaining - n, permit),
            )))
        },
    );
    response.body(Body::from_stream(stream)).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use futures_util::StreamExt;

    fn sample(root: &FsPath) -> (std::path::PathBuf, Vec<u8>) {
        let path = root.join("clip 测试.mp4");
        let mut bytes = b"\0\0\0\x18ftypisom\0\0\0\0isommp42".to_vec();
        bytes.extend((0..255).cycle().take(200_000));
        fs::write(&path, &bytes).unwrap();
        (path, bytes)
    }

    fn fixture() -> (tempfile::TempDir, VideoPreviews, Vec<u8>) {
        let root = tempfile::tempdir().unwrap();
        let (path, bytes) = sample(root.path());
        let video = open_video(root.path().to_str().unwrap(), path.to_str().unwrap()).unwrap();
        let state = VideoPreviews::default();
        state.port.set(43210).unwrap();
        state
            .files
            .lock()
            .unwrap()
            .insert("test-token".into(), Arc::new(video));
        (root, state, bytes)
    }

    async fn request(state: &VideoPreviews, method: Method, range_value: Option<&str>) -> Response {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "127.0.0.1:43210".parse().unwrap());
        if let Some(value) = range_value {
            headers.insert(header::RANGE, value.parse().unwrap());
        }
        serve_video(
            State(state.clone()),
            Path("test-token".into()),
            method,
            headers,
        )
        .await
    }

    #[test]
    fn ranges_cover_seek_suffix_open_end_and_invalid_bounds() {
        assert_eq!(range(None, 100), Ok((0, 100, false)));
        assert_eq!(range(Some("bytes=0-1"), 100), Ok((0, 2, true)));
        assert_eq!(range(Some("bytes=20-"), 100), Ok((20, 80, true)));
        assert_eq!(range(Some("bytes=-10"), 100), Ok((90, 10, true)));
        assert_eq!(range(Some("bytes=90-999"), 100), Ok((90, 10, true)));
        for value in [
            "bytes=100-",
            "bytes=30-20",
            "bytes=-0",
            "bytes=0-1,5-6",
            "bytes=+1-2",
            "bytes=18446744073709551616-",
            "items=0-1",
        ] {
            assert!(range(Some(value), 100).is_err(), "{value}");
        }
    }

    #[test]
    fn video_validation_rejects_non_video_and_project_escape() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let (external, _) = sample(outside.path());
        assert!(open_video(root.path().to_str().unwrap(), external.to_str().unwrap()).is_err());
        let fake = root.path().join("fake.mp4");
        fs::write(&fake, b"<html>not a video</html>").unwrap();
        assert!(open_video(root.path().to_str().unwrap(), fake.to_str().unwrap()).is_err());
        assert!(video_mime("mp4", b"\0\0\0\x18ftypheic").is_none());
        assert_eq!(
            video_mime("mov", b"\0\0\0\x18ftypqt  "),
            Some("video/quicktime")
        );
        assert_eq!(video_mime("webm", b"\x1a\x45\xdf\xa3"), Some("video/webm"));
    }

    #[cfg(unix)]
    #[test]
    fn project_video_rejects_external_symlink_hardlink_and_fifo() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let (external, _) = sample(outside.path());
        let link = root.path().join("linked.mp4");
        std::os::unix::fs::symlink(&external, &link).unwrap();
        assert!(open_video(root.path().to_str().unwrap(), link.to_str().unwrap()).is_err());
        let hard = root.path().join("hard.mp4");
        fs::hard_link(external, &hard).unwrap();
        assert!(open_video(root.path().to_str().unwrap(), hard.to_str().unwrap()).is_err());
        let fifo = root.path().join("pipe.mp4");
        let name = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(open_video(root.path().to_str().unwrap(), fifo.to_str().unwrap()).is_err());
    }

    #[tokio::test]
    async fn ranges_return_exact_independent_bytes_and_head_metadata() {
        let (_root, state, bytes) = fixture();
        let (first, second) = tokio::join!(
            request(&state, Method::GET, Some("bytes=100-149")),
            request(&state, Method::GET, Some("bytes=80000-80019"))
        );
        assert_eq!(first.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            first.headers()[header::CONTENT_RANGE],
            format!("bytes 100-149/{}", bytes.len())
        );
        let (a, b) = tokio::join!(
            to_bytes(first.into_body(), 100),
            to_bytes(second.into_body(), 100)
        );
        assert_eq!(a.unwrap().as_ref(), &bytes[100..150]);
        assert_eq!(b.unwrap().as_ref(), &bytes[80000..80020]);
        let head = request(&state, Method::HEAD, None).await;
        assert_eq!(
            head.headers()[header::CONTENT_LENGTH],
            bytes.len().to_string()
        );
        assert!(to_bytes(head.into_body(), 0).await.unwrap().is_empty());
        assert_eq!(
            request(&state, Method::GET, Some("bytes=999999-"))
                .await
                .status(),
            StatusCode::RANGE_NOT_SATISFIABLE
        );
    }

    #[tokio::test]
    async fn full_response_streams_large_files_in_bounded_chunks_and_close_revokes_it() {
        let root = tempfile::tempdir().unwrap();
        let (path, _) = sample(root.path());
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(2 * 1024 * 1024 * 1024)
            .unwrap();
        let video = open_video(root.path().to_str().unwrap(), path.to_str().unwrap()).unwrap();
        let state = VideoPreviews::default();
        state.port.set(43210).unwrap();
        state
            .files
            .lock()
            .unwrap()
            .insert("test-token".into(), Arc::new(video));
        let response = request(&state, Method::GET, None).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "2147483648");
        let mut body = response.into_body().into_data_stream();
        assert!(body.next().await.unwrap().unwrap().len() <= CHUNK as usize);
        state.close("test-token");
        assert!(body.next().await.unwrap().is_err());
        assert_eq!(
            request(&state, Method::GET, None).await.status(),
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn only_loopback_host_and_bounded_active_streams_are_allowed() {
        let (_root, state, _) = fixture();
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "attacker.invalid:43210".parse().unwrap());
        assert_eq!(
            serve_video(
                State(state.clone()),
                Path("test-token".into()),
                Method::GET,
                headers
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
        let mut responses = Vec::new();
        for _ in 0..8 {
            responses.push(request(&state, Method::GET, None).await);
        }
        assert_eq!(
            request(&state, Method::GET, None).await.status(),
            StatusCode::TOO_MANY_REQUESTS
        );
        drop(responses);
        assert_eq!(
            request(&state, Method::GET, None).await.status(),
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn real_loopback_serves_range_and_revoked_token_returns_404() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let root = tempfile::tempdir().unwrap();
        let (path, bytes) = sample(root.path());
        let state = VideoPreviews::default();
        let source = state
            .open(
                root.path().to_str().unwrap().into(),
                path.to_str().unwrap().into(),
            )
            .await
            .unwrap();
        let port = *state.port.get().unwrap();
        assert!(source.url.starts_with("http://127.0.0.1:"));
        assert!(!source.url.contains("clip"));
        let exchange = |token: String| async move {
            let mut socket = tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
                .await
                .unwrap();
            socket.write_all(format!("GET /video/{token} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nRange: bytes=0-11\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
            let mut result = Vec::new();
            socket.read_to_end(&mut result).await.unwrap();
            result
        };
        let result = exchange(source.token.clone()).await;
        assert!(result.starts_with(b"HTTP/1.1 206"));
        assert!(result.ends_with(&bytes[..12]));
        state.close(&source.token);
        assert!(exchange(source.token).await.starts_with(b"HTTP/1.1 404"));
    }

    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "人工浏览器验收：生成临时 H.264/AAC 视频和最长五分钟本机预览，需要 ffmpeg"]
    async fn probe_video_playback_in_browser() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("preview.mp4");
        let output = std::process::Command::new("ffmpeg")
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=480x270:rate=15",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=44100",
                "-t",
                "12",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
            ])
            .arg(&path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let state = VideoPreviews::default();
        let source = state
            .open(
                root.path().to_str().unwrap().into(),
                path.to_str().unwrap().into(),
            )
            .await
            .unwrap();
        println!("VIDEO_PREVIEW_TEST_URL={}", source.url);
        let stop = root.path().join("finished");
        println!("VIDEO_PREVIEW_STOP_FILE={}", stop.display());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
        while std::time::Instant::now() < deadline && !stop.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        state.close(&source.token);
    }
}
