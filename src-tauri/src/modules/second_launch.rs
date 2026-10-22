//! A later launch of Terax (Open in Terax, `terax <dir>`, a launcher) while
//! one runs: `tauri-plugin-single-instance` hands its arguments and directory
//! to the running process, which opens them, instead of a second process
//! starting on the same state files.

use std::path::PathBuf;

use tauri::{Emitter, Manager};

use super::{fs, windows, workspace};
use crate::{parse_launch_args, LaunchFiles, LaunchTarget};

/// Tells a window that files wait for it in `get_launch_files`.
const OPEN_FILES_EVENT: &str = "terax:open-file";

/// What a later launch asks the running process to do.
#[derive(Debug, PartialEq)]
enum SecondLaunch {
    /// Open the files in the window in front.
    Files {
        dir: Option<String>,
        files: Vec<String>,
    },
    /// Open a new window on the folder.
    Folder(String),
    /// Open a new window, its first terminal in the launch's directory when
    /// that is a usable one.
    Window { cwd: Option<String> },
}

fn second_launch(target: LaunchTarget, cwd: Option<String>) -> SecondLaunch {
    match target {
        LaunchTarget { dir, files, .. } if !files.is_empty() => SecondLaunch::Files { dir, files },
        LaunchTarget {
            folder: Some(folder),
            ..
        } => SecondLaunch::Folder(folder),
        LaunchTarget { folder: None, .. } => SecondLaunch::Window { cwd },
    }
}

pub fn on_second_launch(app: &tauri::AppHandle, args: Vec<String>, cwd: String) {
    let cwd = PathBuf::from(cwd);
    let target = parse_launch_args(args.into_iter().skip(1), Some(&cwd));
    let cwd = workspace::is_usable_launch_dir(&cwd).then(|| fs::to_canon(&cwd));
    let action = second_launch(target, cwd);
    log::info!("later launch forwarded: {action:?}");
    forward(app, action);
}

/// A folder macOS opens in the running Terax (Open With, the Dock icon).
#[cfg(target_os = "macos")]
pub fn open_folder(app: &tauri::AppHandle, folder: String) {
    forward(app, SecondLaunch::Folder(folder));
}

/// Opens files in the window in front, which it returns. They are queued for
/// its page, which takes them once its tabs are restored (`get_launch_files`),
/// and announced, so a page that is already up takes them at once.
pub fn open_files(app: &tauri::AppHandle, files: Vec<String>) -> Option<tauri::WebviewWindow> {
    if files.is_empty() {
        return None;
    }
    let window = windows::target_window(app);
    let label = window
        .as_ref()
        .map_or(windows::MAIN, |window| window.label());
    if let Some(state) = app.try_state::<LaunchFiles>() {
        state.queue(label, files);
    }
    let window = window?;
    let _ = window.emit_to(window.label(), OPEN_FILES_EVENT, ());
    Some(window)
}

/// Called on the plugin's thread, inside the Windows message handler or an
/// event callback: queue the work for the event loop instead of building
/// windows here.
fn forward(app: &tauri::AppHandle, action: SecondLaunch) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || open_second_launch(&handle, action));
    });
}

fn open_second_launch(app: &tauri::AppHandle, action: SecondLaunch) {
    let authorize = |dir: &str| {
        if let Some(registry) = app.try_state::<workspace::WorkspaceRegistry>() {
            let _ = registry.authorize(dir);
        }
    };
    let opened = match action {
        SecondLaunch::Files { dir, files } => {
            if let Some(dir) = &dir {
                authorize(dir);
            }
            match open_files(app, files) {
                Some(window) => {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                    Ok(())
                }
                None => Err("no window is open".to_owned()),
            }
        }
        SecondLaunch::Folder(dir) => {
            authorize(&dir);
            windows::open_new(app, None, Some(windows::WindowStart::Folder(&dir))).map(drop)
        }
        SecondLaunch::Window { cwd } => {
            if let Some(cwd) = &cwd {
                authorize(cwd);
            }
            windows::open_new(app, None, cwd.as_deref().map(windows::WindowStart::Cwd)).map(drop)
        }
    };
    if let Err(error) = opened {
        log::warn!("could not open what a later launch asked for: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_later_launch_opens_files_else_its_folder_else_a_window() {
        let files = LaunchTarget {
            dir: Some("/a".into()),
            folder: None,
            files: vec!["/a/x.rs".into()],
        };
        assert_eq!(
            second_launch(files, Some("/cwd".into())),
            SecondLaunch::Files {
                dir: Some("/a".into()),
                files: vec!["/a/x.rs".into()],
            }
        );
        let folder = LaunchTarget {
            dir: Some("/proj".into()),
            folder: Some("/proj".into()),
            files: vec![],
        };
        assert_eq!(
            second_launch(folder, Some("/cwd".into())),
            SecondLaunch::Folder("/proj".into())
        );
        assert_eq!(
            second_launch(LaunchTarget::default(), Some("/cwd".into())),
            SecondLaunch::Window {
                cwd: Some("/cwd".into())
            }
        );
        assert_eq!(
            second_launch(LaunchTarget::default(), None),
            SecondLaunch::Window { cwd: None }
        );
    }
}
