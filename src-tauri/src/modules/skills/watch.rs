//! Watches the skill folders (Oarlock's, `~/.claude/skills`, the open projects' items) so a change
//! on disk reaches Settings, the composer and the trust prompt. A folder that does not exist yet
//! is watched through its nearest existing parent, without recursion, so its creation is seen.
//! Events only wake a debounced rescan; what windows hear about is decided by comparing the
//! scan with the previous one, so unrelated activity in a parent folder costs a rescan, never an
//! event.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use tauri::AppHandle;

const QUIET: Duration = Duration::from_millis(300);
const MAX_WAIT: Duration = Duration::from_secs(2);

/// A folder to follow, and the folder above which it is not followed while missing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub path: PathBuf,
    pub stop: PathBuf,
}

/// What to watch for `targets`: each target's real path (for matching events), and the watches:
/// an existing folder recursively, an existing file through its folder and a missing target
/// through its nearest existing parent up to its `stop`, both without recursion.
pub fn plan(targets: &[Target]) -> (Vec<PathBuf>, Vec<(PathBuf, bool)>) {
    let mut real_targets = Vec::new();
    let mut watches: Vec<(PathBuf, bool)> = Vec::new();
    for target in targets {
        let Ok(rest) = target.path.strip_prefix(&target.stop) else {
            continue;
        };
        let mut ancestor = target.path.clone();
        let mut missing: Vec<std::ffi::OsString> = Vec::new();
        let real = loop {
            if let Ok(real) = std::fs::canonicalize(&ancestor) {
                break Some(real);
            }
            if ancestor == target.stop || missing.len() > rest.components().count() {
                break None;
            }
            let Some(name) = ancestor.file_name() else {
                break None;
            };
            missing.push(name.to_owned());
            ancestor.pop();
        };
        let Some(real) = real else { continue };
        if !real.is_dir() {
            // A file target (a project's `.mcp.json`) is watched through its folder.
            if missing.is_empty() && real.is_file() {
                if let Some(parent) = real.parent() {
                    let watch = (parent.to_path_buf(), false);
                    real_targets.push(real.clone());
                    if !watches.contains(&watch) {
                        watches.push(watch);
                    }
                }
            }
            continue;
        }
        let full = missing
            .iter()
            .rev()
            .fold(real.clone(), |path, name| path.join(name));
        real_targets.push(full);
        let watch = (real, missing.is_empty());
        if !watches.contains(&watch) {
            watches.push(watch);
        }
    }
    (real_targets, watches)
}

/// Whether a change at `path` can concern a target: inside one, or on the way to one.
pub fn relevant(path: &Path, targets: &[PathBuf]) -> bool {
    targets
        .iter()
        .any(|target| path.starts_with(target) || target.starts_with(path))
}

trait Backend: Send {
    fn set(&mut self, watches: &[(PathBuf, bool)]);
}

type Targets = Arc<RwLock<Vec<PathBuf>>>;

struct Running {
    targets: Targets,
    backend: Box<dyn Backend>,
}

#[derive(Default)]
pub struct SkillsWatch {
    inner: Mutex<Option<Running>>,
}

impl SkillsWatch {
    /// Watches `targets` from now on, starting the watcher on first use. `on_change` runs on the
    /// watcher's thread after each burst of relevant events.
    pub fn sync(&self, app: &AppHandle, targets: &[Target], on_change: fn(&AppHandle)) {
        let (real_targets, watches) = plan(targets);
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            match start(app.clone(), on_change) {
                Ok(running) => *guard = Some(running),
                Err(error) => {
                    log::warn!("skills watcher unavailable: {error}");
                    return;
                }
            }
        }
        let Some(running) = guard.as_mut() else {
            return;
        };
        *running.targets.write().unwrap_or_else(|e| e.into_inner()) = real_targets;
        running.backend.set(&watches);
    }
}

