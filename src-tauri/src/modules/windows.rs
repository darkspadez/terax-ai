//! Terax's app windows: `main` (created from `tauri.conf.json`) and the extra
//! windows the user opens (`w-<id>`). Each window keeps its own spaces (a
//! store file), saved scrollback and active chat, so windows never overwrite
//! each other's state; preferences, chats, history and the workspace
//! authorizations stay shared.
//!
//! - The windows open at quit are listed in `<app data>/terax-windows.json`
//!   and reopen at launch. `main` always opens; when it had been closed, it
//!   takes over the first listed window's state, so the same set of windows
//!   comes back.
//! - Closing a window while others stay open discards it, like closing a
//!   browser window: its state goes and it leaves the list. Closing the last
//!   window quits and keeps it for the next launch.
//! - Quitting asks each window in turn, the focused one first, to confirm
//!   (running commands, unsaved files) and save its state, then exits with
//!   every window kept. Any window can cancel.

use std::collections::{HashSet, VecDeque};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_store::StoreExt;

use super::terminal_scrollback;

pub const MAIN: &str = "main";
const EXTRA_PREFIX: &str = "w-";
const REGISTRY_FILE: &str = "terax-windows.json";
/// An extra window's state lives in `windows/<label>/` under the app data.
const WINDOWS_DIRECTORY: &str = "windows";
const MAIN_SPACES_STORE: &str = "terax-spaces.json";
const SPACES_STORE: &str = "terax-spaces.json";
/// The chat store holds each window's active chat under its own key.
const CHAT_STORE: &str = "terax-ai-sessions.json";
const MAIN_ACTIVE_CHAT_KEY: &str = "activeId";
/// Far above any real use; a runaway loop cannot open windows without bound.
const MAX_WINDOWS: usize = 32;

const QUIT_REQUESTED_EVENT: &str = "terax:quit-requested";
const NEW_WINDOW_EVENT: &str = "terax:new-window-requested";

/// `main`, or `w-` and 1 to 32 ASCII letters and digits.
pub fn is_app_window(label: &str) -> bool {
    label == MAIN
        || label.strip_prefix(EXTRA_PREFIX).is_some_and(|id| {
            !id.is_empty() && id.len() <= 32 && id.bytes().all(|b| b.is_ascii_alphanumeric())
        })
}

/// Where a window's state lives under the app data directory: the data
/// directory itself for `main`, as before windows were separate.
pub fn data_root(app_data: &Path, label: &str) -> PathBuf {
    if label == MAIN {
        app_data.to_path_buf()
    } else {
        app_data.join(WINDOWS_DIRECTORY).join(label)
    }
}

/// The window's spaces store, relative to the app data directory (the path
/// the webview gives the store plugin; `appWindow.ts` derives the same).
pub fn spaces_store(label: &str) -> PathBuf {
    if label == MAIN {
        PathBuf::from(MAIN_SPACES_STORE)
    } else {
        Path::new(WINDOWS_DIRECTORY).join(label).join(SPACES_STORE)
    }
}

/// The key of the window's active chat in the chat store.
pub fn active_chat_key(label: &str) -> String {
    if label == MAIN {
        MAIN_ACTIVE_CHAT_KEY.to_owned()
    } else {
        format!("{MAIN_ACTIVE_CHAT_KEY}:{label}")
    }
}

/// The lowest free extra-window label, `w-1` up. Labels are reused so the
/// window-state plugin, which keeps an entry per label for good, holds at
/// most `MAX_WINDOWS` of them.
fn new_label(taken: &HashSet<String>) -> Option<String> {
    (1..=MAX_WINDOWS)
        .map(|n| format!("{EXTRA_PREFIX}{n}"))
        .find(|label| !taken.contains(label))
}

#[derive(Serialize, Deserialize, Default)]
struct RegistryFile {
    windows: Vec<String>,
}

