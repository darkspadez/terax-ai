//! Saved terminal scrollback, one file per pane under
//! `<app data>/terminal-scrollback/<key>.vt`, restored into the pane after a
//! restart.
//!
//! The webview owns the format (UTF-8 text with SGR styles) and the keys; this
//! side only stores bytes. Every write goes to a private temporary file in the
//! same directory and is renamed over the old one, so a reader sees the old
//! file or the new one, never a torn mix. Files are not flushed to the drive:
//! a power cut can cost the latest save, and the webview treats a damaged file
//! as no history. One gate serializes saves, loads and the retain sweep, so the
//! sweep never removes a file a save is about to publish.

use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::ipc::{Request, Response};
use tauri::{Manager, State};

use super::ipc_body;

const DIRECTORY: &str = "terminal-scrollback";
const EXTENSION: &str = ".vt";
const KEY_HEADER: &str = "x-terax-scrollback";
/// A larger body is refused; the webview trims history well below this.
const MAX_SCROLLBACK_BYTES: usize = 8 * 1024 * 1024;
/// Far above any real pane count; a longer list is refused, never truncated,
/// because truncating it would delete history that is still referenced.
const MAX_RETAINED_KEYS: usize = 16 * 1024;

#[derive(Default)]
pub struct ScrollbackState {
    gate: Arc<tokio::sync::Mutex<()>>,
}

fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && key
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

fn directory(root: &Path) -> PathBuf {
    root.join(DIRECTORY)
}

fn scrollback_path(root: &Path, key: &str) -> Result<PathBuf, String> {
    if !valid_key(key) {
        return Err("invalid scrollback key".into());
    }
    Ok(directory(root).join(format!("{key}{EXTENSION}")))
}

/// The key a stored file belongs to, or `None` for anything else in the
/// directory (temporary files of an interrupted save, foreign files).
fn key_of(file_name: &str) -> Option<&str> {
    file_name
        .strip_suffix(EXTENSION)
        .filter(|key| valid_key(key))
}

fn create_directory(path: &Path) -> std::io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

fn remove_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// Replaces the pane's file; an empty body deletes it.
fn save(root: &Path, key: &str, bytes: &[u8]) -> Result<(), String> {
    let path = scrollback_path(root, key)?;
    if bytes.len() > MAX_SCROLLBACK_BYTES {
        return Err(format!(
            "scrollback exceeds {} MiB",
            MAX_SCROLLBACK_BYTES / (1024 * 1024)
        ));
    }
    if bytes.is_empty() {
        return remove_if_present(&path);
    }
    std::str::from_utf8(bytes).map_err(|_| "scrollback must be UTF-8 text")?;
    let parent = path.parent().ok_or("missing scrollback directory")?;
    create_directory(parent).map_err(|e| e.to_string())?;
    // tempfile creates the file with mode 0600 on Unix, and the rename keeps it.
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temporary.write_all(bytes).map_err(|e| e.to_string())?;
    temporary.persist(&path).map_err(|e| e.error.to_string())?;
    Ok(())
}

#[cfg(unix)]
fn open_regular(path: &Path) -> std::io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
}

#[cfg(not(unix))]
fn open_regular(path: &Path) -> std::io::Result<fs::File> {
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(std::io::Error::other("scrollback file is a link"));
    }
    fs::File::open(path)
}

