//! Live directory change notifications for the explorer and editor tabs.
//!
//! The frontend registers the directories it shows (and the files open in
//! editors) and receives debounced `fs:changed` events carrying the watched
//! directories that changed plus any registered file whose own stamp moved.
//! Backends only report directory-level activity, so a package install or a
//! build never turns into per-file work here.

mod plan;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(not(target_os = "macos"))]
mod portable;

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use super::blocking;
use super::index::FileIndexState;
use super::to_canon;
use crate::modules::workspace::{resolve_path, Gates, Origin, WorkspaceEnv, WorkspaceRegistry};
use plan::{Batch, DirSet, FileStamp, Pending, WatchSet};

// Quiet-gap before a batch flushes; MAX_WINDOW caps latency under a long stream.
const DEBOUNCE: Duration = Duration::from_millis(150);
const MAX_WINDOW: Duration = Duration::from_millis(1000);
// The WSL 9P share delivers no change notifications, so its directories are re-listed on this
// interval instead. Slow enough that an idle explorer costs almost nothing over the share.
const WSL_POLL_INTERVAL: Duration = Duration::from_millis(1500);

#[cfg(target_os = "macos")]
type PlatformBackend = macos::FsEvents;
#[cfg(not(target_os = "macos"))]
type PlatformBackend = portable::Notify;

trait Backend: Send {
    /// Brings the OS watches in line with `set`. Called after every change to
    /// the set; implementations must be a no-op when nothing relevant moved.
    fn sync(&mut self, set: &WatchSet);
    fn needs_retry(&self) -> bool {
        false
    }
}

/// What a backend callback needs: the live set of watched directories to
/// filter against, a way to report a batch, and the file-list cache.
#[derive(Clone)]
struct Sink {
    tx: mpsc::Sender<Batch>,
    dirs: Arc<RwLock<Arc<DirSet>>>,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    index: FileIndexState,
}

impl Sink {
    fn send(&self, batch: Batch) {
        if !batch.is_empty() {
            let _ = self.tx.send(batch);
        }
    }

    fn dirs(&self) -> Arc<DirSet> {
        self.dirs.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Any directory-level change, watched or not, can stale a file list.
    #[cfg(target_os = "macos")]
    fn note_path(&self, path: &[u8]) {
        if let Ok(text) = std::str::from_utf8(path) {
            self.index.note_change(text);
        }
    }
}

struct Shared {
    set: Mutex<WatchSet>,
    dirs: Arc<RwLock<Arc<DirSet>>>,
    /// Wakes the share poller, which sleeps while nothing on the share is watched.
    polling: Condvar,
}

impl Shared {
    fn new() -> Self {
        Self {
            set: Mutex::new(WatchSet::default()),
            dirs: Arc::new(RwLock::new(Arc::new(DirSet::new()))),
            polling: Condvar::new(),
        }
    }
}

struct Running {
    shared: Arc<Shared>,
    backend: Box<dyn Backend>,
    /// The batch channel for the share poller, taken when the first directory on the share is
    /// watched. Only WSL workspaces ever start it.
    poll_tx: Option<mpsc::Sender<Batch>>,
}

#[derive(Default)]
pub struct FsWatchState {
    inner: Mutex<Option<Running>>,
    owners: Mutex<WatchOwners>,
}

/// The watches each window holds, so a window that closes or reloads gives
/// back what it never removed.
#[derive(Default)]
struct WatchOwners(HashMap<String, Held>);

/// Directories and repositories as (key, spelling), files as (directory key, key, spelling).
type HeldDir = (String, String);
type HeldFile = (String, String, String);

#[derive(Default, Debug, PartialEq)]
struct Held {
    dirs: HashMap<HeldDir, usize>,
    files: HashMap<HeldFile, usize>,
    repos: HashMap<HeldDir, usize>,
}

impl WatchOwners {
    fn add(&mut self, owner: &str, dirs: &[HeldDir], files: &[HeldFile], repos: &[HeldDir]) {
        let held = self.0.entry(owner.to_owned()).or_default();
        for dir in dirs {
            *held.dirs.entry(dir.clone()).or_default() += 1;
        }
        for file in files {
            *held.files.entry(file.clone()).or_default() += 1;
        }
        for repo in repos {
            *held.repos.entry(repo.clone()).or_default() += 1;
        }
    }

    fn remove(&mut self, owner: &str, dirs: &[HeldDir], files: &[HeldFile], repos: &[HeldDir]) {
        let Some(held) = self.0.get_mut(owner) else {
            return;
        };
        fn release<K: std::hash::Hash + Eq>(counts: &mut HashMap<K, usize>, key: &K) {
            if let Some(count) = counts.get_mut(key) {
                *count -= 1;
                if *count == 0 {
                    counts.remove(key);
                }
            }
        }
        for dir in dirs {
            release(&mut held.dirs, dir);
        }
        for file in files {
            release(&mut held.files, file);
        }
        for repo in repos {
            release(&mut held.repos, repo);
        }
        if held.dirs.is_empty() && held.files.is_empty() && held.repos.is_empty() {
            self.0.remove(owner);
        }
    }

    fn take(&mut self, owner: &str) -> Held {
        self.0.remove(owner).unwrap_or_default()
    }
}

#[derive(Clone, serde::Serialize)]
struct ChangedPayload {
    paths: Vec<String>,
}

/// `git:changed`: something in these repositories (spelled as Source Control registered them)
/// may have changed what `git status` reports.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GitChangedPayload {
    repo_roots: Vec<String>,
}

