//! MCP (Model Context Protocol) servers: the process host for local (stdio)
//! servers and the proxy for remote (HTTP) ones. The protocol itself, the
//! client, lives in the page (`src/modules/mcp/`, the official SDK); the
//! backend owns processes, network access and secret values.
//!
//! - stdio (`stdio.rs`): spawn, send, stop; newline-delimited JSON-RPC
//!   (`framing.rs`, size-capped); stderr into a bounded log per server
//!   (`logs.rs`) that Settings reads; process group / job object; the user's
//!   shell environment (`lsp::env`), so `npx`, `uvx` and `docker` are found
//!   from a GUI launch; secret environment values read from the keychain here.
//! - HTTP (`http.rs`): requests through the `net.rs` proxy (SSRF and DNS
//!   rebinding defences), allowed only within the configured server origin,
//!   secret header values and the sign-in token added here.
//! - OAuth (`oauth/`): sign-in for remote servers, tokens in the keychain.
//! - import (`import.rs`): other apps' server configurations, parsed here.
//! - project servers (`project.rs`): a project's `.mcp.json`, through the
//!   shared project trust.
//! - status (`status.rs`): what each window's client reports, for Settings.
//!
//! Sessions belong to the window that opened them and end when it reloads or
//! closes; all end at app exit. Servers run with the user's rights, outside
//! the workspace authorization registry: they are programs the user chose.

mod framing;
mod http;
pub mod import;
mod jsonc;
mod logs;
mod names;
pub mod oauth;
pub mod project;
mod status;
mod stdio;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use futures_util::future::Abortable;
use serde::Deserialize;
use tauri::ipc::{Channel, JavaScriptChannelId, Request, Response};
use tauri::{AppHandle, Emitter, State, WebviewWindow};

use crate::modules::net::{self, AiStreamState};
use crate::modules::windows::is_app_window;
pub use names::SECRET_SERVICE;
use names::{secret_account, valid_env_name, valid_header_name, valid_server_id, SecretKind};
use status::{StatusRegistry, StatusReport, WindowStatus};
use stdio::{StdioExit, StdioSession};

const SETTINGS_WINDOW: &str = "settings";
const STATUS_EVENT: &str = "oarlock://mcp-status";
const MAX_SESSIONS_PER_WINDOW: usize = 64;
const MAX_ARGS: usize = 256;
const MAX_ARG_BYTES: usize = 32 * 1024;
const MAX_ENTRIES: usize = 256;
const MAX_COMMAND_BYTES: usize = 4096;
/// Requests in flight over all remote sessions: each holds an event stream
/// while it lives, plus its calls.
const MAX_HTTP_REQUESTS: usize = 128;

type StdioMap = Arc<RwLock<HashMap<u32, Arc<StdioSession>>>>;

pub struct McpState {
    stdio: StdioMap,
    http: Mutex<HashMap<u32, Arc<http::HttpSession>>>,
    /// The local sessions of project servers, and what each was started from.
    projects: Mutex<HashMap<u32, project::Binding>>,
    logs: Arc<logs::LogStore>,
    statuses: Mutex<StatusRegistry>,
    oauth: oauth::OAuthState,
    next_id: AtomicU32,
}

impl Default for McpState {
    fn default() -> Self {
        Self {
            stdio: Arc::default(),
            http: Mutex::default(),
            projects: Mutex::default(),
            logs: Arc::default(),
            statuses: Mutex::default(),
            oauth: oauth::OAuthState::default(),
            next_id: AtomicU32::new(1),
        }
    }
}

/// HTTP streams of MCP sessions: the AI proxy's flow control and request
/// ownership, with a request budget of their own, so a server's long-lived
/// event stream never takes a slot from a model request.
#[derive(Default)]
pub struct McpHttpStreams(AiStreamState);

impl McpHttpStreams {
    pub fn cancel_window(&self, window: &str) {
        self.0.cancel_window(window);
    }
}

impl McpState {
    fn stdio_session(&self, window: &str, id: u32) -> Result<Arc<StdioSession>, String> {
        self.stdio
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
            .filter(|s| s.owner == window)
            .cloned()
            .ok_or_else(|| format!("mcp: unknown session {id}"))
    }

    fn http_session(&self, window: &str, id: u32) -> Result<Arc<http::HttpSession>, String> {
        self.http
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
            .filter(|s| s.owner == window)
            .cloned()
            .ok_or_else(|| format!("mcp: unknown session {id}"))
    }

