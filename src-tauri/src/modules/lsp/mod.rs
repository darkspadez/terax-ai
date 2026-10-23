pub(crate) mod env;
mod framing;
mod session;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, RwLock};

use tauri::ipc::{Channel, Response};
use tauri::Manager;

use crate::modules::workspace::{
    authorize_spawn_cwd, is_plain_name, WorkspaceEnv, WorkspaceRegistry,
};
use session::LspSession;

pub struct LspState {
    sessions: RwLock<HashMap<u32, Arc<LspSession>>>,
    next_id: AtomicU32,
}

impl Default for LspState {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }
}

impl LspState {
    pub(super) fn take(&self, id: u32) -> Option<Arc<LspSession>> {
        self.sessions.write().unwrap().remove(&id)
    }

    pub fn kill_all(&self) {
        let drained: Vec<Arc<LspSession>> =
            self.sessions.write().unwrap().drain().map(|(_, s)| s).collect();
        for session in drained {
            session.kill();
        }
    }
}

#[tauri::command]
pub fn lsp_host_pid() -> u32 {
    std::process::id()
}

/// `shell` is the terminal shell set in Settings, whose environment servers
/// get; an unlisted one is ignored (`terminal_shell_path`).
#[tauri::command]
pub async fn lsp_detect(command: String, shell: Option<String>) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let env = env::server_env_overlay(shell);
        env::detect_binary(&command, &env)
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn lsp_spawn(
    app: tauri::AppHandle,
    state: tauri::State<'_, LspState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
    root: String,
    max_rss_mb: Option<u64>,
    workspace: Option<WorkspaceEnv>,
    shell: Option<String>,
    on_message: Channel<Response>,
    on_exit: Channel<session::LspExit>,
) -> Result<u32, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    if workspace.is_wsl() {
        return Err("lsp: WSL workspaces are not supported yet".into());
    }
    let root = authorize_spawn_cwd(&registry, Some(root.as_str()), &workspace)?
        .ok_or("lsp: workspace root is required")?;

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let spawn_log = format!("cmd={command} root={}", root.display());
    let session = tauri::async_runtime::spawn_blocking(move || {
        let server_env = env::server_env_overlay(shell);
        // A relative command is the project's, the folder the server runs in.
        let binary = env::resolve_binary(&command, &server_env, &root).ok_or_else(|| {
            if env::is_relative_path(command.trim()) {
                format!("lsp: {command} was not found in {}", root.display())
            } else {
                format!("lsp: binary not found: {command}")
            }
        })?;
        let extra_env = env.unwrap_or_default();
        session::spawn(
            id,
            app,
            &binary,
            &args,
            &server_env,
            &extra_env,
            &root,
            max_rss_mb,
            on_message,
            on_exit,
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    state.sessions.write().unwrap().insert(id, session);
    // The server can die before this insert; the waiter's reap then ran with
    // the id absent. Re-check so a dead session isn't stranded in the map.
    let exited = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .map(|s| s.exited.load(Ordering::Acquire))
        .unwrap_or(false);
    if exited {
        state.take(id);
    }
    log::info!("lsp spawned id={id} {spawn_log}");
    Ok(id)
}

#[tauri::command]
pub async fn lsp_resolve_root(
    app: tauri::AppHandle,
    path: String,
    markers: Vec<String>,
) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        resolve_root(&app.state::<WorkspaceRegistry>(), &path, &markers)
    })
    .await
    .ok()
    .flatten()
}

// Stops below the home directory: a stray ~/package.json must not make a
// server index the entire home dir. Looks only into authorized folders, for
// markers that are plain names.
fn resolve_root(registry: &WorkspaceRegistry, path: &str, markers: &[String]) -> Option<String> {
    let home = dirs::home_dir();
    let start = std::path::PathBuf::from(path);
    registry.authorized_existing(&start).ok()?;
    let markers: Vec<&String> = markers
        .iter()
        .filter(|m| is_plain_name(m.as_ref()))
        .collect();
    let mut dir = if start.is_dir() {
        start.as_path()
    } else {
        start.parent()?
    };
    loop {
        if home.as_deref() == Some(dir) || registry.authorized_existing(dir).is_err() {
            return None;
        }
        if markers.iter().any(|m| dir.join(m).exists()) {
            return Some(dir.to_string_lossy().into_owned());
        }
        dir = dir.parent()?;
    }
}

// Async so a stalled server with a full stdin pipe blocks a worker
// thread, never the main thread.
#[tauri::command]
pub async fn lsp_send(
    state: tauri::State<'_, LspState>,
    id: u32,
    message: String,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("lsp_send: unknown id={id}"))?;
    tauri::async_runtime::spawn_blocking(move || session.write_message(&message))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn lsp_kill(state: tauri::State<'_, LspState>, id: u32) {
    if let Some(session) = state.take(id) {
        session.kill();
        log::info!("lsp killed id={id}");
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn authorized(path: &std::path::Path) -> WorkspaceRegistry {
        let registry = WorkspaceRegistry::default();
        registry.authorize(path).unwrap();
        registry
    }

    #[test]
    fn resolve_root_finds_nearest_marker() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path().join("proj");
        let nested = root.join("src").join("deep");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(root.join("Cargo.toml"), "").unwrap();
        std::fs::write(nested.join("main.rs"), "").unwrap();

        let found = resolve_root(
            &authorized(tmp.path()),
            nested.join("main.rs").to_str().unwrap(),
            &["Cargo.toml".to_string()],
        );
        assert_eq!(found, Some(root.to_string_lossy().into_owned()));
    }

    #[test]
    fn resolve_root_returns_none_without_marker() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let nested = tmp.path().join("a").join("b");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("f.rs"), "").unwrap();

        let found = resolve_root(
            &authorized(tmp.path()),
            nested.join("f.rs").to_str().unwrap(),
            &["Cargo.toml".to_string()],
        );
        assert_eq!(found, None);
    }

    #[test]
    fn resolve_root_stops_at_home() {
        let home = dirs::home_dir().expect("home");
        let found = resolve_root(
            &authorized(&home),
            home.to_str().unwrap(),
            &["nonexistent-marker-xyz".to_string()],
        );
        assert_eq!(found, None);
    }

    #[test]
    fn resolve_root_looks_only_into_authorized_folders() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let member = tmp.path().join("crates").join("app");
        std::fs::create_dir_all(&member).unwrap();
        std::fs::write(tmp.path().join("Cargo.toml"), "").unwrap();
        std::fs::write(member.join("main.rs"), "").unwrap();
        let markers = ["Cargo.toml".to_string()];
        let file = member.join("main.rs");

        assert_eq!(
            resolve_root(&authorized(&member), file.to_str().unwrap(), &markers),
            None,
            "the marker above the authorized folder is not probed"
        );
        assert_eq!(
            resolve_root(
                &WorkspaceRegistry::default(),
                file.to_str().unwrap(),
                &markers
            ),
            None,
            "a file outside every authorized folder"
        );
    }

    #[test]
    fn resolve_root_ignores_markers_that_are_not_plain_names() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let proj = tmp.path().join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(proj.join("f.rs"), "").unwrap();
        std::fs::write(tmp.path().join("secret"), "").unwrap();
        let file = proj.join("f.rs");
        let markers = [
            "../secret".to_string(),
            tmp.path().join("secret").to_string_lossy().into_owned(),
        ];
        assert_eq!(
            resolve_root(&authorized(tmp.path()), file.to_str().unwrap(), &markers),
            None
        );
    }
}