/// The stored bytes, empty when the pane has none. A link or a directory in
/// the file's place reads as no history; it is never followed.
fn load(root: &Path, key: &str) -> Result<Vec<u8>, String> {
    let path = scrollback_path(root, key)?;
    let file = match open_regular(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            log::warn!("scrollback {key} is unreadable: {error}");
            return Ok(Vec::new());
        }
    };
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Ok(Vec::new());
    }
    if metadata.len() > MAX_SCROLLBACK_BYTES as u64 {
        return Err("scrollback is too large to restore".into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_SCROLLBACK_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_SCROLLBACK_BYTES {
        return Err("scrollback is too large to restore".into());
    }
    Ok(bytes)
}

/// Deletes every file whose key is not listed, including temporary files left
/// by an interrupted save, and returns how many went. Subdirectories are left
/// alone: nothing here creates them.
fn retain(root: &Path, keys: &[String]) -> Result<usize, String> {
    if keys.len() > MAX_RETAINED_KEYS {
        return Err("too many scrollback keys".into());
    }
    let keep: HashSet<&str> = keys
        .iter()
        .map(String::as_str)
        .filter(|key| valid_key(key))
        .collect();
    let entries = match fs::read_dir(directory(root)) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error.to_string()),
    };
    let mut removed = 0;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let kept = name
            .to_str()
            .and_then(key_of)
            .is_some_and(|key| keep.contains(key));
        if kept {
            continue;
        }
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_dir() {
            continue;
        }
        match fs::remove_file(entry.path()) {
            Ok(()) => removed += 1,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => log::warn!("could not remove stale scrollback {name:?}: {error}"),
        }
    }
    Ok(removed)
}

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// Body: the scrollback as UTF-8 bytes; empty deletes it. Header
/// `x-terax-scrollback`: the pane's key.
#[tauri::command]
pub async fn terminal_scrollback_save(
    app: tauri::AppHandle,
    state: State<'_, ScrollbackState>,
    request: Request<'_>,
) -> Result<(), String> {
    let key = request
        .headers()
        .get(KEY_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|key| valid_key(key))
        .ok_or("missing or invalid scrollback key")?
        .to_owned();
    let bytes = ipc_body::bytes_of(request.body(), MAX_SCROLLBACK_BYTES, MAX_SCROLLBACK_BYTES)?
        .into_owned();
    let root = data_dir(&app)?;
    let guard = state.gate.clone().lock_owned().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        save(&root, &key, &bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The pane's saved scrollback as raw bytes; an empty body means none.
#[tauri::command]
pub async fn terminal_scrollback_load(
    app: tauri::AppHandle,
    state: State<'_, ScrollbackState>,
    key: String,
) -> Result<Response, String> {
    let root = data_dir(&app)?;
    let guard = state.gate.clone().lock_owned().await;
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        load(&root, &key)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Response::new(bytes))
}

/// Keeps the listed panes' files and deletes the rest; returns how many went.
#[tauri::command]
pub async fn terminal_scrollback_retain(
    app: tauri::AppHandle,
    state: State<'_, ScrollbackState>,
    keys: Vec<String>,
) -> Result<usize, String> {
    let root = data_dir(&app)?;
    let guard = state.gate.clone().lock_owned().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        retain(&root, &keys)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(root: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(directory(root))
            .map(|entries| {
                entries
                    .map(|entry| entry.unwrap().file_name().into_string().unwrap())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    #[test]
    fn terminal_scrollback_keys_are_short_plain_identifiers() {
        let longest = "k".repeat(128);
        let too_long = "k".repeat(129);
        for good in ["a", "sb-mh3k2f-1a2b3c", "A_b-9", longest.as_str()] {
            assert!(valid_key(good), "{good}");
        }
        for bad in [
            "",
            too_long.as_str(),
            "..",
            "../x",
            "a/b",
            "a\\b",
            "a.vt",
            "a b",
            "é",
            "a\0",
            "C:x",
        ] {
            assert!(!valid_key(bad), "{bad:?}");
            assert!(scrollback_path(Path::new("/root"), bad).is_err(), "{bad:?}");
        }
        assert_eq!(key_of("abc.vt"), Some("abc"));
        assert_eq!(key_of(".tmpX1y2z3"), None);
        assert_eq!(key_of("abc.vt.tmp"), None);
        assert_eq!(key_of("a.b.vt"), None);
        assert_eq!(key_of(".vt"), None);
    }

    #[test]
    fn terminal_scrollback_saves_atomically_loads_and_deletes() {
        let root = tempfile::tempdir().unwrap();
        assert!(load(root.path(), "one").unwrap().is_empty());
        save(root.path(), "one", "old \x1b[31mred\x1b[0m".as_bytes()).unwrap();
        save(root.path(), "two", b"other").unwrap();
        save(root.path(), "one", "new é".as_bytes()).unwrap();
        assert_eq!(load(root.path(), "one").unwrap(), "new é".as_bytes());
        assert_eq!(load(root.path(), "two").unwrap(), b"other");
        assert_eq!(
            names(root.path()),
            ["one.vt", "two.vt"],
            "no temporary files"
        );

        save(root.path(), "one", b"").unwrap();
        assert!(load(root.path(), "one").unwrap().is_empty());
        save(root.path(), "one", b"").unwrap();
        assert_eq!(names(root.path()), ["two.vt"]);
    }

    #[cfg(unix)]
    #[test]
    fn terminal_scrollback_files_and_directory_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        save(root.path(), "one", b"history").unwrap();
        let mode = |path: PathBuf| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(scrollback_path(root.path(), "one").unwrap()), 0o600);
        assert_eq!(mode(directory(root.path())), 0o700);
    }

    #[test]
    fn terminal_scrollback_refuses_oversized_and_non_utf8_bodies() {
        let root = tempfile::tempdir().unwrap();
        save(root.path(), "one", b"kept").unwrap();
        let limit = vec![b'x'; MAX_SCROLLBACK_BYTES];
        save(root.path(), "two", &limit).unwrap();
        assert_eq!(
            load(root.path(), "two").unwrap().len(),
            MAX_SCROLLBACK_BYTES
        );

        let over = vec![b'x'; MAX_SCROLLBACK_BYTES + 1];
        assert!(save(root.path(), "one", &over).is_err());
        assert!(save(root.path(), "one", &[b'a', 0xff, b'b']).is_err());
        assert!(save(root.path(), "../one", b"x").is_err());
        assert_eq!(
            load(root.path(), "one").unwrap(),
            b"kept",
            "refusals keep the old file"
        );

        fs::write(scrollback_path(root.path(), "big").unwrap(), &over).unwrap();
        assert!(load(root.path(), "big").is_err());
    }

    #[test]
    fn terminal_scrollback_retain_deletes_unlisted_and_stray_files() {
        let root = tempfile::tempdir().unwrap();
        for key in ["keep", "closed", "deleted-space"] {
            save(root.path(), key, key.as_bytes()).unwrap();
        }
        let dir = directory(root.path());
        fs::write(dir.join(".tmpAbC123"), b"interrupted save").unwrap();
        fs::write(dir.join("notes.txt"), b"foreign").unwrap();
        fs::create_dir(dir.join("nested")).unwrap();

        let removed = retain(
            root.path(),
            &["keep".into(), "../escape".into(), "never-saved".into()],
        )
        .unwrap();
        assert_eq!(removed, 4);
        assert_eq!(names(root.path()), ["keep.vt", "nested"]);
        assert_eq!(load(root.path(), "keep").unwrap(), b"keep");

        assert_eq!(retain(root.path(), &[]).unwrap(), 1);
        assert_eq!(names(root.path()), ["nested"]);
    }

    #[test]
    fn terminal_scrollback_retain_without_a_directory_or_with_too_many_keys() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(retain(root.path(), &[]).unwrap(), 0);

        save(root.path(), "keep", b"x").unwrap();
        let flood: Vec<String> = (0..=MAX_RETAINED_KEYS).map(|n| format!("k{n}")).collect();
        assert!(retain(root.path(), &flood).is_err());
        assert_eq!(
            names(root.path()),
            ["keep.vt"],
            "a refused list deletes nothing"
        );
    }

    #[cfg(unix)]
    #[test]
    fn terminal_scrollback_never_follows_a_link() {
        let root = tempfile::tempdir().unwrap();
        let outside = root.path().join("secret.txt");
        fs::write(&outside, b"secret").unwrap();
        create_directory(&directory(root.path())).unwrap();
        let link = scrollback_path(root.path(), "linked").unwrap();
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        assert!(load(root.path(), "linked").unwrap().is_empty());
        save(root.path(), "linked", b"history").unwrap();
        assert_eq!(
            fs::read(&outside).unwrap(),
            b"secret",
            "the target is untouched"
        );
        assert_eq!(load(root.path(), "linked").unwrap(), b"history");

        std::os::unix::fs::symlink(&outside, directory(root.path()).join("other.vt")).unwrap();
        assert_eq!(retain(root.path(), &[]).unwrap(), 2);
        assert_eq!(fs::read(&outside).unwrap(), b"secret");
    }
}
