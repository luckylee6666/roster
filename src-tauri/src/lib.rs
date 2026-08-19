use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

mod remote;
use remote::{PtySession, RemoteHub, SessionMeta};
mod usage;
mod applog;
mod native_esc;
mod project_memory;
mod project_sessions;
mod orchestra;
mod proxy_settings;
mod cli_detect;

/// 手机端远程服务监听端口（局域网）。
const REMOTE_PORT: u16 = 8787;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(alias = "local_path")]
    pub local_path: String,
    #[serde(default, alias = "remote_url")]
    pub remote_url: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub machine: String,
    #[serde(default)]
    pub server_id: String,
    #[serde(default)]
    pub group: String,
    #[serde(default, alias = "created_at")]
    pub created_at: String,
    #[serde(default, alias = "updated_at")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub id: String,
    pub name: String,
    pub host: String,
    #[serde(default)]
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub auth_type: String,
    #[serde(default)]
    pub note: String,
    #[serde(default, alias = "created_at")]
    pub created_at: String,
}

/// 片段的定时发送配置（前端定时器读它，到点把片段注入当前终端并回车）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    /// "interval"（每 N 分钟）| "daily"（每天 HH:MM）
    pub mode: String,
    /// interval 模式：间隔分钟数
    #[serde(default)]
    pub interval_min: u32,
    /// daily 模式：每天发送时刻 "HH:MM"
    #[serde(default)]
    pub time: String,
    /// 是否启用（可暂停而不丢配置）
    #[serde(default)]
    pub enabled: bool,
}

/// Prompt/Snippet 库：可复用的指令片段，一键注入当前终端，可选定时发送。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub title: String,
    pub content: String,
    #[serde(default, alias = "created_at")]
    pub created_at: String,
    /// 可选定时发送配置（None = 不定时）
    #[serde(default)]
    pub schedule: Option<Schedule>,
}

/// 需求清单：开发随手记录的碎片需求/想法收集箱。
/// 默认是全局收集箱，`project_id` 为可选的项目关联标签。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Requirement {
    pub id: String,
    pub title: String,
    /// 可选补充说明
    #[serde(default)]
    pub note: String,
    /// todo | doing | done
    #[serde(default)]
    pub status: String,
    /// high | normal | low
    #[serde(default)]
    pub priority: String,
    /// 可选关联项目 id（空 = 未关联）
    #[serde(default, alias = "project_id")]
    pub project_id: String,
    #[serde(default, alias = "created_at")]
    pub created_at: String,
    #[serde(default, alias = "updated_at")]
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct AppState {
    projects: Vec<Project>,
    servers: Vec<Server>,
    #[serde(default)]
    snippets: Vec<Snippet>,
    #[serde(default)]
    requirements: Vec<Requirement>,
    data_path: PathBuf,
    server_path: PathBuf,
    snippet_path: PathBuf,
    requirement_path: PathBuf,
}

/// 原子写：写同目录临时文件 + fsync，再 rename 覆盖目标。
/// rename 在同一分区是原子操作——崩溃/断电后要么是旧文件、要么是新文件，
/// 绝不会出现写到一半的半截文件（旧版 fs::write 先清空再写，中途被 kill 会损坏整文件）。
pub(crate) fn atomic_write(path: &PathBuf, data: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)
}

/// 数据目录：优先用隐藏目录 ~/.roster/，避免清理软件误删。
/// 首次启动依次从 ~/.vibe-coding-manage/、旧 Application Support 目录迁移。
fn preferred_data_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".roster")
}

/// 本次进程实际使用的数据目录。正常是新隐藏目录；若首次迁移失败，则本次运行
/// 回退旧目录，避免加载空数据后又把空表写进新目录。下次启动仍会重试迁移。
static ACTIVE_DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

pub(crate) fn data_dir() -> PathBuf {
    ACTIVE_DATA_DIR
        .get()
        .cloned()
        .unwrap_or_else(preferred_data_dir)
}

/// 更名前的隐藏目录（v1.2.13–v1.2.18）。
fn previous_hidden_data_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".vibe-coding-manage")
}

/// 更早的数据目录（清理软件常扫的 ~/Library/Application Support/）。
fn oldest_legacy_data_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("vibe-coding-manage"))
}

fn previous_data_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![previous_hidden_data_dir()];
    if let Some(oldest) = oldest_legacy_data_dir() {
        dirs.push(oldest);
    }
    dirs
}

fn copy_file_if_missing(src: &Path, dst: &Path) -> std::io::Result<()> {
    if dst.exists() {
        return Ok(());
    }
    let tmp = dst.with_extension("migrating");
    if tmp.exists() {
        fs::remove_file(&tmp)?;
    }
    fs::copy(src, &tmp)?;
    fs::rename(tmp, dst)
}

fn copy_dir_missing(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let source = entry.path();
        let target = dst.join(entry.file_name());
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_dir_missing(&source, &target)?;
        } else if ty.is_file() {
            copy_file_if_missing(&source, &target)?;
        } else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("迁移目录包含不支持的特殊文件：{}", source.display()),
            ));
        }
    }
    Ok(())
}

/// 从指定旧目录迁移到新目录。只有全部复制成功后才写完成标记；目录使用可重试的
/// 逐项复制而非 rename，迁移中断后可安全补齐，也始终保留旧目录作为恢复来源。
/// 核心文件包括 projects.json、servers.json、snippets.json、requirements.json、
/// term-themes.json、proxy-settings.json，以及 theme-images/、logs/ 和用量缓存。
fn migrate_legacy_data_between(old: &Path, new: &Path) -> std::io::Result<()> {
    let marker = new.join(".migrated-from-legacy");
    if marker.exists() {
        return Ok(());
    }
    fs::create_dir_all(new)?;
    copy_dir_missing(old, new)?;
    atomic_write(&marker, b"ok")
}

fn migrate_backup_dir_if_needed() {
    let new = preferred_data_dir().with_file_name("roster-backups");
    let old = previous_hidden_data_dir().with_file_name("vibe-coding-manage-backups");
    if !old.is_dir() || new.exists() {
        return;
    }
    if let Err(e) = copy_dir_missing(&old, &new) {
        crate::log_error!("迁移旧备份目录失败：{e}");
    }
}

/// 初始化进程级数据目录。迁移失败时继续使用旧目录，既不写完成标记，也不允许
/// 当前进程把空数据保存到新目录；下次启动会再次尝试迁移。
fn initialize_data_dir() -> PathBuf {
    let preferred = preferred_data_dir();
    if preferred.join(".migrated-from-legacy").exists() {
        migrate_backup_dir_if_needed();
        return preferred;
    }
    for old in previous_data_dirs() {
        if !old.is_dir() || old == preferred {
            continue;
        }
        return match migrate_legacy_data_between(&old, &preferred) {
            Ok(()) => {
                migrate_backup_dir_if_needed();
                preferred
            }
            Err(e) => {
                crate::log_error!(
                    "迁移旧数据目录失败，将继续使用旧目录 {}：{e}",
                    old.display()
                );
                old
            }
        };
    }
    preferred
}

/// 备份根目录：跟数据目录同级的 *独立* 目录。
/// 故意放在数据目录外面——一旦数据目录整体被清理工具删除/误删，
/// 备份仍然存活，可手动拷回恢复。
fn backup_root_dir() -> PathBuf {
    data_dir().with_file_name("roster-backups")
}

/// 当前已存在的 4 个核心数据文件（仅返回磁盘上真实存在的）。
fn existing_data_files() -> Vec<(PathBuf, String)> {
    let f = |n: &str| data_dir().join(n);
    let pairs = [
        (f("projects.json"), "projects".to_string()),
        (f("servers.json"), "servers".to_string()),
        (f("snippets.json"), "snippets".to_string()),
        (f("requirements.json"), "requirements".to_string()),
    ];
    pairs
        .into_iter()
        .filter(|(p, _)| p.exists())
        .collect()
}

/// 快照当前全部数据文件到 `backups/<YYYY-MM-DD>/`，保留最近 30 天。
/// 每天首次调用时才会真拷贝（同一天已有当日快照则跳过）。
fn snapshot_data_files() {
    let stamp = chrono::Local::now().format("%Y-%m-%d").to_string();
    let dir = backup_root_dir().join(&stamp);
    if dir.is_dir() && existing_data_files().iter().all(|(_, name)| dir.join(format!("{name}.json")).exists()) {
        return; // 今日已有完整快照
    }
    if let Err(e) = fs::create_dir_all(&dir) {
        crate::log_warn!("创建每日备份目录失败：{e}");
        return;
    }
    for (path, name) in existing_data_files() {
        let dest = dir.join(format!("{name}.json"));
        if !dest.exists() {
            if let Err(e) = copy_file_if_missing(&path, &dest) {
                crate::log_warn!("备份 {:?} 失败：{e}", path.file_name().unwrap_or_default());
            }
        }
    }
    // 裁剪：只保留最近 30 天
    if let Ok(read) = fs::read_dir(backup_root_dir()) {
        let mut days: Vec<PathBuf> = read
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.is_dir())
            .collect();
        days.sort();
        while days.len() > 30 {
            let oldest = days.remove(0);
            let _ = fs::remove_dir_all(oldest);
        }
    }
}

/// 备份某数据文件（覆盖写之前调用）：把现有文件拷贝为 `<name>.prev.json`，
/// 只保留最近一份，防止上一次「正常」的数据被空/坏数据盖掉后无法找回。
fn backup_prev(path: &Path, name: &str) {
    if path.exists() {
        let dest = path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(format!("{name}.prev.json"));
        let tmp = dest.with_extension("prev.tmp");
        let result = fs::copy(path, &tmp).and_then(|_| fs::rename(&tmp, &dest));
        if let Err(e) = result {
            let _ = fs::remove_file(tmp);
            crate::log_warn!("创建 {name}.prev.json 失败：{e}");
        }
    }
}

/// 加载 JSON 数据。解析失败时把损坏文件备份成 `*.bad`（避免随后的保存把它覆盖、
/// 导致可恢复的数据彻底丢失），再返回默认空值。空文件视为默认值、不报错。
pub(crate) fn load_json_or_backup<T: serde::de::DeserializeOwned + Default>(path: &PathBuf) -> T {
    if !path.exists() {
        return T::default();
    }
    let data = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            crate::log_error!("读取 {:?} 失败：{e}", path.file_name().unwrap_or_default());
            return T::default();
        }
    };
    if data.trim().is_empty() {
        return T::default();
    }
    match serde_json::from_str::<T>(&data) {
        Ok(v) => v,
        Err(e) => {
            // 带时间戳命名，避免二次损坏覆盖掉上一份含可恢复数据的备份
            let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
            let bad = path.with_extension(format!("{stamp}.bad"));
            let _ = fs::copy(path, &bad);
            crate::log_error!(
                "解析 {:?} 失败：{e}；已备份损坏文件到 {:?}",
                path.file_name().unwrap_or_default(),
                bad.file_name().unwrap_or_default()
            );
            T::default()
        }
    }
}

impl AppState {
    fn new(data_dir: &Path) -> Self {
        fs::create_dir_all(data_dir).ok();
        snapshot_data_files();
        
        let data_path = data_dir.join("projects.json");
        let projects = load_json_or_backup(&data_path);

        let server_path = data_dir.join("servers.json");
        let servers = load_json_or_backup(&server_path);

        let snippet_path = data_dir.join("snippets.json");
        let snippets = load_json_or_backup(&snippet_path);

        let requirement_path = data_dir.join("requirements.json");
        let requirements = load_json_or_backup(&requirement_path);

        Self {
            projects,
            servers,
            snippets,
            requirements,
            data_path,
            server_path,
            snippet_path,
            requirement_path,
        }
    }

    fn save_projects_value(&self, projects: &[Project]) -> Result<(), String> {
        let data = serde_json::to_string_pretty(projects).map_err(|e| e.to_string())?;
        backup_prev(&self.data_path, "projects");
        atomic_write(&self.data_path, data.as_bytes()).map_err(|e| {
            crate::log_error!("写 projects.json 失败：{e}");
            e.to_string()
        })
    }

    fn save_servers_value(&self, servers: &[Server]) -> Result<(), String> {
        let data = serde_json::to_string_pretty(servers).map_err(|e| e.to_string())?;
        backup_prev(&self.server_path, "servers");
        atomic_write(&self.server_path, data.as_bytes()).map_err(|e| {
            crate::log_error!("写 servers.json 失败：{e}");
            e.to_string()
        })
    }

    fn save_snippets_value(&self, snippets: &[Snippet]) -> Result<(), String> {
        let data = serde_json::to_string_pretty(snippets).map_err(|e| e.to_string())?;
        backup_prev(&self.snippet_path, "snippets");
        atomic_write(&self.snippet_path, data.as_bytes()).map_err(|e| {
            crate::log_error!("写 snippets.json 失败：{e}");
            e.to_string()
        })
    }