fn read_registry(path: &Path) -> Vec<String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<RegistryFile>(&bytes)
            .map(|file| file.windows)
            .unwrap_or_else(|error| {
                log::warn!("ignoring unreadable window list: {error}");
                Vec::new()
            }),
        Err(_) => Vec::new(),
    }
}

/// Atomic, like the other state files: a reader sees the old list or the new.
fn write_registry(path: &Path, windows: &[String]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("no parent"))?;
    fs::create_dir_all(parent)?;
    let bytes = serde_json::to_vec(&RegistryFile {
        windows: windows.to_vec(),
    })?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(&bytes)?;
    temporary.persist(path).map_err(|e| e.error)?;
    Ok(())
}

/// What to reopen at launch, from the list saved at quit.
#[derive(Debug, PartialEq)]
struct RestorePlan {
    /// The window whose state `main` takes over (`main` had been closed).
    adopt: Option<String>,
    /// Every window to have open, `main` first.
    open: Vec<String>,
}

fn restore_plan(saved: Vec<String>) -> RestorePlan {
    let mut seen = HashSet::new();
    let listed: Vec<String> = saved
        .into_iter()
        .filter(|label| is_app_window(label) && seen.insert(label.clone()))
        .take(MAX_WINDOWS)
        .collect();
    let has_main = listed.iter().any(|label| label == MAIN);
    let mut rest = listed.into_iter().filter(|label| label != MAIN);
    let adopt = if has_main { None } else { rest.next() };
    let mut open = vec![MAIN.to_owned()];
    open.extend(rest);
    RestorePlan { adopt, open }
}

fn remove_path(path: &Path) {
    let result = match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    };
    if let Err(error) = result {
        log::warn!("could not remove {}: {error}", path.display());
    }
}

/// `from` replaces `to` (gone afterwards when `from` is missing).
fn replace_path(from: &Path, to: &Path) {
    remove_path(to);
    if fs::symlink_metadata(from).is_err() {
        return;
    }
    if let Some(parent) = to.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Err(error) = fs::rename(from, to) {
        log::warn!(
            "could not move {} to {}: {error}",
            from.display(),
            to.display()
        );
    }
}

/// Moves `from`'s spaces and scrollback into `main`'s places. Whatever `main`
/// left there was discarded when it closed.
fn adopt_files(app_data: &Path, from: &str) {
    let root = data_root(app_data, from);
    replace_path(
        &app_data.join(spaces_store(from)),
        &app_data.join(spaces_store(MAIN)),
    );
    replace_path(
        &terminal_scrollback::directory(&root),
        &terminal_scrollback::directory(app_data),
    );
    remove_path(&root);
}

/// Deletes a discarded window's spaces and scrollback.
fn forget_files(app_data: &Path, label: &str) {
    if label == MAIN {
        remove_path(&app_data.join(spaces_store(MAIN)));
        remove_path(&terminal_scrollback::directory(app_data));
    } else {
        remove_path(&data_root(app_data, label));
    }
}

struct QuitRound {
    id: u64,
    /// Windows still to ask, in order.
    queue: VecDeque<String>,
    /// The window asked now.
    asking: Option<String>,
}

#[derive(Default)]
struct Inner {
    /// Open app windows in the order they reopen; persisted.
    open: Vec<String>,
    focused: Option<String>,
    /// Windows whose page answers quit requests (`app_window_ready`).
    ready: HashSet<String>,
    quit: Option<QuitRound>,
    next_round: u64,
    /// Set once every window agreed to quit: closing them keeps their state.
    quitting: bool,
    /// The window the settings window was opened over.
    settings_parent: Option<String>,
    /// Discarded windows whose files are still being deleted: their labels
    /// are not reused until then.
    discarding: HashSet<String>,
}

#[derive(Default)]
pub struct WindowsState(Mutex<Inner>);

impl WindowsState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|error| error.into_inner())
    }
}

fn app_data(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok()
}