    fn sessions_of(&self, window: &str) -> usize {
        let stdio = self
            .stdio
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|s| s.owner == window)
            .count();
        let http = self
            .http
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|s| s.owner == window)
            .count();
        stdio + http
    }

    /// A window reloaded or closed: its servers stop and its reports go.
    pub fn release_window(&self, app: &AppHandle, window: &str) {
        let stopped: Vec<Arc<StdioSession>> = {
            let mut map = self.stdio.write().unwrap_or_else(|e| e.into_inner());
            let ids: Vec<u32> = map
                .iter()
                .filter(|(_, s)| s.owner == window)
                .map(|(id, _)| *id)
                .collect();
            ids.iter().filter_map(|id| map.remove(id)).collect()
        };
        for session in stopped {
            session.stop();
        }
        self.projects
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, b| b.window != window);
        self.http
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, s| s.owner != window);
        let dropped = self
            .statuses
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drop_window(window);
        for server_id in dropped {
            emit_status(app, window, &server_id, None);
        }
    }

    /// App exit: every server ends within a bounded time.
    pub fn shut_down(&self) {
        let sessions: Vec<Arc<StdioSession>> = self
            .stdio
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
            .map(|(_, s)| s)
            .collect();
        stdio::shut_down(sessions);
    }
}

fn require_app_window(window: &WebviewWindow) -> Result<(), String> {
    if is_app_window(window.label()) {
        Ok(())
    } else {
        Err("mcp: only an app window runs MCP servers".into())
    }
}

fn require_settings(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == SETTINGS_WINDOW {
        Ok(())
    } else {
        Err("mcp: secrets are set in Settings".into())
    }
}

fn require_server_id(id: &str) -> Result<(), String> {
    if valid_server_id(id) {
        Ok(())
    } else {
        Err("mcp: invalid server id".into())
    }
}

/// Values of the named secrets of a server, in order; a missing one is an
/// error that names it, so the user knows what to set.
async fn resolve_secrets(
    app: &AppHandle,
    server_id: &str,
    kind: SecretKind,
    names: &[String],
) -> Result<Vec<(String, String)>, String> {
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let accounts = names
        .iter()
        .map(|name| secret_account(server_id, kind, name))
        .collect::<Result<Vec<_>, _>>()?;
    let values =
        crate::modules::secrets::backend_get(app.clone(), SECRET_SERVICE, accounts).await?;
    names
        .iter()
        .zip(values)
        .map(|(name, value)| match value {
            Some(value) if !value.is_empty() => Ok((name.clone(), value)),
            _ => Err(format!(
                "mcp: the secret {name} is not set; set it in Settings, MCP"
            )),
        })
        .collect()
}

fn check_spawn_input(
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
    secret_env: &[String],
) -> Result<(), String> {
    if command.trim().is_empty() || command.len() > MAX_COMMAND_BYTES || command.contains('\0') {
        return Err("mcp: invalid command".into());
    }
    if args.len() > MAX_ARGS
        || args
            .iter()
            .any(|a| a.len() > MAX_ARG_BYTES || a.contains('\0'))
    {
        return Err("mcp: invalid arguments".into());
    }
    if env.len() + secret_env.len() > MAX_ENTRIES {
        return Err("mcp: too many environment variables".into());
    }
    for (name, value) in env {
        if !valid_env_name(name) || !names::valid_value(value, SecretKind::Env) {
            return Err(format!("mcp: invalid environment variable {name:?}"));
        }
    }
    if let Some(name) = secret_env.iter().find(|n| !valid_env_name(n)) {
        return Err(format!("mcp: invalid environment variable {name:?}"));
    }
    Ok(())
}