fn start(app: AppHandle, on_change: fn(&AppHandle)) -> Result<Running, String> {
    let (tx, rx) = mpsc::channel::<()>();
    let targets: Targets = Arc::new(RwLock::new(Vec::new()));
    let backend = platform::create(tx, targets.clone())?;
    std::thread::Builder::new()
        .name("oarlock-skills-watch".into())
        .stack_size(256 * 1024)
        .spawn(move || loop {
            if rx.recv().is_err() {
                return;
            }
            let deadline = Instant::now() + MAX_WAIT;
            loop {
                let wait = QUIET.min(deadline.saturating_duration_since(Instant::now()));
                match rx.recv_timeout(wait) {
                    Ok(()) if Instant::now() < deadline => continue,
                    Ok(()) | Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            crate::modules::panics::isolate("skills watch", || on_change(&app));
        })
        .map_err(|e| e.to_string())?;
    Ok(Running { targets, backend })
}

fn notify_if_relevant(tx: &mpsc::Sender<()>, targets: &Targets, paths: &[PathBuf]) {
    let targets = targets.read().unwrap_or_else(|e| e.into_inner());
    if paths.iter().any(|path| relevant(path, &targets)) {
        let _ = tx.send(());
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;
    use std::collections::HashSet;

    use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

    struct Notify {
        watcher: RecommendedWatcher,
        watched: HashSet<(PathBuf, bool)>,
    }

    pub(super) fn create(
        tx: mpsc::Sender<()>,
        targets: Targets,
    ) -> Result<Box<dyn Backend>, String> {
        let watcher = RecommendedWatcher::new(
            move |result: notify::Result<Event>| {
                let Ok(event) = result else { return };
                if matches!(event.kind, EventKind::Access(_)) {
                    return;
                }
                notify_if_relevant(&tx, &targets, &event.paths);
            },
            Config::default(),
        )
        .map_err(|e| e.to_string())?;
        Ok(Box::new(Notify {
            watcher,
            watched: HashSet::new(),
        }))
    }

    impl Backend for Notify {
        fn set(&mut self, watches: &[(PathBuf, bool)]) {
            let wanted: HashSet<(PathBuf, bool)> = watches.iter().cloned().collect();
            for gone in self.watched.difference(&wanted) {
                let _ = self.watcher.unwatch(&gone.0);
            }
            let mut live = HashSet::with_capacity(wanted.len());
            for watch in wanted {
                if self.watched.contains(&watch) {
                    live.insert(watch);
                    continue;
                }
                let mode = if watch.1 {
                    RecursiveMode::Recursive
                } else {
                    RecursiveMode::NonRecursive
                };
                match self.watcher.watch(&watch.0, mode) {
                    Ok(()) => {
                        live.insert(watch);
                    }
                    Err(error) => log::debug!("skills watch {} failed: {error}", watch.0.display()),
                }
            }
            self.watched = live;
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    //! One FSEvents stream over the watched folders, directory-level events, rebuilt only when
    //! the folders change. FSEvents always watches recursively; `relevant` drops the activity
    //! of a parent folder watched only for a missing target.
    use super::*;
    use std::ffi::{c_char, c_void, CStr};
    use std::os::unix::ffi::OsStrExt;
    use std::ptr::NonNull;

    use dispatch2::{DispatchQueue, DispatchRetained};
    use objc2_core_foundation::{CFArray, CFString};
    use objc2_core_services as fs;

    const LATENCY_SECONDS: f64 = 0.3;

    struct Context {
        tx: mpsc::Sender<()>,
        targets: Targets,
    }

    unsafe extern "C-unwind" fn release_context(info: *const c_void) {
        drop(unsafe { Box::from_raw(info as *mut Context) });
    }

    unsafe extern "C-unwind" fn callback(
        _stream: fs::ConstFSEventStreamRef,
        info: *mut c_void,
        count: usize,
        paths: NonNull<c_void>,
        _flags: NonNull<fs::FSEventStreamEventFlags>,
        _ids: NonNull<fs::FSEventStreamEventId>,
    ) {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let context = unsafe { &*(info as *const Context) };
            let paths = paths.as_ptr() as *const *const c_char;
            let changed: Vec<PathBuf> = (0..count)
                .map(|i| {
                    let bytes = unsafe { CStr::from_ptr(*paths.add(i)) }.to_bytes();
                    let bytes = bytes.strip_suffix(b"/").unwrap_or(bytes);
                    PathBuf::from(std::ffi::OsStr::from_bytes(bytes))
                })
                .collect();
            notify_if_relevant(&context.tx, &context.targets, &changed);
        }));
    }

    struct Stream(fs::FSEventStreamRef);

    // Only touched under the backend's `&mut self`.
    unsafe impl Send for Stream {}

    impl Drop for Stream {
        fn drop(&mut self) {
            unsafe {
                fs::FSEventStreamStop(self.0);
                fs::FSEventStreamInvalidate(self.0);
                fs::FSEventStreamRelease(self.0);
            }
        }
    }

    struct FsEvents {
        queue: DispatchRetained<DispatchQueue>,
        tx: mpsc::Sender<()>,
        targets: Targets,
        roots: Vec<PathBuf>,
        stream: Option<Stream>,
    }

    pub(super) fn create(
        tx: mpsc::Sender<()>,
        targets: Targets,
    ) -> Result<Box<dyn Backend>, String> {
        Ok(Box::new(FsEvents {
            queue: DispatchQueue::new("sh.oarlock.app.skills-watch", None),
            tx,
            targets,
            roots: Vec::new(),
            stream: None,
        }))
    }

    impl FsEvents {
        fn start(&self, roots: &[PathBuf]) -> Option<Stream> {
            if roots.is_empty() {
                return None;
            }
            let strings: Vec<_> = roots
                .iter()
                .map(|root| CFString::from_str(&root.to_string_lossy()))
                .collect();
            let paths = CFArray::from_retained_objects(&strings);
            let context = Box::into_raw(Box::new(Context {
                tx: self.tx.clone(),
                targets: self.targets.clone(),
            }));
            let mut stream_context = fs::FSEventStreamContext {
                version: 0,
                info: context as *mut c_void,
                retain: None,
                release: Some(release_context),
                copyDescription: None,
            };
            unsafe {
                let raw = fs::FSEventStreamCreate(
                    None,
                    Some(callback),
                    &mut stream_context,
                    paths.as_opaque(),
                    fs::kFSEventStreamEventIdSinceNow,
                    LATENCY_SECONDS,
                    fs::kFSEventStreamCreateFlagNone,
                );
                if raw.is_null() {
                    release_context(context as *const c_void);
                    return None;
                }
                fs::FSEventStreamSetDispatchQueue(raw, Some(&self.queue));
                if !fs::FSEventStreamStart(raw) {
                    fs::FSEventStreamInvalidate(raw);
                    fs::FSEventStreamRelease(raw);
                    return None;
                }
                Some(Stream(raw))
            }
        }
    }

    impl Drop for FsEvents {
        fn drop(&mut self) {
            self.stream = None;
        }
    }

    impl Backend for FsEvents {
        fn set(&mut self, watches: &[(PathBuf, bool)]) {
            let mut roots: Vec<PathBuf> = watches.iter().map(|(path, _)| path.clone()).collect();
            roots.sort();
            roots.dedup();
            if roots == self.roots && (self.stream.is_some() || roots.is_empty()) {
                return;
            }
            self.stream = None;
            self.stream = self.start(&roots);
            if self.stream.is_none() && !roots.is_empty() {
                log::warn!("skills watch: could not start an FSEvents stream");
            }
            self.roots = roots;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watches_an_existing_folder_recursively_and_a_missing_one_through_its_parent() {
        let dir = tempfile::tempdir().unwrap();
        let home = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::create_dir_all(home.join("oarlock/skills")).unwrap();
        let targets = [
            Target {
                path: home.join(".claude/skills"),
                stop: home.clone(),
            },
            Target {
                path: home.join("oarlock/skills"),
                stop: home.join("oarlock"),
            },
            Target {
                path: home.join("project/.terax/skills"),
                stop: home.join("project"),
            },
        ];
        let (real, watches) = plan(&targets);
        assert_eq!(
            real,
            vec![home.join(".claude/skills"), home.join("oarlock/skills")]
        );
        assert_eq!(
            watches,
            vec![
                (home.join(".claude"), false),
                (home.join("oarlock/skills"), true)
            ]
        );
    }

    #[test]
    fn a_missing_target_is_never_watched_above_its_stop() {
        let dir = tempfile::tempdir().unwrap();
        let home = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(home.join("p")).unwrap();
        let (real, watches) = plan(&[Target {
            path: home.join("p/.claude/skills"),
            stop: home.join("p"),
        }]);
        assert_eq!(real, vec![home.join("p/.claude/skills")]);
        assert_eq!(watches, vec![(home.join("p"), false)]);
        let (real, watches) = plan(&[Target {
            path: home.join("gone/.claude/skills"),
            stop: home.join("gone"),
        }]);
        assert!(real.is_empty() && watches.is_empty());
    }

    #[test]
    fn a_file_target_is_watched_through_its_folder() {
        let dir = tempfile::tempdir().unwrap();
        let project = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::write(project.join(".mcp.json"), "{}").unwrap();
        let (real, watches) = plan(&[Target {
            path: project.join(".mcp.json"),
            stop: project.clone(),
        }]);
        assert_eq!(real, vec![project.join(".mcp.json")]);
        assert_eq!(watches, vec![(project.clone(), false)]);
        assert!(relevant(&project.join(".mcp.json"), &real));
        assert!(!relevant(&project.join("src/main.rs"), &real));
        std::fs::remove_file(project.join(".mcp.json")).unwrap();
        let (real, watches) = plan(&[Target {
            path: project.join(".mcp.json"),
            stop: project.clone(),
        }]);
        assert_eq!(real, vec![project.join(".mcp.json")]);
        assert_eq!(watches, vec![(project, false)]);
    }

    #[test]
    fn only_changes_in_or_towards_a_target_matter() {
        let targets = vec![PathBuf::from("/h/.claude/skills")];
        assert!(relevant(
            Path::new("/h/.claude/skills/pdf/SKILL.md"),
            &targets
        ));
        assert!(relevant(Path::new("/h/.claude/skills"), &targets));
        assert!(relevant(Path::new("/h/.claude"), &targets));
        assert!(!relevant(
            Path::new("/h/.claude/projects/x.jsonl"),
            &targets
        ));
        assert!(!relevant(Path::new("/h/.claude/skills-old"), &targets));
    }
}
