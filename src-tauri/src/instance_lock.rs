//! Hold an OS file lock for the full app lifetime, before loading or migrating data.
use std::fs::{self, File, OpenOptions};
use std::path::Path;

pub fn acquire(data_dir: &Path) -> Result<File, String> {
    fs::create_dir_all(data_dir).map_err(|e| format!("无法打开应用数据目录：{e}"))?;
    // Never remove this file: replacing its inode would let two processes lock different files.
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(data_dir.join("instance.lock"))
        .map_err(|e| format!("无法打开应用实例锁：{e}"))?;
    file.try_lock().map_err(|error| match error {
        std::fs::TryLockError::WouldBlock => {
            "Roster 已在运行，请使用已打开的窗口。切换版本前请先退出原版本。".to_string()
        }
        std::fs::TryLockError::Error(e) => format!("无法锁定应用数据目录：{e}"),
    })?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_one_owner_can_load_shared_data_and_exit_releases_lock() {
        const CHILD_DIR: &str = "ROSTER_INSTANCE_LOCK_TEST_DIR";
        if let Some(path) = std::env::var_os(CHILD_DIR) {
            assert!(acquire(Path::new(&path)).unwrap_err().contains("已在运行"));
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let first = acquire(dir.path()).unwrap();
        assert!(acquire(dir.path()).unwrap_err().contains("已在运行"));
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "instance_lock::tests::only_one_owner_can_load_shared_data_and_exit_releases_lock",
            ])
            .env(CHILD_DIR, dir.path())
            .output()
            .unwrap();
        assert!(
            child.status.success(),
            "other process must reject shared data access: {}",
            String::from_utf8_lossy(&child.stdout)
        );
        drop(first);
        let second = acquire(dir.path()).unwrap();
        assert!(acquire(dir.path()).is_err());
        drop(second);
        assert!(acquire(dir.path()).is_ok());
    }
}
