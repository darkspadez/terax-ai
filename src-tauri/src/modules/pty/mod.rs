mod agent_detect;
mod cwd;
mod da_filter;
mod foreground;
mod gate;
mod hub;
mod output;
mod presentation;
mod protocol;
mod queue;
mod session;
pub(crate) mod shell_init;
mod terminal_env;
#[cfg(unix)]
mod unix_reader;
mod wake;
mod wire;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, LockResult, OnceLock, PoisonError, RwLock};
use std::thread;

use portable_pty::PtySize;
use tauri::Manager;

use crate::modules::control::ControlState;
use crate::modules::workspace::{
    resolve_path, user_spawn_cwd_or_home, WorkspaceEnv, WorkspaceRegistry,
};
pub(crate) use gate::AllowedOrigins;
use hub::{Command, Hub};
pub use presentation::PresentationClass;
pub use protocol::stream_protocol;
use session::Session;

/// A lock's guard even after a thread panicked while holding it. The guarded
/// state is a map insert or remove, or a child handle, which a panic cannot
/// leave half-changed, and a poisoned lock would otherwise fail every
/// terminal command for the rest of the session.
pub(super) fn unpoisoned<T>(lock: LockResult<T>) -> T {
    lock.unwrap_or_else(PoisonError::into_inner)
}

/// Largest `pty_set_presentation` batch accepted; a window never has more
/// terminals than this, so anything larger is a malformed request.
const MAX_PRESENTATION_BATCH: usize = 4096;

pub struct PtyState {
    sessions: RwLock<HashMap<u32, Arc<Session>>>,
    // Starts at 1 so freshly-handed-out ids are never 0, which the frontend
    // sometimes treats as "unset". Increments monotonically; never reused.
    next_id: AtomicU32,
    hub: Hub,
    /// Resolved from the app's config on the first `terax-pty` request.
    origins: OnceLock<gate::AllowedOrigins>,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            next_id: AtomicU32::new(1),
            hub: Hub::new(),
            origins: OnceLock::new(),
        }
    }
}

impl PtyState {
    /// Removes a session from the registry and from the hub's delivery set.
    pub(super) fn take(&self, id: u32) -> Option<Arc<Session>> {
        let session = unpoisoned(self.sessions.write()).remove(&id);
        if session.is_some() {
            self.hub.submit(Command::Unregister { id });
        }
        session
    }

    /// Removes and unregisters every terminal `label` owns, for reaping.
    /// Other windows' terminals are left alone.
    fn take_owned_by(&self, label: &str) -> Vec<(u32, Arc<Session>)> {
        let drained: Vec<(u32, Arc<Session>)> = {
            let mut sessions = unpoisoned(self.sessions.write());
            let ids: Vec<u32> = sessions
                .iter()
                .filter(|(_, session)| &*session.owner == label)
                .map(|(id, _)| *id)
                .collect();
            ids.into_iter()
                .filter_map(|id| sessions.remove(&id).map(|session| (id, session)))
                .collect()
        };
        for (id, _) in &drained {
            self.hub.submit(Command::Unregister { id: *id });
        }
        drained
    }

    /// The window's page navigated away (reload, HMR): its stream token dies
    /// and its terminals stop producing output until the new page's
    /// `pty_close_all` reaps them, exactly as when their channel went away.
    pub fn reset_webview(&self, label: &str) {
        self.hub.submit(Command::ResetWebview {
            label: Arc::from(label),
        });
        for session in unpoisoned(self.sessions.read()).values() {
            if &*session.owner == label {
                session.close_output();
            }
        }
    }

    /// The webview is gone: close every terminal it owned.
    pub fn destroy_webview(&self, label: &str) {
        self.hub.submit(Command::RemoveWebview {
            label: Arc::from(label),
        });
        let owned: Vec<(u32, Arc<Session>)> = {
            let mut sessions = unpoisoned(self.sessions.write());
            let ids: Vec<u32> = sessions
                .iter()
                .filter(|(_, session)| &*session.owner == label)
                .map(|(id, _)| *id)
                .collect();
            ids.into_iter()
                .filter_map(|id| sessions.remove(&id).map(|session| (id, session)))
                .collect()
        };
        for (id, session) in owned {
            reap(id, session, "webview destroyed");
        }
    }

    /// Native window occlusion or system sleep: every terminal of the window
    /// drops to the occluded cadence without a frontend round trip.
    pub fn set_window_hidden(&self, label: &str, hidden: bool) {
        self.hub.submit(Command::WindowHidden {
            label: Arc::from(label),
            hidden,
        });
    }
}