fn start(app: &AppHandle) -> Result<Running, String> {
    let (tx, rx) = mpsc::channel::<Batch>();
    let poll_tx = Some(tx.clone());
    let shared = Arc::new(Shared::new());
    let index = app.state::<FileIndexState>().inner().clone();
    let sink = Sink {
        tx,
        dirs: shared.dirs.clone(),
        index: index.clone(),
    };
    let backend: Box<dyn Backend> = Box::new(PlatformBackend::new(sink)?);

    let drain_shared = shared.clone();
    let app = app.clone();
    std::thread::Builder::new()
        .name("oarlock-fs-watch".into())
        .stack_size(256 * 1024)
        .spawn(move || drain_loop(rx, drain_shared, app, index))
        .map_err(|e| e.to_string())?;
    Ok(Running {
        shared,
        backend,
        poll_tx,
    })
}

/// Re-lists the directories on the WSL share on a timer: the share never notifies, so a change
/// would otherwise stay invisible until the tree is reloaded by hand. It feeds the same channel
/// as the backends, so polling reuses the debounce, `resolve_changes` and the `fs:changed` emit.
fn poll_loop(tx: mpsc::Sender<Batch>, shared: Arc<Shared>) {
    loop {
        {
            let set = shared.set.lock().unwrap_or_else(|e| e.into_inner());
            let _parked = shared
                .polling
                .wait_while(set, |set| !set.has_polled_dirs())
                .unwrap_or_else(|e| e.into_inner());
        }
        std::thread::sleep(WSL_POLL_INTERVAL);
        let alive = crate::modules::panics::isolate("fs watch poll", || poll_once(&tx, &shared))
            .unwrap_or(true);
        if !alive {
            return;
        }
    }
}

/// One tick. Returns false once the drain loop is gone and nothing can consume a batch.
fn poll_once(tx: &mpsc::Sender<Batch>, shared: &Shared) -> bool {
    // Copied out and read outside the lock, like `resolve_changes`: add/remove never wait
    // for the share.
    let polled = {
        let set = shared.set.lock().unwrap_or_else(|e| e.into_inner());
        set.polled_dirs()
    };
    if polled.is_empty() {
        return true;
    }
    let signatures: Vec<Option<u64>> = polled
        .iter()
        .map(|(_, path)| plan::listing_signature(path))
        .collect();
    // The files open in editors are registered under the same directory. An edit in place
    // leaves the listing untouched, so their own stamps are what move.
    let watched_files: Vec<Vec<String>> = {
        let set = shared.set.lock().unwrap_or_else(|e| e.into_inner());
        polled
            .iter()
            .map(|(key, _)| set.file_keys(key))
            .collect::<Vec<_>>()
    };
    let stamps: Vec<HashMap<String, Option<FileStamp>>> = watched_files
        .iter()
        .map(|files| {
            files
                .iter()
                .map(|file| (file.clone(), FileStamp::of(std::path::Path::new(file))))
                .collect()
        })
        .collect();
    let moved: Vec<String> = {
        let set = shared.set.lock().unwrap_or_else(|e| e.into_inner());
        polled
            .iter()
            .zip(signatures)
            .zip(stamps)
            .filter(|(((key, _), signature), stamps)| {
                set.listing_moved(key, *signature) || set.files_moved(key, stamps)
            })
            .map(|(((key, _), _), _)| key.clone())
            .collect()
    };
    if moved.is_empty() {
        return true;
    }
    // `resolve_changes` re-reads and remembers the listing and re-stamps the files: the
    // poller only decides that something moved.
    tx.send(Batch {
        dirs: moved,
        subtrees: Vec::new(),
    })
    .is_ok()
}