/// Starts a local server. `env` holds plain values; `secret_env` names the
/// variables whose values are read from the keychain here, so they never pass
/// through the page. `shell` is the terminal shell set in Settings, whose
/// environment (PATH) the server gets, as language servers do.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn mcp_spawn(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, McpState>,
    server_id: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    secret_env: Vec<String>,
    cwd: Option<String>,
    shell: Option<String>,
    on_message: Channel<Response>,
    on_exit: Channel<StdioExit>,
) -> Result<u32, String> {
    require_app_window(&window)?;
    require_server_id(&server_id)?;
    check_spawn_input(&command, &args, &env, &secret_env)?;
    let owner = window.label().to_owned();
    if state.sessions_of(&owner) >= MAX_SESSIONS_PER_WINDOW {
        return Err("mcp: too many servers in this window".into());
    }
    let secrets = resolve_secrets(&app, &server_id, SecretKind::Env, &secret_env).await?;
    let cwd = stdio::resolve_cwd(cwd.as_deref())?;
    let mut configured: Vec<(String, String)> = env.into_iter().collect();
    configured.sort();
    configured.extend(secrets);
    start_stdio(
        &state,
        StdioStart {
            owner,
            server_id,
            command,
            args,
            configured,
            cwd,
            shell,
        },
        on_message,
        on_exit,
    )
    .await
}

/// A local server to start: the command as given, its configured environment
/// (values resolved) and folder.
struct StdioStart {
    owner: String,
    server_id: String,
    command: String,
    args: Vec<String>,
    configured: Vec<(String, String)>,
    cwd: stdio::WorkingFolder,
    shell: Option<String>,
}

async fn start_stdio(
    state: &McpState,
    start: StdioStart,
    on_message: Channel<Response>,
    on_exit: Channel<StdioExit>,
) -> Result<u32, String> {
    let StdioStart {
        owner,
        server_id,
        command,
        args,
        configured,
        cwd,
        shell,
    } = start;
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let sessions = state.stdio.clone();
    let logs = state.logs.clone();
    let spawn_id = server_id.clone();
    let session = tauri::async_runtime::spawn_blocking(move || {
        let shell_env = crate::modules::lsp::env::server_env_overlay(shell);
        let binary = match stdio::resolve_program(&command, &shell_env, &cwd) {
            Ok(binary) => binary,
            Err(e) => {
                logs.push(&spawn_id, logs::Stream::Oarlock, e.clone());
                return Err(e);
            }
        };
        let spec = stdio::SpawnSpec {
            server_id: spawn_id.clone(),
            owner,
            binary,
            args,
            cwd: cwd.path().to_owned(),
            env: stdio::environment(
                &shell_env,
                crate::modules::workspace::child_env_overrides(),
                &configured,
            ),
            max_message: framing::MAX_MESSAGE_BYTES,
        };
        let exit_sessions = sessions.clone();
        stdio::spawn(
            spec,
            logs.clone(),
            Box::new(move |bytes| {
                on_message
                    .send(Response::new(bytes))
                    .map_err(|e| e.to_string())
            }),
            Box::new(move |exit| {
                exit_sessions
                    .write()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&id);
                let _ = on_exit.send(exit);
            }),
        )
        .inspect_err(|e| logs.push(&spawn_id, logs::Stream::Oarlock, e.clone()))
    })
    .await
    .map_err(|e| e.to_string())??;

    state
        .stdio
        .write()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id, session.clone());
    // It may have exited before the insert, when its exit could not remove it.
    if session.has_exited() {
        state
            .stdio
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
    }
    log::info!("mcp spawned id={id} server={server_id}");
    Ok(id)
}

/// Async so a server that stopped reading never blocks the main thread. A
/// project server stops once its project's `.mcp.json` is no longer allowed.
#[tauri::command]
pub async fn mcp_send(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, McpState>,
    id: u32,
    message: String,
) -> Result<(), String> {
    let session = state.stdio_session(window.label(), id)?;
    let framed = framing::encode(&message)?;
    let binding = state
        .projects
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
        .cloned();
    let written = tauri::async_runtime::spawn_blocking(move || {
        if let Some(binding) = binding {
            if !project::still_allowed(&app, &binding) {
                session.stop();
                return Err(NOT_ALLOWED.to_owned());
            }
        }
        session.write(&framed)
    })
    .await
    .map_err(|e| e.to_string())?;
    if written.as_ref().err().map(String::as_str) == Some(NOT_ALLOWED) {
        state
            .projects
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
    }
    written
}

const NOT_ALLOWED: &str =
    "mcp: the project's .mcp.json is no longer allowed in this window; the server stopped";

#[tauri::command]
pub fn mcp_kill(window: WebviewWindow, state: State<'_, McpState>, id: u32) {
    let session = {
        let mut map = state.stdio.write().unwrap_or_else(|e| e.into_inner());
        match map.get(&id) {
            Some(session) if session.owner == window.label() => map.remove(&id),
            _ => None,
        }
    };
    if let Some(session) = session {
        session.stop();
    }
}

