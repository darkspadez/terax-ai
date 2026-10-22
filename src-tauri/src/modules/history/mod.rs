mod index;
mod parse;

use index::HistoryIndex;
use parse::{demetafy, parse_bash, parse_fish, parse_zsh};
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Default)]
struct Inner {
    index: Mutex<Option<HistoryIndex>>,
    /// Flips once the (slow) first build has finished; later calls are cheap
    /// enough to answer without leaving the async worker.
    ready: AtomicBool,
    /// PATH executables, scanned only when command-name completion asks.
    path_cmds: OnceLock<Vec<String>>,
}

#[derive(Default, Clone)]
pub struct HistoryState(Arc<Inner>);

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn read_histories() -> Vec<(String, i64)> {
    let mut all = Vec::new();
    let home = dirs::home_dir();

    let dotdir = zsh_dotdir();
    if let Some(path) = zsh_histfile(std::env::var_os("HISTFILE"), dotdir.as_ref(), home.as_ref()) {
        if let Ok(bytes) = std::fs::read(&path) {
            let content = String::from_utf8_lossy(&demetafy(&bytes)).into_owned();
            all.extend(parse_zsh(&content));
        }
    }
    if let Some(home) = home.as_ref() {
        if let Ok(content) = std::fs::read_to_string(home.join(".bash_history")) {
            all.extend(parse_bash(&content));
        }
    }
    if let Some(path) = fish_histfile(std::env::var_os("XDG_DATA_HOME"), home.as_ref()) {
        if let Ok(content) = std::fs::read_to_string(&path) {
            all.extend(parse_fish(&content));
        }
    }
    all
}

/// `$HISTFILE` when it exists, then `.zsh_history` in zsh's dot directory
/// (where macOS's /etc/zshrc and most configs that set a `ZDOTDIR` keep it),
/// then in home.
fn zsh_histfile(
    histfile: Option<OsString>,
    dotdir: Option<&PathBuf>,
    home: Option<&PathBuf>,
) -> Option<PathBuf> {
    if let Some(p) = histfile {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    if let Some(pb) = dotdir.map(|d| d.join(".zsh_history")) {
        if pb.exists() {
            return Some(pb);
        }
    }
    home.map(|h| h.join(".zsh_history"))
}

#[cfg(unix)]
const ZDOTDIR_MARKER: &str = "__TERAX_ZDOTDIR_3c9e__";

/// zsh's `ZDOTDIR`: Terax's own, or the one the user's `.zshenv` sets (often
/// `~/.config/zsh`), which a GUI app's environment lacks. zsh reads
/// `.zshenv` for every shell, so a non-interactive one answers quickly.
#[cfg(unix)]
fn zsh_dotdir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("ZDOTDIR").filter(|d| !d.is_empty()) {
        return Some(dir.into());
    }
    let shell = PathBuf::from(std::env::var_os("SHELL")?);
    if shell.file_name()? != "zsh" {
        return None;
    }
    read_zsh_dotdir(zsh_dotdir_query(&shell))
}

#[cfg(not(unix))]
fn zsh_dotdir() -> Option<PathBuf> {
    None
}

#[cfg(unix)]
fn zsh_dotdir_query(zsh: &std::path::Path) -> std::process::Command {
    use std::process::{Command, Stdio};
    let mut cmd = Command::new(zsh);
    cmd.arg("-c")
        .arg(format!("print -rn -- \"{ZDOTDIR_MARKER}$ZDOTDIR\""))
        .env("TERAX_RESOLVING_ENVIRONMENT", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

/// Runs the query; `.zshenv` may print before the marker.
#[cfg(unix)]
fn read_zsh_dotdir(mut cmd: std::process::Command) -> Option<PathBuf> {
    use crate::modules::proc::capture::{self, Limits};
    let limits = Limits {
        stdout: 64 * 1024,
        stderr: 4 * 1024,
        stop_on_stdout_cap: true,
    };
    let out = capture::run(&mut cmd, std::time::Duration::from_secs(5), limits).ok()?;
    if out.timed_out || out.exit_code != Some(0) {
        return None;
    }
    let text = String::from_utf8(out.stdout).ok()?;
    let (_, dir) = text.rsplit_once(ZDOTDIR_MARKER)?;
    (!dir.is_empty()).then(|| PathBuf::from(dir))
}

fn fish_histfile(xdg_data_home: Option<OsString>, home: Option<&PathBuf>) -> Option<PathBuf> {
    if let Some(data) = xdg_data_home {
        let pb = PathBuf::from(data).join("fish/fish_history");
        if pb.exists() {
            return Some(pb);
        }
    }
    home.map(|h| h.join(".local/share/fish/fish_history"))
}

fn scan_path() -> Vec<String> {
    use std::collections::HashSet;
    let mut set: HashSet<String> = HashSet::new();
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let Ok(rd) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in rd.flatten() {
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                if is_executable(&entry) {
                    if let Some(name) = entry.file_name().to_str() {
                        set.insert(name.to_string());
                    }
                }
            }
        }
    }
    let mut v: Vec<String> = set.into_iter().collect();
    v.sort();
    v
}