fn drain_loop(
    rx: mpsc::Receiver<Batch>,
    shared: Arc<Shared>,
    app: AppHandle,
    index: FileIndexState,
) {
    loop {
        let Ok(first) = rx.recv() else { return };
        let mut pending = Pending::default();
        pending.merge(first);

        let deadline = Instant::now() + MAX_WINDOW;
        loop {
            let timeout = DEBOUNCE.min(deadline.saturating_duration_since(Instant::now()));
            match rx.recv_timeout(timeout) {
                Ok(batch) => pending.merge(batch),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
            if Instant::now() >= deadline {
                break;
            }
        }

        // A burst that panics is lost, not the watcher.
        crate::modules::panics::isolate("fs watch burst", || {
            let Changes {
                touched,
                report,
                repos,
            } = resolve_changes(pending, &shared);
            // The file list cache hears about every touched directory, whether or not the
            // frontend does: an edited ignore file changes the list without changing a name.
            for path in &touched {
                index.note_change(path);
            }
            if !report.is_empty() {
                let _ = app.emit("fs:changed", ChangedPayload { paths: report });
            }
            if !repos.is_empty() {
                let _ = app.emit("git:changed", GitChangedPayload { repo_roots: repos });
            }
        });
    }
}

/// What one burst resolved to.
struct Changes {
    /// Watched directories the backend reported.
    touched: Vec<String>,
    /// What the frontend is told: the touched directories whose listing moved, plus registered
    /// files inside them whose stamp moved.
    report: Vec<String>,
    /// Watched repositories with a touched directory in their work tree or git directory. An
    /// edit in place moves no listing but does change `git status`, so this uses `touched`.
    repos: Vec<String>,
}

/// Watched directories that changed, plus registered files inside them whose
/// stamp moved. A directory whose listing is the one the frontend already has (a file edited
/// in place, a build rewriting a file) is left out: see `WatchSet::listing_changed`.
fn resolve_changes(pending: Pending, shared: &Shared) -> Changes {
    let (touched, locations) = {
        let set = shared.set.lock().unwrap_or_else(|e| e.into_inner());
        let touched = pending.resolve(set.dir_keys());
        let locations: Vec<Option<PathBuf>> = touched.iter().map(|dir| set.dir_path(dir)).collect();
        (touched, locations)
    };
    // Reading the directories happens outside the lock: add/remove never wait for the disk.
    let signatures: Vec<Option<u64>> = locations
        .iter()
        .map(|path| path.as_deref().and_then(plan::listing_signature))
        .collect();
    let mut set = shared.set.lock().unwrap_or_else(|e| e.into_inner());
    let stamp_of = |path: &str| FileStamp::of(std::path::Path::new(path));
    let mut report = Vec::new();
    for (dir, signature) in touched.iter().zip(signatures) {
        if set.listing_changed(dir, signature) {
            report.extend(set.dir_spellings(dir));
        }
        report.extend(set.changed_files_in(dir, &stamp_of));
    }
    let repos = set.repos_touched(touched.iter().map(String::as_str));
    Changes {
        touched,
        report,
        repos,
    }
}

/// Each requested directory with its canonical path. Canonical keys keep add/remove symmetric
/// whatever the spelling, and the spelling is what changes are reported under.
fn prepare_dirs(
    gates: Gates<'_>,
    workspace: &WorkspaceEnv,
    paths: Vec<String>,
) -> Vec<(String, PathBuf)> {
    paths
        .into_iter()
        .filter_map(|raw| {
            let resolved = resolve_path(&raw, workspace);
            let canonical = std::fs::canonicalize(&resolved).ok()?;
            if !canonical.is_dir() || plan::is_skipped(&canonical) || !gates.reaches(&canonical) {
                return None;
            }
            Some((raw, canonical))
        })
        .collect()
}

/// The key a directory being released was registered under. A removed or renamed directory no
/// longer canonicalizes, but its parent usually still does.
fn removal_dir_key(workspace: &WorkspaceEnv, raw: &str) -> String {
    let resolved = resolve_path(raw, workspace);
    if let Ok(canonical) = std::fs::canonicalize(&resolved) {
        return to_canon(canonical);
    }
    match canonical_file(workspace, raw) {
        Some((_, key, _)) => key,
        None => to_canon(resolved),
    }
}

/// A file is identified by its canonical directory plus its own name, so the
/// path we report matches what editor tabs store even when the file itself no
/// longer exists.
fn canonical_file(workspace: &WorkspaceEnv, raw: &str) -> Option<(String, String, PathBuf)> {
    let resolved = resolve_path(raw, workspace);
    let name = resolved.file_name()?.to_owned();
    let parent = std::fs::canonicalize(resolved.parent()?).ok()?;
    let file = parent.join(name);
    Some((to_canon(&parent), to_canon(&file), file))
}

impl FsWatchState {
    fn owners(&self) -> std::sync::MutexGuard<'_, WatchOwners> {
        self.owners.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Gives back every watch `owner` (a window) still holds.
    pub fn release_window(&self, app: &AppHandle, owner: &str) {
        let held = self.owners().take(owner);
        if held.dirs.is_empty() && held.files.is_empty() && held.repos.is_empty() {
            return;
        }
        let _ = self.with_running(app, false, |running| {
            running.apply(|set| {
                let mut moved = false;
                for ((dir, spelling), count) in &held.dirs {
                    for _ in 0..*count {
                        moved |= set.remove_dir(dir, spelling);
                    }
                }
                for ((dir, key, spelling), count) in &held.files {
                    for _ in 0..*count {
                        set.remove_file(dir, key, spelling);
                    }
                }
                for ((root, spelling), count) in &held.repos {
                    for _ in 0..*count {
                        moved |= release_repo(set, root, spelling);
                    }
                }
                moved
            });
        });
    }

    fn with_running<T>(
        &self,
        app: &AppHandle,
        create: bool,
        f: impl FnOnce(&mut Running) -> T,
    ) -> Result<Option<T>, String> {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            if !create {
                return Ok(None);
            }
            *guard = Some(start(app)?);
        }
        Ok(guard.as_mut().map(f))
    }
}

impl Running {
    /// `change` reports whether the set of watched directories moved; file
    /// bookkeeping alone never touches healthy OS watches.
    fn apply(&mut self, change: impl FnOnce(&mut WatchSet) -> bool) {
        let mut set = self.shared.set.lock().unwrap_or_else(|e| e.into_inner());
        let moved = change(&mut set);
        if !moved && !self.backend.needs_retry() {
            return;
        }
        *self.shared.dirs.write().unwrap_or_else(|e| e.into_inner()) = Arc::new(set.snapshot());
        self.backend.sync(&set);
        let poll = set.has_polled_dirs();
        drop(set);
        if poll {
            self.start_polling();
            self.shared.polling.notify_one();
        }
    }

    fn start_polling(&mut self) {
        let Some(tx) = self.poll_tx.take() else {
            return;
        };
        let shared = self.shared.clone();
        let spawned = std::thread::Builder::new()
            .name("oarlock-fs-poll".into())
            .stack_size(256 * 1024)
            .spawn(move || poll_loop(tx, shared));
        if let Err(e) = spawned {
            log::warn!("fs watch poller failed to start: {e}");
        }
    }
}