#[tauri::command]
pub fn mcp_logs(
    state: State<'_, McpState>,
    server_id: String,
    after: Option<u64>,
) -> Result<logs::LogPage, String> {
    require_server_id(&server_id)?;
    Ok(state.logs.read(&server_id, after.unwrap_or(0)))
}

#[tauri::command]
pub fn mcp_logs_clear(state: State<'_, McpState>, server_id: String) -> Result<(), String> {
    require_server_id(&server_id)?;
    state.logs.clear(&server_id);
    Ok(())
}

/// A lifecycle note from a window's client (connected, restarting, a
/// protocol error) into the server's log.
#[tauri::command]
pub fn mcp_log_note(
    window: WebviewWindow,
    state: State<'_, McpState>,
    server_id: String,
    text: String,
) -> Result<(), String> {
    require_app_window(&window)?;
    require_server_id(&server_id)?;
    state.logs.push(
        &server_id,
        logs::Stream::Oarlock,
        logs::clean_line(text.as_bytes()),
    );
    Ok(())
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusEvent<'a> {
    window: &'a str,
    server_id: &'a str,
    /// None when the window no longer runs it.
    report: Option<&'a StatusReport>,
}

fn emit_status(app: &AppHandle, window: &str, server_id: &str, report: Option<&StatusReport>) {
    let _ = app.emit(
        STATUS_EVENT,
        StatusEvent {
            window,
            server_id,
            report,
        },
    );
}

#[tauri::command]
pub fn mcp_status_report(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, McpState>,
    report: StatusReport,
) -> Result<(), String> {
    require_app_window(&window)?;
    let label = window.label();
    state
        .statuses
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .report(label, report.clone())?;
    let kept = report.state != status::ServerState::Stopped;
    emit_status(&app, label, &report.server_id, kept.then_some(&report));
    Ok(())
}