#[cfg(unix)]
fn is_executable(entry: &std::fs::DirEntry) -> bool {
    use std::os::unix::fs::PermissionsExt;
    entry
        .metadata()
        .map(|m| m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(windows)]
fn is_executable(entry: &std::fs::DirEntry) -> bool {
    entry
        .file_name()
        .to_str()
        .is_some_and(has_launcher_extension)
}

#[cfg(any(windows, test))]
fn has_launcher_extension(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".exe", ".cmd", ".bat", ".com", ".ps1"]
        .iter()
        .any(|e| lower.ends_with(e))
}

impl HistoryState {
    fn with_index<T>(&self, f: impl FnOnce(&mut HistoryIndex) -> T) -> T {
        let mut guard = self.0.index.lock().unwrap_or_else(|e| e.into_inner());
        let index = guard.get_or_insert_with(|| HistoryIndex::build(read_histories()));
        self.0.ready.store(true, Ordering::Release);
        f(index)
    }

    fn path_commands(&self) -> &[String] {
        self.0.path_cmds.get_or_init(scan_path)
    }

    /// Whether a query can be answered without a slow first-time build.
    fn is_warm(&self, needs_path: bool) -> bool {
        self.0.ready.load(Ordering::Acquire) && (!needs_path || self.0.path_cmds.get().is_some())
    }
}

/// The first call parses every history file; once warm, queries are
/// microseconds and run inline instead of paying for a pool hop per keystroke.
async fn run<T, F>(state: &HistoryState, needs_path: bool, work: F) -> Option<T>
where
    T: Send + 'static,
    F: FnOnce(&HistoryState) -> T + Send + 'static,
{
    if state.is_warm(needs_path) {
        return Some(work(state));
    }
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || work(&state))
        .await
        .ok()
}

#[tauri::command]
pub async fn history_suggest(
    state: tauri::State<'_, HistoryState>,
    line: String,
) -> Result<Option<String>, String> {
    Ok(run(state.inner(), false, move |s| {
        s.with_index(|i| i.suggest(&line))
    })
    .await
    .flatten())
}

#[tauri::command]
pub async fn history_commands(
    state: tauri::State<'_, HistoryState>,
    prefix: String,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    Ok(run(state.inner(), true, move |s| {
        // Warm the index first so the PATH scan is the only cold cost left.
        s.with_index(|_| ());
        let path = s.path_commands();
        s.with_index(|i| i.complete_commands(path, &prefix, limit.unwrap_or(50)))
    })
    .await
    .unwrap_or_default())
}

#[tauri::command]
pub async fn history_list(
    state: tauri::State<'_, HistoryState>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    Ok(run(state.inner(), false, move |s| {
        s.with_index(|i| i.list(&query, limit.unwrap_or(200)))
    })
    .await
    .unwrap_or_default())
}

