use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::UNIX_EPOCH;
use std::{fs, io::Write};

use serde::Serialize;
use tauri::{Emitter, Manager};
use tempfile::NamedTempFile;

use super::blocking;
use super::index::FileIndexState;
use super::launch;
use super::mutate::note_changed;
use super::run_prompt;
use crate::modules::project_trust::{self, OwnChange};
use crate::modules::workspace::{resolve_path, Gates, Origin, WorkspaceEnv, WorkspaceRegistry};

const MAX_READ_BYTES: u64 = 10 * 1024 * 1024; // 10 MB
/// Ceiling for explicit "open anyway"; mirrored as FORCE_READ_LIMIT in useDocument.ts.
const FORCE_MAX_READ_BYTES: u64 = 50 * 1024 * 1024;
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ReadResult {
    Text {
        content: String,
        size: u64,
        mtime: u64,
    },
    Binary {
        size: u64,
    },
    /// File exceeds MAX_READ_BYTES. UI decides whether to offer "open anyway".
    TooLarge {
        size: u64,
        limit: u64,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StatKind {
    File,
    Dir,
    Symlink,
}

#[derive(Serialize)]
pub struct FileStat {
    pub size: u64,
    pub mtime: u64,
    pub kind: StatKind,
}

fn mtime_millis(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub async fn fs_read_file(
    app: tauri::AppHandle,
    path: String,
    workspace: Option<WorkspaceEnv>,
    force: Option<bool>,
    origin: Option<Origin>,
) -> Result<ReadResult, String> {
    blocking(move || {
        let workspace = WorkspaceEnv::from_option(workspace);
        let real = app
            .state::<WorkspaceRegistry>()
            .gates(origin.unwrap_or_default())
            .authorized_existing(&resolve_path(&path, &workspace))?;
        read_file_sync(&real, force.unwrap_or(false))
    })
    .await
}

fn read_file_sync(p: &Path, force: bool) -> Result<ReadResult, String> {
    let meta = std::fs::metadata(p).map_err(|e| {
        log::debug!("fs_read_file stat({}) failed: {e}", p.display());
        e.to_string()
    })?;

    let size = meta.len();
    let limit = if force {
        FORCE_MAX_READ_BYTES
    } else {
        MAX_READ_BYTES
    };
    if size > limit {
        return Ok(ReadResult::TooLarge { size, limit });
    }

    let bytes = std::fs::read(p).map_err(|e| {
        log::debug!("fs_read_file read({}) failed: {e}", p.display());
        e.to_string()
    })?;

    // Null-byte sniff on the first chunk. Not perfect (misses UTF-16 BOM
    // cases) but catches the common "this is a PNG" mistake cheaply.
    let sniff_len = bytes.len().min(BINARY_SNIFF_BYTES);
    if bytes[..sniff_len].contains(&0) {
        return Ok(ReadResult::Binary { size });
    }

    match String::from_utf8(bytes) {
        Ok(content) => Ok(ReadResult::Text {
            content,
            size,
            mtime: mtime_millis(&meta),
        }),
        Err(_) => Ok(ReadResult::Binary { size }),
    }
}

#[derive(Serialize, Clone)]
struct FileWrittenEvent {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

/// Atomic write via O_EXCL tempfile in the target's parent, then rename.
/// The random suffix is what blocks pre-staged symlink attacks.
fn write_atomic(target: &Path, content: &[u8]) -> std::io::Result<()> {
    let parent = target.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no parent")
    })?;
    let mut tmp = NamedTempFile::new_in(parent)?;
    tmp.as_file_mut().write_all(content)?;
    tmp.as_file_mut().sync_all()?;
    tmp.persist(target).map_err(|e| e.error)?;
    Ok(())
}

/// Resolves `target` to the path the atomic rename must replace. A symlink is
/// followed to its real file so the link survives the write (dotfile managers
/// rely on it). A dangling link is an error: writing would either replace the
/// link or create a file at a location the user never named.
fn resolve_write_target(target: &Path) -> std::io::Result<PathBuf> {
    match fs::symlink_metadata(target) {
        Ok(m) if m.file_type().is_symlink() => fs::canonicalize(target).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "symlink target does not exist",
                )
            } else {
                e
            }
        }),
        _ => Ok(target.to_path_buf()),
    }
}