#[tauri::command]
pub fn mcp_status_list(state: State<'_, McpState>) -> Vec<WindowStatus> {
    state
        .statuses
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .list()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretRef {
    kind: SecretKind,
    name: String,
}

#[tauri::command]
pub async fn mcp_secret_set(
    app: AppHandle,
    window: WebviewWindow,
    server_id: String,
    kind: SecretKind,
    name: String,
    value: String,
) -> Result<(), String> {
    require_settings(&window)?;
    let account = secret_account(&server_id, kind, &name)?;
    if value.len() > crate::modules::secrets::MAX_VALUE_BYTES {
        return Err(format!(
            "mcp: the value of {name} is longer than {} KiB",
            crate::modules::secrets::MAX_VALUE_BYTES / 1024
        ));
    }
    if value.is_empty() || !names::valid_value(&value, kind) {
        return Err(format!("mcp: invalid value for {name}"));
    }
    crate::modules::secrets::backend_set(app, SECRET_SERVICE, account, value).await
}

#[tauri::command]
pub async fn mcp_secret_delete(
    app: AppHandle,
    window: WebviewWindow,
    server_id: String,
    secrets: Vec<SecretRef>,
) -> Result<(), String> {
    require_settings(&window)?;
    let accounts = secrets
        .iter()
        .map(|s| secret_account(&server_id, s.kind, &s.name))
        .collect::<Result<Vec<_>, _>>()?;
    crate::modules::secrets::backend_delete(app, SECRET_SERVICE, accounts).await
}

/// Which of the named secrets are set; the values never leave the backend.
#[tauri::command]
pub async fn mcp_secret_status(
    app: AppHandle,
    window: WebviewWindow,
    server_id: String,
    secrets: Vec<SecretRef>,
) -> Result<Vec<bool>, String> {
    require_settings(&window)?;
    let accounts = secrets
        .iter()
        .map(|s| secret_account(&server_id, s.kind, &s.name))
        .collect::<Result<Vec<_>, _>>()?;
    let values = crate::modules::secrets::backend_get(app, SECRET_SERVICE, accounts).await?;
    Ok(values
        .into_iter()
        .map(|v| v.is_some_and(|v| !v.is_empty()))
        .collect())
}

/// Opens a remote server's session: the one origin its requests may reach,
/// and the configured headers, secret values read from the keychain here.
#[tauri::command]
pub async fn mcp_http_open(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, McpState>,
    server_id: String,
    url: String,
    headers: HashMap<String, String>,
    secret_headers: Vec<String>,
) -> Result<u32, String> {
    require_app_window(&window)?;
    require_server_id(&server_id)?;
    if headers.len() + secret_headers.len() > MAX_ENTRIES {
        return Err("mcp: too many headers".into());
    }
    if let Some(name) = secret_headers.iter().find(|n| !valid_header_name(n)) {
        return Err(format!("mcp: invalid header name {name:?}"));
    }
    let owner = window.label().to_owned();
    if state.sessions_of(&owner) >= MAX_SESSIONS_PER_WINDOW {
        return Err("mcp: too many servers in this window".into());
    }
    let secrets = resolve_secrets(&app, &server_id, SecretKind::Header, &secret_headers).await?;
    let mut entries: Vec<(String, String)> = headers.into_iter().collect();
    entries.sort();
    entries.extend(secrets);
    open_http(&state, owner, server_id, &url, entries, None).await
}

/// Opens a session: the one origin its requests may reach, private
/// addresses only when that host is local or private, and sign-in unless the
/// configuration sets `Authorization` itself.
async fn open_http(
    state: &McpState,
    owner: String,
    server_id: String,
    url: &str,
    entries: Vec<(String, String)>,
    project: Option<project::Binding>,
) -> Result<u32, String> {
    let url = http::parse_server_url(url)?;
    let host = url.host_str().ok_or("mcp: the URL has no host")?.to_owned();
    let allow_private = net::host_is_private(&host)
        .await
        .map_err(|e| format!("mcp: {e}"))?;
    let headers = http::session_headers(entries)?;
    let oauth = (!http::sets_authorization(&headers))
        .then(|| oauth::Policy::for_server(&url, allow_private));
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    state.http.lock().unwrap_or_else(|e| e.into_inner()).insert(
        id,
        Arc::new(http::HttpSession {
            owner,
            server_id,
            url,
            allow_private,
            headers,
            oauth,
            project,
        }),
    );
    Ok(id)
}

/// Starts a server of the calling window's project, as its trusted
/// `.mcp.json` declares it: variables expanded here from the shell
/// environment, in the project's folder, with `CLAUDE_PROJECT_DIR` set.
#[tauri::command]
pub async fn mcp_project_spawn(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, McpState>,
    server_id: String,
    shell: Option<String>,
    on_message: Channel<Response>,
    on_exit: Channel<StdioExit>,
) -> Result<u32, String> {
    require_app_window(&window)?;
    require_server_id(&server_id)?;
    let owner = window.label().to_owned();
    if state.sessions_of(&owner) >= MAX_SESSIONS_PER_WINDOW {
        return Err("mcp: too many servers in this window".into());
    }
    let resolve_app = app.clone();
    let resolve_owner = owner.clone();
    let resolve_id = server_id.clone();
    let resolve_shell = shell.clone();
    let (launch, project, binding) = crate::modules::fs::blocking(move || {
        let (entry, project, binding) =
            project::resolve(&resolve_app, &resolve_owner, &resolve_id)?;
        if project.workspace.is_wsl() {
            return Err(
                "mcp: a WSL project's local servers are not started; add the server in Settings"
                    .to_owned(),
            );
        }
        let env = crate::modules::lsp::env::server_env_overlay(resolve_shell);
        let launch = project::stdio_launch(&entry, &project::lookup(&env))?;
        Ok((launch, project, binding))
    })
    .await?;
    if !launch.missing.is_empty() {
        state.logs.push(
            &server_id,
            logs::Stream::Oarlock,
            format!("Not set in the environment: {}", launch.missing.join(", ")),
        );
    }
    let mut configured = launch.env;
    configured.push((
        "CLAUDE_PROJECT_DIR".to_owned(),
        project.real.to_string_lossy().into_owned(),
    ));
    let env: HashMap<String, String> = configured.iter().cloned().collect();
    check_spawn_input(&launch.command, &launch.args, &env, &[])?;
    let id = start_stdio(
        &state,
        StdioStart {
            owner,
            server_id,
            command: launch.command,
            args: launch.args,
            configured,
            cwd: stdio::WorkingFolder::Set(project.real.clone()),
            shell,
        },
        on_message,
        on_exit,
    )
    .await?;
    state
        .projects
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id, binding);
    Ok(id)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSession {
    id: u32,
    /// The URL with its variables expanded, which the client connects to.
    url: String,
}

/// Opens a session with a remote server of the calling window's project.
#[tauri::command]
pub async fn mcp_project_http_open(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, McpState>,
    server_id: String,
    shell: Option<String>,
) -> Result<ProjectSession, String> {
    require_app_window(&window)?;
    require_server_id(&server_id)?;
    let owner = window.label().to_owned();
    if state.sessions_of(&owner) >= MAX_SESSIONS_PER_WINDOW {
        return Err("mcp: too many servers in this window".into());
    }
    let resolve_owner = owner.clone();
    let resolve_id = server_id.clone();
    let (launch, binding) = crate::modules::fs::blocking(move || {
        let (entry, _, binding) = project::resolve(&app, &resolve_owner, &resolve_id)?;
        let env = crate::modules::lsp::env::server_env_overlay(shell);
        let launch = project::remote_launch(&entry, &project::lookup(&env))?;
        Ok((launch, binding))
    })
    .await?;
    if !launch.missing.is_empty() {
        state.logs.push(
            &server_id,
            logs::Stream::Oarlock,
            format!("Not set in the environment: {}", launch.missing.join(", ")),
        );
    }
    if launch.headers.len() > MAX_ENTRIES {
        return Err("mcp: too many headers".into());
    }
    let url = http::parse_server_url(&launch.url)?.to_string();
    let id = open_http(
        &state,
        owner,
        server_id,
        &url,
        launch.headers,
        Some(binding),
    )
    .await?;
    Ok(ProjectSession { id, url })
}

#[tauri::command]
pub fn mcp_http_close(window: WebviewWindow, state: State<'_, McpState>, id: u32) {
    let mut sessions = state.http.lock().unwrap_or_else(|e| e.into_inner());
    if sessions.get(&id).is_some_and(|s| s.owner == window.label()) {
        sessions.remove(&id);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamRequest {
    request_id: String,
    session: u32,
    url: String,
    method: String,
    headers: Option<HashMap<String, String>>,
    on_event: JavaScriptChannelId,
}

/// One request of a remote session, streamed back as the AI proxy streams
/// (`net::ai_http_stream`: packets 0 headers, 1 body, 2 end, 3 error).
#[tauri::command]
pub async fn mcp_http_stream(
    app: AppHandle,
    window: WebviewWindow,
    streams: State<'_, McpHttpStreams>,
    state: State<'_, McpState>,
    request: Request<'_>,
) -> Result<(), String> {
    require_app_window(&window)?;
    let metadata = request
        .headers()
        .get("x-oarlock-mcp-request")
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.len() <= 64 * 1024)
        .ok_or("missing or oversized MCP request metadata")?;
    let StreamRequest {
        request_id,
        session,
        url,
        method,
        headers,
        on_event,
    } = serde_json::from_str(metadata).map_err(|e| e.to_string())?;
    let session = state.http_session(window.label(), session)?;
    let on_event = on_event.channel_on::<_, Response>(window.as_ref().clone());
    let body = net::request_body(request.body())?;
    let (lease, registration) =
        streams
            .0
            .start_bounded(window.label(), &request_id, MAX_HTTP_REQUESTS)?;
    tauri::async_runtime::spawn(async move {
        let run = async {
            let url = reqwest::Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
            if !http::within_origin(&session.url, &url) {
                return Err(format!(
                    "mcp: {} is outside the server's origin {}",
                    url.origin().ascii_serialization(),
                    session.url.origin().ascii_serialization()
                ));
            }
            if let Some(binding) = &session.project {
                if !project::still_allowed(&app, binding) {
                    return Err(NOT_ALLOWED.to_owned());
                }
            }
            let host = url.host_str().ok_or("missing host")?.to_string();
            let ips = net::classify_and_collect_safe_ips(&host, session.allow_private).await?;
            let client = net::client_for(net::Profile::Mcp, &host, &ips, session.allow_private)?;
            let method =
                reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
            let base = http::request_headers(headers, &session.headers)?;
            let send = |token: Option<String>| {
                let mut request = client
                    .request(method.clone(), url.clone())
                    .headers(http::with_bearer(base.clone(), token.as_deref())?);
                if let Some(body) = body.clone() {
                    request = request.body(body);
                }
                Ok::<_, String>(request.send())
            };
            let token = match &session.oauth {
                Some(policy) => oauth::bearer(&app, &session.server_id, &session.url, policy).await,
                None => None,
            };
            let mut response = send(token.clone())?
                .await
                .map_err(|e| net::error_chain(&e))?;
            let mut sign_in = false;
            if let Some(policy) = &session.oauth {
                response = match response.status().as_u16() {
                    401 => {
                        let challenge = oauth::challenge::from_headers(response.headers());
                        let outcome = oauth::after_unauthorized(
                            &app,
                            &session.server_id,
                            &session.url,
                            policy,
                            token.as_deref(),
                            challenge,
                        )
                        .await;
                        match outcome {
                            oauth::Unauthorized::Retry(fresh) => {
                                let again =
                                    send(Some(fresh))?.await.map_err(|e| net::error_chain(&e))?;
                                if again.status() == reqwest::StatusCode::UNAUTHORIZED {
                                    sign_in = true;
                                    oauth::note_required(
                                        &app,
                                        &session.server_id,
                                        session.url.as_str(),
                                        oauth::Reason::Unauthorized,
                                        oauth::challenge::from_headers(again.headers()),
                                    );
                                }
                                again
                            }
                            oauth::Unauthorized::SignIn => {
                                sign_in = true;
                                response
                            }
                            oauth::Unauthorized::Other => response,
                        }
                    }
                    403 => {
                        if let Some(challenge) = oauth::challenge::from_headers(response.headers())
                            .filter(oauth::challenge::Challenge::insufficient_scope)
                        {
                            oauth::note_required(
                                &app,
                                &session.server_id,
                                session.url.as_str(),
                                oauth::Reason::Scope,
                                Some(challenge),
                            );
                        }
                        response
                    }
                    _ => response,
                };
            }
            let cap =
                (!http::is_event_stream(response.headers())).then_some(http::MAX_RESPONSE_BYTES);
            let mut headers = net::header_map_to_strings(response.headers());
            if sign_in {
                headers.insert(oauth::SIGN_IN_HEADER.to_owned(), "required".to_owned());
            }
            let metadata = serde_json::to_vec(&serde_json::json!({
                "status": response.status().as_u16(),
                "headers": headers,
            }))
            .map_err(|e| e.to_string())?;
            on_event
                .send(net::stream_packet(0, &metadata))
                .map_err(|e| e.to_string())?;
            net::pump(
                http::capped(response.bytes_stream(), cap),
                &lease.control,
                |packet| {
                    on_event
                        .send(Response::new(packet))
                        .map_err(|e| e.to_string())
                },
            )
            .await?;
            on_event
                .send(net::stream_packet(2, &[]))
                .map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        };
        if let Ok(Err(error)) = Abortable::new(run, registration).await {
            let _ = on_event.send(net::stream_packet(3, error.as_bytes()));
        }
        drop(lease);
    });
    Ok(())
}

#[tauri::command]
pub async fn mcp_http_cancel(
    window: WebviewWindow,
    streams: State<'_, McpHttpStreams>,
    request_id: String,
) -> Result<(), String> {
    streams.0.cancel(window.label(), &request_id);
    Ok(())
}

#[tauri::command]
pub async fn mcp_http_ack(
    window: WebviewWindow,
    streams: State<'_, McpHttpStreams>,
    request_id: String,
    bytes: u64,
) -> Result<(), String> {
    streams.0.acknowledge(window.label(), &request_id, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_input_is_bounded_and_validated() {
        let env = HashMap::from([("API_URL".to_string(), "https://x".to_string())]);
        assert!(check_spawn_input("npx", &["-y".into()], &env, &["TOKEN".into()]).is_ok());
        assert!(check_spawn_input("", &[], &HashMap::new(), &[]).is_err());
        assert!(check_spawn_input("a\0b", &[], &HashMap::new(), &[]).is_err());
        assert!(check_spawn_input("npx", &["a\0".into()], &HashMap::new(), &[]).is_err());
        let too_many: Vec<String> = (0..=MAX_ARGS).map(|i| i.to_string()).collect();
        assert!(check_spawn_input("npx", &too_many, &HashMap::new(), &[]).is_err());
        let bad_env = HashMap::from([("A-B".to_string(), "x".to_string())]);
        assert!(check_spawn_input("npx", &[], &bad_env, &[]).is_err());
        assert!(check_spawn_input("npx", &[], &HashMap::new(), &["1X".into()]).is_err());
    }
}