    fn save_requirements_value(&self, requirements: &[Requirement]) -> Result<(), String> {
        let data = serde_json::to_string_pretty(requirements).map_err(|e| e.to_string())?;
        backup_prev(&self.requirement_path, "requirements");
        atomic_write(&self.requirement_path, data.as_bytes()).map_err(|e| {
            crate::log_error!("写 requirements.json 失败：{e}");
            e.to_string()
        })
    }
}

#[tauri::command]
fn get_projects(state: State<Mutex<AppState>>) -> Result<Vec<Project>, String> {
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(state.projects.clone())
}

// Tauri IPC 直接按前端表单字段解包，保留具名参数可避免额外嵌套和协议变更。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn add_project(
    state: State<Mutex<AppState>>,
    name: String,
    local_path: String,
    remote_url: String,
    description: String,
    machine: String,
    server_id: String,
    group: String,
) -> Result<Project, String> {
    let mut state = state.lock().map_err(|e| e.to_string())?;
    
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let project = Project {
        id: Uuid::new_v4().to_string(),
        name,
        local_path,
        remote_url,
        description,
        machine,
        server_id,
        group,
        created_at: now.clone(),
        updated_at: now,
    };
    
    let mut projects = state.projects.clone();
    projects.push(project.clone());
    state.save_projects_value(&projects)?;
    state.projects = projects;
    
    Ok(project)
}

// Tauri IPC 直接按前端表单字段解包，保留具名参数可避免额外嵌套和协议变更。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn update_project(
    state: State<Mutex<AppState>>,
    id: String,
    name: String,
    local_path: String,
    remote_url: String,
    description: String,
    machine: String,
    server_id: String,
    group: String,
) -> Result<Project, String> {
    let mut state = state.lock().map_err(|e| e.to_string())?;
    
    let index = state.projects.iter().position(|p| p.id == id)
        .ok_or_else(|| "Project not found".to_string())?;
    
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let project = Project {
        id: id.clone(),
        name,
        local_path,
        remote_url,
        description,
        machine,
        server_id,
        group,
        created_at: state.projects[index].created_at.clone(),
        updated_at: now,
    };
    
    let mut projects = state.projects.clone();
    projects[index] = project.clone();
    state.save_projects_value(&projects)?;
    state.projects = projects;
    
    Ok(project)
}

#[tauri::command]
fn delete_project(state: State<Mutex<AppState>>, id: String) -> Result<(), String> {
    let mut state = state.lock().map_err(|e| e.to_string())?;
    let mut projects = state.projects.clone();
    projects.retain(|p| p.id != id);
    state.save_projects_value(&projects)?;
    state.projects = projects;
    Ok(())
}

/// 重命名分组：把该组下所有项目的 group 字段批量改名（分组无独立实体，靠 group 字段聚合）。
#[tauri::command]
fn rename_group(state: State<Mutex<AppState>>, old: String, new: String) -> Result<(), String> {
    let mut state = state.lock().map_err(|e| e.to_string())?;
    let mut projects = state.projects.clone();
    for p in &mut projects {
        if p.group == old {
            p.group = new.clone();
        }
    }
    state.save_projects_value(&projects)?;
    state.projects = projects;
    Ok(())
}

#[tauri::command]
fn export_excel(state: State<Mutex<AppState>>) -> Result<String, String> {
    let state = state.lock().map_err(|e| e.to_string())?;
    
    let file_path = rfd::FileDialog::new()
        .set_title("导出Excel文件")
        .set_file_name("vibe-coding-projects.xlsx")
        .add_filter("Excel文件", &["xlsx"])
        .save_file()
        .ok_or_else(|| "未选择保存位置".to_string())?;

    let mut workbook = rust_xlsxwriter::Workbook::new();
    let worksheet = workbook.add_worksheet();
    
    let header_format = rust_xlsxwriter::Format::new()
        .set_bold()
        .set_background_color(rust_xlsxwriter::Color::RGB(0x4472C4))
        .set_font_color(rust_xlsxwriter::Color::White)
        .set_border(rust_xlsxwriter::FormatBorder::Thin);
    
    worksheet.write_string_with_format(0, 0, "项目名称", &header_format).map_err(|e| e.to_string())?;
    worksheet.write_string_with_format(0, 1, "分组", &header_format).map_err(|e| e.to_string())?;
    worksheet.write_string_with_format(0, 2, "本地路径", &header_format).map_err(|e| e.to_string())?;
    worksheet.write_string_with_format(0, 3, "远端仓库", &header_format).map_err(|e| e.to_string())?;
    worksheet.write_string_with_format(0, 4, "项目描述", &header_format).map_err(|e| e.to_string())?;
    worksheet.write_string_with_format(0, 5, "运行环境", &header_format).map_err(|e| e.to_string())?;
    worksheet.write_string_with_format(0, 6, "服务器", &header_format).map_err(|e| e.to_string())?;
    worksheet.write_string_with_format(0, 7, "创建时间", &header_format).map_err(|e| e.to_string())?;
    worksheet.write_string_with_format(0, 8, "更新时间", &header_format).map_err(|e| e.to_string())?;
    
    worksheet.set_column_width(0, 20).map_err(|e| e.to_string())?;
    worksheet.set_column_width(1, 15).map_err(|e| e.to_string())?;
    worksheet.set_column_width(2, 40).map_err(|e| e.to_string())?;
    worksheet.set_column_width(3, 40).map_err(|e| e.to_string())?;
    worksheet.set_column_width(4, 30).map_err(|e| e.to_string())?;
    worksheet.set_column_width(5, 12).map_err(|e| e.to_string())?;
    worksheet.set_column_width(6, 15).map_err(|e| e.to_string())?;
    worksheet.set_column_width(7, 20).map_err(|e| e.to_string())?;
    worksheet.set_column_width(8, 20).map_err(|e| e.to_string())?;
    
    let data_format = rust_xlsxwriter::Format::new()
        .set_border(rust_xlsxwriter::FormatBorder::Thin);
    
    for (i, project) in state.projects.iter().enumerate() {
        let row = (i + 1) as u32;
        let server_name = if project.server_id.is_empty() {
            String::new()
        } else {
            state.servers.iter()
                .find(|s| s.id == project.server_id)
                .map(|s| s.name.clone())
                .unwrap_or_default()
        };
        let machine_label = match project.machine.as_str() {
            "local" => "本地电脑",
            "server" => "服务器",
            other => other,
        };
        worksheet.write_string_with_format(row, 0, &project.name, &data_format).map_err(|e| e.to_string())?;
        worksheet.write_string_with_format(row, 1, &project.group, &data_format).map_err(|e| e.to_string())?;
        worksheet.write_string_with_format(row, 2, &project.local_path, &data_format).map_err(|e| e.to_string())?;
        worksheet.write_string_with_format(row, 3, &project.remote_url, &data_format).map_err(|e| e.to_string())?;
        worksheet.write_string_with_format(row, 4, &project.description, &data_format).map_err(|e| e.to_string())?;
        worksheet.write_string_with_format(row, 5, machine_label, &data_format).map_err(|e| e.to_string())?;
        worksheet.write_string_with_format(row, 6, &server_name, &data_format).map_err(|e| e.to_string())?;
        worksheet.write_string_with_format(row, 7, &project.created_at, &data_format).map_err(|e| e.to_string())?;
        worksheet.write_string_with_format(row, 8, &project.updated_at, &data_format).map_err(|e| e.to_string())?;
    }
    
    workbook.save(&file_path).map_err(|e| e.to_string())?;
    
    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    opener::open(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_folder_dialog() -> Result<String, String> {
    let folder = rfd::FileDialog::new()
        .set_title("选择项目文件夹")
        .pick_folder()
        .ok_or_else(|| "未选择文件夹".to_string())?;
    
    Ok(folder.to_string_lossy().to_string())
}

/// 把路径包成单引号 shell 字面量（转义内部单引号），
/// 防止空格、`;`、反引号、`$()` 等破坏命令或被注入执行。
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[tauri::command]
fn open_terminal(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // 两层转义：先 shell 单引号包路径，再为 AppleScript 字符串转义 \ 和 "
        let cmd = format!("cd {} && claude", shell_quote(&path));
        let as_escaped = cmd.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!(
            "tell application \"Terminal\"\n\tactivate\n\tdo script \"{}\"\nend tell",
            as_escaped
        );
        std::process::Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        // bash -c 收到独立 argv，路径再用单引号包裹，无嵌套引号问题
        std::process::Command::new("x-terminal-emulator")
            .args([
                "-e",
                "bash",
                "-c",
                &format!("cd {} && claude; exec bash", shell_quote(&path)),
            ])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        // Windows 路径用双引号包裹（路径通常不含 "）
        std::process::Command::new("cmd")
            .args(["/C", "start", "cmd", "/K", &format!("cd /d \"{}\" && claude", path)])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_servers(state: State<Mutex<AppState>>) -> Result<Vec<Server>, String> {
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(state.servers.clone())
}

#[tauri::command]
fn add_server(
    state: State<Mutex<AppState>>,
    name: String,
    host: String,
    port: u16,
    user: String,
    auth_type: String,
    note: String,
) -> Result<Server, String> {
    let mut state = state.lock().map_err(|e| e.to_string())?;
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let server = Server {
        id: Uuid::new_v4().to_string(),
        name,
        host,
        port,
        user,
        auth_type,
        note,
        created_at: now,
    };
    let mut servers = state.servers.clone();
    servers.push(server.clone());
    state.save_servers_value(&servers)?;
    state.servers = servers;
    Ok(server)
}

// Tauri IPC 直接按前端表单字段解包，保留具名参数可避免额外嵌套和协议变更。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn update_server(
    state: State<Mutex<AppState>>,
    id: String,
    name: String,
    host: String,
    port: u16,
    user: String,
    auth_type: String,
    note: String,
) -> Result<Server, String> {
    let mut state = state.lock().map_err(|e| e.to_string())?;
    let index = state.servers.iter().position(|s| s.id == id)
        .ok_or_else(|| "Server not found".to_string())?;
    let server = Server {
        id: id.clone(),
        name,
        host,
        port,
        user,
        auth_type,
        note,
        created_at: state.servers[index].created_at.clone(),
    };
    let mut servers = state.servers.clone();
    servers[index] = server.clone();
    state.save_servers_value(&servers)?;
    state.servers = servers;
    Ok(server)
}

#[tauri::command]
fn delete_server(state: State<Mutex<AppState>>, id: String) -> Result<(), String> {
    let mut state = state.lock().map_err(|e| e.to_string())?;
    let count = state.projects.iter().filter(|p| p.server_id == id).count();
    if count > 0 {
        return Err(format!("有 {} 个项目引用了该服务器，请先修改项目", count));
    }
    let mut servers = state.servers.clone();
    servers.retain(|s| s.id != id);
    state.save_servers_value(&servers)?;
    state.servers = servers;
    Ok(())
}

#[tauri::command]
fn get_snippets(state: State<Mutex<AppState>>) -> Result<Vec<Snippet>, String> {
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(state.snippets.clone())
}

/// 整表保存（前端管理增删改后回写）。给缺 id / created_at 的项补齐。
#[tauri::command]
fn save_snippets(
    state: State<Mutex<AppState>>,
    snippets: Vec<Snippet>,
) -> Result<Vec<Snippet>, String> {
    let mut state = state.lock().map_err(|e| e.to_string())?;
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let snippets: Vec<Snippet> = snippets
        .into_iter()
        .map(|mut s| {
            if s.id.is_empty() {
                s.id = Uuid::new_v4().to_string();
            }
            if s.created_at.is_empty() {
                s.created_at = now.clone();
            }
            s
        })
        .collect();
    state.save_snippets_value(&snippets)?;
    state.snippets = snippets.clone();
    Ok(snippets)
}

// ===== 终端 DIY 主题：整表读写 term-themes.json（仿片段库），背景图拷入 appdata/theme-images/ =====

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TermTheme {
    pub id: String,
    pub name: String,
    /// 基础配色 key：guofeng / sakura / neon-rain / classic / homebrew（xterm 调色板来源）
    pub base: String,
    /// 背景图："" 无图；"builtin:<path>" 内置资源；"file:<name>" 用户上传（appdata/theme-images/）
    #[serde(default)]
    pub image: String,
    /// 遮罩浓度 0~0.7
    #[serde(default)]
    pub dim: f64,
    /// 遮罩色 "r, g, b"
    #[serde(default)]
    pub tint: String,
    /// 是否启用与 base 对应的主题点击粒子特效
    #[serde(default)]
    pub click_fx: bool,
    /// 菜单缩略图标路径（""=菜单用背景图缩略图兜底）。预装主题用它保留专属图标。
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub created_at: String,
}

fn term_theme_path() -> PathBuf {
    data_dir().join("term-themes.json")
}

/// 主题表不在 AppState 里（那是项目/服务器数据），但整表读改写仍需互斥：
/// 两次并发 save_term_themes 若都在跑 atomic_write，会同时截断同一个
/// term-themes.tmp，产出合并坏文件——用这把独立锁把它俩串行化。
struct TermThemeLock(Mutex<()>);

fn theme_image_dir() -> PathBuf {
    data_dir().join("theme-images")
}

#[tauri::command]
fn get_term_themes(lock: State<TermThemeLock>) -> Result<Vec<TermTheme>, String> {
    let _guard = lock.0.lock().map_err(|e| e.to_string())?;
    Ok(load_json_or_backup(&term_theme_path()))
}

/// 整表保存（前端管理增删改后回写）。给缺 id / created_at 的项补齐。
#[tauri::command]
fn save_term_themes(
    lock: State<TermThemeLock>,
    themes: Vec<TermTheme>,
) -> Result<Vec<TermTheme>, String> {
    let _guard = lock.0.lock().map_err(|e| e.to_string())?;
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let themes: Vec<TermTheme> = themes
        .into_iter()
        .map(|mut t| {
            if t.id.is_empty() {
                t.id = Uuid::new_v4().to_string();
            }
            if t.created_at.is_empty() {
                t.created_at = now.clone();
            }
            t
        })
        .collect();
    let data = serde_json::to_string_pretty(&themes).map_err(|e| e.to_string())?;
    atomic_write(&term_theme_path(), data.as_bytes()).map_err(|e| {
        crate::log_error!("写 term-themes.json 失败：{e}");
        e.to_string()
    })?;
    Ok(themes)
}

/// 选一张背景图并拷入 appdata/theme-images/（原图不动），返回存储文件名。
#[tauri::command]
fn pick_theme_image() -> Result<Option<String>, String> {
    let Some(src) = rfd::FileDialog::new()
        .set_title("选择主题背景图")
        .add_filter("图片", &["png", "jpg", "jpeg", "webp"])
        .pick_file()
    else {
        return Ok(None);
    };
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_lowercase();
    let dir = theme_image_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("创建主题图目录失败：{e}"))?;
    let name = format!("{}.{ext}", Uuid::new_v4());
    let bytes = read_binary_file_bounded(&src, MAX_THEME_IMAGE_SIZE, "主题图片过大（>16MB）")?;
    atomic_write(&dir.join(&name), &bytes).map_err(|e| format!("拷贝背景图失败：{e}"))?;
    crate::log_info!("主题背景图已导入：{name}（来自 {src:?}）");
    Ok(Some(name))
}

/// 读取已导入的主题背景图，返回 data URL（前端直接用作 background-image）。
#[tauri::command]
fn load_theme_image(name: String) -> Result<String, String> {
    // 防目录穿越：只允许纯文件名
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("非法文件名".to_string());
    }
    let path = theme_image_dir().join(&name);
    let bytes = read_binary_file_bounded(&path, MAX_THEME_IMAGE_SIZE, "主题图片过大（>16MB）")
        .map_err(|e| format!("读取背景图失败：{e}"))?;
    let mime = match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "image/png",
    };
    use base64::Engine as _;
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[tauri::command]
fn get_requirements(state: State<Mutex<AppState>>) -> Result<Vec<Requirement>, String> {
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(state.requirements.clone())
}