fn save_open(app: &AppHandle, open: &[String]) {
    let Some(root) = app_data(app) else { return };
    if let Err(error) = write_registry(&root.join(REGISTRY_FILE), open) {
        log::warn!("could not save the window list: {error}");
    }
}

/// Moves (or with `to` None deletes) a window's active-chat key.
fn move_active_chat(app: &AppHandle, from: &str, to: Option<&str>) {
    let store = match app.store(CHAT_STORE) {
        Ok(store) => store,
        Err(error) => {
            log::warn!("could not open the chat store: {error}");
            return;
        }
    };
    let value = store.get(active_chat_key(from));
    store.delete(active_chat_key(from));
    if let (Some(to), Some(value)) = (to, value) {
        store.set(active_chat_key(to), value);
    }
    if let Err(error) = store.save() {
        log::warn!("could not save the chat store: {error}");
    }
}

/// Reopens the windows listed at the last quit. Runs in `setup`, after Tauri
/// created `main` but before any page runs, so no store is loaded yet.
pub fn restore(app: &AppHandle) {
    let Some(root) = app_data(app) else { return };
    let plan = restore_plan(read_registry(&root.join(REGISTRY_FILE)));
    if let Some(from) = &plan.adopt {
        adopt_files(&root, from);
        move_active_chat(app, from, Some(MAIN));
    }
    let state = app.state::<WindowsState>();
    state.lock().open = plan.open.clone();
    save_open(app, &plan.open);
    for label in plan.open.iter().filter(|label| *label != MAIN) {
        if let Err(error) = build(app, label, None, None) {
            log::warn!("could not reopen window {label}: {error}");
            state.lock().open.retain(|open| open != label);
        }
    }
}

fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~/".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Where a new window's first terminal starts (`launchDir.ts` reads it).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum WindowStart<'a> {
    /// The directory of the window it was opened from (New Window).
    Cwd(&'a str),
    /// A folder a later launch of Terax asked it to open: it wins over the
    /// window's restored spaces, like a folder given to the first launch.
    Folder(&'a str),
}

fn window_url(start: Option<WindowStart>) -> String {
    match start {
        Some(WindowStart::Cwd(cwd)) => format!("index.html?cwd={}", percent_encode(cwd)),
        Some(WindowStart::Folder(dir)) => format!("index.html?folder={}", percent_encode(dir)),
        None => "index.html".to_owned(),
    }
}

/// A window like `main` (see `tauri.conf.json` and the platform files),
/// hidden until its page has painted. `near` places it a step down and right
/// of that window.
fn build(
    app: &AppHandle,
    label: &str,
    start: Option<WindowStart>,
    near: Option<&WebviewWindow>,
) -> tauri::Result<WebviewWindow> {
    let url = window_url(start);
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title("Terax")
        .inner_size(800.0, 600.0)
        .min_inner_size(420.0, 280.0)
        .visible(false);
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    #[cfg(target_os = "linux")]
    let builder = builder.decorations(false).transparent(true);
    #[cfg(target_os = "windows")]
    let builder = builder.decorations(false).transparent(true).shadow(false);
    let window = builder.build()?;
    // After the window-state plugin restored what a reused label last had.
    if let Some(near) = near {
        if let (Ok(position), Ok(size)) = (near.outer_position(), near.inner_size()) {
            let step = (28.0 * near.scale_factor().unwrap_or(1.0)).round() as i32;
            let _ = window.set_size(size);
            let _ = window.set_position(tauri::PhysicalPosition::new(
                position.x + step,
                position.y + step,
            ));
        }
    }
    // Some Linux compositors ignore the builder's flag (as for Settings).
    #[cfg(target_os = "linux")]
    {
        let _ = window.set_decorations(false);
    }
    #[cfg(target_os = "macos")]
    super::window_presentation::macos::install_window(app, &window);
    Ok(window)
}

/// Opens a new window near `from`.
pub fn open_new(
    app: &AppHandle,
    from: Option<&str>,
    start: Option<WindowStart>,
) -> Result<String, String> {
    let state = app.state::<WindowsState>();
    let label = {
        let inner = state.lock();
        let taken: HashSet<String> = inner
            .open
            .iter()
            .chain(inner.discarding.iter())
            .cloned()
            .chain(app.webview_windows().into_keys())
            .collect();
        new_label(&taken).ok_or_else(|| format!("At most {MAX_WINDOWS} windows can be open"))?
    };
    let near = from.and_then(|label| app.get_webview_window(label));
    build(app, &label, start, near.as_ref()).map_err(|e| e.to_string())?;
    let open = {
        let mut inner = state.lock();
        inner.open.push(label.clone());
        inner.open.clone()
    };
    save_open(app, &open);
    Ok(label)
}

/// The window app-wide requests go to: the focused app window, else `main`,
/// else any.
pub fn target_window(app: &AppHandle) -> Option<WebviewWindow> {
    let focused = app.state::<WindowsState>().lock().focused.clone();
    focused
        .and_then(|label| app.get_webview_window(&label))
        .or_else(|| app.get_webview_window(MAIN))
        .or_else(|| {
            app.webview_windows()
                .into_iter()
                .find(|(label, _)| is_app_window(label))
                .map(|(_, window)| window)
        })
}

/// Whether `label` is an open app window whose state is kept: false once a
/// closed window was discarded, so a late save cannot bring its files back.
pub fn keeps_state(app: &AppHandle, label: &str) -> bool {
    let state = app.state::<WindowsState>();
    let inner = state.lock();
    // Without a window list (no app data directory) `main` is all there is.
    (inner.open.is_empty() && label == MAIN) || inner.open.iter().any(|open| open == label)
}

/// Remembers the window Settings opens over, so closing it closes Settings.
pub fn set_settings_parent(app: &AppHandle, label: Option<String>) {
    app.state::<WindowsState>().lock().settings_parent = label;
}

/// `New Window` from the native menu: the focused window opens it, so it
/// starts where that window's terminal is.
pub fn request_new_window(app: &AppHandle) {
    match target_window(app) {
        Some(window) => {
            if window
                .emit_to(window.label(), NEW_WINDOW_EVENT, ())
                .is_err()
            {
                let _ = open_new(app, Some(window.label()), None);
            }
        }
        None => {
            let _ = open_new(app, None, None);
        }
    }
}

pub fn on_focus(app: &AppHandle, label: &str) {
    if is_app_window(label) {
        app.state::<WindowsState>().lock().focused = Some(label.to_owned());
    }
}

/// A page (re)started loading: it answers quit requests again only once it
/// says so, and a quit waiting on it moves on.
pub fn on_page_load(app: &AppHandle, label: &str) {
    let state = app.state::<WindowsState>();
    let waiting = {
        let mut inner = state.lock();
        inner.ready.remove(label);
        inner
            .quit
            .as_ref()
            .is_some_and(|round| round.asking.as_deref() == Some(label))
    };
    if waiting {
        advance_quit(app);
    }
}

/// What closing `label` means: discard it when other app windows stay open
/// and the app is not quitting; keep it otherwise.
fn discards(quitting: bool, label: &str, remaining: &[String]) -> bool {
    !quitting && is_app_window(label) && remaining.iter().any(|other| other != label)
}

pub fn on_destroyed(app: &AppHandle, label: &str) {
    if !is_app_window(label) {
        return;
    }
    let remaining: Vec<String> = app
        .webview_windows()
        .into_keys()
        .filter(|other| is_app_window(other) && other != label)
        .collect();
    let state = app.state::<WindowsState>();
    let (discard, waiting, settings_parent) = {
        let mut inner = state.lock();
        inner.ready.remove(label);
        if inner.focused.as_deref() == Some(label) {
            inner.focused = None;
        }
        let waiting = match inner.quit.as_mut() {
            Some(round) => {
                round.queue.retain(|queued| queued != label);
                round.asking.as_deref() == Some(label)
            }
            None => false,
        };
        let discard = discards(inner.quitting, label, &remaining);
        if discard {
            inner.open.retain(|open| open != label);
        }
        let settings_parent = inner.settings_parent.as_deref() == Some(label);
        (discard, waiting, settings_parent)
    };
    if let Some(control) = app.try_state::<super::control::ControlState>() {
        control.forget_window(label);
    }
    super::window_presentation::forget_window(app, label);
    if settings_parent {
        if let Some(settings) = app.get_webview_window("settings") {
            let _ = settings.destroy();
        }
    }
    if waiting {
        advance_quit(app);
    }
    if remaining.is_empty() {
        // The quick terminal floats on its own (not a child window), so it
        // would keep the app alive after the last window.
        if let Some(quick) = app.get_webview_window(super::quick_terminal::LABEL) {
            let _ = quick.destroy();
        }
    }
    if discard {
        let open = state.lock().open.clone();
        save_open(app, &open);
        discard_state(app, label);
    }
}

/// Deletes a discarded window's state. Its spaces store is closed first:
/// dropping it writes any pending autosave, which must land before the files go.
fn discard_state(app: &AppHandle, label: &str) {
    if let Some(store) = app.get_store(spaces_store(label)) {
        store.close_resource();
        drop(store);
    }
    move_active_chat(app, label, None);
    let Some(root) = app_data(app) else { return };
    app.state::<WindowsState>()
        .lock()
        .discarding
        .insert(label.to_owned());
    let label = label.to_owned();
    let gate = app.state::<terminal_scrollback::ScrollbackState>().gate();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // A scrollback save still in flight must not recreate the directory.
        let guard = gate.lock_owned().await;
        let done = label.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let _guard = guard;
            forget_files(&root, &label);
        })
        .await;
        app.state::<WindowsState>().lock().discarding.remove(&done);
    });
}

