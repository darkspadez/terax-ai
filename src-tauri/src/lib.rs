pub mod modules;

#[cfg(target_os = "macos")]
use modules::app_menu;
use modules::{
    agent, control, fs, git, history, lsp, net, primary_selection, pty, secrets, shell, vibrancy,
    windows, workspace,
};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use tauri::PhysicalPosition;
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_window_state::StateFlags;

/// The folder Terax was launched with (not a launched file's parent), until
/// the main window reads it: drained so HMR / re-mounts can't replay it.
struct LaunchDir(Mutex<LaunchFolder>);

enum LaunchFolder {
    Unread(Option<String>),
    Read,
}

impl LaunchDir {
    fn new(folder: Option<String>) -> Self {
        Self(Mutex::new(LaunchFolder::Unread(folder)))
    }

    fn take(&self) -> Option<String> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match std::mem::replace(&mut *state, LaunchFolder::Read) {
            LaunchFolder::Unread(folder) => folder,
            LaunchFolder::Read => None,
        }
    }

    /// A folder opened before the main window read its launch folder becomes
    /// that folder; false once it was read (or one is already there).
    #[cfg(any(target_os = "macos", test))]
    fn seed(&self, folder: String) -> bool {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *state {
            LaunchFolder::Unread(slot @ None) => {
                *slot = Some(folder);
                true
            }
            _ => false,
        }
    }
}

/// Drained on first read so HMR / re-mounts can't replay the launch files.
#[derive(Default)]
struct LaunchFiles(Mutex<Vec<String>>);

#[tauri::command]
fn get_launch_dir(state: State<'_, LaunchDir>) -> Option<String> {
    state.take()
}

#[tauri::command]
fn get_launch_files(state: State<'_, LaunchFiles>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().expect("LaunchFiles mutex poisoned"))
}

enum LaunchEntry {
    Dir(PathBuf),
    File(PathBuf),
}

#[derive(Default, Debug, PartialEq)]
struct LaunchTarget {
    dir: Option<String>,
    /// The first dir arg: a folder the user asked Terax to open.
    folder: Option<String>,
    files: Vec<String>,
}

/// First dir arg (else the first file's parent) becomes the workspace; every
/// file arg is opened. Kept free of fs/env access so it stays unit-testable.
fn resolve_launch_target(entries: Vec<LaunchEntry>) -> LaunchTarget {
    let mut dir = None;
    let mut folder = None;
    let mut files = Vec::new();
    for entry in entries {
        match entry {
            LaunchEntry::Dir(path) => {
                if folder.is_none() {
                    folder = Some(fs::to_canon(&path));
                }
                if dir.is_none() {
                    dir = folder.clone();
                }
            }
            LaunchEntry::File(path) => {
                if dir.is_none() {
                    dir = path.parent().map(fs::to_canon);
                }
                files.push(fs::to_canon(&path));
            }
        }
    }
    LaunchTarget { dir, folder, files }
}

fn parse_launch_target() -> LaunchTarget {
    parse_launch_args(std::env::args().skip(1), None)
}

/// Paths among `args` (flags skipped), relative ones taken from `cwd` when
/// given (a later launch's directory) else from this process's.
fn parse_launch_args(args: impl IntoIterator<Item = String>, cwd: Option<&Path>) -> LaunchTarget {
    let entries = args
        .into_iter()
        .filter(|arg| !arg.starts_with('-'))
        .map(|arg| match cwd {
            Some(cwd) => cwd.join(arg),
            None => PathBuf::from(arg),
        })
        .filter_map(launch_entry)
        .collect();
    resolve_launch_target(entries)
}

fn launch_entry(path: PathBuf) -> Option<LaunchEntry> {
    let path = std::fs::canonicalize(path).ok()?;
    Some(if std::fs::metadata(&path).ok()?.is_dir() {
        LaunchEntry::Dir(path)
    } else {
        LaunchEntry::File(path)
    })
}