// Called on every accepted command so in-memory history stays hot without a
// re-read. Only ever fed prompt-mode commands, never raw running-mode input,
// so passwords typed into a running command never enter history.
#[tauri::command]
pub async fn history_record(
    state: tauri::State<'_, HistoryState>,
    command: String,
) -> Result<(), String> {
    run(state.inner(), false, move |s| {
        s.with_index(|i| i.record(&command, now()))
    })
    .await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_cold_builds_leave_the_async_worker() {
        let state = HistoryState::default();
        assert!(!state.is_warm(false), "nothing parsed yet");
        state.0.ready.store(true, Ordering::Release);
        assert!(state.is_warm(false));
        assert!(
            !state.is_warm(true),
            "command-name completion also needs the PATH scan"
        );
        state.0.path_cmds.set(Vec::new()).unwrap();
        assert!(state.is_warm(true));
    }

    #[test]
    fn zsh_histfile_prefers_an_existing_histfile() {
        let tmp = tempfile::tempdir().unwrap();
        let custom = tmp.path().join("custom_zhistory");
        std::fs::write(&custom, b"").unwrap();
        let home = tmp.path().join("home");

        let got = zsh_histfile(Some(custom.clone().into()), None, Some(&home));

        assert_eq!(got, Some(custom));
    }

    #[test]
    fn zsh_histfile_looks_in_the_dot_directory_before_home() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let dotdir = home.join(".config/zsh");
        std::fs::create_dir_all(&dotdir).unwrap();

        assert_eq!(
            zsh_histfile(None, Some(&dotdir), Some(&home)),
            Some(home.join(".zsh_history")),
            "no history in the dot directory"
        );
        std::fs::write(dotdir.join(".zsh_history"), b"").unwrap();
        assert_eq!(
            zsh_histfile(None, Some(&dotdir), Some(&home)),
            Some(dotdir.join(".zsh_history"))
        );
    }

    #[test]
    fn zsh_histfile_falls_back_to_home_when_histfile_is_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");

        let missing = Some(tmp.path().join("missing").into());
        assert_eq!(
            zsh_histfile(missing, None, Some(&home)),
            Some(home.join(".zsh_history"))
        );
        assert_eq!(
            zsh_histfile(None, None, Some(&home)),
            Some(home.join(".zsh_history"))
        );
        assert_eq!(zsh_histfile(None, None, None), None);
    }

    #[cfg(unix)]
    fn fake_zsh(dir: &std::path::Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("zsh");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn the_dot_directory_query_reads_past_what_zshenv_prints() {
        let tmp = tempfile::tempdir().unwrap();
        let zsh = fake_zsh(
            tmp.path(),
            &format!("printf 'Welcome\\n'; printf '%s' '{ZDOTDIR_MARKER}/home/me/.config/zsh'"),
        );
        assert_eq!(
            read_zsh_dotdir(zsh_dotdir_query(&zsh)),
            Some(PathBuf::from("/home/me/.config/zsh"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_dot_directory_query_gives_up_without_an_answer() {
        let tmp = tempfile::tempdir().unwrap();
        let unset = fake_zsh(tmp.path(), &format!("printf '%s' '{ZDOTDIR_MARKER}'"));
        assert_eq!(read_zsh_dotdir(zsh_dotdir_query(&unset)), None);
        let failing = fake_zsh(
            tmp.path(),
            &format!("printf '%s' '{ZDOTDIR_MARKER}/x'; exit 1"),
        );
        assert_eq!(read_zsh_dotdir(zsh_dotdir_query(&failing)), None);
        let silent = fake_zsh(tmp.path(), "printf 'banner only'");
        assert_eq!(read_zsh_dotdir(zsh_dotdir_query(&silent)), None);
    }

    #[test]
    fn fish_histfile_prefers_xdg_then_falls_back_to_default_location() {
        let tmp = tempfile::tempdir().unwrap();
        let xdg = tmp.path().join("xdg-data");
        std::fs::create_dir_all(xdg.join("fish")).unwrap();
        let fish_file = xdg.join("fish").join("fish_history");
        std::fs::write(&fish_file, b"").unwrap();
        let home = tmp.path().join("home");
        let default = Some(home.join(".local/share/fish/fish_history"));

        assert_eq!(
            fish_histfile(Some(xdg.into()), Some(&home)),
            Some(fish_file)
        );
        assert_eq!(
            fish_histfile(Some(tmp.path().join("empty-xdg").into()), Some(&home)),
            default
        );
        assert_eq!(fish_histfile(None, Some(&home)), default);
    }

    #[test]
    fn windows_executables_are_matched_by_launcher_extension() {
        for name in [
            "cargo.exe",
            "RUN.CMD",
            "tool.bat",
            "legacy.com",
            "script.ps1",
        ] {
            assert!(has_launcher_extension(name), "{name}");
        }
        for name in ["readme.txt", "noext", "exe", "archive.exe.zip"] {
            assert!(!has_launcher_extension(name), "{name}");
        }
    }
}
