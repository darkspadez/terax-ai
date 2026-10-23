//! The settings store (`tauri-plugin-store`), limited to the app's own data folder.
//!
//! The plugin joins the path a page gives it to the app data folder, so an absolute path or `..`
//! reaches any JSON file on disk, and it has no option to stop that. This wraps the plugin
//! unchanged (its stores, resource ids, cross-window change events and file names) and refuses,
//! before the plugin sees them, the two commands that name a file (`load`, `get_store`) unless
//! the name is a plain file name in the data folder, or the calling window's own spaces store
//! (`windows/<label>/oarlock-spaces.json`, `windows.rs`). Every other store command takes the
//! resource id of a store opened that way. The backend's own stores (`StoreExt`) are not
//! affected.

use serde_json::Value as JsonValue;
use tauri::ipc::{Invoke, InvokeBody};
use tauri::plugin::{Plugin, TauriPlugin};
use tauri::webview::PageLoadPayload;
use tauri::{AppHandle, RunEvent, Runtime, Url, Webview, Window};

use super::windows;

/// Longest store file name accepted; ours are about twenty characters.
const MAX_NAME_LEN: usize = 128;

/// The store plugin, opening files only inside the app's data folder.
pub fn plugin<R: Runtime>() -> ScopedStore<R> {
    ScopedStore {
        inner: tauri_plugin_store::Builder::new().build(),
    }
}

pub struct ScopedStore<R: Runtime> {
    inner: TauriPlugin<R>,
}

// Every hook goes to the plugin. `initialization_script_2` keeps its default, which wraps
// `initialization_script`: the store plugin has no script (a test checks it), and the type it
// returns is not public in `tauri`.
impl<R: Runtime> Plugin<R> for ScopedStore<R> {
    fn name(&self) -> &'static str {
        self.inner.name()
    }

    fn initialize(
        &mut self,
        app: &AppHandle<R>,
        config: JsonValue,
    ) -> Result<(), Box<dyn std::error::Error>> {
        self.inner.initialize(app, config)
    }

    fn initialization_script(&self) -> Option<String> {
        self.inner.initialization_script()
    }

    fn window_created(&mut self, window: Window<R>) {
        self.inner.window_created(window)
    }

    fn webview_created(&mut self, webview: Webview<R>) {
        self.inner.webview_created(webview)
    }

    fn on_navigation(&mut self, webview: &Webview<R>, url: &Url) -> bool {
        self.inner.on_navigation(webview, url)
    }

    fn on_page_load(&mut self, webview: &Webview<R>, payload: &PageLoadPayload<'_>) {
        self.inner.on_page_load(webview, payload)
    }

    fn on_event(&mut self, app: &AppHandle<R>, event: &RunEvent) {
        self.inner.on_event(app, event)
    }

    fn extend_api(&mut self, invoke: Invoke<R>) -> bool {
        let message = &invoke.message;
        if let Some(reason) = refusal(
            message.command(),
            message.payload(),
            message.webview_ref().label(),
        ) {
            log::warn!("store: {reason}");
            invoke.resolver.reject(reason);
            return true;
        }
        self.inner.extend_api(invoke)
    }
}

/// Why `command` from the page in window `window` may not run, if it may not: a command that
/// names a store file must name one the page may open.
fn refusal(command: &str, payload: &InvokeBody, window: &str) -> Option<String> {
    if !matches!(command, "load" | "get_store") {
        return None;
    }
    let path = match payload {
        InvokeBody::Json(args) => args.get("path").and_then(JsonValue::as_str),
        InvokeBody::Raw(_) => None,
    };
    match path {
        Some(path) if allowed_store_path(path, window) => None,
        Some(path) => Some(format!(
            "refused store file {path:?}: stores are plain file names in the app's data folder"
        )),
        None => Some("refused store request without a file name".to_owned()),
    }
}

/// A store file the page in `window` may open: a plain file name, which the plugin resolves in
/// the app's data folder, or that window's own spaces store when it is an extra app window.
fn allowed_store_path(path: &str, window: &str) -> bool {
    is_plain_store_name(path)
        || (window != windows::MAIN
            && windows::is_app_window(window)
            && std::path::Path::new(path) == windows::spaces_store(window))
}

/// One plain file name the same on every platform: ASCII letters, digits, `-`, `_` and inner
/// dots, so no separator, drive, `..`, hidden name or trailing dot (which Windows drops), and
/// no Windows device name (`CON`, `NUL.json`, `COM1`), which would open a device there.
fn is_plain_store_name(name: &str) -> bool {
    let plain = !name.is_empty()
        && name.len() <= MAX_NAME_LEN
        && !name.starts_with('.')
        && !name.ends_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
    plain && !is_windows_device_name(name)
}