fn check_presentation_batch(ids: &[u32]) -> Result<(), String> {
    if ids.len() > MAX_PRESENTATION_BATCH {
        return Err(format!(
            "pty_set_presentation: at most {MAX_PRESENTATION_BATCH} ids per call"
        ));
    }
    Ok(())
}

/// Closes output, kills the child and drops the session off the caller's
/// thread (`ClosePseudoConsole` can block until conhost drains).
fn reap(id: u32, session: Arc<Session>, reason: &str) {
    session.close_output();
    if let Err(e) = unpoisoned(session.killer.lock()).kill() {
        // Non-fatal: the child may already have exited on its own (e.g. the
        // user ran `exit`). Log so this isn't invisible during debugging.
        log::debug!("pty {reason}: kill id={id} returned {e}");
    }
    thread::Builder::new()
        .name(format!("terax-pty-drop-{id}"))
        .spawn(move || {
            let t0 = std::time::Instant::now();
            session::drop_session(session);
            log::info!(
                "pty session id={id} dropped in {}ms",
                t0.elapsed().as_millis()
            );
        })
        .expect("spawn pty drop thread");
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pty_open(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: tauri::State<'_, PtyState>,
    control: tauri::State<'_, ControlState>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    workspace: Option<WorkspaceEnv>,
    blocks: Option<bool>,
    shell: Option<String>,
    pane_id: Option<u32>,
    presentation: Option<PresentationClass>,
) -> Result<u32, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let blocks = blocks.unwrap_or(false);
    // A Windows helper cannot execute inside WSL without explicit path and
    // network translation. Do not inject credentials for a broken command.
    let control_env = if workspace.is_wsl() {
        None
    } else {
        pane_id.and_then(|pane_id| control.shell_env(webview.label(), pane_id))
    };
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let owner: Arc<str> = Arc::from(webview.label());
    let hub = state.hub.clone();
    let class = presentation.unwrap_or_default();
    let session = tauri::async_runtime::spawn_blocking(move || {
        // Authorizing the directory canonicalizes it, which touches the disk
        // (a network volume, or wsl.exe for a WSL workspace): never on a worker.
        let cwd = user_spawn_cwd_or_home(
            &app.state::<WorkspaceRegistry>(),
            cwd.as_deref(),
            &workspace,
        );
        session::spawn(
            id,
            app,
            owner,
            hub,
            class,
            cols,
            rows,
            cwd,
            workspace,
            blocks,
            shell,
            control_env,
        )
    })
    .await
    .map_err(|e| {
        log::error!("pty_open join failed: {e}");
        e.to_string()
    })?
    .map_err(|e| {
        log::error!("pty_open failed: {e}");
        e
    })?;
    unpoisoned(state.sessions.write()).insert(id, session);
    // The shell can exit before this insert (instant failure, `exit` in an rc
    // file); the waiter's reap then ran with the id absent. Re-check and reap
    // so the pseudoconsole isn't stranded.
    let finished = unpoisoned(state.sessions.read())
        .get(&id)
        .map(|s| s.finished.load(Ordering::Acquire))
        .unwrap_or(false);
    if finished {
        if let Some(s) = state.take(id) {
            thread::Builder::new()
                .name(format!("terax-pty-drop-{id}"))
                .spawn(move || session::drop_session(s))
                .expect("spawn pty drop thread");
        }
    }
    log::info!("pty opened id={id} cols={cols} rows={rows}");
    Ok(id)
}

// Input is the latency-critical path: raw body + id header skips JSON
// serialization of every keystroke on both sides of the IPC boundary.
#[tauri::command]
pub async fn pty_write(
    state: tauri::State<'_, PtyState>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let id: u32 = request
        .headers()
        .get("x-pty-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "pty_write: missing x-pty-id header".to_string())?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("pty_write: expected raw body".to_string());
    };
    let session = unpoisoned(state.sessions.read())
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("pty_write: unknown id={id}");
            "no session".to_string()
        })?;
    // One ordered queue per session feeds a dedicated writer thread: no task
    // spawn or lock per keystroke, and the result is the real pipe write's.
    session.write(bytes.clone()).await.map_err(|e| {
        log::debug!("pty_write id={id} failed: {e}");
        e
    })
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = unpoisoned(state.sessions.read())
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("pty_resize: unknown id={id}");
            "no session".to_string()
        })?;
    let result = session
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| {
            log::warn!("pty_resize id={id} failed: {e}");
            e
        });
    result
}

