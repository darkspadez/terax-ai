use std::io;

use tauri::{
    menu::{Menu, MenuEvent, MenuId, MenuItem},
    AppHandle, Runtime,
};

use super::windows;

const GUARDED_QUIT_MENU_ID: &str = "terax.quit";
const QUIT_ACCELERATOR: &str = "Command+Q";
const NEW_WINDOW_MENU_ID: &str = "terax.new-window";
const NEW_WINDOW_ACCELERATOR: &str = "Command+Shift+N";

fn invalid_default_menu(message: &'static str) -> tauri::Error {
    io::Error::new(io::ErrorKind::InvalidData, message).into()
}

fn is_guarded_quit(id: &MenuId) -> bool {
    id == GUARDED_QUIT_MENU_ID
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let app_menu = menu
        .items()?
        .into_iter()
        .next()
        .and_then(|item| item.as_submenu().cloned())
        .ok_or_else(|| invalid_default_menu("macOS default app menu is missing"))?;
    let items = app_menu.items()?;
    let quit_index = items
        .len()
        .checked_sub(1)
        .ok_or_else(|| invalid_default_menu("macOS default app menu is empty"))?;
    let native_quit = items[quit_index]
        .as_predefined_menuitem()
        .ok_or_else(|| invalid_default_menu("macOS default Quit item is not predefined"))?;
    let quit_text = native_quit.text()?;
    if quit_text != "Quit" && !quit_text.starts_with("Quit ") {
        return Err(invalid_default_menu(
            "macOS default app menu does not end with Quit",
        ));
    }

    let guarded_quit = MenuItem::with_id(
        app,
        GUARDED_QUIT_MENU_ID,
        quit_text,
        true,
        Some(QUIT_ACCELERATOR),
    )?;
    app_menu.remove_at(quit_index)?;
    app_menu.insert(&guarded_quit, quit_index)?;

    // File > New Window, first in the File menu as in other Mac apps.
    let file_menu = menu
        .items()?
        .into_iter()
        .filter_map(|item| item.as_submenu().cloned())
        .find(|submenu| submenu.text().is_ok_and(|text| text == "File"));
    if let Some(file_menu) = file_menu {
        let new_window = MenuItem::with_id(
            app,
            NEW_WINDOW_MENU_ID,
            "New Window",
            true,
            Some(NEW_WINDOW_ACCELERATOR),
        )?;
        file_menu.insert(&new_window, 0)?;
    }

    Ok(menu)
}

pub fn handle_event(app: &AppHandle, event: MenuEvent) {
    if is_guarded_quit(event.id()) {
        // Every window confirms running commands and unsaved files first.
        windows::request_quit(app);
    } else if event.id() == NEW_WINDOW_MENU_ID {
        windows::request_new_window(app);
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