#[tauri::command]
async fn open_settings_window(app: tauri::AppHandle, tab: Option<String>) -> Result<(), String> {
    let url_path = match tab.as_deref() {
        Some(t) if !t.is_empty() => format!("settings.html?tab={}", t),
        _ => "settings.html".to_string(),
    };

    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.set_focus();
        if let Some(t) = tab.as_deref().filter(|s| !s.is_empty()) {
            // emit() serializes via JSON — no string-escape footgun, unlike
            // eval() with format!(). Frontend listens via Tauri event API.
            let _ = window.emit("terax:settings-tab", t);
        }
        return Ok(());
    }

    let builder = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App(url_path.into()))
        .title("Settings")
        .inner_size(900.0, 700.0)
        .min_inner_size(820.0, 620.0)
        .resizable(true)
        .visible(false);

    // A normal-level child (an owned window on Windows, a transient one on
    // Linux) stays above the window it opens over and recedes with the app.
    // Never always_on_top: that floats it over every other app (#957), and
    // with the macOS parent it breaks WebView compositing (#33).
    // It opens over the window in front, and closes with it.
    let parent = windows::target_window(&app);
    let builder = if let Some(parent) = &parent {
        builder.parent(parent).map_err(|e| e.to_string())?
    } else {
        builder
    };
    windows::set_settings_parent(&app, parent.as_ref().map(|w| w.label().to_owned()));

    // The traffic lights sit centred on the Settings header, 4 px taller
    // than an app window's.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .traffic_light_position(tauri::LogicalPosition::new(
            windows::TRAFFIC_LIGHTS.0,
            windows::TRAFFIC_LIGHTS.1 + 2.0,
        ))
        .hidden_title(true);

    // On Linux/Windows we render our own titlebar, so drop native chrome
    // and make the window transparent.
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    let builder = builder.decorations(false).transparent(true);

    #[cfg_attr(windows, allow(unused_variables))]
    let window = builder.build().map_err(|e| e.to_string())?;

    // Some Linux compositors (GNOME/Mutter with CSD-by-default) ignore the
    // builder-time decorations flag — re-assert it after realize.
    #[cfg(target_os = "linux")]
    {
        let _ = window.set_decorations(false);
    }

    #[cfg(target_os = "macos")]
    if let Some(main) = parent {
        if let (Ok(main_pos), Ok(main_size), Ok(settings_size)) = (
            main.outer_position(),
            main.outer_size(),
            window.outer_size(),
        ) {
            let x = main_pos.x
                + ((main_size.width as i32).saturating_sub(settings_size.width as i32)) / 2;
            let y = main_pos.y
                + ((main_size.height as i32).saturating_sub(settings_size.height as i32)) / 2;
            let _ = window.set_position(PhysicalPosition::new(x, y));
        } else {
            let _ = window.center();
        }
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    {
        let args: Vec<String> = std::env::args().collect();
        if args.get(1).map(String::as_str) == Some("__terax_notify") {
            if let (Some(agent), Some(event)) = (args.get(2), args.get(3)) {
                agent::emit_conout_marker(agent, event);
            }
            use std::io::Write;
            let mut out = std::io::stdout();
            let _ = out.write_all(b"{}");
            let _ = out.flush();
            std::process::exit(0);
        }
    }

    modules::panics::install_log_hook();
    modules::runtime::install();

    let launch = parse_launch_target();
    let cli_dir = launch.dir.clone();
    workspace::init_launch_cwd(cli_dir.as_deref());
    let control_state = control::ControlState::default();
    let control_for_setup = control_state.clone();

    let builder = tauri::Builder::default();
    // First, so a later launch hands over before anything else starts. Debug
    // builds skip it: a dev build would otherwise hand off to an installed
    // Terax (same identifier) and exit.
    let builder = if cfg!(debug_assertions) {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(
            modules::second_launch::on_second_launch,
        ))
    };
    let builder = builder.plugin(tauri_plugin_clipboard_manager::init());
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(app_menu::build)
        .on_menu_event(app_menu::handle_event);
    builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Skip restoring VISIBLE — frontend calls window.show() after first
        // paint so the user never sees a transparent window-shadow flash on
        // Windows/Linux.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                // Placed under the pointer on every show, never restored.
                .with_denylist(&[modules::quick_terminal::LABEL])
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        // One async scheme multiplexes every terminal's output; see pty/hub.rs.
        .register_asynchronous_uri_scheme_protocol("terax-pty", pty::stream_protocol)
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                if let Some(state) = webview.try_state::<net::AiStreamState>() {
                    state.cancel_window(webview.window().label());
                }
                if let Some(state) = webview.try_state::<pty::PtyState>() {
                    state.reset_webview(webview.label());
                }
                if let Some(state) = webview.try_state::<fs::watch::FsWatchState>() {
                    state.release_window(webview.app_handle(), webview.label());
                }
                windows::on_page_load(webview.app_handle(), webview.label());
            }
        })
        .setup(move |_app| {
            #[cfg(feature = "bench")]
            modules::bench::guard(_app.handle())?;
            #[cfg(target_os = "macos")]
            modules::window_presentation::macos::install(_app.handle());
            #[cfg(target_os = "linux")]
            modules::color_scheme::follow();
            if let Err(error) = control::start(_app.handle().clone(), control_for_setup.clone()) {
                log::warn!("could not start Terax control server: {error}");
            }
            // After `main` exists, before any page runs.
            windows::restore(_app.handle());
            Ok(())
        })
        .manage(pty::PtyState::default())
        .manage(net::AiStreamState::default())
        .manage(modules::ai_sessions::SessionFilesState::default())
        .manage(modules::terminal_scrollback::ScrollbackState::default())
        .manage(modules::window_presentation::WindowPresentationState::default())
        .manage(control_state)
        .manage(shell::ShellState::default())
        .manage(secrets::SecretsState::default())
        .manage(primary_selection::PrimarySelection::default())
        .manage(modules::quick_terminal::QuickTerminalState::default())
        .manage(windows::WindowsState::default())
        .manage(modules::system_fonts::SystemFontsState::default())
        .manage(fs::watch::FsWatchState::default())
        .manage(history::HistoryState::default())
        .manage(lsp::LspState::default())
        .manage(fs::supersede::Supersede::default())
        .manage(fs::index::FileIndexState::default())
        .manage({
            let registry = workspace::WorkspaceRegistry::default();
            workspace::bootstrap_registry(&registry);
            if let Some(ref launch_dir) = cli_dir {
                let _ = registry.authorize(launch_dir);
            }
            registry
        })
        .manage(LaunchDir::new(launch.folder))
        .manage(LaunchFiles(Mutex::new(launch.files)))
        .invoke_handler(tauri::generate_handler![
            pty::pty_open,
            pty::pty_write,
            pty::pty_stream_open,
            pty::pty_set_presentation,
            pty::pty_diagnostics,
            pty::pty_resize,
            pty::pty_close,
            pty::pty_close_all,
            pty::pty_has_foreground_process,
            pty::pty_has_foreground_job,
            pty::pty_shell_name,
            pty::pty_list_shells,
            fs::tree::list_subdirs,
            fs::tree::fs_read_dir,
            fs::file::fs_read_file,
            fs::file::fs_write_file,
            fs::file::fs_stat,
            fs::file::fs_host_path,
            fs::file::fs_canonicalize,
            fs::file::fs_open_default,
            fs::mutate::fs_create_file,
            fs::mutate::fs_create_dir,
            fs::mutate::fs_rename,
            fs::mutate::fs_move,
            fs::mutate::fs_delete,
            fs::mutate::fs_delete_batch,
            fs::copy::fs_copy,
            fs::clipboard::fs_clipboard_paths,
            modules::clipboard_image::clipboard_image_read,
            modules::clipboard_image::clipboard_image_write,
            primary_selection::terminal_primary_selection_write,
            primary_selection::terminal_primary_selection_read,
            modules::quick_terminal::quick_terminal_toggle,
            modules::quick_terminal::quick_terminal_set_hotkey,
            fs::watch::fs_watch_add,
            fs::watch::fs_watch_remove,
            fs::watch::git_watch_add,
            fs::watch::git_watch_remove,
            lsp::lsp_detect,
            lsp::lsp_host_pid,
            lsp::lsp_resolve_root,
            lsp::lsp_spawn,
            lsp::lsp_send,
            lsp::lsp_kill,
            fs::search::fs_search,
            fs::search::fs_list_files,
            fs::grep::fs_grep,
            fs::grep::fs_grep_interactive,
            fs::grep::fs_glob,
            git::commands::git_resolve_repo,
            git::commands::git_panel_snapshot,
            git::commands::git_status,
            git::commands::git_diff,
            git::commands::git_diff_content,
            git::commands::git_file_base,
            git::commands::git_stage,
            git::commands::git_unstage,
            git::commands::git_discard,
            git::commands::git_commit,
            git::commands::git_undo_commit,
            git::commands::git_commit_on_remote,
            git::commands::git_fetch,
            git::commands::git_pull_ff_only,
            git::commands::git_push,
            git::commands::git_log,
            git::commands::git_show_commit,
            git::commands::git_commit_files,
            git::commands::git_commit_file_diff,
            git::commands::git_remote_url,
            git::commands::git_list_branches,
            git::commands::git_discover_repos,
            git::commands::git_checkout_branch,
            shell::shell_run_command,
            shell::shell_session_open,
            shell::shell_session_run,
            shell::shell_session_close,
            shell::shell_bg_spawn,
            shell::shell_bg_logs,
            shell::shell_bg_kill,
            shell::shell_bg_list,
            workspace::wsl_list_distros,
            workspace::wsl_default_distro,
            workspace::ipc::wsl_home,
            workspace::workspace_authorize,
            workspace::workspace_current_dir,
            control::control_frontend_ready,
            control::control_respond,
            get_launch_dir,
            get_launch_files,
            open_settings_window,
            agent::agent_enable_hooks,
            agent::agent_hooks_status,
            secrets::secrets_get,
            secrets::secrets_set,
            secrets::secrets_delete,
            secrets::secrets_get_all,
            net::lm_ping,
            net::image::markdown_remote_image,
            net::ai_http_stream,
            net::ai_http_cancel,
            net::ai_http_ack,
            modules::ai_sessions::ai_session_load,
            modules::ai_sessions::ai_session_save,
            modules::ai_sessions::ai_session_delete,
            modules::ai_sessions::ai_session_finish_migration,
            modules::ai_sessions::ai_session_prune_backup,
            modules::terminal_scrollback::terminal_scrollback_save,
            modules::terminal_scrollback::terminal_scrollback_load,
            modules::terminal_scrollback::terminal_scrollback_retain,
            history::history_suggest,
            history::history_commands,
            history::history_record,
            history::history_list,
            vibrancy::window_backdrop_kind,
            vibrancy::window_set_backdrop,
            modules::window_presentation::window_presentation_state,
            modules::system_fonts::system_font_faces,
            windows::app_window_open,
            windows::app_window_ready,
            windows::app_quit,
            windows::app_quit_ready,
            #[cfg(feature = "bench")]
            modules::bench::bench_config,
            #[cfg(feature = "bench")]
            modules::bench::bench_window,
            #[cfg(feature = "bench")]
            modules::bench::bench_exit,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::Focused(true),
                    ..
                } => windows::on_focus(app, &label),
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::Destroyed,
                    ..
                } => {
                    if let Some(state) = app.try_state::<net::AiStreamState>() {
                        state.cancel_window(&label);
                    }
                    if let Some(state) = app.try_state::<pty::PtyState>() {
                        state.destroy_webview(&label);
                    }
                    if let Some(state) = app.try_state::<fs::watch::FsWatchState>() {
                        state.release_window(app, &label);
                    }
                    windows::on_destroyed(app, &label);
                }
                // Servers exit on stdin EOF, but destructors are not guaranteed
                // on process exit; kill explicitly.
                tauri::RunEvent::Exit => {
                    #[cfg(target_os = "macos")]
                    modules::window_presentation::macos::uninstall();
                    if let Some(state) = app.try_state::<lsp::LspState>() {
                        state.kill_all();
                    }
                    if let Some(state) = app.try_state::<control::ControlState>() {
                        state.shutdown();
                    }
                }
                // macOS delivers "Open With" files here, not as argv (cold and
                // warm start, several at once). Seed the drain-once state and
                // emit; canonicalize so the /tmp -> /private/tmp symlink can't
                // defeat openFileTab's path dedupe against a CLI launch.
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Opened { urls } => {
                    let entries = urls
                        .iter()
                        .filter_map(|u| u.to_file_path().ok())
                        .filter_map(launch_entry)
                        .collect();
                    let target = resolve_launch_target(entries);
                    if let Some(dir) = &target.dir {
                        if let Some(registry) = app.try_state::<workspace::WorkspaceRegistry>() {
                            let _ = registry.authorize(dir);
                        }
                    }
                    // A folder (Open With, dropped on the Dock icon) is a launch
                    // folder while the main window has not started, later it
                    // opens in a new window, as from the command line.
                    if let Some(folder) = target.folder {
                        let seeded = app
                            .try_state::<LaunchDir>()
                            .is_some_and(|state| state.seed(folder.clone()));
                        if !seeded {
                            modules::second_launch::open_folder(app, folder);
                        }
                    }
                    if target.files.is_empty() {
                        return;
                    }
                    if let Some(state) = app.try_state::<LaunchFiles>() {
                        *state.0.lock().expect("LaunchFiles mutex poisoned") = target.files.clone();
                    }
                    // One window opens them: the one in front.
                    if let Some(window) = windows::target_window(app) {
                        let _ = window.emit_to(window.label(), "terax:open-file", target.files);
                    }
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod launch_target_tests {
    use super::{parse_launch_args, resolve_launch_target, LaunchDir, LaunchEntry, LaunchTarget};
    use std::path::PathBuf;

    #[test]
    fn no_entries_resolves_to_empty() {
        assert_eq!(resolve_launch_target(vec![]), LaunchTarget::default());
    }

    #[test]
    fn dir_arg_sets_workspace_and_opens_nothing() {
        let out = resolve_launch_target(vec![LaunchEntry::Dir(PathBuf::from("/home/u/proj"))]);
        assert_eq!(out.dir.as_deref(), Some("/home/u/proj"));
        assert_eq!(out.folder.as_deref(), Some("/home/u/proj"));
        assert!(out.files.is_empty());
    }

    #[test]
    fn file_arg_opens_file_and_uses_parent_as_workspace() {
        let out = resolve_launch_target(vec![LaunchEntry::File(PathBuf::from(
            "/home/u/proj/main.rs",
        ))]);
        assert_eq!(out.dir.as_deref(), Some("/home/u/proj"));
        assert_eq!(out.folder, None);
        assert_eq!(out.files, vec!["/home/u/proj/main.rs".to_string()]);
    }

    #[test]
    fn multiple_files_all_open_and_first_parent_wins() {
        let out = resolve_launch_target(vec![
            LaunchEntry::File(PathBuf::from("/a/one.txt")),
            LaunchEntry::File(PathBuf::from("/b/two.txt")),
        ]);
        assert_eq!(out.dir.as_deref(), Some("/a"));
        assert_eq!(
            out.files,
            vec!["/a/one.txt".to_string(), "/b/two.txt".to_string()]
        );
    }

    #[test]
    fn explicit_dir_takes_precedence_over_file_parent() {
        let out = resolve_launch_target(vec![
            LaunchEntry::Dir(PathBuf::from("/workspace")),
            LaunchEntry::File(PathBuf::from("/other/x.rs")),
        ]);
        assert_eq!(out.dir.as_deref(), Some("/workspace"));
        assert_eq!(out.files, vec!["/other/x.rs".to_string()]);
    }

    #[test]
    fn a_later_launch_resolves_its_arguments_from_its_own_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let launch = tmp.path().join("launched-from");
        std::fs::create_dir_all(launch.join("proj")).unwrap();
        std::fs::write(launch.join("notes.md"), "").unwrap();
        let canon = |rel: &str| super::fs::to_canon(launch.join(rel).canonicalize().unwrap());

        let out = parse_launch_args(
            ["--path", "proj", "notes.md", "missing"].map(String::from),
            Some(&launch),
        );

        assert_eq!(out.dir, Some(canon("proj")));
        assert_eq!(out.folder, Some(canon("proj")));
        assert_eq!(out.files, vec![canon("notes.md")]);
    }

    #[test]
    fn the_launch_folder_is_read_once_and_taken_before_that_only() {
        let state = LaunchDir::new(None);
        assert!(state.seed("/opened".into()));
        assert!(!state.seed("/second".into()));
        assert_eq!(state.take().as_deref(), Some("/opened"));
        assert_eq!(state.take(), None);
        // Read: a later folder opens a window instead.
        assert!(!state.seed("/later".into()));

        let launched = LaunchDir::new(Some("/cli".into()));
        assert!(!launched.seed("/opened".into()));
        assert_eq!(launched.take().as_deref(), Some("/cli"));
    }

}