/// Atomic write that follows symlinks and keeps the existing file's
/// permissions. Returns the real path written and whether it already existed.
fn write_file_sync(target: &Path, content: &[u8]) -> std::io::Result<(PathBuf, bool)> {
    let real = resolve_write_target(target)?;
    let original = fs::metadata(&real).ok();
    write_atomic(&real, content)?;
    if let Some(perms) = original.as_ref().map(|m| m.permissions()) {
        let _ = fs::set_permissions(&real, perms);
    }
    Ok((real, original.is_some()))
}

/// Returns the new mtime so the editor can track disk state for conflict
/// detection without a follow-up stat.
#[tauri::command]
pub async fn fs_write_file(
    path: String,
    content: String,
    workspace: Option<WorkspaceEnv>,
    source: Option<String>,
    origin: Option<Origin>,
    app: tauri::AppHandle,
    index: tauri::State<'_, FileIndexState>,
) -> Result<u64, String> {
    let index = index.inner().clone();
    let watcher = app.clone();
    let (path, mtime) = blocking(move || {
        let workspace = WorkspaceEnv::from_option(workspace);
        let target = watcher
            .state::<WorkspaceRegistry>()
            .gates(origin.unwrap_or_default())
            .authorized_write_target(&resolve_path(&path, &workspace))?;
        // Oarlock's own write into a project's trusted item keeps the user's trust in it.
        let change = OwnChange::File {
            target: &target,
            content: content.as_bytes(),
        };
        let (real, existed) = project_trust::keeping_trust(&watcher, change, || {
            write_file_sync(&target, content.as_bytes())
        })
        .map_err(|e| {
            log::warn!("fs_write_file({}) failed: {e}", target.display());
            e.to_string()
        })?;

        if !existed {
            note_changed(&index, &real);
        }
        super::watch::note_written(&watcher, &real);
        let mtime = fs::metadata(&real).map(|m| mtime_millis(&m)).unwrap_or(0);
        Ok((path, mtime))
    })
    .await?;
    let _ = app.emit("fs:file-written", FileWrittenEvent { path, source });

    Ok(mtime)
}

#[tauri::command]
pub async fn fs_canonicalize(
    app: tauri::AppHandle,
    path: String,
    workspace: Option<WorkspaceEnv>,
    origin: Option<Origin>,
) -> Result<String, String> {
    blocking(move || {
        let workspace = WorkspaceEnv::from_option(workspace);
        let real = app
            .state::<WorkspaceRegistry>()
            .gates(origin.unwrap_or_default())
            .authorized_existing(&resolve_path(&path, &workspace))?;
        Ok(super::to_canon(&real))
    })
    .await
}

/// The host path a workspace file is read through. The asset protocol (media
/// and Markdown image previews) opens host paths, so a WSL path must become
/// its share or drvfs drive path first; local paths come back unchanged,
/// without touching the disk.
#[tauri::command]
pub async fn fs_host_path(
    app: tauri::AppHandle,
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<String, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    if !workspace.is_wsl() {
        return Ok(path);
    }
    // Mapping a WSL path probes the share, which can stall.
    blocking(move || {
        let host = host_path(&path, &workspace);
        app.state::<WorkspaceRegistry>()
            .gates(Origin::App)
            .authorized_existing(Path::new(&host))?;
        Ok(host)
    })
    .await
}

fn host_path(path: &str, workspace: &WorkspaceEnv) -> String {
    resolve_path(path, workspace).to_string_lossy().into_owned()
}

/// What "Open in Default App" may hand to the OS: an existing file whose real location is
/// within the app's reach (an authorized workspace unless the app may access all folders; a
/// link pointing out of it is refused). A folder goes to the file manager through Reveal instead.
fn default_app_target(gates: Gates<'_>, path: &Path) -> Result<PathBuf, String> {
    let canonical = gates.authorized_existing(path)?;
    if !canonical.is_file() {
        return Err("only files open in their default app".into());
    }
    // Applications get the path in its ordinary spelling, not `\\?\`-prefixed.
    #[cfg(windows)]
    let canonical = PathBuf::from(super::to_canon(&canonical).replace('/', "\\"));
    Ok(canonical)
}

/// What "Open in Default App" does with a request.
#[derive(Debug, PartialEq, Eq)]
enum OpenStep {
    /// Hand this path to the OS.
    Open(PathBuf),
    /// The file would run as a program: the user is asked first, in a native dialog.
    AskFirst(PathBuf),
}