#[tauri::command]
pub async fn fs_watch_add(
    app: AppHandle,
    webview: tauri::Webview,
    paths: Vec<String>,
    files: Option<Vec<String>>,
    workspace: Option<WorkspaceEnv>,
) -> Result<(), String> {
    let owner = webview.label().to_owned();
    blocking(move || {
        let workspace = WorkspaceEnv::from_option(workspace);
        let gates = app.state::<WorkspaceRegistry>().inner().gates(Origin::App);
        let dirs = prepare_dirs(gates, &workspace, paths);
        let files: Vec<_> = files
            .unwrap_or_default()
            .into_iter()
            .filter_map(|raw| {
                let (dir, key, path) = canonical_file(&workspace, &raw)?;
                // Its folder, as the watch sees it: the file's own changes are reported from there.
                if !gates.reaches(path.parent()?) {
                    return None;
                }
                Some((dir, key, raw, FileStamp::of(&path)))
            })
            .collect();
        if dirs.is_empty() && files.is_empty() {
            return Ok(());
        }
        let held_dirs: Vec<HeldDir> = dirs
            .iter()
            .map(|(spelling, dir)| (to_canon(dir), spelling.clone()))
            .collect();
        let held_files: Vec<HeldFile> = files
            .iter()
            .map(|(dir, key, spelling, _)| (dir.clone(), key.clone(), spelling.clone()))
            .collect();
        // Taken before the OS watch starts (inside `apply`), so a change after it differs.
        let baselines: Vec<Option<u64>> = dirs
            .iter()
            .map(|(_, dir)| plan::listing_signature(dir))
            .collect();
        app.state::<FsWatchState>()
            .with_running(&app, true, |running| {
                running.apply(|set| {
                    let mut moved = false;
                    for ((spelling, dir), signature) in dirs.into_iter().zip(baselines) {
                        let key = to_canon(&dir);
                        // A `/mnt/<drive>` workspace path already became a native drive path in
                        // `prepare_dirs`; what is left on the share can never notify.
                        let poll = plan::is_wsl_share(&key);
                        if set.add_dir(key.clone(), spelling, dir, poll) {
                            set.record_listing(&key, signature);
                            moved = true;
                        }
                    }
                    for (dir, key, spelling, stamp) in files {
                        set.add_file(dir, key, spelling, stamp);
                    }
                    moved
                });
            })?;
        app.state::<FsWatchState>()
            .owners()
            .add(&owner, &held_dirs, &held_files, &[]);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn fs_watch_remove(
    app: AppHandle,
    webview: tauri::Webview,
    paths: Vec<String>,
    files: Option<Vec<String>>,
    workspace: Option<WorkspaceEnv>,
) -> Result<(), String> {
    let owner = webview.label().to_owned();
    blocking(move || {
        let workspace = WorkspaceEnv::from_option(workspace);
        let dirs: Vec<HeldDir> = paths
            .into_iter()
            .map(|raw| (removal_dir_key(&workspace, &raw), raw))
            .collect();
        let files: Vec<HeldFile> = files
            .unwrap_or_default()
            .into_iter()
            .filter_map(|raw| {
                let (dir, key, _) = canonical_file(&workspace, &raw)?;
                Some((dir, key, raw))
            })
            .collect();
        app.state::<FsWatchState>()
            .with_running(&app, false, |running| {
                running.apply(|set| {
                    let mut moved = false;
                    for (dir, spelling) in &dirs {
                        moved |= set.remove_dir(dir, spelling);
                    }
                    for (dir, key, spelling) in &files {
                        set.remove_file(dir, key, spelling);
                    }
                    moved
                });
            })?;
        app.state::<FsWatchState>()
            .owners()
            .remove(&owner, &dirs, &files, &[]);
        Ok(())
    })
    .await
}

/// Files at the top of a git directory that the operations which change `git status` rewrite.
/// A rewrite keeps the listing, so the share poller only notices them as registered files;
/// native backends already report the directory.
const GIT_STATE_FILES: &[&str] = &["HEAD", "index", "ORIG_HEAD", "FETCH_HEAD", "COMMIT_EDITMSG"];

/// The git directory of the work tree at `root`: `.git` itself, or where a `.git` file (a
/// linked worktree, a submodule) points.
fn git_dir_of(root: &Path, workspace: &WorkspaceEnv) -> Option<PathBuf> {
    let dot_git = root.join(".git");
    if dot_git.is_dir() {
        return std::fs::canonicalize(dot_git).ok();
    }
    let mut text = String::new();
    std::fs::File::open(&dot_git)
        .ok()?
        .take(4096)
        .read_to_string(&mut text)
        .ok()?;
    let target = text.lines().next()?.strip_prefix("gitdir:")?.trim();
    // A WSL repository names its git dir as a Linux path.
    let path = if target.starts_with('/') || Path::new(target).is_absolute() {
        resolve_path(target, workspace)
    } else {
        root.join(target)
    };
    std::fs::canonicalize(path).ok().filter(|dir| dir.is_dir())
}

/// What `git_watch_add` registers for one repository.
struct RepoWatchPlan {
    root: String,
    spelling: String,
    git_dir: PathBuf,
    git_dir_key: String,
    /// On the WSL share, which cannot notify: polled instead.
    poll: bool,
    listing: Option<u64>,
    files: Vec<(String, Option<FileStamp>)>,
}

fn plan_repo_watch(
    registry: &WorkspaceRegistry,
    workspace: &WorkspaceEnv,
    repo_root: String,
) -> Option<RepoWatchPlan> {
    let root = std::fs::canonicalize(resolve_path(&repo_root, workspace)).ok()?;
    if !root.is_dir() || !registry.is_authorized(&root) {
        return None;
    }
    let git_dir = git_dir_of(&root, workspace)?;
    let git_dir_key = to_canon(&git_dir);
    let files = GIT_STATE_FILES
        .iter()
        .map(|name| {
            let key = format!("{}/{name}", git_dir_key.trim_end_matches('/'));
            let stamp = FileStamp::of(Path::new(&key));
            (key, stamp)
        })
        .collect();
    Some(RepoWatchPlan {
        root: to_canon(&root),
        spelling: repo_root,
        poll: plan::is_wsl_share(&git_dir_key),
        listing: plan::listing_signature(&git_dir),
        git_dir,
        git_dir_key,
        files,
    })
}

/// Registers the repository, its git directory and the state files in it. True when the set
/// of watched directories moved.
fn register_repo(set: &mut WatchSet, plan: RepoWatchPlan) -> bool {
    let RepoWatchPlan {
        root,
        spelling,
        git_dir,
        git_dir_key,
        poll,
        listing,
        files,
    } = plan;
    set.add_repo(root, spelling, git_dir_key.clone());
    let moved = set.add_dir(git_dir_key.clone(), git_dir_key.clone(), git_dir, poll);
    if moved {
        set.record_listing(&git_dir_key, listing);
    }
    for (key, stamp) in files {
        set.add_file(git_dir_key.clone(), key.clone(), key, stamp);
    }
    moved
}

/// Undoes one `register_repo` of `root` under `spelling`. True when the set of watched
/// directories moved.
fn release_repo(set: &mut WatchSet, root: &str, spelling: &str) -> bool {
    let Some(git_dir) = set.repo_git_dir(root, spelling) else {
        return false;
    };
    set.remove_repo(root, spelling);
    for name in GIT_STATE_FILES {
        let key = format!("{}/{name}", git_dir.trim_end_matches('/'));
        set.remove_file(&git_dir, &key, &key);
    }
    set.remove_dir(&git_dir, &git_dir)
}

/// Watches a repository while a Source Control view of it is on screen: activity in its git
/// directory, or in any watched directory of its work tree, emits `git:changed`. Nothing is
/// watched for a repository nobody is looking at.
#[tauri::command]
pub async fn git_watch_add(
    app: AppHandle,
    webview: tauri::Webview,
    repo_root: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<(), String> {
    let owner = webview.label().to_owned();
    blocking(move || {
        let workspace = WorkspaceEnv::from_option(workspace);
        let Some(plan) = plan_repo_watch(&app.state::<WorkspaceRegistry>(), &workspace, repo_root)
        else {
            return Ok(());
        };
        let held = (plan.root.clone(), plan.spelling.clone());
        app.state::<FsWatchState>()
            .with_running(&app, true, |running| {
                running.apply(|set| register_repo(set, plan));
            })?;
        app.state::<FsWatchState>()
            .owners()
            .add(&owner, &[], &[], &[held]);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn git_watch_remove(
    app: AppHandle,
    webview: tauri::Webview,
    repo_root: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<(), String> {
    let owner = webview.label().to_owned();
    blocking(move || {
        let workspace = WorkspaceEnv::from_option(workspace);
        let held = (removal_dir_key(&workspace, &repo_root), repo_root);
        app.state::<FsWatchState>()
            .with_running(&app, false, |running| {
                running.apply(|set| release_repo(set, &held.0, &held.1));
            })?;
        app.state::<FsWatchState>()
            .owners()
            .remove(&owner, &[], &[], &[held]);
        Ok(())
    })
    .await
}

/// Tells Source Control about a file Oarlock wrote: a save or an AI edit outside every watched
/// directory changes `git status` without any watcher seeing it. Blocking (canonicalizes).
pub fn note_written(app: &AppHandle, path: &Path) {
    let Some(name) = path.file_name() else {
        return;
    };
    let Some(parent) = path.parent().and_then(|p| std::fs::canonicalize(p).ok()) else {
        return;
    };
    let key = to_canon(parent.join(name));
    let repos = {
        let state = app.state::<FsWatchState>();
        let guard = state.inner.lock().unwrap_or_else(|e| e.into_inner());
        let Some(running) = guard.as_ref() else {
            return;
        };
        let set = running.shared.set.lock().unwrap_or_else(|e| e.into_inner());
        set.repos_touched([key.as_str()])
    };
    if !repos.is_empty() {
        let _ = app.emit("git:changed", GitChangedPayload { repo_roots: repos });
    }
}

#[cfg(test)]
mod tests {

    #[test]
    fn a_window_gives_back_the_watches_it_still_holds() {
        let mut owners = WatchOwners::default();
        let dir = |d: &str| (d.to_owned(), d.to_owned());
        let file = |d: &str, f: &str| (d.to_owned(), f.to_owned(), f.to_owned());
        owners.add(
            "main",
            &[dir("/a"), dir("/a")],
            &[file("/a", "/a/x")],
            &[dir("/r")],
        );
        owners.add("w-1", &[dir("/a")], &[], &[]);
        owners.remove("main", &[dir("/a")], &[], &[]);
        // Removing what the window never added changes nothing.
        owners.remove("main", &[dir("/b")], &[file("/b", "/b/y")], &[dir("/s")]);
        let held = owners.take("main");
        assert_eq!(held.dirs, HashMap::from([(dir("/a"), 1)]));
        assert_eq!(held.files, HashMap::from([(file("/a", "/a/x"), 1)]));
        assert_eq!(held.repos, HashMap::from([(dir("/r"), 1)]));
        assert_eq!(owners.take("main"), Held::default());
        // Another window's watches stay its own.
        assert_eq!(owners.take("w-1").dirs, HashMap::from([(dir("/a"), 1)]));
        owners.add("w-2", &[dir("/c")], &[], &[dir("/r")]);
        owners.remove("w-2", &[dir("/c")], &[], &[]);
        assert!(!owners.0.is_empty(), "the repository is still held");
        owners.remove("w-2", &[], &[], &[dir("/r")]);
        assert!(owners.0.is_empty());
    }

    use super::*;

    #[test]
    fn an_unchanged_watch_set_retries_a_failed_backend_but_not_a_healthy_one() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct Retrying {
            calls: Arc<AtomicUsize>,
            failed: bool,
        }
        impl Backend for Retrying {
            fn sync(&mut self, _: &WatchSet) {
                self.calls.fetch_add(1, Ordering::SeqCst);
                self.failed = false;
            }
            fn needs_retry(&self) -> bool {
                self.failed
            }
        }
        let calls = Arc::new(AtomicUsize::new(0));
        let mut running = Running {
            shared: Arc::new(Shared::new()),
            backend: Box::new(Retrying {
                calls: calls.clone(),
                failed: true,
            }),
            poll_tx: None,
        };
        running.apply(|_| false);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        running.apply(|_| false);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    fn shared_watching(dir: &std::path::Path) -> Shared {
        let key = to_canon(dir);
        let shared = Shared::new();
        let mut set = shared.set.lock().unwrap();
        assert!(set.add_dir(key.clone(), key.clone(), dir.to_path_buf(), false));
        set.record_listing(&key, plan::listing_signature(dir));
        drop(set);
        shared
    }

    fn burst(dir: &std::path::Path) -> Pending {
        let mut pending = Pending::default();
        pending.merge(Batch {
            dirs: vec![to_canon(dir)],
            subtrees: Vec::new(),
        });
        pending
    }

    fn shared_polling(dir: &std::path::Path) -> Shared {
        let key = to_canon(dir);
        let shared = Shared::new();
        let mut set = shared.set.lock().unwrap();
        assert!(set.add_dir(key.clone(), key.clone(), dir.to_path_buf(), true));
        set.record_listing(&key, plan::listing_signature(dir));
        drop(set);
        shared
    }

    /// A polled directory that also holds an open editor file, as the editor registers it.
    fn shared_polling_with_file(dir: &std::path::Path, file: &std::path::Path) -> Shared {
        let shared = shared_polling(dir);
        let mut set = shared.set.lock().unwrap();
        set.add_file(
            to_canon(dir),
            to_canon(file),
            to_canon(file),
            FileStamp::of(file),
        );
        drop(set);
        shared
    }

    #[test]
    fn an_edited_open_file_reaches_the_frontend_through_the_poller() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("open.ts");
        std::fs::write(&file, "one").unwrap();
        let shared = shared_polling_with_file(dir.path(), &file);
        let (tx, rx) = mpsc::channel::<Batch>();

        assert!(poll_once(&tx, &shared));
        assert!(rx.try_recv().is_err(), "an untouched file is not a tick");

        // An edit in place: the listing is unchanged, only the file's stamp moved.
        std::fs::write(&file, "two, a different length").unwrap();
        assert!(poll_once(&tx, &shared));
        let batch = rx.try_recv().expect("the moved file is a batch");
        assert_eq!(batch.dirs, vec![to_canon(dir.path())]);

        // The batch takes the normal resolve path, which re-stamps the file.
        let mut pending = Pending::default();
        pending.merge(batch);
        let changes = resolve_changes(pending, &shared);
        assert_eq!(
            changes.report,
            vec![to_canon(&file)],
            "the file is reported, not the directory"
        );

        // The new stamp is the baseline: the next tick is quiet again.
        assert!(poll_once(&tx, &shared));
        assert!(
            rx.try_recv().is_err(),
            "a reported change is not reported twice"
        );
    }

    #[test]
    fn a_deleted_open_file_reaches_the_frontend_through_the_poller() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("open.ts");
        std::fs::write(&file, "one").unwrap();
        let shared = shared_polling_with_file(dir.path(), &file);
        let (tx, rx) = mpsc::channel::<Batch>();

        std::fs::remove_file(&file).unwrap();
        assert!(poll_once(&tx, &shared));
        let batch = rx.try_recv().expect("the deleted file is a batch");
        assert_eq!(batch.dirs, vec![to_canon(dir.path())]);

        let mut pending = Pending::default();
        pending.merge(batch);
        let changes = resolve_changes(pending, &shared);
        assert_eq!(
            changes.report,
            vec![to_canon(dir.path()), to_canon(&file)],
            "the directory loses the entry and the file is reported as gone"
        );
    }

    #[test]
    fn a_polled_directory_reaches_the_frontend_through_the_backend_batch_path() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.ts"), "one").unwrap();
        let shared = shared_polling(dir.path());
        let (tx, rx) = mpsc::channel::<Batch>();

        assert!(poll_once(&tx, &shared));
        assert!(rx.try_recv().is_err(), "an unchanged listing is not a tick");

        std::fs::write(dir.path().join("b.ts"), "").unwrap();
        assert!(poll_once(&tx, &shared));
        let batch = rx.try_recv().expect("the moved listing is a batch");
        assert_eq!(batch.dirs, vec![to_canon(dir.path())]);
        assert!(batch.subtrees.is_empty());

        // The batch takes the normal resolve path, which remembers the listing.
        let mut pending = Pending::default();
        pending.merge(batch);
        let changes = resolve_changes(pending, &shared);
        assert_eq!(changes.report, vec![to_canon(dir.path())]);

        assert!(poll_once(&tx, &shared));
        assert!(
            rx.try_recv().is_err(),
            "the new listing is now the baseline"
        );
    }

    #[test]
    fn a_polled_directory_that_cannot_be_read_does_not_report_every_tick() {
        let dir = tempfile::tempdir().unwrap();
        let shared = shared_polling(dir.path());
        let (tx, rx) = mpsc::channel::<Batch>();
        std::fs::remove_dir_all(dir.path()).unwrap();

        assert!(poll_once(&tx, &shared));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn the_poller_stops_once_nothing_consumes_batches() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.ts"), "one").unwrap();
        let shared = shared_polling(dir.path());
        let (tx, rx) = mpsc::channel::<Batch>();
        drop(rx);

        std::fs::write(dir.path().join("b.ts"), "").unwrap();
        assert!(!poll_once(&tx, &shared), "a dead channel ends the loop");
    }

    #[test]
    fn edits_in_place_reach_the_index_but_not_the_frontend() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.ts"), "one").unwrap();
        let shared = shared_watching(dir.path());

        std::fs::write(dir.path().join("a.ts"), "two, longer").unwrap();
        let changes = resolve_changes(burst(dir.path()), &shared);
        assert_eq!(changes.touched, vec![to_canon(dir.path())]);
        assert!(
            changes.report.is_empty(),
            "nothing the explorer shows moved"
        );

        std::fs::write(dir.path().join("b.ts"), "").unwrap();
        let changes = resolve_changes(burst(dir.path()), &shared);
        assert_eq!(changes.report, vec![to_canon(dir.path())]);

        let changes = resolve_changes(burst(dir.path()), &shared);
        assert!(changes.report.is_empty(), "the new listing is now known");

        std::fs::remove_file(dir.path().join("b.ts")).unwrap();
        let changes = resolve_changes(burst(dir.path()), &shared);
        assert_eq!(changes.report, vec![to_canon(dir.path())]);
    }

    #[test]
    fn a_registered_file_is_still_reported_when_only_its_contents_change() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("open.ts");
        std::fs::write(&file, "one").unwrap();
        let shared = shared_watching(dir.path());
        shared.set.lock().unwrap().add_file(
            to_canon(dir.path()),
            to_canon(&file),
            to_canon(&file),
            FileStamp::of(&file),
        );

        std::fs::write(&file, "two, a different length").unwrap();
        let changes = resolve_changes(burst(dir.path()), &shared);
        assert_eq!(changes.report, vec![to_canon(&file)]);
    }

    /// A project opened through a link (`/tmp` on macOS, `/home` on Fedora Atomic) is watched
    /// at its canonical path but keyed by the frontend under the path it was given.
    #[cfg(unix)]
    #[test]
    fn changes_under_a_linked_root_are_reported_in_the_spelling_the_frontend_used() {
        let tmp = tempfile::tempdir().unwrap();
        let real = std::fs::canonicalize(tmp.path()).unwrap().join("real");
        std::fs::create_dir_all(real.join("src")).unwrap();
        std::fs::write(real.join("src/open.ts"), "one").unwrap();
        let link = tmp.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(&real).unwrap();
        let spelled = |path: &std::path::Path| path.to_string_lossy().into_owned();
        let link_src = spelled(&link.join("src"));
        let link_file = spelled(&link.join("src/open.ts"));

        let dirs = prepare_dirs(
            registry.gates(Origin::App),
            &WorkspaceEnv::Local,
            vec![link_src.clone()],
        );
        assert_eq!(dirs, vec![(link_src.clone(), real.join("src"))]);
        let (dir_key, file_key, file_path) =
            canonical_file(&WorkspaceEnv::Local, &link_file).unwrap();
        assert_eq!(dir_key, to_canon(real.join("src")));

        let shared = Shared::new();
        {
            let mut set = shared.set.lock().unwrap();
            let (spelling, dir) = dirs.into_iter().next().unwrap();
            assert!(set.add_dir(dir_key.clone(), spelling, dir.clone(), false));
            set.record_listing(&dir_key, plan::listing_signature(&dir));
            set.add_file(
                dir_key.clone(),
                file_key,
                link_file.clone(),
                FileStamp::of(&file_path),
            );
        }

        std::fs::write(real.join("src/new.ts"), "").unwrap();
        std::fs::write(real.join("src/open.ts"), "two, a different length").unwrap();
        let changes = resolve_changes(burst(&real.join("src")), &shared);
        assert_eq!(changes.touched, vec![dir_key.clone()]);
        assert_eq!(changes.report, vec![link_src.clone(), link_file]);

        // Released under the same spelling, also once the directory itself is gone.
        std::fs::remove_dir_all(real.join("src")).unwrap();
        assert_eq!(removal_dir_key(&WorkspaceEnv::Local, &link_src), dir_key);
        assert!(shared.set.lock().unwrap().remove_dir(&dir_key, &link_src));
    }

    fn git(dir: &std::path::Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git on PATH");
        assert!(out.status.success(), "git {args:?} failed");
    }

    /// A repository with one commit, authorized, and its canonical root.
    fn repo_fixture() -> (tempfile::TempDir, PathBuf, WorkspaceRegistry) {
        let tmp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(tmp.path()).unwrap().join("repo");
        std::fs::create_dir_all(root.join("src")).unwrap();
        git(&root, &["init", "-q"]);
        git(&root, &["config", "user.email", "test@oarlock.local"]);
        git(&root, &["config", "user.name", "Oarlock Test"]);
        git(&root, &["config", "commit.gpgsign", "false"]);
        std::fs::write(root.join("src/a.ts"), "one").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "seed"]);
        let registry = WorkspaceRegistry::default();
        registry.authorize(tmp.path()).unwrap();
        (tmp, root, registry)
    }

    fn repo_burst(dirs: Vec<String>) -> Pending {
        let mut pending = Pending::default();
        pending.merge(Batch {
            dirs,
            subtrees: Vec::new(),
        });
        pending
    }

    #[test]
    fn git_dir_of_follows_a_linked_worktree_and_a_relative_gitdir_file() {
        let (tmp, root, _) = repo_fixture();
        assert_eq!(
            git_dir_of(&root, &WorkspaceEnv::Local),
            Some(root.join(".git"))
        );

        let linked = tmp.path().join("linked");
        git(
            &root,
            &["worktree", "add", "-q", linked.to_str().unwrap(), "-b", "f"],
        );
        let linked = std::fs::canonicalize(&linked).unwrap();
        assert_eq!(
            git_dir_of(&linked, &WorkspaceEnv::Local),
            Some(root.join(".git/worktrees/linked"))
        );

        let sub = root.join("sub");
        std::fs::create_dir_all(root.join(".git/modules/sub")).unwrap();
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join(".git"), "gitdir: ../.git/modules/sub\n").unwrap();
        assert_eq!(
            git_dir_of(&sub, &WorkspaceEnv::Local),
            Some(root.join(".git/modules/sub"))
        );

        assert_eq!(git_dir_of(&root.join("src"), &WorkspaceEnv::Local), None);
    }

    #[test]
    fn a_repository_outside_the_workspace_is_not_watched() {
        let (_tmp, root, _) = repo_fixture();
        let registry = WorkspaceRegistry::default();
        let spelling = root.to_string_lossy().into_owned();
        assert!(plan_repo_watch(&registry, &WorkspaceEnv::Local, spelling).is_none());
    }

    #[test]
    fn git_operations_and_work_tree_edits_reach_the_repository_view() {
        let (_tmp, root, registry) = repo_fixture();
        let spelling = root.to_string_lossy().into_owned();
        let src = to_canon(root.join("src"));
        let shared = Shared::new();
        let git_dir_key = {
            let plan = plan_repo_watch(&registry, &WorkspaceEnv::Local, spelling.clone())
                .expect("an authorized repository");
            assert_eq!(plan.root, to_canon(&root));
            assert!(!plan.poll);
            let key = plan.git_dir_key.clone();
            let mut set = shared.set.lock().unwrap();
            assert!(register_repo(&mut set, plan), "the git dir is watched");
            // The explorer watches a folder of the work tree.
            set.add_dir(src.clone(), src.clone(), root.join("src"), false);
            set.record_listing(&src, plan::listing_signature(&root.join("src")));
            key
        };

        // An edit in place moves no listing, so the explorer hears nothing, but the status did
        // change.
        std::fs::write(root.join("src/a.ts"), "two, a different length").unwrap();
        let changes = resolve_changes(repo_burst(vec![src.clone()]), &shared);
        assert!(changes.report.is_empty());
        assert_eq!(changes.repos, vec![spelling.clone()]);

        // Staging rewrites the index inside the git dir.
        git(&root, &["add", "src/a.ts"]);
        let changes = resolve_changes(repo_burst(vec![git_dir_key.clone()]), &shared);
        assert_eq!(changes.repos, vec![spelling.clone()]);
        assert!(changes.report.contains(&format!("{git_dir_key}/index")));

        // Activity outside the repository is not its business.
        let other = root.parent().unwrap().join("other");
        std::fs::create_dir_all(&other).unwrap();
        let other_key = to_canon(&other);
        shared.set.lock().unwrap().add_dir(
            other_key.clone(),
            other_key.clone(),
            other.clone(),
            false,
        );
        std::fs::write(other.join("x"), "").unwrap();
        let changes = resolve_changes(repo_burst(vec![other_key.clone()]), &shared);
        assert_eq!(changes.report, vec![other_key.clone()]);
        assert!(changes.repos.is_empty());

        let mut set = shared.set.lock().unwrap();
        set.remove_dir(&other_key, &other_key);
        set.remove_dir(&src, &src);
        assert!(release_repo(&mut set, &to_canon(&root), &spelling));
        assert!(
            set.is_empty(),
            "releasing the repository gives everything back"
        );
        assert!(!release_repo(&mut set, &to_canon(&root), &spelling));
    }

    /// The WSL share cannot notify, and staging rewrites `index` in place, which moves no
    /// listing: the registered state files are what the poller sees.
    #[test]
    fn the_poller_sees_git_state_files_move_in_a_polled_git_dir() {
        let (_tmp, root, registry) = repo_fixture();
        let spelling = root.to_string_lossy().into_owned();
        let shared = Shared::new();
        let git_dir_key = {
            let mut plan = plan_repo_watch(&registry, &WorkspaceEnv::Local, spelling.clone())
                .expect("an authorized repository");
            plan.poll = true;
            let key = plan.git_dir_key.clone();
            register_repo(&mut shared.set.lock().unwrap(), plan);
            key
        };
        let (tx, rx) = mpsc::channel::<Batch>();
        assert!(poll_once(&tx, &shared));
        assert!(rx.try_recv().is_err(), "nothing moved yet");

        std::fs::write(root.join("src/b.ts"), "new").unwrap();
        git(&root, &["add", "src/b.ts"]);
        assert!(poll_once(&tx, &shared));
        let batch = rx.try_recv().expect("the rewritten index is a tick");
        assert_eq!(batch.dirs, vec![git_dir_key]);
        let mut pending = Pending::default();
        pending.merge(batch);
        assert_eq!(resolve_changes(pending, &shared).repos, vec![spelling]);
    }
}