/// 整表保存（前端管理增删改后回写）。补齐缺失的 id / 默认值 / 时间戳。
#[tauri::command]
fn save_requirements(
    state: State<Mutex<AppState>>,
    requirements: Vec<Requirement>,
) -> Result<Vec<Requirement>, String> {
    let mut state = state.lock().map_err(|e| e.to_string())?;
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let requirements: Vec<Requirement> = requirements
        .into_iter()
        .map(|mut r| {
            if r.id.is_empty() {
                r.id = Uuid::new_v4().to_string();
            }
            if r.status.is_empty() {
                r.status = "todo".to_string();
            }
            if r.priority.is_empty() {
                r.priority = "normal".to_string();
            }
            if r.created_at.is_empty() {
                r.created_at = now.clone();
            }
            r.updated_at = now.clone();
            r
        })
        .collect();
    state.save_requirements_value(&requirements)?;
    state.requirements = requirements.clone();
    Ok(requirements)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedProject {
    pub name: String,
    pub path: String,
    pub remote_url: String,
    pub group: String,
}

#[tauri::command]
fn scan_directory(path: String) -> Result<Vec<ScannedProject>, String> {
    let dir = std::path::Path::new(&path);
    if !dir.is_dir() {
        return Err("路径不是目录".to_string());
    }

    let dir_name = dir.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let mut results = Vec::new();

    // 检查当前目录是否本身就是 git 仓库
    if dir.join(".git").exists() {
        let remote = read_git_remote(dir);
        results.push(ScannedProject {
            name: dir_name.clone(),
            path: dir.to_string_lossy().to_string(),
            remote_url: remote,
            group: String::new(),
        });
        return Ok(results);
    }

    // 扫描子目录
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let entry_path = entry.path();
        if !entry_path.is_dir() {
            continue;
        }
        // 跳过隐藏目录
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if entry_path.join(".git").exists() {
            let remote = read_git_remote(&entry_path);
            results.push(ScannedProject {
                name,
                path: entry_path.to_string_lossy().to_string(),
                remote_url: remote,
                group: dir_name.clone(),
            });
        }
    }

    results.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(results)
}

fn read_git_remote(repo_path: &std::path::Path) -> String {
    let config_path = repo_path.join(".git").join("config");
    let content = match fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    // 简单解析 git config 找 remote "origin" 的 url
    let mut in_origin = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "[remote \"origin\"]" {
            in_origin = true;
            continue;
        }
        if in_origin && trimmed.starts_with('[') {
            break;
        }
        if in_origin {
            if let Some(url) = trimmed.strip_prefix("url = ") {
                return url.trim().to_string();
            }
            if let Some(url) = trimmed.strip_prefix("url=") {
                return url.trim().to_string();
            }
        }
    }
    String::new()
}

#[tauri::command]
fn open_pick_directory() -> Result<String, String> {
    let dir = rfd::FileDialog::new()
        .set_title("选择要扫描的目录")
        .pick_folder()
        .ok_or_else(|| "未选择目录".to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

// ========== 文件树 / 文件预览 ==========

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirEntryInfo {
    name: String,
    path: String,
    is_dir: bool,
}

/// 列出目录直接子项（懒加载用），目录在前、再按名称不区分大小写排序。
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntryInfo>, String> {
    let dir = std::path::Path::new(&path);
    if !dir.is_dir() {
        return Err("路径不是目录".to_string());
    }
    let mut result = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let p = entry.path();
        result.push(DirEntryInfo {
            name: entry.file_name().to_string_lossy().to_string(),
            path: p.to_string_lossy().to_string(),
            is_dir: p.is_dir(),
        });
    }
    result.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(result)
}

#[derive(Default)]
struct EditorExitGuard {
    allow_exit: AtomicBool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileContent {
    content: String,
    truncated: bool,
    size: u64,
    editable: bool,
    edit_reason: Option<String>,
    line_ending: String,
    utf8_bom: bool,
}

const MAX_TEXT_FILE_SIZE: u64 = 1024 * 1024;
const MAX_IMAGE_FILE_SIZE: u64 = 16 * 1024 * 1024;
const MAX_PDF_FILE_SIZE: u64 = 32 * 1024 * 1024;
const MAX_THEME_IMAGE_SIZE: u64 = 16 * 1024 * 1024;

fn split_utf8_bom(bytes: &[u8]) -> (bool, &[u8]) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        (true, &bytes[3..])
    } else {
        (false, bytes)
    }
}

fn detect_line_ending(text: &str) -> String {
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count().saturating_sub(crlf);
    let cr = text.matches('\r').count().saturating_sub(crlf);
    let kinds = usize::from(crlf > 0) + usize::from(lf > 0) + usize::from(cr > 0);
    if kinds > 1 {
        "mixed"
    } else if crlf > 0 {
        "crlf"
    } else if cr > 0 {
        "cr"
    } else {
        "lf"
    }
    .to_string()
}

/// 从同一个已打开的文件句柄读取，最多保留 `limit` 字节；额外读取 1 字节用来
/// 捕获“检查大小后文件又增长”的竞争，避免对变化中的文件进行无界分配。
fn read_file_bounded(p: &Path, limit: u64) -> Result<(Vec<u8>, u64, bool), String> {
    let file = fs::File::open(p).map_err(|e| e.to_string())?;
    let metadata_size = file.metadata().map_err(|e| e.to_string())?.len();
    let mut bytes = Vec::with_capacity((metadata_size.min(limit) as usize).saturating_add(1));
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let observed_size = metadata_size.max(bytes.len() as u64);
    let truncated = observed_size > limit || bytes.len() as u64 > limit;
    if bytes.len() as u64 > limit {
        bytes.truncate(limit as usize);
    }
    Ok((bytes, observed_size, truncated))
}

/// 从同一个已打开句柄完成类型、大小检查和有界读取，避免 metadata 与 fs::read
/// 之间文件被替换或增长，绕过预览内存上限。
fn read_binary_file_bounded(p: &Path, limit: u64, too_large: &str) -> Result<Vec<u8>, String> {
    let file = fs::File::open(p).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("不是文件".to_string());
    }
    if metadata.len() > limit {
        return Err(too_large.to_string());
    }
    let mut bytes = Vec::with_capacity(metadata.len().min(limit) as usize + 1);
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err(too_large.to_string());
    }
    Ok(bytes)
}

fn read_text_file(p: &Path) -> Result<FileContent, String> {
    if !p.is_file() {
        return Err("不是文件".to_string());
    }
    let (bytes, size, truncated) = read_file_bounded(p, MAX_TEXT_FILE_SIZE)?;
    if bytes.contains(&0) {
        return Err("二进制文件，无法预览".to_string());
    }
    let (utf8_bom, text_bytes) = split_utf8_bom(&bytes);
    let utf8 = std::str::from_utf8(text_bytes);
    let read_only = fs::metadata(p)
        .map_err(|e| e.to_string())?
        .permissions()
        .readonly();
    let content = String::from_utf8_lossy(text_bytes).to_string();
    let line_ending = detect_line_ending(&content);
    let edit_reason = if truncated {
        Some("文件超过 1MB，只能预览前 1MB".to_string())
    } else if utf8.is_err() {
        Some("文件不是 UTF-8 编码，为避免损坏仅支持预览".to_string())
    } else if line_ending == "mixed" {
        Some("文件包含混合换行符，为避免整文件换行格式被改写，仅支持预览".to_string())
    } else if read_only {
        Some("文件为只读，无法保存修改".to_string())
    } else {
        None
    };
    Ok(FileContent {
        line_ending,
        content,
        truncated,
        size,
        editable: edit_reason.is_none(),
        edit_reason,
        utf8_bom,
    })
}

/// 读取文本文件内容预览：>1MB 截断，含 NUL 字节判为二进制拒绝。
/// 可编辑性、换行符和 UTF-8 BOM 一并返回，前端保存时据此保持原格式。
#[tauri::command]
fn read_file(path: String) -> Result<FileContent, String> {
    let p = fs::canonicalize(Path::new(&path)).map_err(|e| e.to_string())?;
    read_text_file(&p)
}

