use tauri::{
    menu::{
        AboutMetadata, Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem, Submenu,
        HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
    },
    AppHandle, Runtime,
};

use super::windows;

const GUARDED_QUIT_MENU_ID: &str = "terax.quit";
const QUIT_ACCELERATOR: &str = "Command+Q";
const NEW_WINDOW_MENU_ID: &str = "terax.new-window";
const NEW_WINDOW_ACCELERATOR: &str = "Command+Shift+N";
const CLOSE_TAB_MENU_ID: &str = "terax.close-tab";
const CLOSE_TAB_ACCELERATOR: &str = "Command+W";
const CLOSE_WINDOW_MENU_ID: &str = "terax.close-window";
const CLOSE_WINDOW_ACCELERATOR: &str = "Command+Shift+W";

fn is_guarded_quit(id: &MenuId) -> bool {
    id == GUARDED_QUIT_MENU_ID
}

/// The macOS menu bar, built whole rather than by editing `Menu::default` in
/// place: the app menu, the one whose predefined Quit used to be removed and
/// replaced, stayed open after Escape or a click elsewhere. Quit, New Window,
/// Close Tab and Close Window are ours; the rest are AppKit's own items.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let package = app.package_info();
    let config = app.config();
    let name = package.name.clone();
    let about = AboutMetadata {
        name: Some(name.clone()),
        version: Some(package.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    let app_menu = Submenu::with_items(
        app,
        &name,
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            // Every window confirms running commands and unsaved files first,
            // which AppKit's terminate: would not ask.
            &MenuItem::with_id(
                app,
                GUARDED_QUIT_MENU_ID,
                format!("Quit {name}"),
                true,
                Some(QUIT_ACCELERATOR),
            )?,
        ],
    )?;

    // Close Tab reaches the window even while a preview frame has the
    // keyboard, where the page's own Command+W binding never sees the key.
    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(
                app,
                NEW_WINDOW_MENU_ID,
                "New Window",
                true,
                Some(NEW_WINDOW_ACCELERATOR),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                CLOSE_TAB_MENU_ID,
                "Close Tab",
                true,
                Some(CLOSE_TAB_ACCELERATOR),
            )?,
            &MenuItem::with_id(
                app,
                CLOSE_WINDOW_MENU_ID,
                "Close Window",
                true,
                Some(CLOSE_WINDOW_ACCELERATOR),
            )?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(app, None)?],
    )?;

    let window_menu = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
        ],
    )?;

    let help_menu = Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[])?;

    Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ],
    )
}

pub fn handle_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id();
    if is_guarded_quit(id) {
        windows::request_quit(app);
    } else if id == NEW_WINDOW_MENU_ID {
        windows::request_new_window(app);
    } else if id == CLOSE_TAB_MENU_ID {
        windows::request_close_tab(app);
    } else if id == CLOSE_WINDOW_MENU_ID {
        windows::close_key_window(app);
    }
}

#[cfg(test)]
mod tests {
    use super::{is_guarded_quit, GUARDED_QUIT_MENU_ID};
    use tauri::menu::MenuId;

    #[test]
    fn only_guarded_quit_id_requests_window_close() {
        assert!(is_guarded_quit(&MenuId::new(GUARDED_QUIT_MENU_ID)));
        assert!(!is_guarded_quit(&MenuId::new("unrelated")));
    }
}