/// Decides on the real path, so a link or an innocent-looking name cannot skip the question.
fn open_step(
    gates: Gates<'_>,
    path: &Path,
    runs_as_program: impl Fn(&Path) -> bool,
) -> Result<OpenStep, String> {
    let target = default_app_target(gates, path)?;
    if runs_as_program(&target) {
        return Ok(OpenStep::AskFirst(target));
    }
    Ok(OpenStep::Open(target))
}

/// The path to hand the OS: a document at once, a program only once `ask` says the user agreed.
async fn consented<F, A>(step: OpenStep, ask: A) -> Option<PathBuf>
where
    A: FnOnce(PathBuf) -> F,
    F: std::future::Future<Output = bool>,
{
    match step {
        OpenStep::Open(target) => Some(target),
        OpenStep::AskFirst(target) => ask(target.clone()).await.then_some(target),
    }
}

/// The question's title and text: the file's name, and that it runs as a program.
fn run_prompt_text(target: &Path) -> (String, String) {
    let name = target.file_name().map_or_else(
        || target.display().to_string(),
        |n| n.to_string_lossy().into_owned(),
    );
    (
        format!("Run \u{201c}{name}\u{201d}?"),
        format!(
            "Opening \u{201c}{name}\u{201d} runs it as a program on your computer. Only run it if you \
             trust where it came from.\n\n{}",
            target.display()
        ),
    )
}

/// Set while a run question is on screen, so a second request does not stack another dialog.
static RUN_PROMPT_OPEN: AtomicBool = AtomicBool::new(false);

struct RunPrompt;

impl RunPrompt {
    fn begin() -> Option<Self> {
        (!RUN_PROMPT_OPEN.swap(true, Ordering::AcqRel)).then_some(Self)
    }
}

impl Drop for RunPrompt {
    fn drop(&mut self) {
        RUN_PROMPT_OPEN.store(false, Ordering::Release);
    }
}

