//! Moving a folder to the system trash: the Finder's Trash on macOS, the Recycle Bin on Windows,
//! the freedesktop.org home trash elsewhere. An error means the folder was left where it was.

use std::path::Path;

#[cfg(target_os = "macos")]
pub fn trash(path: &Path) -> Result<(), String> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&url, None)
        .map_err(|error| error.localizedDescription().to_string())
}

#[cfg(windows)]
pub fn trash(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE,
        SHFILEOPSTRUCTW,
    };
    // The shell takes neither `\\?\` paths nor forward slashes, and a list ended by two NULs.
    let plain = crate::modules::fs::to_canon(path).replace('/', "\\");
    let mut from: Vec<u16> = std::ffi::OsStr::new(&plain).encode_wide().collect();
    from.extend([0, 0]);
    let mut operation = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: from.as_ptr(),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT) as u16,
        ..Default::default()
    };
    // SAFETY: `operation` and the NUL-terminated list it points to outlive the call.
    let result = unsafe { SHFileOperationW(&mut operation) };
    if result != 0 || operation.fAnyOperationsAborted != 0 || path.exists() {
        return Err(format!("the Recycle Bin refused it (code {result})"));
    }
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn trash(path: &Path) -> Result<(), String> {
    let data_home = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .or_else(|| dirs::home_dir().map(|home| home.join(".local/share")))
        .ok_or("no home folder")?;
    freedesktop::trash_into(&data_home.join("Trash"), path, &freedesktop::local_now())
}

#[cfg(all(unix, not(target_os = "macos")))]
mod freedesktop {
    use std::io::Write;
    use std::path::Path;

    /// `YYYY-MM-DDThh:mm:ss` in local time, as the specification's `DeletionDate` wants.
    pub fn local_now() -> String {
        // SAFETY: `localtime_r` writes only into `tm`, which outlives the call.
        unsafe {
            let now = libc::time(std::ptr::null_mut());
            let mut tm: libc::tm = std::mem::zeroed();
            if libc::localtime_r(&now, &mut tm).is_null() {
                return "1970-01-01T00:00:00".to_owned();
            }
            format!(
                "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
                tm.tm_year + 1900,
                tm.tm_mon + 1,
                tm.tm_mday,
                tm.tm_hour,
                tm.tm_min,
                tm.tm_sec
            )
        }
    }

    pub fn escape(path: &str) -> String {
        let mut out = String::with_capacity(path.len());
        for byte in path.bytes() {
            if byte.is_ascii_alphanumeric() || b"/-_.~".contains(&byte) {
                out.push(byte as char);
            } else {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
        out
    }

    /// The home trash of the freedesktop.org specification: an info file reserves a free name,
    /// then the entry is renamed into `files`. A rename across volumes fails and changes nothing.
    pub fn trash_into(trash: &Path, path: &Path, deleted_at: &str) -> Result<(), String> {
        let files = trash.join("files");
        let info = trash.join("info");
        for dir in [&files, &info] {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
        let name = path
            .file_name()
            .ok_or("nothing to trash")?
            .to_string_lossy()
            .into_owned();
        let absolute = std::path::absolute(path).map_err(|e| e.to_string())?;
        for attempt in 1..1000 {
            let candidate = if attempt == 1 {
                name.clone()
            } else {
                format!("{name}.{attempt}")
            };
            let info_file = info.join(format!("{candidate}.trashinfo"));
            let mut reserved = match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&info_file)
            {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.to_string()),
            };
            if std::fs::symlink_metadata(files.join(&candidate)).is_ok() {
                let _ = std::fs::remove_file(&info_file);
                continue;
            }
            let written = write!(
                reserved,
                "[Trash Info]\nPath={}\nDeletionDate={deleted_at}\n",
                escape(&absolute.to_string_lossy())
            );
            if let Err(error) = written.and_then(|_| std::fs::rename(path, files.join(&candidate)))
            {
                let _ = std::fs::remove_file(&info_file);
                return Err(error.to_string());
            }
            return Ok(());
        }
        Err("the trash has no free name".to_owned())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn moves_into_the_trash_with_an_info_file() {
            let dir = tempfile::tempdir().unwrap();
            let trash = dir.path().join("Trash");
            for _ in 0..2 {
                let skill = dir.path().join("my skill");
                std::fs::create_dir_all(skill.join("scripts")).unwrap();
                std::fs::write(skill.join("SKILL.md"), "x").unwrap();
                trash_into(&trash, &skill, "2026-10-23T10:00:00").unwrap();
                assert!(!skill.exists());
            }
            assert!(trash.join("files/my skill/SKILL.md").is_file());
            assert!(trash.join("files/my skill.2/SKILL.md").is_file());
            let info = std::fs::read_to_string(trash.join("info/my skill.trashinfo")).unwrap();
            let expected = format!(
                "[Trash Info]\nPath={}/my%20skill\nDeletionDate=2026-10-23T10:00:00\n",
                escape(&dir.path().to_string_lossy())
            );
            assert_eq!(info, expected);
            assert!(trash.join("info/my skill.2.trashinfo").is_file());
        }

        #[test]
        fn a_failed_move_leaves_no_info_file() {
            let dir = tempfile::tempdir().unwrap();
            let trash = dir.path().join("Trash");
            assert!(trash_into(&trash, &dir.path().join("missing"), "x").is_err());
            assert_eq!(std::fs::read_dir(trash.join("info")).unwrap().count(), 0);
        }

        #[test]
        fn escapes_paths_as_urls() {
            assert_eq!(escape("/a b/é%"), "/a%20b/%C3%A9%25");
            assert!(local_now().len() == 19);
        }
    }
}