#[tauri::command]
pub fn pty_close(state: tauri::State<PtyState>, id: u32) -> Result<(), String> {
    // Detached drop: on Windows `ClosePseudoConsole` can block until conhost
    // drains, which would freeze this Tauri worker thread and stall IPC.
    match state.take(id) {
        Some(session) => {
            log::info!("pty closed id={id}");
            reap(id, session, "close");
        }
        None => log::debug!("pty_close: unknown id={id}"),
    }
    Ok(())
}

#[tauri::command]
pub fn pty_has_foreground_process(state: tauri::State<PtyState>, id: u32) -> Result<bool, String> {
    let sessions = unpoisoned(state.sessions.read());
    let session = sessions.get(&id).ok_or_else(|| {
        log::warn!("pty_has_foreground_process: unknown session id={id}");
        "no session".to_string()
    })?;
    let shell_pid = session.shell_pid;
    if shell_pid == 0 {
        return Ok(false);
    }
    Ok(foreground::shell_has_children(shell_pid))
}

// Foreground-only check for the renderer hibernation path: true while a job
// owns the tty (tcgetpgrp != shell pgid). Stricter and cheaper than
// pty_has_foreground_process, which counts background children too. Windows
// has no foreground group: there, a child built for the console subsystem.
#[tauri::command]
pub fn pty_has_foreground_job(state: tauri::State<PtyState>, id: u32) -> Result<bool, String> {
    let sessions = unpoisoned(state.sessions.read());
    let session = sessions.get(&id).ok_or_else(|| {
        log::warn!("pty_has_foreground_job: unknown session id={id}");
        "no session".to_string()
    })?;
    let shell_pid = session.shell_pid;
    if shell_pid == 0 {
        return Ok(false);
    }
    #[cfg(unix)]
    {
        let leader = unpoisoned(session.master.lock())
            .as_ref()
            .and_then(|master| master.process_group_leader());
        Ok(matches!(leader, Some(pid) if pid > 0 && pid as u32 != shell_pid))
    }
    #[cfg(windows)]
    {
        Ok(foreground::shell_has_console_children(shell_pid))
    }
}