/// Asks in the OS's own dialog, attached to the calling window, whether to run `target`, with
/// Cancel the button Return presses (`run_prompt`). This waits without holding a thread, and
/// nothing in a page can answer it.
async fn ask_to_run(app: &tauri::AppHandle, window: &tauri::Window, target: &Path) -> bool {
    let (title, message) = run_prompt_text(target);
    run_prompt::ask(app, window, title, message).await
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OpenOutcome {
    Opened,
    /// Nothing was opened: the file would run as a program and the user said no.
    Cancelled,
}

/// Opens a file with the application the OS associates with it, as a double-click in the file
/// manager would. A file that would run as a program (`launch::runs_as_program`) opens only
/// after the user agrees in a native dialog the backend shows; the page cannot approve it.
#[tauri::command]
pub async fn fs_open_default(
    app: tauri::AppHandle,
    window: tauri::Window,
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<OpenOutcome, String> {
    let gate = app.clone();
    let step = blocking(move || {
        let workspace = WorkspaceEnv::from_option(workspace);
        open_step(
            gate.state::<WorkspaceRegistry>().gates(Origin::App),
            &resolve_path(&path, &workspace),
            launch::file_runs_as_program,
        )
    })
    .await?;
    let prompt = match &step {
        OpenStep::AskFirst(_) => {
            Some(RunPrompt::begin().ok_or("another program is waiting for an answer to run")?)
        }
        OpenStep::Open(_) => None,
    };
    let (app_ref, window_ref) = (&app, &window);
    let target = consented(step, |target| async move {
        ask_to_run(app_ref, window_ref, &target).await
    })
    .await;
    drop(prompt);
    let Some(target) = target else {
        return Ok(OpenOutcome::Cancelled);
    };
    blocking(move || {
        // Still a file within reach now that the user has answered.
        let target =
            default_app_target(app.state::<WorkspaceRegistry>().gates(Origin::App), &target)?;
        tauri_plugin_opener::open_path(&target, None::<&str>).map_err(|e| {
            log::warn!("fs_open_default({}) failed: {e}", target.display());
            e.to_string()
        })
    })
    .await?;
    Ok(OpenOutcome::Opened)
}

#[tauri::command]
pub async fn fs_stat(
    app: tauri::AppHandle,
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<FileStat, String> {
    blocking(move || {
        let workspace = WorkspaceEnv::from_option(workspace);
        let p = resolve_path(&path, &workspace);
        let real = app
            .state::<WorkspaceRegistry>()
            .gates(Origin::App)
            .authorized_existing(&p)?;
        stat_path(&p, &real)
    })
    .await
}

/// `path` as the page named it (a link reports itself), `real` where it leads.
fn stat_path(p: &Path, real: &Path) -> Result<FileStat, String> {
    let meta = std::fs::metadata(real).map_err(|e| e.to_string())?;
    // fs::metadata follows symlinks, so the link check needs symlink_metadata.
    let kind = if std::fs::symlink_metadata(p)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        StatKind::Symlink
    } else if meta.is_dir() {
        StatKind::Dir
    } else {
        StatKind::File
    };
    Ok(FileStat {
        size: meta.len(),
        mtime: mtime_millis(&meta),
        kind,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_path_keeps_local_paths() {
        assert_eq!(
            host_path("/home/me/pic.png", &WorkspaceEnv::Local),
            "/home/me/pic.png"
        );
    }

    #[cfg(windows)]
    #[test]
    fn host_path_maps_wsl_drvfs_paths_to_the_drive() {
        let workspace = WorkspaceEnv::Wsl {
            distro: "Ubuntu".into(),
        };
        assert_eq!(
            host_path("/mnt/c/Users/me/pic.png", &workspace),
            r"C:\Users\me\pic.png"
        );
    }

    #[test]
    fn only_an_authorized_file_opens_in_its_default_app() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let file = root.join("photo.png");
        std::fs::write(&file, b"png").unwrap();
        let registry = WorkspaceRegistry::default();
        assert!(
            default_app_target(registry.gates(Origin::App), &file).is_err(),
            "nothing is authorized yet"
        );
        registry.authorize(&root).unwrap();
        assert_eq!(
            default_app_target(registry.gates(Origin::App), &file).unwrap(),
            file
        );
        assert!(
            default_app_target(registry.gates(Origin::App), &root).is_err(),
            "a folder"
        );
        assert!(default_app_target(registry.gates(Origin::App), &root.join("missing")).is_err());
    }

    #[test]
    fn a_program_is_asked_about_and_a_document_is_not() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let doc = root.join("report.pdf");
        std::fs::write(&doc, b"%PDF").unwrap();
        let script = root.join("setup.bat");
        std::fs::write(&script, b"@echo off").unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(&root).unwrap();
        let step = |path: &Path| {
            open_step(
                registry.gates(Origin::App),
                path,
                launch::file_runs_as_program,
            )
        };

        assert_eq!(step(&doc), Ok(OpenStep::Open(doc.clone())));
        assert_eq!(step(&script), Ok(OpenStep::AskFirst(script.clone())));
    }

    #[test]
    fn a_program_opens_only_with_the_users_consent() {
        let run = |step, answer: bool| {
            let asked = std::cell::Cell::new(None);
            let target = tauri::async_runtime::block_on(consented(step, |target| {
                asked.set(Some(target));
                std::future::ready(answer)
            }));
            (target, asked.take())
        };
        let script = PathBuf::from("/w/setup.sh");
        assert_eq!(
            run(OpenStep::AskFirst(script.clone()), false),
            (None, Some(script.clone()))
        );
        assert_eq!(
            run(OpenStep::AskFirst(script.clone()), true),
            (Some(script.clone()), Some(script))
        );
        let doc = PathBuf::from("/w/report.pdf");
        assert_eq!(
            run(OpenStep::Open(doc.clone()), false),
            (Some(doc), None),
            "a document opens without a question"
        );
    }

    #[test]
    fn the_question_names_the_file_and_says_it_runs_as_a_program() {
        let (title, message) = run_prompt_text(Path::new("/w/tools/setup.sh"));
        assert_eq!(title, "Run \u{201c}setup.sh\u{201d}?");
        assert!(message.starts_with("Opening \u{201c}setup.sh\u{201d} runs it as a program"));
        assert!(message.ends_with(&Path::new("/w/tools/setup.sh").display().to_string()));
    }

    #[test]
    fn one_run_question_is_on_screen_at_a_time() {
        let first = RunPrompt::begin().expect("no question is open");
        assert!(RunPrompt::begin().is_none(), "a second one would stack");
        drop(first);
        assert!(RunPrompt::begin().is_some(), "answered: the next may ask");
    }

    #[test]
    fn nothing_outside_the_workspace_is_asked_about() {
        let dir = tempfile::tempdir().unwrap();
        let script = std::fs::canonicalize(dir.path()).unwrap().join("setup.bat");
        std::fs::write(&script, b"@echo off").unwrap();
        let registry = WorkspaceRegistry::default();
        assert!(open_step(registry.gates(Origin::App), &script, |_| true).is_err());
        assert!(open_step(registry.gates(Origin::App), &script, |_| false).is_err());
    }

    #[test]
    fn with_access_to_all_folders_a_file_anywhere_opens_and_a_program_still_asks() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let doc = root.join("report.pdf");
        std::fs::write(&doc, b"%PDF").unwrap();
        let script = root.join("setup.bat");
        std::fs::write(&script, b"@echo off").unwrap();
        let registry = WorkspaceRegistry::default();
        registry.set_all_folders(Origin::Ai, true);
        assert!(
            default_app_target(registry.gates(Origin::App), &doc).is_err(),
            "the AI tools' setting does not open the app"
        );

        registry.set_all_folders(Origin::App, true);
        let step = |path: &Path| {
            open_step(
                registry.gates(Origin::App),
                path,
                launch::file_runs_as_program,
            )
        };
        assert_eq!(step(&doc), Ok(OpenStep::Open(doc.clone())));
        assert_eq!(step(&script), Ok(OpenStep::AskFirst(script.clone())));
        assert!(
            default_app_target(registry.gates(Origin::App), &root).is_err(),
            "a folder"
        );

        registry.set_all_folders(Origin::App, false);
        assert!(step(&doc).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_to_a_program_is_judged_by_its_target() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let script = root.join("setup.sh");
        std::fs::write(&script, b"echo hi").unwrap();
        let link = root.join("readme.txt");
        std::os::unix::fs::symlink(&script, &link).unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(&root).unwrap();
        assert_eq!(
            open_step(
                registry.gates(Origin::App),
                &link,
                launch::file_runs_as_program
            ),
            Ok(OpenStep::AskFirst(script))
        );
    }

    #[test]
    fn the_outcome_reaches_the_frontend_as_a_word() {
        assert_eq!(
            serde_json::to_string(&OpenOutcome::Opened).unwrap(),
            r#""opened""#
        );
        assert_eq!(
            serde_json::to_string(&OpenOutcome::Cancelled).unwrap(),
            r#""cancelled""#
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_link_out_of_the_workspace_does_not_open() {
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.txt");
        std::fs::write(&secret, b"x").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let link = root.join("innocent.txt");
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(&root).unwrap();
        assert!(default_app_target(registry.gates(Origin::App), &link).is_err());
    }

    #[test]
    fn write_new_file_creates_it() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("new.txt");
        let (real, existed) = write_file_sync(&f, b"hi").unwrap();
        assert!(!existed);
        assert_eq!(real, f);
        assert_eq!(std::fs::read(&f).unwrap(), b"hi");
    }

    #[test]
    fn write_plain_file_replaces_content() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.txt");
        std::fs::write(&f, b"old").unwrap();
        let (real, existed) = write_file_sync(&f, b"new").unwrap();
        assert!(existed);
        assert_eq!(real, f);
        assert_eq!(std::fs::read(&f).unwrap(), b"new");
    }

    #[cfg(unix)]
    #[test]
    fn write_through_symlink_keeps_link_and_updates_target() {
        let dir = tempfile::tempdir().unwrap();
        let real_dir = dir.path().join("dotfiles");
        std::fs::create_dir(&real_dir).unwrap();
        let real = real_dir.join("zshrc");
        std::fs::write(&real, b"old").unwrap();
        let link = dir.path().join("zshrc");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let (written, existed) = write_file_sync(&link, b"new").unwrap();
        assert!(existed);
        assert_eq!(written, std::fs::canonicalize(&real).unwrap());
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_link(&link).unwrap(), real);
        assert_eq!(std::fs::read(&real).unwrap(), b"new");
    }

    #[cfg(unix)]
    #[test]
    fn write_through_symlink_preserves_target_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.sh");
        std::fs::write(&real, b"old").unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o750)).unwrap();
        let link = dir.path().join("link.sh");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        write_file_sync(&link, b"new").unwrap();
        let mode = std::fs::metadata(&real).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o750);
    }

    #[cfg(unix)]
    #[test]
    fn write_through_relative_symlink_chain_keeps_every_link() {
        use std::os::unix::fs::symlink;
        use std::path::Path;
        let dir = tempfile::tempdir().unwrap();
        let dotfiles = dir.path().join("dotfiles");
        let links = dir.path().join("links");
        std::fs::create_dir(&dotfiles).unwrap();
        std::fs::create_dir(&links).unwrap();
        let real = dotfiles.join("zshrc");
        std::fs::write(&real, b"old").unwrap();
        let link2 = links.join("link2");
        symlink("../dotfiles/zshrc", &link2).unwrap();
        let link1 = dir.path().join("link1");
        symlink("links/link2", &link1).unwrap();

        write_file_sync(&link1, b"new").unwrap();
        assert_eq!(std::fs::read(&real).unwrap(), b"new");
        assert_eq!(
            std::fs::read_link(&link1).unwrap(),
            Path::new("links/link2")
        );
        assert_eq!(
            std::fs::read_link(&link2).unwrap(),
            Path::new("../dotfiles/zshrc")
        );
        assert!(!std::fs::symlink_metadata(&real)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn write_through_symlink_to_directory_errors_without_stray_files() {
        let dir = tempfile::tempdir().unwrap();
        let target_dir = dir.path().join("sub");
        std::fs::create_dir(&target_dir).unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&target_dir, &link).unwrap();

        assert!(write_file_sync(&link, b"x").is_err());
        assert_eq!(std::fs::read_link(&link).unwrap(), target_dir);
        assert!(target_dir.is_dir());
        assert_eq!(std::fs::read_dir(&target_dir).unwrap().count(), 0);
        let mut names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        names.sort();
        assert_eq!(names, ["link", "sub"]);
    }

    #[cfg(unix)]
    #[test]
    fn write_through_dangling_symlink_errors_and_keeps_link() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&missing, &link).unwrap();

        let err = write_file_sync(&link, b"x").unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
        assert!(err.to_string().contains("symlink target does not exist"));
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!missing.exists());
    }

    #[test]
    fn read_file_classifies_utf8_as_text() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.txt");
        std::fs::write(&f, b"hello world").unwrap();
        match read_file_sync(&f, false).unwrap() {
            ReadResult::Text {
                content,
                size,
                mtime,
            } => {
                assert_eq!(content, "hello world");
                assert_eq!(size, 11);
                assert!(mtime > 0);
            }
            _ => panic!("expected text"),
        }
    }

    #[test]
    fn read_file_detects_binary_via_null_byte() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.bin");
        std::fs::write(&f, b"PNG\0\x89image").unwrap();
        assert!(matches!(
            read_file_sync(&f, false).unwrap(),
            ReadResult::Binary { .. }
        ));
    }

    #[test]
    fn read_file_detects_binary_via_invalid_utf8() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.bin");
        // Invalid UTF-8 with no null byte: must still classify as binary.
        std::fs::write(&f, [0xff, 0xfe, 0xfd, 0xfc]).unwrap();
        assert!(matches!(
            read_file_sync(&f, false).unwrap(),
            ReadResult::Binary { .. }
        ));
    }

    #[test]
    fn force_lifts_the_default_size_limit() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("big.txt");
        std::fs::write(&f, vec![b'a'; (MAX_READ_BYTES + 1) as usize]).unwrap();
        assert!(matches!(
            read_file_sync(&f, false).unwrap(),
            ReadResult::TooLarge { .. }
        ));
        assert!(matches!(
            read_file_sync(&f, true).unwrap(),
            ReadResult::Text { .. }
        ));
    }

    #[test]
    fn overwrites_existing_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("note.txt");
        std::fs::write(&target, b"old").unwrap();
        write_atomic(&target, b"new").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new");
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_legacy_staging_symlink() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside.txt");
        std::fs::write(&outside, b"untouched").unwrap();

        let target = dir.path().join("note.txt");
        // Pre-stage a symlink at the legacy deterministic staging path.
        let legacy = dir.path().join(".note.txt.oarlock.tmp");
        symlink(&outside, &legacy).unwrap();

        write_atomic(&target, b"payload").unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"payload");
        // The pre-staged symlink target must not have been written through.
        assert_eq!(std::fs::read(&outside).unwrap(), b"untouched");
    }
}
