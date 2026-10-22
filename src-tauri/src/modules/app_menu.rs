use std::sync::{Mutex, PoisonError};

use tauri::{
    menu::{
        AboutMetadata, IsMenuItem, Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem, Submenu,
        HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
    },
    AppHandle, Emitter, Runtime,
};

use super::menu_shortcuts::{MenuAccelerators, MenuShortcut};
use super::windows;

const GUARDED_QUIT_MENU_ID: &str = "terax.quit";
const QUIT_ACCELERATOR: &str = "Command+Q";
const NEW_WINDOW_MENU_ID: &str = "terax.new-window";
const NEW_WINDOW_ACCELERATOR: &str = "Command+Shift+N";
const CLOSE_TAB_MENU_ID: &str = "terax.close-tab";
const CLOSE_TAB_ACCELERATOR: &str = "Command+W";
const CLOSE_WINDOW_MENU_ID: &str = "terax.close-window";
const CLOSE_WINDOW_ACCELERATOR: &str = "Command+Shift+W";
const MENU_SHORTCUT_EVENT: &str = "terax:menu-shortcut";

/// The key equivalents the menu bar was last built with.
static CARRIED: Mutex<Option<MenuAccelerators>> = Mutex::new(None);

fn is_guarded_quit(id: &MenuId) -> bool {
    id == GUARDED_QUIT_MENU_ID
}

/// The macOS menu bar, built whole rather than by editing `Menu::default` in
/// place: the app menu, the one whose predefined Quit used to be removed and
/// replaced, stayed open after Escape or a click elsewhere. Quit, New Window,
/// Close Tab, Close Window and the shortcut items are ours; the rest are
/// AppKit's own items. The shortcut items get their keys once a window sends
/// the user's bindings (`app_menu_set_shortcuts`).
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    build_with(app, &MenuAccelerators::default())
}

/// An app shortcut's item: it runs in the window in front with the handler its
/// keys run there, which also works while a preview frame has the keyboard.
fn shortcut_item<R: Runtime>(
    app: &AppHandle<R>,
    shortcut: MenuShortcut,
    title: &str,
    accelerators: &MenuAccelerators,
) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(
        app,
        shortcut.menu_id(),
        title,
        true,
        accelerators.of(shortcut),
    )
}

fn build_with<R: Runtime>(
    app: &AppHandle<R>,
    accelerators: &MenuAccelerators,
) -> tauri::Result<Menu<R>> {
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
            &shortcut_item(app, MenuShortcut::NewTab, "New Tab", accelerators)?,
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
        &[
            &shortcut_item(
                app,
                MenuShortcut::CommandPalette,
                "Command Palette...",
                accelerators,
            )?,
            &shortcut_item(app, MenuShortcut::ToggleAi, "Toggle AI Agent", accelerators)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let tab_items = (1..=9)
        .map(|tab| {
            shortcut_item(
                app,
                MenuShortcut::SelectTab { tab },
                &format!("Tab {tab}"),
                accelerators,
            )
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let tab_items: Vec<&dyn IsMenuItem<R>> = tab_items
        .iter()
        .map(|item| item as &dyn IsMenuItem<R>)
        .collect();
    let window_menu = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &shortcut_item(
                app,
                MenuShortcut::PreviousTab,
                "Show Previous Tab",
                accelerators,
            )?,
            &shortcut_item(app, MenuShortcut::NextTab, "Show Next Tab", accelerators)?,
            &Submenu::with_items(app, "Select Tab", true, &tab_items)?,
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
    } else if let Some(shortcut) = MenuShortcut::from_menu_id(&id.0) {
        request_shortcut(app, shortcut);
    }
}

/// Runs a shortcut chosen in the menu bar in the window in front, through the
/// handler its keys run there. The page handles every key it sees that an item
/// carries, which keeps the key from the menu, so this runs for keys a preview
/// frame had and for clicks. Windows without tabs (Settings, the quick
/// terminal) have none to run.
fn request_shortcut(app: &AppHandle, shortcut: MenuShortcut) {
    let Some(window) = windows::key_window(app) else {
        return;
    };
    if windows::is_app_window(window.label()) {
        let _ = window.emit_to(window.label(), MENU_SHORTCUT_EVENT, shortcut);
    }
}

/// The shortcut items' keys, sent by each app window from the user's bindings
/// when it loads and when they change. The menu bar is built anew when they
/// differ, since muda cannot take a key equivalent off an item on macOS.
#[tauri::command]
pub fn app_menu_set_shortcuts(
    app: AppHandle,
    accelerators: MenuAccelerators,
) -> Result<(), String> {
    let accelerators = accelerators.validated();
    let mut carried = CARRIED.lock().unwrap_or_else(PoisonError::into_inner);
    if carried.as_ref() == Some(&accelerators) {
        return Ok(());
    }
    let menu = build_with(&app, &accelerators).map_err(|error| error.to_string())?;
    app.set_menu(menu).map_err(|error| error.to_string())?;
    *carried = Some(accelerators);
    Ok(())
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