#[cfg(target_os = "macos")]
fn copy_file_metadata(path: &Path, temp: &tempfile::NamedTempFile) -> Result<(), String> {
    use std::os::fd::AsRawFd;

    let source = fs::File::open(path).map_err(|e| e.to_string())?;
    // COPYFILE_METADATA 包含 stat、ACL 与扩展属性；随后写入正文会自然刷新 mtime。
    let result = unsafe {
        libc::fcopyfile(
            source.as_raw_fd(),
            temp.as_file().as_raw_fd(),
            std::ptr::null_mut(),
            libc::COPYFILE_METADATA,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(format!(
            "无法保留文件元数据，已停止保存: {}",
            std::io::Error::last_os_error()
        ))
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn copy_file_metadata(path: &Path, temp: &tempfile::NamedTempFile) -> Result<(), String> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::MetadataExt;
    use xattr::FileExt;

    let source = fs::File::open(path).map_err(|e| e.to_string())?;
    let metadata = source.metadata().map_err(|e| e.to_string())?;
    let result =
        unsafe { libc::fchown(temp.as_file().as_raw_fd(), metadata.uid(), metadata.gid()) };
    if result != 0 {
        return Err(format!(
            "无法保留文件所有者或用户组，已停止保存: {}",
            std::io::Error::last_os_error()
        ));
    }
    // fchown 可能清除 setuid/setgid 位，因此所有者复制后再恢复完整权限。
    temp.as_file()
        .set_permissions(metadata.permissions())
        .map_err(|e| format!("无法保留文件权限，已停止保存: {e}"))?;
    for name in source
        .list_xattr()
        .map_err(|e| format!("无法读取文件扩展属性，已停止保存: {e}"))?
    {
        if let Some(value) = source
            .get_xattr(&name)
            .map_err(|e| format!("无法读取文件扩展属性，已停止保存: {e}"))?
        {
            temp.as_file()
                .set_xattr(&name, &value)
                .map_err(|e| format!("无法保留文件扩展属性，已停止保存: {e}"))?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn copy_file_metadata(_path: &Path, _temp: &tempfile::NamedTempFile) -> Result<(), String> {
    // ReplaceFileW 会在最终替换时继承目标文件的 ACL、属性和命名流。
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn copy_file_metadata(path: &Path, temp: &tempfile::NamedTempFile) -> Result<(), String> {
    let permissions = fs::metadata(path).map_err(|e| e.to_string())?.permissions();
    temp.as_file()
        .set_permissions(permissions)
        .map_err(|e| format!("无法保留文件权限，已停止保存: {e}"))
}

#[cfg(windows)]
fn persist_temp_file(temp: tempfile::NamedTempFile, path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    let temp_path = temp.into_temp_path();
    let target_wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let temp_wide: Vec<u16> = temp_path.as_os_str().encode_wide().chain(Some(0)).collect();
    let result = unsafe {
        ReplaceFileW(
            target_wide.as_ptr(),
            temp_wide.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if result == 0 {
        Err(format!("替换文件失败: {}", std::io::Error::last_os_error()))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn persist_temp_file(temp: tempfile::NamedTempFile, path: &Path) -> Result<(), String> {
    temp.persist(path).map_err(|e| e.error.to_string())?;
    Ok(())
}

/// 同目录临时文件落盘后再替换目标：避免崩溃时只留下半截内容，并尽可能完整
/// 保留原文件的权限、所有者、ACL、扩展属性及平台元数据。
fn atomic_replace_file(path: &Path, data: &[u8], expected_current: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "无法确定文件所在目录".to_string())?;
    let mut temp = tempfile::Builder::new()
        .prefix(".vcm-edit-")
        .tempfile_in(parent)
        .map_err(|e| e.to_string())?;
    copy_file_metadata(path, &temp)?;
    temp.as_file_mut()
        .write_all(data)
        .map_err(|e| e.to_string())?;
    temp.as_file_mut().sync_all().map_err(|e| e.to_string())?;
    // 临时文件准备期间目标仍可能被外部改动，替换前再核对一次以缩小竞争窗口。
    let (latest, _, latest_truncated) = read_file_bounded(path, MAX_TEXT_FILE_SIZE)?;
    if latest_truncated || latest != expected_current {
        return Err("文件已被其他程序修改；为避免覆盖，请取消编辑后重新打开".to_string());
    }
    persist_temp_file(temp, path)?;
    // Unix 上再同步目录项；不支持目录 fsync 的平台无需阻止正常保存。
    #[cfg(unix)]
    {
        let _ = fs::File::open(parent).and_then(|dir| dir.sync_all());
    }
    Ok(())
}

/// 保存 UTF-8 文本文件。保存前和原子替换前逐字节核对打开时的内容，尽力检测
/// 终端、Git 或其他编辑器在此期间写入的新版本。
#[tauri::command]
fn write_file(
    path: String,
    content: String,
    expected_content: String,
    utf8_bom: bool,
) -> Result<FileContent, String> {
    let target = fs::canonicalize(Path::new(&path)).map_err(|e| e.to_string())?;
    if !target.is_file() {
        return Err("不是文件".to_string());
    }
    let metadata = fs::metadata(&target).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_TEXT_FILE_SIZE {
        return Err("文件超过 1MB，不能在应用内编辑".to_string());
    }
    if metadata.permissions().readonly() {
        return Err("文件为只读，无法保存修改".to_string());
    }

    let (current_bytes, _, current_truncated) = read_file_bounded(&target, MAX_TEXT_FILE_SIZE)?;
    if current_truncated {
        return Err("文件超过 1MB，不能在应用内编辑".to_string());
    }
    if current_bytes.contains(&0) {
        return Err("二进制文件不能作为文本保存".to_string());
    }
    let (current_bom, current_text_bytes) = split_utf8_bom(&current_bytes);
    let current_text = std::str::from_utf8(current_text_bytes)
        .map_err(|_| "文件已变为非 UTF-8 编码，已停止保存".to_string())?;
    if current_bom != utf8_bom || current_text != expected_content {
        return Err("文件已被其他程序修改；为避免覆盖，请取消编辑后重新打开".to_string());
    }
    if content.as_bytes().contains(&0) {
        return Err("文本内容不能包含 NUL 字节".to_string());
    }

    let mut encoded = Vec::with_capacity(content.len() + usize::from(utf8_bom) * 3);
    if utf8_bom {
        encoded.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    encoded.extend_from_slice(content.as_bytes());
    if encoded.len() as u64 > MAX_TEXT_FILE_SIZE {
        return Err("编辑后的文件超过 1MB，未保存".to_string());
    }

    atomic_replace_file(&target, &encoded, &current_bytes)?;
    read_text_file(&target)
}

#[tauri::command]
fn confirm_app_exit(app: AppHandle, state: State<'_, EditorExitGuard>) {
    state.allow_exit.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// 原生窗口关闭会在窗口销毁后触发应用 ExitRequested。先由前端用本地编辑器状态
/// 做完判断，再放行这一次退出，避免异步 dirty IPC 与 Cmd+Q 之间的竞态。
#[tauri::command]
fn confirm_window_close(state: State<'_, EditorExitGuard>) {
    state.allow_exit.store(true, Ordering::SeqCst);
}

/// 读取图片文件 → base64 data URL（供 <img> 直接显示）。>16MB 拒绝。
#[tauri::command]
fn read_image(path: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    };
    let bytes = read_binary_file_bounded(p, MAX_IMAGE_FILE_SIZE, "图片过大（>16MB）")?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

/// 读取任意文件 → base64（供前端转 Blob 显示，如 PDF）。>32MB 拒绝。
#[tauri::command]
fn read_binary_base64(path: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    let bytes = read_binary_file_bounded(p, MAX_PDF_FILE_SIZE, "文件过大（>32MB）")?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// 把文件/文件夹移到系统废纸篓（可恢复，不永久删除）。
#[tauri::command]
fn trash_path(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err("路径不存在".to_string());
    }
    trash::delete(p).map_err(|e| e.to_string())
}

// ========== 项目 Git 状态徽标 ==========

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitStatus {
    path: String,
    /// 是否是 git 仓库
    is_repo: bool,
    /// 当前分支名（detached 时为 "(detached)"）
    branch: String,
    /// 相对上游领先 / 落后的提交数
    ahead: u32,
    behind: u32,
    /// 已追踪文件的改动数（暂存 + 未暂存 + 冲突）
    changed: u32,
    /// 未追踪文件数
    untracked: u32,
    /// 工作区是否有改动
    dirty: bool,
    /// 执行 git 出错（如 git 不在 PATH）
    error: bool,
}

impl GitStatus {
    fn empty(path: String) -> Self {
        GitStatus {
            path,
            is_repo: false,
            branch: String::new(),
            ahead: 0,
            behind: 0,
            changed: 0,
            untracked: 0,
            dirty: false,
            error: false,
        }
    }
}

/// 扫描单个仓库的 git 状态。用 `status --porcelain=v2 --branch` 一条命令拿全：
/// 分支 / 上游领先落后 / 各文件状态。非仓库直接返回 is_repo=false。
fn git_status_one(path: &str) -> GitStatus {
    let mut st = GitStatus::empty(path.to_string());
    let p = std::path::Path::new(path);
    if !p.is_dir() || !p.join(".git").exists() {
        return st;
    }
    st.is_repo = true;
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["status", "--porcelain=v2", "--branch"])
        .output();
    let out = match out {
        Ok(o) if o.status.success() => o,
        _ => {
            st.error = true;
            return st;
        }
    };
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            st.branch = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            for tok in rest.split_whitespace() {
                if let Some(n) = tok.strip_prefix('+') {
                    st.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = tok.strip_prefix('-') {
                    st.behind = n.parse().unwrap_or(0);
                }
            }
        } else if line.starts_with("1 ") || line.starts_with("2 ") || line.starts_with("u ") {
            st.changed += 1;
        } else if line.starts_with("? ") {
            st.untracked += 1;
        }
    }
    st.dirty = st.changed > 0 || st.untracked > 0;
    st
}

/// 取某目录的当前 git 分支（终端标签显示用）。不预判 .git——交给 git 自己向上找仓库，
/// 兼容仓库子目录。非 git / 出错 / 分离 HEAD → 空串（前端据此隐藏徽标）。
#[tauri::command]
async fn git_branch(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if path.is_empty() || !std::path::Path::new(&path).is_dir() {
            return String::new();
        }
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(&path)
            .args(["--no-optional-locks", "branch", "--show-current"])
            .output();
        match out {
            Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
            _ => String::new(),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// 批量扫描多个项目路径的 git 状态。整体在 spawn_blocking 里跑（绝不阻塞主线程），
/// 内部按批并发（每批一线程），限制并发量避免项目极多时一次性 fork 上百个 git 进程。
#[tauri::command]
async fn git_status_batch(paths: Vec<String>) -> Result<Vec<GitStatus>, String> {
    const MAX_CONCURRENT: usize = 12;
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::with_capacity(paths.len());
        for chunk in paths.chunks(MAX_CONCURRENT) {
            let handles: Vec<_> = chunk
                .iter()
                .cloned()
                .map(|path| std::thread::spawn(move || git_status_one(&path)))
                .collect();
            for h in handles {
                out.push(h.join().unwrap_or_else(|_| {
                    let mut s = GitStatus::empty(String::new());
                    s.error = true;
                    s
                }));
            }
        }
        out
    })
    .await
    .map_err(|e| e.to_string())
}

// ========== 项目"恢复现场" ==========

#[derive(Clone, Serialize)]
struct Commit {
    hash: String,
    subject: String,
    /// 相对时间，如 "2 hours ago"（git 自带）
    rel: String,
}

#[derive(Clone, Serialize)]
struct ChangedFile {
    /// porcelain 两字符状态码去空格后的值（M / A / D / R / ?? 等）
    status: String,
    path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectContext {
    is_repo: bool,
    branch: String,
    ahead: u32,
    behind: u32,
    changed: u32,
    untracked: u32,
    dirty: bool,
    /// 最近提交（最多 5 条）
    commits: Vec<Commit>,
    /// 改动文件（最多 20 条）
    files: Vec<ChangedFile>,
    /// 还有多少改动文件未列出（files 截断后的剩余数）
    files_more: u32,
    /// CLAUDE.md 摘要（前若干字符；无则空）
    claude_md: String,
    /// 项目目录是否存在
    exists: bool,
}

fn read_claude_md(dir: &std::path::Path) -> String {
    let candidates = [dir.join("CLAUDE.md"), dir.join(".claude").join("CLAUDE.md")];
    for c in candidates {
        if let Ok(text) = fs::read_to_string(&c) {
            // 取前若干非空行，拼成摘要，最长 ~500 字符
            let mut out = String::new();
            for line in text.lines() {
                let l = line.trim_end();
                if out.is_empty() && l.trim().is_empty() {
                    continue; // 跳过开头空行
                }
                out.push_str(l);
                out.push('\n');
                if out.chars().count() >= 500 {
                    break;
                }
            }
            return out.trim_end().to_string();
        }
    }
    String::new()
}

/// 聚合一个项目的"现场"：git 概览 + 最近提交 + 改动文件 + CLAUDE.md 摘要。
#[tauri::command]
async fn project_context(path: String) -> Result<ProjectContext, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = std::path::Path::new(&path);
        let mut ctx = ProjectContext {
            is_repo: false,
            branch: String::new(),
            ahead: 0,
            behind: 0,
            changed: 0,
            untracked: 0,
            dirty: false,
            commits: Vec::new(),
            files: Vec::new(),
            files_more: 0,
            claude_md: String::new(),
            exists: dir.is_dir(),
        };
        if !ctx.exists {
            return ctx;
        }
        ctx.claude_md = read_claude_md(dir);

        // git 概览复用 git_status_one
        let st = git_status_one(&path);
        ctx.is_repo = st.is_repo;
        ctx.branch = st.branch;
        ctx.ahead = st.ahead;
        ctx.behind = st.behind;
        ctx.changed = st.changed;
        ctx.untracked = st.untracked;
        ctx.dirty = st.dirty;

        if ctx.is_repo {
            // 最近提交
            if let Ok(out) = std::process::Command::new("git")
                .arg("-C")
                .arg(&path)
                .args(["log", "-n", "5", "--pretty=format:%h%x1f%s%x1f%cr"])
                .output()
            {
                if out.status.success() {
                    for line in String::from_utf8_lossy(&out.stdout).lines() {
                        let mut parts = line.split('\u{1f}');
                        if let (Some(h), Some(s), Some(r)) =
                            (parts.next(), parts.next(), parts.next())
                        {
                            ctx.commits.push(Commit {
                                hash: h.to_string(),
                                subject: s.to_string(),
                                rel: r.to_string(),
                            });
                        }
                    }
                }
            }
            // 改动文件
            if let Ok(out) = std::process::Command::new("git")
                .arg("-C")
                .arg(&path)
                .args(["status", "--porcelain"])
                .output()
            {
                if out.status.success() {
                    let text = String::from_utf8_lossy(&out.stdout);
                    let lines: Vec<&str> = text.lines().filter(|l| l.len() > 3).collect();
                    let total = lines.len();
                    for l in lines.iter().take(20) {
                        ctx.files.push(ChangedFile {
                            status: l[..2].trim().to_string(),
                            path: l[3..].trim().to_string(),
                        });
                    }
                    if total > 20 {
                        ctx.files_more = (total - 20) as u32;
                    }
                }
            }
        }
        ctx
    })
    .await
    .map_err(|e| e.to_string())
}

// ========== 终端会话上下文用量（Claude 会话当前上下文占比）==========

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContextUsage {
    /// 是否找到该项目的 Claude 会话 transcript
    ok: bool,
    /// 当前上下文占比 0-100
    percent: u32,
    /// 当前上下文 token 数（input + cache_read + cache_creation）
    tokens: u64,
    /// 模型上下文上限
    limit: u64,
}

const DEFAULT_CONTEXT_WINDOW: u64 = 200_000;
const CONTEXT_WINDOW_ENV: &str = "CLAUDE_CODE_MAX_CONTEXT_TOKENS";

fn parse_context_window_value(value: &str) -> Option<u64> {
    let trimmed = value.trim();
    let value = if trimmed.contains([',', '_']) {
        std::borrow::Cow::Owned(trimmed.replace([',', '_'], ""))
    } else {
        std::borrow::Cow::Borrowed(trimmed)
    };
    let (number, multiplier) = match value.as_bytes().last()?.to_ascii_lowercase() {
        b'k' => (&value[..value.len() - 1], 1_000_f64),
        b'm' => (&value[..value.len() - 1], 1_000_000_f64),
        b'0'..=b'9' => (value.as_ref(), 1_f64),
        _ => return None,
    };
    let parsed = number.parse::<f64>().ok()?;
    (parsed.is_finite() && parsed > 0.0)
        .then(|| (parsed * multiplier).round() as u64)
        .filter(|&n| n > 0)
}

fn context_window_from_settings_json(json: &str) -> Option<u64> {
    let settings: serde_json::Value = serde_json::from_str(json).ok()?;
    let value = settings.get("env")?.get(CONTEXT_WINDOW_ENV)?;
    match value {
        serde_json::Value::String(s) => parse_context_window_value(s),
        serde_json::Value::Number(n) => n.as_u64().filter(|&v| v > 0),
        _ => None,
    }
}

fn context_window_from_settings(path: &std::path::Path) -> Option<u64> {
    fs::read_to_string(path)
        .ok()
        .and_then(|json| context_window_from_settings_json(&json))
}

/// 读取 Claude Code 当前配置的上下文窗口。进程环境优先；项目本地/共享设置随后；
/// 最后读取用户设置。只读配置，不注入或覆盖用户已有的 statusLine。
fn configured_context_window(cwd: &str) -> Option<u64> {
    if let Ok(value) = std::env::var(CONTEXT_WINDOW_ENV) {
        if let Some(limit) = parse_context_window_value(&value) {
            return Some(limit);
        }
    }

    let project = PathBuf::from(cwd).join(".claude");
    for name in ["settings.local.json", "settings.json"] {
        if let Some(limit) = context_window_from_settings(&project.join(name)) {
            return Some(limit);
        }
    }

    usage::claude_user_env_value(CONTEXT_WINDOW_ENV)
        .and_then(|value| parse_context_window_value(&value))
}

/// Claude Code 把项目路径编码成 ~/.claude/projects 下的目录名：`/`、`\` 和 `.` 都替换为 `-`。
fn encode_claude_project_dir(cwd: &str) -> String {
    project_memory::encode_claude_project_dir(cwd)
}

#[tauri::command]
async fn ensure_project_memory(path: String) -> Result<project_memory::ProjectMemoryState, String> {
    tauri::async_runtime::spawn_blocking(move || project_memory::ensure_project_memory(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn detach_project_memory(path: String) -> Result<project_memory::ProjectMemoryState, String> {
    tauri::async_runtime::spawn_blocking(move || project_memory::detach_project_memory(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_project_sessions(path: String) -> Result<project_sessions::ProjectHistory, String> {
    tauri::async_runtime::spawn_blocking(move || project_sessions::list_project_history(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn preview_project_session(
    path: String,
    tool: String,
    id: String,
) -> Result<project_sessions::ProjectHistoryPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        project_sessions::preview_project_session(&path, &tool, &id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn delete_project_session(path: String, tool: String, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        project_sessions::delete_project_session(&path, &tool, &id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn ensure_orchestra(path: String) -> Result<orchestra::OrchestraState, String> {
    tauri::async_runtime::spawn_blocking(move || orchestra::ensure_orchestra(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn write_orchestra_file(
    path: String,
    name: String,
    content: String,
) -> Result<orchestra::OrchestraState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        orchestra::write_orchestra_file(&path, &name, &content)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn read_orchestra_file(path: String, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || orchestra::read_orchestra_file(&path, &name))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_proxy_settings() -> proxy_settings::ProxySettings {
    proxy_settings::load_settings()
}

#[tauri::command]
fn save_proxy_settings(
    lock: State<proxy_settings::ProxySettingsLock>,
    settings: proxy_settings::ProxySettings,
) -> Result<proxy_settings::ProxySettings, String> {
    let _guard = lock.0.lock().map_err(|e| e.to_string())?;
    proxy_settings::save_settings(settings)
}

#[tauri::command]
fn get_proxy_shell_hook() -> proxy_settings::ProxyShellHook {
    proxy_settings::shell_hook()
}

/// 找某项目对应的 Claude transcript 目录：先按编码规则猜，猜不中再扫 projects 下
/// 各目录、读首行的 `cwd` 字段匹配。
fn find_claude_project_dir(cwd: &str) -> Option<PathBuf> {
    let projects = dirs::home_dir()?.join(".claude").join("projects");
    let cand = projects.join(encode_claude_project_dir(cwd));
    if cand.is_dir() {
        return Some(cand);
    }
    for entry in fs::read_dir(&projects).ok()?.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        // 读该目录任一 jsonl 的首行，比对 cwd 字段（只读首行，别把整份 transcript 读进内存）
        if let Some(j) = newest_jsonl(&p) {
            if let Some(Ok(line)) = fs::File::open(&j)
                .ok()
                .and_then(|f| std::io::BufRead::lines(std::io::BufReader::new(f)).next())
            {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    if v.get("cwd").and_then(|x| x.as_str()) == Some(cwd) {
                        return Some(p);
                    }
                }
            }
        }
    }
    None
}

fn newest_jsonl(dir: &std::path::Path) -> Option<PathBuf> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let mtime = entry.metadata().and_then(|m| m.modified()).ok()?;
        if best.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
            best = Some((mtime, p));
        }
    }
    best.map(|(_, p)| p)
}

fn strip_terminal_sequences(s: &str) -> std::borrow::Cow<'_, str> {
    if !s.as_bytes().contains(&0x1b) {
        return std::borrow::Cow::Borrowed(s);
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != 0x1b {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        i += 1;
        match bytes.get(i).copied() {
            Some(b'[') => {
                i += 1;
                while i < bytes.len() {
                    let b = bytes[i];
                    i += 1;
                    if (0x40..=0x7e).contains(&b) {
                        break;
                    }
                }
            }
            Some(b']') => {
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == 0x07 {
                        i += 1;
                        break;
                    }
                    if bytes[i] == 0x1b && bytes.get(i + 1) == Some(&b'\\') {
                        i += 2;
                        break;
                    }
                    i += 1;
                }
            }
            Some(_) => i += 1,
            None => break,
        }
    }
    std::borrow::Cow::Owned(String::from_utf8_lossy(&out).into_owned())
}

/// 从 Claude Code 的终端输出探上下文窗口。兼容启动横幅的 `(1M context)`、
/// 新版的 `353k context`，以及 `/context` 的 `225.8k/353k tokens`。
fn detect_context_window(s: &str) -> Option<u64> {
    let lower = strip_terminal_sequences(s).to_ascii_lowercase();

    // `/context` 的分母最明确，优先取最后一次完整的 `已用/上限 tokens`。
    for (idx, _) in lower.rmatch_indices(" token") {
        let head = lower[..idx].trim_end();
        let Some(slash) = head.rfind('/') else { continue };
        let candidate = head[slash + 1..]
            .split_whitespace()
            .next()
            .unwrap_or("");
        if let Some(limit) = parse_context_window_value(candidate) {
            return Some(limit);
        }
    }

    // 启动横幅。括号只是 UI 样式，不参与协议判断。
    for marker in [" context", " window"] {
        for (idx, _) in lower.rmatch_indices(marker) {
            let head = lower[..idx].trim_end();
            let candidate = head
                .rsplit(|c: char| !(c.is_ascii_digit() || matches!(c, '.' | ',' | '_' | 'k' | 'm')))
                .next()
                .unwrap_or("");
            if let Some(limit) = parse_context_window_value(candidate) {
                return Some(limit);
            }
        }
    }
    None
}

/// 读文件尾部至多 max 字节；从尾部第一个换行之后返回，避免截断出半截行。
/// 文件不超过 max 则整读。用于 transcript 这类「只关心最近记录」的大文件，免整读进内存。
fn context_percent(tokens: u64, limit: u64) -> u32 {
    if limit == 0 {
        return 0;
    }
    ((tokens as f64 / limit as f64) * 100.0).round().min(100.0) as u32
}

fn read_file_tail(path: &PathBuf, max: u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    if len <= max {
        let mut s = String::new();
        f.read_to_string(&mut s).ok()?;
        return Some(s);
    }
    f.seek(SeekFrom::Start(len - max)).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    // 丢掉可能被截断的首行残片（从第一个换行之后开始）
    let start = buf.iter().position(|&b| b == b'\n').map(|i| i + 1).unwrap_or(0);
    Some(String::from_utf8_lossy(&buf[start..]).into_owned())
}

/// 估算某 Claude 会话的当前上下文占比。
/// 分母（窗口大小）：会话缓存 → Claude Code 当前生效配置 → 终端输出 → 标准 200k 兜底。
/// 分子：读该项目最新 transcript 最后一条带 usage 的消息，
///   context ≈ input + cache_read + cache_creation tokens。
#[tauri::command]
async fn context_usage(
    state: State<'_, TerminalState>,
    id: String,
    cwd: String,
    started_at: u64,
) -> Result<ContextUsage, String> {
    // 只在持锁期间复制缓存，终端文本解析和配置文件 I/O 都放到阻塞线程。
    let cached_limit = state
        .ctx_window
        .lock()
        .ok()
        .and_then(|m| m.get(&id).copied());
    let scrollback = if cached_limit.is_none() {
        state
            .hub
            .scrollback
            .lock()
            .ok()
            .and_then(|sb| sb.get(&id).cloned())
    } else {
        None
    };
    let ctx_window = state.ctx_window.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let resolved_limit = cached_limit.or_else(|| {
            configured_context_window(&cwd).or_else(|| {
                scrollback
                    .as_deref()
                    .and_then(|buf| detect_context_window(&String::from_utf8_lossy(buf)))
            })
        });
        if cached_limit.is_none() {
            if let Some(limit) = resolved_limit {
                if let Ok(mut limits) = ctx_window.lock() {
                    limits.insert(id, limit);
                }
            }
        }

        let fallback_limit = resolved_limit.unwrap_or(DEFAULT_CONTEXT_WINDOW);
        let mut cu = ContextUsage { ok: false, percent: 0, tokens: 0, limit: fallback_limit };
        let Some(dir) = find_claude_project_dir(&cwd) else { return cu };
        let Some(jsonl) = newest_jsonl(&dir) else { return cu };
        // 只认「本会话开始之后」修改过的 transcript：新会话发第一句前还没有自己的
        // transcript，最新那个是上一个会话——此时上下文应为 0，别拿旧会话的数充数。
        let mtime_ms = fs::metadata(&jsonl)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        if mtime_ms + 2000 < started_at {
            cu.ok = true; // 本会话尚无上下文
            return cu;
        }
        // transcript 可能达数十 MB；最近一条 usage 几乎总在文件尾部——先只读尾部 512KB 扫，
        // 命中就用；没命中（罕见：尾部恰好没有带 usage 的助手消息）再整读兜底，
        // 避免每次轮询都把整份文件读进内存。
        let scan = |text: &str| -> Option<u64> {
            for line in text.lines().rev() {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
                let Some(usage) = v.pointer("/message/usage") else { continue };
                let g = |k: &str| usage.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
                let tokens = g("input_tokens")
                    + g("cache_read_input_tokens")
                    + g("cache_creation_input_tokens");
                if tokens > 0 {
                    return Some(tokens);
                }
            }
            None
        };
        let found = read_file_tail(&jsonl, 512 * 1024)
            .as_deref()
            .and_then(&scan)
            .or_else(|| fs::read_to_string(&jsonl).ok().and_then(|c| scan(&c)));
        if let Some(tokens) = found {
            cu.ok = true;
            cu.tokens = tokens;
            cu.percent = context_percent(tokens, fallback_limit);
        }
        cu
    })
    .await
    .map_err(|e| e.to_string())
}

// ========== 内置终端（PTY）==========

// ===== 会话状态感知（"AI 跑完/在等你"检测）=====
// 思路：reader 线程记录每会话的输出活动；监控线程每秒扫描——
// 一个会话"活跃输出了一阵后突然安静超过阈值"即判定为需要用户关注，emit `terminal-attention`。
// 启发式过滤掉空 shell 打印提示符这类"瞬时单次输出"（不是干活），只在持续输出后变静默才报。

/// 静默多久判定为"等待关注"
const ATTENTION_IDLE_SECS: u64 = 5;
/// 活跃输出至少持续这么久（毫秒）才算"干过活"——过滤瞬时提示符
const ATTENTION_MIN_BURST_MS: u128 = 1500;
/// 或：单段输出累计这么多字节也算干过活（捕捉一次性大输出，如构建日志/长回答）
const ATTENTION_MIN_BYTES: usize = 2000;

/// 单个会话的输出活动追踪。
struct Activity {
    /// 最近一次产生输出的时刻
    last_output: Instant,
    /// 当前这段活跃输出的起点（busy 由 false→true 时重置）
    burst_start: Instant,
    /// 当前活跃段累计字节
    burst_bytes: usize,
    /// 自上次通知后是否有新输出（true = 有待消费的活跃）
    busy: bool,
    /// 本段活跃是否已通知过（避免重复报）
    notified: bool,
    name: String,
    tool: String,
}

/// 推给前端的"需要关注"事件。
#[derive(Clone, Serialize)]
struct AttentionEvent {
    id: String,
    name: String,
    tool: String,
}

type ActivityMap = Arc<Mutex<HashMap<String, Activity>>>;

/// 终端状态：持有共享的 RemoteHub（会话表 / 滚动缓存 / 广播通道 / PIN）。
/// 桌面命令与内嵌的手机端服务都操作同一个 hub（克隆即共享 Arc）。
struct TerminalState {
    hub: RemoteHub,
    /// 本进程内已经使用或正在创建的会话 ID。成功创建后也不复用，避免旧 reader
    /// 线程的迟到 EOF 清理掉同 ID 的新会话。
    used_ids: Arc<Mutex<HashSet<String>>>,
    /// 各会话输出活动追踪（reader 线程写、监控线程读）
    activity: ActivityMap,
    /// 各会话探测到的上下文窗口大小（终端输出或 Claude Code 生效配置，按会话缓存，
    /// 避免启动信息被滚出 scrollback 后丢失）
    ctx_window: Arc<Mutex<HashMap<String, u64>>>,
}

impl Default for TerminalState {
    fn default() -> Self {
        Self {
            hub: RemoteHub::new(REMOTE_PORT),
            used_ids: Arc::new(Mutex::new(HashSet::new())),
            activity: Arc::new(Mutex::new(HashMap::new())),
            ctx_window: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// 监控线程：每秒扫描所有会话，把"活跃后静默超阈值"的会话报给前端。
fn monitor_attention(app: AppHandle, activity: ActivityMap) {
    let idle = Duration::from_secs(ATTENTION_IDLE_SECS);
    loop {
        std::thread::sleep(Duration::from_millis(1000));
        let mut fire: Vec<AttentionEvent> = Vec::new();
        if let Ok(mut map) = activity.lock() {
            let now = Instant::now();
            for (id, a) in map.iter_mut() {
                if !a.busy || a.notified {
                    continue;
                }
                if now.duration_since(a.last_output) < idle {
                    continue;
                }
                let burst_ms = a.last_output.duration_since(a.burst_start).as_millis();
                let qualifies = burst_ms >= ATTENTION_MIN_BURST_MS || a.burst_bytes >= ATTENTION_MIN_BYTES;
                // 不管够不够格，这段活跃都已结束 → 消费掉，等下一段新输出再重新计
                a.busy = false;
                if qualifies {
                    a.notified = true;
                    fire.push(AttentionEvent {
                        id: id.clone(),
                        name: a.name.clone(),
                        tool: a.tool.clone(),
                    });
                }
            }
        }
        for ev in fire {
            let _ = app.emit("terminal-attention", ev);
        }
    }
}

#[derive(Clone, Serialize)]
struct TerminalOutput {
    id: String,
    /// base64 编码的原始字节（避免 UTF-8 切断转义序列 / 多字节字符）
    data: String,
}

/// 一个可访问地址（带网络类型标注 + 扫码用二维码）。
#[derive(Clone, Serialize)]
struct RemoteAddr {
    /// 网络类型："局域网" / "其他"
    kind: String,
    ip: String,
    url: String,
    /// 二维码 SVG（编码 url?k=PIN，扫码即自动带 PIN 登录）
    qr: String,
}

/// 手机端连接信息，桌面 UI 展示给用户。
#[derive(Clone, Serialize)]
struct RemoteInfo {
    addrs: Vec<RemoteAddr>,
    port: u16,
    pin: String,
}

/// 创建一个新的终端会话，在 `cwd` 起一个登录 shell，并把输出流式推到前端。
fn validate_terminal_cwd(cwd: &str) -> Result<(), String> {
    if cwd.is_empty() || std::path::Path::new(cwd).is_dir() {
        return Ok(());
    }
    Err(format!("终端工作目录不存在或不可访问：{cwd}"))
}

fn validate_terminal_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("终端会话 ID 非法".to_string());
    }
    Ok(())
}

struct TerminalIdReservation {
    used_ids: Arc<Mutex<HashSet<String>>>,
    id: String,
    committed: bool,
}

impl TerminalIdReservation {
    fn reserve(used_ids: Arc<Mutex<HashSet<String>>>, id: &str) -> Result<Self, String> {
        validate_terminal_id(id)?;
        let mut ids = used_ids.lock().map_err(|e| e.to_string())?;
        if !ids.insert(id.to_string()) {
            return Err("终端会话 ID 已存在或已使用".to_string());
        }
        drop(ids);
        Ok(Self {
            used_ids,
            id: id.to_string(),
            committed: false,
        })
    }

    fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for TerminalIdReservation {
    fn drop(&mut self) {
        if !self.committed {
            if let Ok(mut ids) = self.used_ids.lock() {
                ids.remove(&self.id);
            }
        }
    }
}

// Tauri IPC 直接按终端创建参数解包，保留具名参数可避免前端协议变更。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn terminal_create(
    app: AppHandle,
    state: State<TerminalState>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    name: Option<String>,
    tool: Option<String>,
) -> Result<(), String> {
    // 不允许无效项目路径静默回退到应用默认目录，否则 `codex resume --last`
    // 可能按错误 cwd 接入另一个项目的最近会话。
    validate_terminal_cwd(&cwd)?;
    let id_reservation = TerminalIdReservation::reserve(state.used_ids.clone(), &id)?;
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // 选 shell：Unix 用用户默认 shell 的登录交互模式（加载 PATH/别名）；Windows 用 PowerShell
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let mut c = CommandBuilder::new(&shell);
        c.arg("-l");
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = CommandBuilder::new("powershell.exe");

    if !cwd.is_empty() {
        cmd.cwd(&cwd);
    }
    cmd.env("TERM", "xterm-256color");
    proxy_settings::apply_to_command(&mut cmd);

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| {
        crate::log_error!(
            "终端 spawn 失败（id={id} tool={}）：{e}",
            tool.as_deref().unwrap_or("")
        );
        e.to_string()
    })?;
    // slave 句柄在 spawn 后即可释放，否则子进程退出时读端不会收到 EOF
    drop(pair.slave);
    crate::log_info!(
        "终端已创建：id={id} tool={} cwd={} proxy={}",
        tool.as_deref().unwrap_or(""),
        if cwd.is_empty() { "(默认)" } else { cwd.as_str() },
        {
            let proxy = proxy_settings::load_settings();
            if proxy.enabled && !proxy.url.is_empty() {
                proxy_settings::redact_proxy_url(&proxy.url)
            } else {
                "off".into()
            }
        }
    );

    let mut reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e.to_string());
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e.to_string());
        }
    };
    let pty_session = PtySession {
        master: pair.master,
        writer: Arc::new(Mutex::new(writer)),
        child,
    };

    // 后台线程持续读 PTY 输出：base64 后同时推给桌面窗口（Tauri 事件）和手机端（WS 广播 + 滚动缓存）
    let sess_name = name.unwrap_or_else(|| id.clone());
    let sess_tool = tool.unwrap_or_default();

    // 先登记会话元信息 + PtySession，再起 reader 线程——否则 shell 秒退时 reader 可能
    // 在下面登记之前就读到 EOF、触发 cleanup_session 扑空，之后登记的这两张表就再没人清理
    // （泄漏 master FD + 手机端幽灵会话）。writer 包一层 Arc<Mutex<>>，让 terminal_write
    // 能在锁外做可能阻塞的写、不攥着全局 sessions 锁。
    {
        let mut activity = state.activity.lock().map_err(|e| e.to_string())?;
        let mut metas = state.hub.metas.lock().map_err(|e| e.to_string())?;
        let mut sessions = state.hub.sessions.lock().map_err(|e| e.to_string())?;
        let now = Instant::now();
        activity.insert(
            id.clone(),
            Activity {
                last_output: now,
                burst_start: now,
                burst_bytes: 0,
                busy: false,
                notified: false,
                name: sess_name.clone(),
                tool: sess_tool.clone(),
            },
        );
        metas.insert(
            id.clone(),
            SessionMeta {
                id: id.clone(),
                name: sess_name.clone(),
                tool: sess_tool.clone(),
            },
        );
        sessions.insert(id.clone(), pty_session);
    }
    id_reservation.commit();

    let app_evt = app.clone();
    let sid = id.clone();
    let hub_evt = state.hub.clone();
    let act_evt = state.activity.clone();
    let ctxwin_evt = state.ctx_window.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = &buf[..n];
                    // 同一块只 base64 一次，桌面事件与手机端广播共用（手机没连也只编这一次）
                    let data = base64::engine::general_purpose::STANDARD.encode(chunk);
                    let _ = app_evt.emit(
                        "terminal-output",
                        TerminalOutput {
                            id: sid.clone(),
                            data: data.clone(),
                        },
                    );
                    hub_evt.publish(&sid, chunk, data);
                    // 记录输出活动：新一段活跃则重置起点；持续输出则累加
                    if let Ok(mut map) = act_evt.lock() {
                        if let Some(a) = map.get_mut(&sid) {
                            let now = Instant::now();
                            if !a.busy {
                                a.burst_start = now;
                                a.burst_bytes = 0;
                            }
                            a.busy = true;
                            a.notified = false;
                            a.last_output = now;
                            a.burst_bytes += n;
                        }
                    }
                }
                Err(_) => break,
            }
        }
        let _ = app_evt.emit("terminal-exit", &sid);
        hub_evt.mark_exit(&sid);
        if let Ok(mut map) = act_evt.lock() {
            map.remove(&sid);
        }
        if let Ok(mut map) = ctxwin_evt.lock() {
            map.remove(&sid);
        }
    });

    Ok(())
}

/// 把前端的键入（已是 UTF-8 文本）写进对应会话的 PTY。
#[tauri::command]
fn terminal_write(state: State<TerminalState>, id: String, data: String) -> Result<(), String> {
    // 只在锁内取出该会话的 writer 句柄（clone Arc，廉价），随即释放全局 sessions 锁，
    // 再做可能阻塞的 write_all/flush——否则向「暂不读 stdin 的前台程序」灌大段内容时，
    // 阻塞的写会一直攥着全局锁，把 create/resize/close 所有会话（含关掉这个卡住的）全楔死。
    let writer = {
        let sessions = state.hub.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(&id).ok_or("会话不存在")?.writer.clone()
    };
    let mut w = writer.lock().map_err(|e| e.to_string())?;
    w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// 终端尺寸变化时同步 PTY 窗口大小（让 TUI 正确换行）。
#[tauri::command]
fn terminal_resize(
    state: State<TerminalState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.hub.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&id).ok_or("会话不存在")?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 关闭并清理一个会话（杀掉子进程）。
#[tauri::command]
fn terminal_close(state: State<TerminalState>, id: String) -> Result<(), String> {
    // 三个表（sessions/metas/scrollback）统一在 cleanup_session 里清，
    // 与 reader 线程 EOF 路径（mark_exit）共用同一处逻辑，避免漏删某个表泄漏。
    drop(state.hub.cleanup_session(&id));
    if let Ok(mut map) = state.activity.lock() {
        map.remove(&id);
    }
    if let Ok(mut map) = state.ctx_window.lock() {
        map.remove(&id);
    }
    Ok(())
}

/// 发系统级桌面通知（"会话状态感知"用：AI 跑完/在等你时叫回用户）。
/// 由前端在判定窗口失焦/不在当前标签时调用，避免你正盯着看还弹通知。
#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

/// 把一个 IPv4 分类为「局域网」/「其他」；返回 None 表示该地址不适合展示
/// （回环、链路本地，以及 Tailscale/CGNAT 100.64.0.0/10——先不接 Tailscale，直接排除）。
fn classify_ipv4(ip: std::net::Ipv4Addr) -> Option<&'static str> {
    if ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() {
        return None;
    }
    let o = ip.octets();
    // Tailscale / CGNAT 100.64.0.0/10：本期不展示
    if o[0] == 100 && (64..=127).contains(&o[1]) {
        return None;
    }
    if o[0] == 10
        || (o[0] == 172 && (16..=31).contains(&o[1]))
        || (o[0] == 192 && o[1] == 168)
    {
        return Some("局域网");
    }
    Some("其他")
}

/// 把字符串编码成二维码 SVG（深蓝点 + 白底，留白边便于扫描）。
fn make_qr_svg(data: &str) -> String {
    use qrcode::render::svg;
    match qrcode::QrCode::new(data.as_bytes()) {
        Ok(code) => code
            .render::<svg::Color>()
            .min_dimensions(168, 168)
            .quiet_zone(true)
            .dark_color(svg::Color("#0f172a"))
            .light_color(svg::Color("#ffffff"))
            .build(),
        Err(_) => String::new(),
    }
}

/// 生成 6 位随机 PIN（取 UUID 前 4 字节 mod 1_000_000，左补零）。
fn random_pin() -> String {
    let b = Uuid::new_v4().into_bytes();
    format!("{:06}", u32::from_le_bytes([b[0], b[1], b[2], b[3]]) % 1_000_000)
}

/// 按需启动手机端服务：用户首次打开「手机远程」面板时才生成随机 PIN 并监听端口。
/// 不打开就永不对外暴露；幂等（compare_exchange 保证只起一次）。
fn ensure_remote_started(hub: &remote::RemoteHub) {
    if hub.start_if_needed() {
        let pin = random_pin();
        if let Ok(mut t) = hub.token.lock() {
            *t = pin;
        }
        // 记端口（对外暴露事件值得留痕）；PIN 属敏感信息，绝不入日志
        crate::log_info!("手机远程服务已启动，监听端口 {}（PIN 不记录）", hub.port);
        remote::spawn_server(hub.clone());
    }
}

/// 返回手机端连接信息（局域网地址 + PIN），桌面 UI 展示。
/// 枚举所有网卡，局域网地址排前面；多网卡（有线/WiFi）全部列出供选择。
#[tauri::command]
fn terminal_remote_info(state: State<TerminalState>) -> RemoteInfo {
    ensure_remote_started(&state.hub);
    let port = state.hub.port;
    let pin = state.hub.token.lock().map(|t| t.clone()).unwrap_or_default();

    let mut addrs: Vec<RemoteAddr> = Vec::new();
    if let Ok(ifaces) = local_ip_address::list_afinet_netifas() {
        for (_name, ip) in ifaces {
            if let std::net::IpAddr::V4(v4) = ip {
                if let Some(kind) = classify_ipv4(v4) {
                    let s = v4.to_string();
                    if addrs.iter().any(|a| a.ip == s) {
                        continue; // 去重
                    }
                    let url = format!("http://{s}:{port}");
                    // 二维码编码 url?k=PIN，手机扫码打开即自动登录
                    let qr = make_qr_svg(&format!("{url}/?k={pin}"));
                    addrs.push(RemoteAddr {
                        kind: kind.to_string(),
                        url,
                        ip: s,
                        qr,
                    });
                }
            }
        }
    }
    // 局域网优先
    addrs.sort_by_key(|a| if a.kind == "局域网" { 0 } else { 1 });

    RemoteInfo { addrs, port, pin }
}

/// 关闭「手机远程」面板时调用：真正停掉服务（清空 PIN、踢掉所有已连接的手机、
/// 停止监听），而不是只隐藏桌面 UI。下次打开面板会重新生成新 PIN 并按需监听。
#[tauri::command]
fn terminal_remote_stop(state: State<TerminalState>) {
    state.hub.stop();
    crate::log_info!("手机远程服务已停止");
}

/// Codex 限流用量（ChatGPT 套餐窗口）：走本机 `codex app-server` 的
/// `account/rateLimits/read`，带 60s 缓存。async + spawn_blocking，避免冻 UI。
#[tauri::command]
async fn codex_usage() -> Result<usage::CodexUsage, String> {
    tauri::async_runtime::spawn_blocking(usage::fetch_codex_usage)
        .await
        .map_err(|e| e.to_string())
}

/// 探测本机 PATH 上已安装的登记 CLI。走登录壳，才能看到 nvm / Homebrew。
#[tauri::command]
async fn list_installed_clis(names: Vec<String>) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || cli_detect::list_installed_cli_names(&names))
        .await
        .unwrap_or_default()
}

/// `.sh` 快捷命令依赖 Bash；仅探测可用性，不执行用户脚本。
#[tauri::command]
async fn has_bash() -> bool {
    tauri::async_runtime::spawn_blocking(|| {
        std::process::Command::new("bash")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

/// 用系统默认浏览器打开一个 URL（如引导去 nodejs.org 装 Node）。
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    opener::open(&url).map_err(|e| e.to_string())
}

/// 打开日志文件（排查问题用）。文件不存在则先建空文件再打开。
#[tauri::command]
fn open_log() -> Result<(), String> {
    let path = applog::log_path();
    if !path.exists() {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).ok();
        }
        std::fs::write(&path, b"").map_err(|e| e.to_string())?;
    }
    opener::open(&path).map_err(|e| e.to_string())
}

/// 供前端写日志（未捕获异常 / 关键 catch 转发到同一份 app.log）。
#[tauri::command]
fn app_log(level: String, msg: String) {
    match level.as_str() {
        "error" => applog::error(&format!("[前端] {msg}")),
        "warn" => applog::warn(&format!("[前端] {msg}")),
        _ => applog::info(&format!("[前端] {msg}")),
    }
}

/// OAuth 限流用量（Claude 专属，同 /usage 数据源）：5h/7d 使用百分比 + 重置时间，带 60s 缓存。
#[tauri::command]
async fn oauth_usage() -> Result<usage::OAuthUsage, String> {
    tauri::async_runtime::spawn_blocking(usage::fetch_oauth_usage)
        .await
        .map_err(|e| e.to_string())
}

/// 刷新菜单栏托盘标题为「5h X% · 周 Y%」（OAuth 限流用量，走 60s 缓存）。
fn update_tray_usage(app: &AppHandle) {
    let u = usage::fetch_oauth_usage();
    let title = if u.ok {
        let base = format!(
            "5h {}% · 周 {}%",
            u.five_hour.utilization.round() as i64,
            u.seven_day.utilization.round() as i64
        );
        // 过期回退（实时刷新失败）：加感叹号提示，别把旧值伪装成现值
        if u.stale {
            format!("⚠ {base}")
        } else {
            base
        }
    } else {
        "用量 —".to_string()
    };
    if let Some(tray) = app.tray_by_id("usage-tray") {
        let _ = tray.set_title(Some(&title));
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn app_exit_is_confirmed(app: &AppHandle) -> bool {
    let state = app.state::<EditorExitGuard>();
    state.allow_exit.load(Ordering::SeqCst)
}

fn request_app_quit_confirmation(app: &AppHandle) {
    show_main_window(app);
    let _ = app.emit("app-quit-requested", ());
}

const COMPANION_WEBVIEW_LABEL: &str = "companion-webview";

/// The companion WebView may follow normal HTTPS redirects, but it must never
/// navigate its top-level document to file/data/javascript or public HTTP URLs.
/// Other application WebViews keep their existing navigation behavior.
fn companion_navigation_policy<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::<R>::new("companion_navigation_policy")
        .on_navigation(|webview, url| {
            if webview.label() != COMPANION_WEBVIEW_LABEL {
                return true;
            }

            if !url.username().is_empty() || url.password().is_some() {
                return false;
            }
            if url.scheme() == "https" {
                return true;
            }
            if url.scheme() != "http" {
                return false;
            }
            matches!(
                url.host_str().map(|host| host.trim_end_matches('.')),
                Some("localhost" | "127.0.0.1" | "::1" | "[::1]")
            )
        })
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    log_info!(
        "===== 应用启动 v{} ({}) =====",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS
    );
    let active_data_dir = initialize_data_dir();
    let _ = ACTIVE_DATA_DIR.set(active_data_dir.clone());
    let state = Mutex::new(AppState::new(&active_data_dir));
    let term_state = TerminalState::default();
    let activity_for_monitor = term_state.activity.clone();

    tauri::Builder::default()
        .plugin(companion_navigation_policy())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(state)
        .manage(term_state)
        .manage(TermThemeLock(Mutex::new(())))
        .manage(proxy_settings::ProxySettingsLock(Mutex::new(())))
        .manage(EditorExitGuard::default())
        .setup(move |app| {
            // macOS WKWebView 会吞掉 ESC；本地 NSEvent 监听把裸 ESC 转成 native-esc。
            native_esc::install_native_esc_monitor(app.handle().clone());
            // 会话状态感知：监控线程扫描"活跃后静默"的终端，emit terminal-attention
            let mon_app = app.handle().clone();
            std::thread::spawn(move || monitor_attention(mon_app, activity_for_monitor));
            // 版本号显示在原生标题栏（来自 Cargo.toml，单一来源）
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_title(&format!(
                    "Roster v{}",
                    env!("CARGO_PKG_VERSION")
                ));
            }
            // 菜单栏托盘：常驻显示 5h / 周限流用量，菜单可打开主窗/刷新/退出
            let show_i = MenuItem::with_id(
                app,
                "tray_show",
                "打开 Roster",
                true,
                None::<&str>,
            )?;
            let refresh_i = MenuItem::with_id(app, "tray_refresh", "刷新用量", true, None::<&str>)?;
            let log_i = MenuItem::with_id(app, "tray_log", "打开日志", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "tray_quit", "退出", true, None::<&str>)?;
            let tray_menu = Menu::with_items(
                app,
                &[
                    &show_i as &dyn tauri::menu::IsMenuItem<_>,
                    &refresh_i,
                    &log_i,
                    &quit_i,
                ],
            )?;
            let mut tray_builder = TrayIconBuilder::with_id("usage-tray")
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .title("用量…")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "tray_show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                    "tray_refresh" => update_tray_usage(app),
                    "tray_log" => {
                        if let Err(e) = open_log() {
                            log_warn!("打开日志失败：{e}");
                        }
                    }
                    "tray_quit" => {
                        request_app_quit_confirmation(app);
                    }
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon().cloned() {
                tray_builder = tray_builder.icon(icon);
            }
            tray_builder.build(app)?;
            // 后台每 60s 刷新托盘标题（首次会触发钥匙串授权）
            let tray_app = app.handle().clone();
            std::thread::spawn(move || loop {
                update_tray_usage(&tray_app);
                std::thread::sleep(std::time::Duration::from_secs(60));
            });
            // 手机端服务不在启动时常驻：PIN 随机化 + 端口监听都推迟到用户首次打开
            // 「手机远程」面板（terminal_remote_info → ensure_remote_started）。
            // 不用该功能就永远不对外暴露端口。
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_projects,
            add_project,
            update_project,
            delete_project,
            rename_group,
            export_excel,
            open_folder,
            open_folder_dialog,
            open_terminal,
            get_servers,
            add_server,
            update_server,
            delete_server,
            scan_directory,
            open_pick_directory,
            list_dir,
            read_file,
            write_file,
            confirm_app_exit,
            confirm_window_close,
            read_image,
            read_binary_base64,
            trash_path,
            terminal_create,
            terminal_write,
            terminal_resize,
            terminal_close,
            terminal_remote_info,
            terminal_remote_stop,
            notify,
            git_status_batch,
            git_branch,
            project_context,
            ensure_project_memory,
            detach_project_memory,
            list_project_sessions,
            preview_project_session,
            delete_project_session,
            ensure_orchestra,
            write_orchestra_file,
            read_orchestra_file,
            get_proxy_settings,
            save_proxy_settings,
            get_proxy_shell_hook,
            context_usage,
            get_snippets,
            save_snippets,
            get_term_themes,
            save_term_themes,
            pick_theme_image,
            load_theme_image,
            get_requirements,
            save_requirements,
            oauth_usage,
            codex_usage,
            list_installed_clis,
            has_bash,
            open_url,
            open_log,
            app_log
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if !app_exit_is_confirmed(app) {
                    api.prevent_exit();
                    request_app_quit_confirmation(app);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_legacy_migration_copies_all_data_before_marking_complete() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("old");
        let new = root.path().join("new");
        fs::create_dir_all(old.join("theme-images/nested")).unwrap();
        fs::create_dir_all(old.join("logs")).unwrap();
        fs::write(old.join("projects.json"), b"[1]").unwrap();
        fs::write(old.join("oauth-usage-cache-test.json"), b"{}").unwrap();
        fs::write(old.join("theme-images/nested/bg.png"), b"image").unwrap();
        fs::write(old.join("logs/app.log"), b"log").unwrap();

        migrate_legacy_data_between(&old, &new).unwrap();

        assert_eq!(fs::read(new.join("projects.json")).unwrap(), b"[1]");
        assert_eq!(fs::read(new.join("oauth-usage-cache-test.json")).unwrap(), b"{}");
        assert_eq!(
            fs::read(new.join("theme-images/nested/bg.png")).unwrap(),
            b"image"
        );
        assert_eq!(fs::read(new.join("logs/app.log")).unwrap(), b"log");
        assert!(new.join(".migrated-from-legacy").is_file());
        assert!(old.join("projects.json").is_file());
    }

    #[test]
    fn test_data_dir_names_use_roster_and_keep_vibe_as_legacy() {
        assert!(preferred_data_dir().ends_with(".roster"));
        assert!(previous_hidden_data_dir().ends_with(".vibe-coding-manage"));
        assert!(backup_root_dir().ends_with("roster-backups"));
    }

    #[test]
    fn test_legacy_migration_failure_never_writes_marker() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("old");
        let new = root.path().join("new");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("projects.json"), b"[]").unwrap();
        fs::write(&new, b"not-a-directory").unwrap();

        assert!(migrate_legacy_data_between(&old, &new).is_err());
        assert!(!new.join(".migrated-from-legacy").exists());
    }

    #[test]
    fn test_terminal_cwd_allows_default_and_existing_directory() {
        let dir = tempfile::tempdir().unwrap();
        assert!(validate_terminal_cwd("").is_ok());
        assert!(validate_terminal_cwd(dir.path().to_str().unwrap()).is_ok());
    }

    #[test]
    fn test_terminal_cwd_rejects_missing_directory_and_regular_file() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");
        let file = dir.path().join("file.txt");
        std::fs::write(&file, b"not a directory").unwrap();

        assert!(validate_terminal_cwd(missing.to_str().unwrap()).is_err());
        assert!(validate_terminal_cwd(file.to_str().unwrap()).is_err());
    }

    #[test]
    fn test_terminal_id_rejects_invalid_and_reused_values() {
        assert!(validate_terminal_id("").is_err());
        assert!(validate_terminal_id("../../escape").is_err());
        assert!(validate_terminal_id("term-valid_1").is_ok());

        let used = Arc::new(Mutex::new(HashSet::new()));
        let reservation = TerminalIdReservation::reserve(used.clone(), "term-1").unwrap();
        assert!(TerminalIdReservation::reserve(used.clone(), "term-1").is_err());
        drop(reservation);
        let reservation = TerminalIdReservation::reserve(used.clone(), "term-1").unwrap();
        reservation.commit();
        assert!(TerminalIdReservation::reserve(used, "term-1").is_err());
    }

    #[test]
    fn test_binary_reads_enforce_limit_on_open_handle() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.bin");
        let file = fs::File::create(&path).unwrap();
        file.set_len(9).unwrap();
        assert!(read_binary_file_bounded(&path, 8, "too large").is_err());
        file.set_len(8).unwrap();
        assert_eq!(read_binary_file_bounded(&path, 8, "too large").unwrap().len(), 8);
    }

    #[test]
    fn test_project_serde_roundtrip() {
        let p = Project {
            id: "test-id".into(),
            name: "测试项目".into(),
            local_path: "/Users/test/project".into(),
            remote_url: "https://github.com/test/repo".into(),
            description: "desc".into(),
            machine: "local".into(),
            server_id: String::new(),
            group: "前端".into(),
            created_at: "2025-01-01 00:00:00".into(),
            updated_at: "2025-01-01 00:00:00".into(),
        };
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("localPath"), "JSON should use camelCase: {}", json);
        assert!(json.contains("remoteUrl"), "JSON should use camelCase: {}", json);
        assert!(json.contains("createdAt"), "JSON should use camelCase: {}", json);

        // 验证能从 camelCase JSON 反序列化
        let p2: Project = serde_json::from_str(&json).unwrap();
        assert_eq!(p2.name, "测试项目");
        assert_eq!(p2.local_path, "/Users/test/project");

        // 验证也能从 snake_case JSON 反序列化（兼容旧数据）
        let snake = r#"{"id":"x","name":"t","local_path":"/tmp","remote_url":"","description":"","machine":"local","group":"","created_at":"","updated_at":""}"#;
        let p3: Project = serde_json::from_str(snake).unwrap();
        assert_eq!(p3.local_path, "/tmp");
    }

    #[test]
    fn test_add_and_save() {
        let dir = std::env::temp_dir().join("vibe-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let data_path = dir.join("projects.json");

        let mut state = AppState {
            projects: vec![],
            servers: vec![],
            snippets: vec![],
            requirements: vec![],
            data_path: data_path.clone(),
            server_path: dir.join("servers.json"),
            snippet_path: dir.join("snippets.json"),
            requirement_path: dir.join("requirements.json"),
        };

        let now = "2025-01-01 00:00:00".to_string();
        let project = Project {
            id: Uuid::new_v4().to_string(),
            name: "test".into(),
            local_path: "/tmp".into(),
            remote_url: String::new(),
            description: String::new(),
            machine: "local".into(),
            server_id: String::new(),
            group: String::new(),
            created_at: now.clone(),
            updated_at: now,
        };
        state.projects.push(project);
        state.save_projects_value(&state.projects).unwrap();

        let data = std::fs::read_to_string(&data_path).unwrap();
        let loaded: Vec<Project> = serde_json::from_str(&data).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "test");

        let mut next = state.projects.clone();
        next.push(Project {
            id: Uuid::new_v4().to_string(),
            name: "second".into(),
            local_path: "/tmp".into(),
            remote_url: String::new(),
            description: String::new(),
            machine: "local".into(),
            server_id: String::new(),
            group: String::new(),
            created_at: "2025-01-02 00:00:00".into(),
            updated_at: "2025-01-02 00:00:00".into(),
        });
        state.save_projects_value(&next).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("projects.prev.json")).unwrap(),
            data
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_read_text_file_reports_format_and_editability() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".env.test");
        fs::write(
            &path,
            b"\xEF\xBB\xBFAPI_URL=http://localhost\r\nDEBUG=true\r\n",
        )
        .unwrap();

        let file = read_text_file(&path).unwrap();
        assert_eq!(file.content, "API_URL=http://localhost\r\nDEBUG=true\r\n");
        assert_eq!(file.line_ending, "crlf");
        assert!(file.utf8_bom);
        assert!(file.editable);
        assert!(file.edit_reason.is_none());
        assert!(!file.truncated);
    }

    #[test]
    fn test_write_file_preserves_format_and_rejects_external_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(&path, b"\xEF\xBB\xBFname = \"old\"\r\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o754)).unwrap();
        }

        let saved = write_file(
            path.to_string_lossy().to_string(),
            "name = \"new\"\r\n".to_string(),
            "name = \"old\"\r\n".to_string(),
            true,
        )
        .unwrap();
        assert_eq!(saved.content, "name = \"new\"\r\n");
        assert_eq!(fs::read(&path).unwrap(), b"\xEF\xBB\xBFname = \"new\"\r\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o754
            );
        }

        fs::write(&path, b"\xEF\xBB\xBFname = \"external\"\r\n").unwrap();
        let error = write_file(
            path.to_string_lossy().to_string(),
            "name = \"mine\"\r\n".to_string(),
            "name = \"new\"\r\n".to_string(),
            true,
        )
        .unwrap_err();
        assert!(error.contains("其他程序修改"));
        assert_eq!(
            fs::read(&path).unwrap(),
            b"\xEF\xBB\xBFname = \"external\"\r\n"
        );
    }

    #[test]
    fn test_mixed_line_endings_are_preview_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mixed.txt");
        fs::write(&path, b"one\r\ntwo\nthree\r").unwrap();

        let file = read_text_file(&path).unwrap();
        assert_eq!(file.line_ending, "mixed");
        assert!(!file.editable);
        assert!(file.edit_reason.unwrap().contains("混合换行符"));
    }

    #[test]
    fn test_nul_after_initial_probe_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("binary.dat");
        let mut bytes = vec![b'a'; 9000];
        bytes[8500] = 0;
        fs::write(&path, bytes).unwrap();

        assert!(read_text_file(&path).unwrap_err().contains("二进制"));
    }

    #[test]
    fn test_oversized_file_is_bounded_and_cannot_be_saved() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.log");
        fs::write(&path, vec![b'a'; MAX_TEXT_FILE_SIZE as usize + 1]).unwrap();

        let file = read_text_file(&path).unwrap();
        assert!(file.truncated);
        assert!(!file.editable);
        assert_eq!(file.content.len(), MAX_TEXT_FILE_SIZE as usize);

        let error = write_file(
            path.to_string_lossy().to_string(),
            String::new(),
            file.content,
            false,
        )
        .unwrap_err();
        assert!(error.contains("超过 1MB"));
    }

    #[test]
    fn test_invalid_utf8_is_preview_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.conf");
        fs::write(&path, [0xff, b'a', b'\n']).unwrap();

        let file = read_text_file(&path).unwrap();
        assert!(!file.editable);
        assert!(file.edit_reason.unwrap().contains("不是 UTF-8"));
    }

    #[cfg(unix)]
    #[test]
    fn test_write_file_preserves_extended_attributes() {
        use xattr::FileExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("metadata.txt");
        fs::write(&path, b"old\n").unwrap();
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        #[cfg(target_os = "macos")]
        let attribute = "com.roster.test";
        #[cfg(not(target_os = "macos"))]
        let attribute = "user.roster.test";
        file.set_xattr(attribute, b"kept").unwrap();

        write_file(
            path.to_string_lossy().to_string(),
            "new\n".to_string(),
            "old\n".to_string(),
            false,
        )
        .unwrap();

        let saved = fs::File::open(&path).unwrap();
        assert_eq!(saved.get_xattr(attribute).unwrap(), Some(b"kept".to_vec()));
    }

    #[test]
    fn test_parse_context_window_value() {
        assert_eq!(parse_context_window_value("353000"), Some(353_000));
        assert_eq!(parse_context_window_value("353k"), Some(353_000));
        assert_eq!(parse_context_window_value("1M"), Some(1_000_000));
        assert_eq!(parse_context_window_value("225.8k"), Some(225_800));
        assert_eq!(parse_context_window_value("1,000,000"), Some(1_000_000));
        assert_eq!(parse_context_window_value("0"), None);
        assert_eq!(parse_context_window_value("unknown"), None);
    }

    #[test]
    fn test_context_window_from_settings_json() {
        let string_value = r#"{"env":{"CLAUDE_CODE_MAX_CONTEXT_TOKENS":"353000"}}"#;
        assert_eq!(context_window_from_settings_json(string_value), Some(353_000));

        let number_value = r#"{"env":{"CLAUDE_CODE_MAX_CONTEXT_TOKENS":353000}}"#;
        assert_eq!(context_window_from_settings_json(number_value), Some(353_000));
        assert_eq!(context_window_from_settings_json(r#"{"env":{}}"#), None);
    }

    #[test]
    fn test_detect_context_window_from_terminal_output() {
        assert_eq!(detect_context_window("Opus 4.8 (1M context)"), Some(1_000_000));
        assert_eq!(detect_context_window("model · 200K context"), Some(200_000));
        assert_eq!(detect_context_window("gpt-5.6-sol · 353k context"), Some(353_000));
        assert_eq!(
            detect_context_window("225.8k/353k tokens (64%)"),
            Some(353_000)
        );
        assert_eq!(detect_context_window("30.4k / 353k tokens (9%)"), Some(353_000));
        assert_eq!(
            detect_context_window("\x1b[32m225.8k\x1b[0m/\x1b[36m353k\x1b[0m tokens (64%)"),
            Some(353_000)
        );
        assert_eq!(detect_context_window("ordinary terminal output"), None);
    }

    #[test]
    fn test_custom_context_percentage_rounds_correctly() {
        assert_eq!(context_percent(230_375, 353_000), 65);
        assert_eq!(context_percent(230_375, 1_000_000), 23);
        assert_eq!(context_percent(1, 0), 0);
    }

    /// 验证 base64 对终端原始字节（含转义序列、UTF-8 多字节、控制字符）能无损往返。
    #[test]
    fn test_terminal_base64_roundtrip() {
        let data: &[u8] = b"\x1b[31m\xe4\xbd\xa0\xe5\xa5\xbd\x07\x1b[0m"; // ESC[31m 你好 BEL ESC[0m
        let enc = base64::engine::general_purpose::STANDARD.encode(data);
        let dec = base64::engine::general_purpose::STANDARD.decode(&enc).unwrap();
        assert_eq!(dec, data, "base64 应无损还原原始终端字节");
    }

    /// 验证本机能真正打开 PTY、起一个 shell、写入命令并读回输出（内置终端的核心机制）。
    #[test]
    fn test_pty_spawn_echo() {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty 失败");

        let cmd = CommandBuilder::new("/bin/sh");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn shell 失败");
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("clone reader 失败");
        let mut writer = pair.master.take_writer().expect("take writer 失败");

        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut out = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => out.extend_from_slice(&buf[..n]),
                    Err(_) => break,
                }
            }
            let _ = tx.send(out);
        });

        writer.write_all(b"echo VIBE_TEST_123\n").unwrap();
        writer.flush().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        writer.write_all(b"exit\n").unwrap();
        writer.flush().unwrap();

        let out = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("读取 PTY 输出超时");
        let _ = child.wait();

        let s = String::from_utf8_lossy(&out);
        assert!(
            s.contains("VIBE_TEST_123"),
            "PTY 输出应包含 echo 的内容，实际收到: {:?}",
            s
        );
    }
}
