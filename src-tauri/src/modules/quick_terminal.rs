//! The quick terminal: a borderless window that drops down from the top of the
//! screen under the pointer when a global hotkey is pressed, and goes away when
//! it is pressed again (Ghostty's quick terminal, iTerm2's hotkey window).
//!
//! The window is created on first use and kept, so its shell survives being
//! hidden. Its page (`quick.html`) holds one terminal and hides the window when
//! the shell exits or, with autohide, when it loses focus. It is not a child of
//! the main window (it must float above other apps), so the main window's
//! destruction destroys it explicitly (`lib.rs`).

use std::sync::Mutex;

use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalRect, PhysicalSize, Runtime, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub const LABEL: &str = "quick";

/// Share of the work area's height the window takes.
const HEIGHT_FRACTION: f64 = 0.4;

/// The registered hotkey, so a new choice replaces it.
#[derive(Default)]
pub struct QuickTerminalState {
    hotkey: Mutex<Option<Shortcut>>,
}

/// The window's frame: the work area's full width, from its top edge, at
/// `HEIGHT_FRACTION` of its height (never less than 120 px).
pub fn frame(work_area: PhysicalRect<i32, u32>) -> (PhysicalPosition<i32>, PhysicalSize<u32>) {
    let height = ((f64::from(work_area.size.height) * HEIGHT_FRACTION).round() as u32).clamp(
        120.min(work_area.size.height).max(1),
        work_area.size.height.max(1),
    );
    (
        work_area.position,
        PhysicalSize::new(work_area.size.width.max(1), height),
    )
}

/// Moves the window to the top of the monitor under the pointer (the primary
/// monitor when that is unknown).
fn place<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) -> Result<(), String> {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|point| app.monitor_from_point(point.x, point.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let (position, size) = frame(*monitor.work_area());
    window.set_size(size).map_err(|e| e.to_string())?;
    window.set_position(position).map_err(|e| e.to_string())
}

/// Shows the quick terminal, creating it on first use, or hides it when it is
/// already in front.
pub fn toggle<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        let in_front = window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false);
        if in_front {
            return window.hide().map_err(|e| e.to_string());
        }
        place(app, &window)?;
        window.show().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("quick.html".into()))
        .title("Terax Quick Terminal")
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible_on_all_workspaces(true)
        // The page shows and focuses it after its first paint (quick/main.tsx).
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    place(app, &window)
}

#[tauri::command]
pub fn quick_terminal_toggle(app: AppHandle) -> Result<(), String> {
    toggle(&app)
}

/// Registers `accelerator` (Tauri's syntax, e.g. "CommandOrControl+`") as the
/// global hotkey, replacing the previous one; none or an empty string turns
/// the hotkey off. Fails when the accelerator is invalid or the system refuses
/// it (taken by another app, or a Wayland session without global shortcuts);
/// the previous hotkey is then gone too, so nothing stale stays bound.
#[tauri::command]
pub fn quick_terminal_set_hotkey(
    app: AppHandle,
    state: tauri::State<'_, QuickTerminalState>,
    accelerator: Option<String>,
) -> Result<(), String> {
    let mut current = state
        .hotkey
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let accelerator = accelerator
        .map(|a| a.trim().to_owned())
        .filter(|a| !a.is_empty());
    let parsed = accelerator.as_deref().map(str::parse::<Shortcut>);
    // Every app window applies the preference when it opens: the hotkey
    // already registered stays as it is.
    if let (Some(Ok(shortcut)), Some(registered)) = (&parsed, current.as_ref()) {
        if shortcut == registered {
            return Ok(());
        }
    }
    if let Some(previous) = current.take() {
        let _ = app.global_shortcut().unregister(previous);
    }
    let (Some(accelerator), Some(parsed)) = (accelerator, parsed) else {
        return Ok(());
    };
    let shortcut: Shortcut = parsed.map_err(|e| format!("invalid hotkey {accelerator:?}: {e}"))?;
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                if let Err(error) = toggle(app) {
                    log::warn!("quick terminal: {error}");
                }
            }
        })
        .map_err(|e| format!("could not register {accelerator:?}: {e}"))?;
    *current = Some(shortcut);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area(x: i32, y: i32, width: u32, height: u32) -> PhysicalRect<i32, u32> {
        PhysicalRect {
            position: PhysicalPosition::new(x, y),
            size: PhysicalSize::new(width, height),
        }
    }

    #[test]
    fn drops_down_from_the_top_of_the_work_area_at_full_width() {
        // A second monitor left of the primary, below a 25 px menu bar.
        let (position, size) = frame(area(-2560, 25, 2560, 1415));
        assert_eq!(position, PhysicalPosition::new(-2560, 25));
        assert_eq!(size, PhysicalSize::new(2560, 566));
    }

    #[test]
    fn stays_usable_and_inside_tiny_work_areas() {
        assert_eq!(frame(area(0, 0, 800, 200)).1, PhysicalSize::new(800, 120));
        assert_eq!(frame(area(0, 0, 800, 90)).1, PhysicalSize::new(800, 90));
        assert_eq!(frame(area(0, 0, 0, 0)).1, PhysicalSize::new(1, 1));
    }

    #[test]
    fn accepts_the_offered_hotkeys() {
        for accelerator in [
            "CommandOrControl+`",
            "Control+`",
            "Alt+Space",
            "CommandOrControl+Shift+Space",
            "F12",
        ] {
            assert!(accelerator.parse::<Shortcut>().is_ok(), "{accelerator}");
        }
    }
}