/// Starts quitting: each window confirms in turn (`terax:quit-requested`,
/// answered by `app_quit_ready`). A second request while one runs brings the
/// window being asked forward.
pub fn request_quit(app: &AppHandle) {
    let state = app.state::<WindowsState>();
    let asking = {
        let mut inner = state.lock();
        if let Some(round) = &inner.quit {
            round.asking.clone()
        } else {
            let existing: HashSet<String> = app
                .webview_windows()
                .into_keys()
                .filter(|label| is_app_window(label))
                .collect();
            let mut queue: VecDeque<String> = VecDeque::new();
            if let Some(focused) = inner.focused.clone() {
                queue.push_back(focused);
            }
            for label in inner.open.iter().chain(existing.iter()) {
                if !queue.contains(label) {
                    queue.push_back(label.clone());
                }
            }
            queue.retain(|label| existing.contains(label));
            inner.next_round += 1;
            let id = inner.next_round;
            inner.quit = Some(QuitRound {
                id,
                queue,
                asking: None,
            });
            None
        }
    };
    match asking {
        Some(label) => {
            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        None => advance_quit(app),
    }
}

/// Asks the next window, or exits when none is left. Windows whose page does
/// not answer requests yet (still loading) have nothing to confirm.
fn advance_quit(app: &AppHandle) {
    let state = app.state::<WindowsState>();
    loop {
        let next = {
            let mut inner = state.lock();
            let ready = inner.ready.clone();
            let Some(round) = inner.quit.as_mut() else {
                return;
            };
            round.asking = None;
            match round.queue.pop_front() {
                Some(label) => {
                    let id = round.id;
                    if ready.contains(&label) {
                        round.asking = Some(label.clone());
                        Some((label, id))
                    } else {
                        continue;
                    }
                }
                None => {
                    inner.quit = None;
                    inner.quitting = true;
                    None
                }
            }
        };
        match next {
            Some((label, id)) => {
                if app
                    .emit_to(label.as_str(), QUIT_REQUESTED_EVENT, id)
                    .is_ok()
                {
                    return;
                }
                // Unreachable page: nothing to confirm there.
            }
            None => {
                let open = state.lock().open.clone();
                save_open(app, &open);
                app.exit(0);
                return;
            }
        }
    }
}

/// A window's answer to quit request `round`: `ok` once it confirmed and
/// saved, else the quit is cancelled.
pub fn quit_answer(app: &AppHandle, label: &str, round: u64, ok: bool) {
    let state = app.state::<WindowsState>();
    let proceed = {
        let mut inner = state.lock();
        let current = inner
            .quit
            .as_ref()
            .is_some_and(|quit| quit.id == round && quit.asking.as_deref() == Some(label));
        if !current {
            return;
        }
        if !ok {
            inner.quit = None;
        }
        ok
    };
    if proceed {
        advance_quit(app);
    }
}

/// Opens a new window near the calling one; returns its label.
#[tauri::command]
pub fn app_window_open(
    app: AppHandle,
    window: tauri::Window,
    cwd: Option<String>,
) -> Result<String, String> {
    open_new(
        &app,
        Some(window.label()),
        cwd.as_deref().map(WindowStart::Cwd),
    )
}

/// The calling page now answers quit requests.
#[tauri::command]
pub fn app_window_ready(app: AppHandle, window: tauri::Window) {
    if is_app_window(window.label()) {
        app.state::<WindowsState>()
            .lock()
            .ready
            .insert(window.label().to_owned());
    }
}

/// Quits Terax once every window has confirmed.
#[tauri::command]
pub fn app_quit(app: AppHandle) {
    request_quit(&app);
}

#[tauri::command]
pub fn app_quit_ready(app: AppHandle, window: tauri::Window, round: u64, ok: bool) {
    quit_answer(&app, window.label(), round, ok);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn window_labels_are_main_or_short_plain_ids() {
        for good in ["main", "w-1", "w-abc123", &format!("w-{}", "a".repeat(32))] {
            assert!(is_app_window(good), "{good}");
        }
        for bad in [
            "",
            "quick",
            "settings",
            "w-",
            "w-a/b",
            "w-../x",
            "w-a b",
            &format!("w-{}", "a".repeat(33)),
            "Main",
        ] {
            assert!(!is_app_window(bad), "{bad:?}");
        }
        let mut taken: HashSet<String> = HashSet::new();
        assert_eq!(new_label(&taken).as_deref(), Some("w-1"));
        taken.insert("w-1".into());
        taken.insert("w-3".into());
        assert_eq!(new_label(&taken).as_deref(), Some("w-2"));
        let full: HashSet<String> = (1..=MAX_WINDOWS).map(|n| format!("w-{n}")).collect();
        assert_eq!(new_label(&full), None);
    }

    #[test]
    fn main_keeps_its_old_places_and_extra_windows_get_their_own() {
        let root = Path::new("/data");
        assert_eq!(data_root(root, "main"), PathBuf::from("/data"));
        assert_eq!(data_root(root, "w-1"), PathBuf::from("/data/windows/w-1"));
        assert_eq!(spaces_store("main"), PathBuf::from("terax-spaces.json"));
        assert_eq!(
            spaces_store("w-1"),
            PathBuf::from("windows/w-1/terax-spaces.json")
        );
        assert_eq!(active_chat_key("main"), "activeId");
        assert_eq!(active_chat_key("w-1"), "activeId:w-1");
    }

    #[test]
    fn launch_reopens_the_listed_windows_with_main_first() {
        assert_eq!(
            restore_plan(vec![]),
            RestorePlan {
                adopt: None,
                open: labels(&["main"])
            }
        );
        assert_eq!(
            restore_plan(labels(&["w-a", "main", "w-b", "w-a", "../x"])),
            RestorePlan {
                adopt: None,
                open: labels(&["main", "w-a", "w-b"])
            }
        );
        // `main` had been closed: it takes over the first window's state.
        assert_eq!(
            restore_plan(labels(&["w-a", "w-b"])),
            RestorePlan {
                adopt: Some("w-a".to_owned()),
                open: labels(&["main", "w-b"])
            }
        );
        let many: Vec<String> = (0..40).map(|i| format!("w-{i}")).collect();
        assert_eq!(restore_plan(many).open.len(), MAX_WINDOWS);
    }

    #[test]
    fn closing_discards_a_window_only_while_another_stays_and_no_quit_runs() {
        assert!(discards(false, "w-a", &labels(&["main"])));
        assert!(discards(false, "main", &labels(&["w-a"])));
        // The last window keeps its state for the next launch.
        assert!(!discards(false, "main", &[]));
        assert!(!discards(false, "w-a", &labels(&["w-a"])));
        // Quitting keeps every window.
        assert!(!discards(true, "w-a", &labels(&["main"])));
        assert!(!discards(false, "settings", &labels(&["main"])));
    }

    #[test]
    fn the_window_list_round_trips_and_a_damaged_file_reads_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(REGISTRY_FILE);
        assert!(read_registry(&path).is_empty());
        write_registry(&path, &labels(&["main", "w-a"])).unwrap();
        assert_eq!(read_registry(&path), labels(&["main", "w-a"]));
        fs::write(&path, b"{not json").unwrap();
        assert!(read_registry(&path).is_empty());
    }

    fn touch(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn main_adopts_a_window_by_taking_its_spaces_and_scrollback() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        touch(&root.join("terax-spaces.json"), "stale main");
        touch(&root.join("terminal-scrollback/old.vt"), "stale");
        touch(&root.join("windows/w-a/terax-spaces.json"), "spaces of a");
        touch(
            &root.join("windows/w-a/terminal-scrollback/sb-1.vt"),
            "history",
        );
        adopt_files(root, "w-a");
        assert_eq!(
            fs::read_to_string(root.join("terax-spaces.json")).unwrap(),
            "spaces of a"
        );
        assert_eq!(
            fs::read_to_string(root.join("terminal-scrollback/sb-1.vt")).unwrap(),
            "history"
        );
        assert!(!root.join("terminal-scrollback/old.vt").exists());
        assert!(!root.join("windows/w-a").exists());
    }

    #[test]
    fn forgetting_a_window_deletes_only_its_state() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        touch(&root.join("terax-spaces.json"), "main");
        touch(&root.join("terminal-scrollback/sb-m.vt"), "main");
        touch(&root.join("windows/w-a/terax-spaces.json"), "a");
        touch(&root.join("windows/w-b/terax-spaces.json"), "b");
        forget_files(root, "w-a");
        assert!(!root.join("windows/w-a").exists());
        assert!(root.join("windows/w-b/terax-spaces.json").exists());
        assert!(root.join("terax-spaces.json").exists());
        forget_files(root, "main");
        assert!(!root.join("terax-spaces.json").exists());
        assert!(!root.join("terminal-scrollback").exists());
        assert!(root.join("windows/w-b/terax-spaces.json").exists());
    }

    #[test]
    fn a_new_window_url_carries_its_directory_encoded() {
        assert_eq!(percent_encode("/home/me/my proj"), "/home/me/my%20proj");
        assert_eq!(percent_encode("C:\\a&b=c#d"), "C%3A%5Ca%26b%3Dc%23d");
        assert_eq!(percent_encode("/ü"), "/%C3%BC");
        assert_eq!(window_url(None), "index.html");
        assert_eq!(
            window_url(Some(WindowStart::Cwd("/home/me/my proj"))),
            "index.html?cwd=/home/me/my%20proj"
        );
        assert_eq!(
            window_url(Some(WindowStart::Folder("C:/work/a&b"))),
            "index.html?folder=C%3A/work/a%26b"
        );
    }
}