fn is_windows_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    match stem.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" => true,
        _ => ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix)
                .is_some_and(|n| n.len() == 1 && n.as_bytes()[0].is_ascii_digit())
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn load(path: JsonValue, window: &str) -> Option<String> {
        refusal(
            "load",
            &InvokeBody::Json(json!({ "path": path, "options": { "defaults": {} } })),
            window,
        )
    }

    /// Every store file the page opens (`STORE_PATH` in `src/`, and `spacesStorePath`).
    const APP_STORES: &[&str] = &[
        "oarlock-settings.json",
        "oarlock-ai-sessions.json",
        "oarlock-ai-snippets.json",
        "oarlock-ai-todos.json",
        "oarlock-ai-agents.json",
        "oarlock-custom-themes.json",
        "oarlock-mcp.json",
        "oarlock-spaces.json",
    ];

    #[test]
    fn every_store_the_app_opens_is_allowed_in_every_window() {
        for window in ["main", "w-1", "w-32", "settings", "quick"] {
            for name in APP_STORES {
                assert_eq!(load(json!(name), window), None, "{name} in {window}");
                assert_eq!(
                    refusal(
                        "get_store",
                        &InvokeBody::Json(json!({ "path": name })),
                        window
                    ),
                    None
                );
            }
        }
        // An extra window's spaces, as `appWindow.ts` names them.
        for window in ["w-1", "w-7", "w-abc"] {
            let own = format!("windows/{window}/oarlock-spaces.json");
            assert_eq!(load(json!(own), window), None, "{own}");
        }
    }

    #[test]
    fn the_app_stores_are_the_ones_the_page_names() {
        // A new store in `src/` must be added above, so it is checked here.
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
        let mut found = Vec::new();
        let mut dirs = vec![root];
        while let Some(dir) = dirs.pop() {
            for entry in std::fs::read_dir(&dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    dirs.push(path);
                    continue;
                }
                let name = path.file_name().unwrap().to_string_lossy();
                if !(name.ends_with(".ts") || name.ends_with(".tsx")) || name.contains(".test.") {
                    continue;
                }
                let source = std::fs::read_to_string(&path).unwrap();
                if !source.contains("new LazyStore(") {
                    continue;
                }
                let declared = source
                    .split("const STORE_PATH = ")
                    .nth(1)
                    .and_then(|rest| rest.split(';').next())
                    .unwrap_or_else(|| panic!("{name} opens a store without STORE_PATH"));
                found.push(declared.trim().to_owned());
            }
        }
        found.sort();
        let mut expected: Vec<String> = APP_STORES
            .iter()
            .filter(|name| **name != "oarlock-spaces.json")
            .map(|name| format!("\"{name}\""))
            .chain(["spacesStorePath()".to_owned()])
            .collect();
        expected.sort();
        assert_eq!(found, expected);
    }

    #[test]
    fn paths_outside_the_data_folder_are_refused() {
        for path in [
            "/etc/passwd",
            "/home/me/.config/app/settings.json",
            "../oarlock-settings.json",
            "../../.ssh/config.json",
            "..",
            ".",
            "",
            "C:\\Users\\me\\settings.json",
            "C:settings.json",
            "\\\\server\\share\\x.json",
            "\\\\?\\C:\\x.json",
            "~/x.json",
            "sub/oarlock-settings.json",
            "sub\\oarlock-settings.json",
            "conversations/session-1.json",
            "oarlock-settings.json/..",
            "a/../oarlock-settings.json",
            ".window-state.json",
            "settings.json.",
            "settings .json",
            "settings.json:stream",
            "settings\0.json",
            "CON",
            "nul.json",
            "Com1.json",
            "lpt9",
        ] {
            assert!(load(json!(path), "main").is_some(), "{path:?}");
            assert!(load(json!(path), "w-1").is_some(), "{path:?}");
        }
        assert!(load(json!("x".repeat(MAX_NAME_LEN + 1)), "main").is_some());
        assert_eq!(load(json!("x".repeat(MAX_NAME_LEN)), "main"), None);
        // Names that only look like devices are fine.
        assert_eq!(load(json!("console.json"), "main"), None);
        assert_eq!(load(json!("com10.json"), "main"), None);
    }

    #[test]
    fn a_window_reaches_only_its_own_spaces_store() {
        assert_eq!(load(json!("windows/w-1/oarlock-spaces.json"), "w-1"), None);
        for (path, window) in [
            // Another window's, or main's folder that is not a folder of its own.
            ("windows/w-2/oarlock-spaces.json", "w-1"),
            ("windows/w-1/oarlock-spaces.json", "main"),
            ("windows/main/oarlock-spaces.json", "main"),
            ("windows/settings/oarlock-spaces.json", "settings"),
            // Another file in its own folder, or a way out of it.
            ("windows/w-1/oarlock-settings.json", "w-1"),
            ("windows/w-1/../w-2/oarlock-spaces.json", "w-1"),
            ("windows/w-1/terminal-scrollback/sb-1.vt", "w-1"),
            ("/windows/w-1/oarlock-spaces.json", "w-1"),
            ("windows/w-1", "w-1"),
        ] {
            assert!(load(json!(path), window).is_some(), "{path} in {window}");
        }
    }

    #[test]
    fn a_request_without_a_file_name_is_refused() {
        assert!(load(json!(null), "main").is_some());
        assert!(load(json!(42), "main").is_some());
        assert!(load(json!(["oarlock-settings.json"]), "main").is_some());
        assert!(refusal("load", &InvokeBody::Json(json!({})), "main").is_some());
        assert!(refusal(
            "load",
            &InvokeBody::Raw(b"oarlock-settings.json".to_vec()),
            "main"
        )
        .is_some());
    }

    #[test]
    fn commands_on_an_open_store_pass_through() {
        for command in [
            "get", "set", "entries", "save", "reload", "delete", "clear", "keys",
        ] {
            let args = InvokeBody::Json(json!({ "rid": 1, "key": "/etc/passwd" }));
            assert_eq!(refusal(command, &args, "main"), None, "{command}");
        }
    }

    #[test]
    fn the_wrapped_plugin_has_no_script_to_forward() {
        let inner = tauri_plugin_store::Builder::new().build::<tauri::Wry>();
        assert_eq!(inner.name(), "store");
        assert!(inner.initialization_script().is_none());
    }
}