/// A terminal reported its working directory (OSC 7): authorizes that folder as a workspace root
/// and answers whether the page may take it as the terminal's folder. The report is terminal
/// output, which any program can print, so on Linux and macOS it counts only when the OS says the
/// shell, or the leader of the job in front of it, is working there (`cwd`); otherwise nothing is
/// authorized and the answer is false. Windows cannot read another process's folder cheaply:
/// there the report is authorized as before and always taken. Only the window that opened the
/// terminal may ask.
#[tauri::command]
pub async fn pty_authorize_cwd(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: tauri::State<'_, PtyState>,
    id: u32,
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<bool, String> {
    let session = unpoisoned(state.sessions.read())
        .get(&id)
        .filter(|session| *session.owner == *webview.label())
        .cloned()
        .ok_or_else(|| "no session".to_string())?;
    #[cfg(unix)]
    let processes = {
        let leader = unpoisoned(session.master.lock())
            .as_ref()
            .and_then(|master| master.process_group_leader());
        cwd::reporting_processes(session.shell_pid, leader)
    };
    drop(session);
    // Canonicalizing the folder touches the disk (a network volume, wsl.exe for WSL).
    crate::modules::fs::blocking(move || {
        let reported = resolve_path(&path, &WorkspaceEnv::from_option(workspace));
        let registry = app.state::<WorkspaceRegistry>();
        #[cfg(unix)]
        let taken = cwd::authorize_reported(&registry, &reported, &processes);
        #[cfg(windows)]
        let taken = cwd::authorize_reported(&registry, &reported);
        Ok(taken)
    })
    .await
}

// A fresh webview load orphans the previous frontend's sessions in this still
// running process; reap them on boot before any new tab spawns. Only the
// calling window's: another window's shells keep running.
#[tauri::command]
pub fn pty_close_all(
    webview: tauri::Webview,
    state: tauri::State<PtyState>,
) -> Result<usize, String> {
    let drained = state.take_owned_by(webview.label());
    let count = drained.len();
    for (id, session) in drained {
        reap(id, session, "close_all");
    }
    if count > 0 {
        log::info!("pty_close_all: reaped {count} orphaned session(s)");
    }
    Ok(count)
}

/// Opens (or reopens) this webview's output stream and returns the secret
/// that authorizes its `terax-pty` requests. Only the page's own frame can
/// invoke commands, so other frames and origins cannot read terminal output
/// even though the custom protocol is reachable from any frame. Reopening
/// supersedes the previous stream and detaches its terminals.
#[tauri::command]
pub async fn pty_stream_open(
    webview: tauri::Webview,
    state: tauri::State<'_, PtyState>,
) -> Result<String, String> {
    let (reply, token) = tokio::sync::oneshot::channel();
    state.hub.submit(Command::OpenStream {
        label: Arc::from(webview.label()),
        reply: Box::new(move |token| {
            let _ = reply.send(token);
        }),
    });
    let token = token
        .await
        .map_err(|_| "PTY stream is unavailable".to_string())?
        .map_err(|reason| {
            log::error!("pty_stream_open refused: {reason}");
            reason.to_string()
        })?;
    Ok(format!("{token:016x}"))
}

/// Reports which presentation class terminals are in. Called only when a
/// class changes; unknown ids are ignored (the terminal may have just closed).
///
/// This stays `async`, off the main thread, but async commands run on a
/// multi-threaded runtime and two reports can be applied in either order.
/// `seq` is the page's counter of reports (it only grows): a terminal ignores
/// any report not newer than the last one that named it, so the final class
/// is always the latest one sent. Making the command synchronous would order
/// arrivals only if the webview delivered separate requests in order, and
/// would put every report on the main thread for nothing.
#[tauri::command]
pub async fn pty_set_presentation(
    webview: tauri::Webview,
    state: tauri::State<'_, PtyState>,
    ids: Vec<u32>,
    class: PresentationClass,
    seq: u64,
) -> Result<(), String> {
    check_presentation_batch(&ids)?;
    state.hub.submit(Command::SetPresentation {
        label: Arc::from(webview.label()),
        ids,
        class,
        seq,
    });
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyDiagnostics {
    host_pid: u32,
    host_rss_bytes: Option<u64>,
    hub: hub::HubDiagnostics,
    sessions: Vec<PtySessionDiagnostics>,
}

#[derive(serde::Serialize)]
struct PtySessionDiagnostics {
    id: u32,
    #[serde(flatten)]
    output: session::OutputDiagnostics,
}

#[tauri::command]
pub fn pty_diagnostics(state: tauri::State<PtyState>) -> PtyDiagnostics {
    let host_pid = std::process::id();
    let sessions = unpoisoned(state.sessions.read())
        .iter()
        .map(|(id, session)| PtySessionDiagnostics {
            id: *id,
            output: session.diagnostics(),
        })
        .collect();
    PtyDiagnostics {
        host_pid,
        host_rss_bytes: crate::modules::proc::rss::rss_bytes(host_pid),
        hub: state.hub.diagnostics(),
        sessions,
    }
}

#[tauri::command]
pub fn pty_shell_name() -> String {
    shell_init::detect_shell_name()
}

#[tauri::command]
pub fn pty_list_shells() -> Vec<shell_init::ShellInfo> {
    shell_init::list_shells()
}

#[cfg(all(test, unix))]
mod tests {
    use super::session::{spawn_with, Host};
    use super::*;
    use portable_pty::CommandBuilder;
    use std::path::Path;
    use std::time::{Duration, Instant};

    fn open(state: &Arc<PtyState>, id: u32, owner: &str) -> Arc<Session> {
        open_running(state, id, owner, "sleep 30")
    }

    /// A terminal whose shell runs `script` with `/bin/sh -c`.
    fn open_running(state: &Arc<PtyState>, id: u32, owner: &str, script: &str) -> Arc<Session> {
        let reaper = state.clone();
        let script = script.to_owned();
        let session = spawn_with(
            Host {
                id,
                owner: Arc::from(owner),
                hub: state.hub.clone(),
                class: PresentationClass::Hidden,
                signal: Arc::new(|_| {}),
                reap: Box::new(move || {
                    if let Some(session) = reaper.take(id) {
                        session::drop_session(session);
                    }
                }),
            },
            PtySize::default(),
            || {
                let mut command = CommandBuilder::new("/bin/sh");
                command.arg("-c");
                command.arg(script);
                Ok(command)
            },
        )
        .unwrap();
        unpoisoned(state.sessions.write()).insert(id, session.clone());
        session
    }

    fn wait_for(what: &str, condition: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !condition() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// What `pty_authorize_cwd` decides for terminal `session` and a reported folder.
    fn authorize_reported(session: &Session, registry: &WorkspaceRegistry, folder: &Path) -> bool {
        let leader = unpoisoned(session.master.lock())
            .as_ref()
            .and_then(|master| master.process_group_leader());
        let processes = cwd::reporting_processes(session.shell_pid, leader);
        cwd::authorize_reported(registry, folder, &processes)
    }

    #[test]
    fn a_terminal_folder_is_authorized_where_its_shell_or_foreground_job_is() {
        let root = tempfile::tempdir().unwrap();
        let (shell_dir, job_dir) = (root.path().join("shell"), root.path().join("job"));
        for dir in [&shell_dir, &job_dir] {
            std::fs::create_dir(dir).unwrap();
        }
        let state = Arc::new(PtyState::default());
        // With job control, the subshell is the terminal's foreground job, in a folder of its
        // own, as a nested shell started from the user's shell is.
        let session = open_running(
            &state,
            1,
            "main",
            &format!(
                "cd '{}' && set -m && (cd '{}' && exec sleep 30)",
                shell_dir.display(),
                job_dir.display()
            ),
        );
        let registry = WorkspaceRegistry::default();
        wait_for("the job to take the terminal", || {
            authorize_reported(&session, &registry, &job_dir)
        });
        assert!(authorize_reported(&session, &registry, &shell_dir));
        assert!(!authorize_reported(&session, &registry, root.path()));
        assert!(!authorize_reported(&session, &registry, Path::new("/")));
        assert!(!registry.is_authorized(&std::fs::canonicalize(root.path()).unwrap()));
        if let Some(session) = state.take(1) {
            reap(1, session, "test cleanup");
        }
    }

    #[test]
    fn a_panic_while_the_registry_is_locked_does_not_break_later_commands() {
        let state = Arc::new(PtyState::default());
        let poisoner = state.clone();
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.sessions.write().unwrap();
            panic!("poison the terminal registry");
        })
        .join();
        assert!(state.sessions.is_poisoned());

        let session = open(&state, 1, "main");
        state.reset_webview("main");
        wait_for("main's output to close", || session.queue_closed());
        let owned = state.take_owned_by("main");
        assert_eq!(owned.len(), 1);
        for (id, session) in owned {
            reap(id, session, "test cleanup");
        }
        assert!(state.take(1).is_none());
    }

    #[test]
    fn presentation_batches_are_bounded_at_the_boundary() {
        assert!(check_presentation_batch(&[]).is_ok());
        assert!(check_presentation_batch(&vec![1; MAX_PRESENTATION_BATCH]).is_ok());
        assert!(check_presentation_batch(&vec![1; MAX_PRESENTATION_BATCH + 1]).is_err());
    }

    #[test]
    fn reloading_a_page_stops_its_terminals_streaming_but_leaves_them_for_pty_close_all() {
        let state = Arc::new(PtyState::default());
        let main = open(&state, 1, "main");
        let other = open(&state, 2, "settings");
        state.reset_webview("main");
        wait_for("main's output to close", || main.queue_closed());
        assert!(!other.queue_closed());
        // Both sessions are still registered: only pty_close_all reaps them.
        assert_eq!(state.sessions.read().unwrap().len(), 2);
        for id in [1, 2] {
            if let Some(session) = state.take(id) {
                reap(id, session, "test cleanup");
            }
        }
    }

    #[test]
    fn a_page_load_reaps_only_its_own_windows_terminals() {
        let state = Arc::new(PtyState::default());
        let _ = open(&state, 1, "main");
        let _ = open(&state, 2, "quick");
        let _ = open(&state, 3, "main");
        let mut drained: Vec<u32> = state
            .take_owned_by("main")
            .into_iter()
            .map(|(id, session)| {
                reap(id, session, "test");
                id
            })
            .collect();
        drained.sort_unstable();
        assert_eq!(drained, [1, 3]);
        assert!(state.sessions.read().unwrap().contains_key(&2));
        assert!(state.take_owned_by("main").is_empty());
        if let Some(session) = state.take(2) {
            reap(2, session, "test cleanup");
        }
    }

    #[test]
    fn destroying_a_webview_closes_exactly_its_terminals() {
        let state = Arc::new(PtyState::default());
        let doomed = open(&state, 1, "main");
        let survivor = open(&state, 2, "settings");
        let pid = doomed.shell_pid as i32;
        drop(doomed);
        state.destroy_webview("main");
        assert!(state.sessions.read().unwrap().get(&1).is_none());
        assert!(state.sessions.read().unwrap().get(&2).is_some());
        wait_for("the shell to be killed", || unsafe {
            let mut status = 0;
            libc::waitpid(pid, &mut status, libc::WNOHANG) == pid || libc::kill(pid, 0) != 0
        });
        assert!(!survivor.queue_closed());
        if let Some(session) = state.take(2) {
            reap(2, session, "test cleanup");
        }
    }
}
