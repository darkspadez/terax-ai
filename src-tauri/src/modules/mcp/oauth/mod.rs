//! OAuth sign-in for remote MCP servers (the MCP authorization specification, revision
//! 2026-07-28), entirely in the backend: the page never sees a token.
//!
//! - A server that answers 401 (or whose protected resource metadata says it is protected)
//!   is "sign in required"; Settings shows it, and only Settings may sign in or out.
//! - Sign-in (`mcp_oauth_sign_in`): discovery (`flow.rs`, `discovery.rs`), a client (the one
//!   the user configured, else one registered dynamically and kept per authorization server),
//!   authorization code with PKCE S256, `state` and `resource`, through the system browser and
//!   a one-shot loopback listener (`callback.rs`); the issuer of the response is checked
//!   (RFC 9207).
//! - Tokens and the registration live in the keychain (`store.rs`), bound to the server URL
//!   they were obtained for. Requests of that server's sessions get `Authorization: Bearer`
//!   here (`bearer`), refreshed before expiry or once on a 401 (`after_unauthorized`); a refresh
//!   the server refuses deletes them and reports sign-in required.
//!
//! Client ID metadata documents are not offered: they need an https document Oarlock would host.

mod callback;
pub mod challenge;
mod discovery;
mod fetch;
mod flow;
#[cfg(test)]
mod live_tests;
mod pkce;
mod store;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::Url;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tokio::sync::Notify;

use super::names::{secret_account, OauthItem, SecretKind, OAUTH_CLIENT_SECRET, SECRET_SERVICE};
use super::{http, require_server_id, require_settings, McpState};
use challenge::Challenge;
pub use fetch::Policy;
use flow::{Client, TokenError};
use store::{ClientSource, Registration, TokenSet};

/// Sent to every window when a server's sign-in state changes: `{ serverId }`.
pub const AUTH_EVENT: &str = "oarlock://mcp-auth";
/// How long the browser has to come back.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Refresh this long before the access token expires.
const REFRESH_MARGIN_SECS: u64 = 60;

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Reason {
    /// The server answered 401.
    Unauthorized,
    /// It publishes protected resource metadata, so it is protected.
    Metadata,
    /// It asked for more scopes (403 insufficient_scope).
    Scope,
    /// Its tokens could not be refreshed.
    Expired,
}

#[derive(Clone, Debug)]
struct Required {
    url: String,
    reason: Reason,
    challenge: Option<Challenge>,
}

struct Pending {
    server_id: String,
    cancel: Arc<Notify>,
}

/// Sign-in state the backend keeps in memory; the records themselves are in the keychain.
#[derive(Default)]
pub struct OAuthState {
    /// Token records read so far (None: known to have none).
    tokens: Mutex<HashMap<String, Option<Arc<TokenSet>>>>,
    /// One refresh at a time per server.
    refreshing: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    required: Mutex<HashMap<String, Required>>,
    pending: Mutex<Option<Pending>>,
}

fn state(app: &AppHandle) -> &OAuthState {
    &app.state::<McpState>().inner().oauth
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AuthEvent<'a> {
    server_id: &'a str,
}

fn announce(app: &AppHandle, server_id: &str) {
    let _ = app.emit(AUTH_EVENT, AuthEvent { server_id });
}

/// The token record of a server, read from the keychain once.
async fn tokens(app: &AppHandle, server_id: &str) -> Option<Arc<TokenSet>> {
    if let Some(cached) = lock(&state(app).tokens).get(server_id) {
        return cached.clone();
    }
    let read = store::read::<TokenSet>(app, server_id, OauthItem::Tokens)
        .await
        .unwrap_or_else(|error| {
            log::warn!("mcp: could not read the sign-in of {server_id}: {error}");
            None
        })
        .map(Arc::new);
    lock(&state(app).tokens)
        .entry(server_id.to_owned())
        .or_insert(read)
        .clone()
}

/// The tokens of `server_id` when they were obtained for `url`, the server as configured now.
async fn bound_tokens(app: &AppHandle, server_id: &str, url: &str) -> Option<Arc<TokenSet>> {
    tokens(app, server_id).await.filter(|t| t.server_url == url)
}

async fn save_tokens(
    app: &AppHandle,
    server_id: &str,
    tokens: TokenSet,
) -> Result<Arc<TokenSet>, String> {
    store::write(app, server_id, OauthItem::Tokens, &tokens).await?;
    let tokens = Arc::new(tokens);
    lock(&state(app).tokens).insert(server_id.to_owned(), Some(tokens.clone()));
    Ok(tokens)
}

async fn forget_tokens(app: &AppHandle, server_id: &str) {
    if let Err(error) = store::delete(app, server_id, OauthItem::Tokens).await {
        log::warn!("mcp: could not delete the tokens of {server_id}: {error}");
    }
    lock(&state(app).tokens).insert(server_id.to_owned(), None);
}

fn refresh_lock(app: &AppHandle, server_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    credential_lock(state(app), server_id)
}

fn credential_lock(state: &OAuthState, server_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    lock(&state.refreshing)
        .entry(server_id.to_owned())
        .or_default()
        .clone()
}

/// Marks a server as needing sign-in; tells Settings when that is news.
pub fn note_required(
    app: &AppHandle,
    server_id: &str,
    url: &str,
    reason: Reason,
    challenge: Option<Challenge>,
) {
    let changed = {
        let mut required = lock(&state(app).required);
        let next = Required {
            url: url.to_owned(),
            reason,
            challenge,
        };
        let changed = required
            .get(server_id)
            .is_none_or(|old| old.reason != next.reason || old.url != next.url);
        required.insert(server_id.to_owned(), next);
        changed
    };
    if changed {
        announce(app, server_id);
    }
}

fn clear_required(app: &AppHandle, server_id: &str) {
    lock(&state(app).required).remove(server_id);
}

/// The client the tokens were obtained with, its secret read again.
async fn client_of(app: &AppHandle, server_id: &str, tokens: &TokenSet) -> Result<Client, String> {
    let secret = match (tokens.client_auth, tokens.client_source) {
        (store::ClientAuth::None, _) => None,
        (_, ClientSource::Registered) => {
            store::read::<Registration>(app, server_id, OauthItem::Client)
                .await?
                .and_then(|r| r.client_secret)
        }
        (_, ClientSource::Configured) => configured_secret(app, server_id).await?,
    };
    Ok(Client {
        id: tokens.client_id.clone(),
        secret,
        auth: tokens.client_auth,
        source: tokens.client_source,
    })
}

async fn configured_secret(app: &AppHandle, server_id: &str) -> Result<Option<String>, String> {
    let account = secret_account(server_id, SecretKind::Oauth, OAUTH_CLIENT_SECRET)?;
    Ok(
        crate::modules::secrets::backend_get(app.clone(), SECRET_SERVICE, vec![account])
            .await?
            .pop()
            .flatten()
            .filter(|s| !s.is_empty()),
    )
}

fn renewed(old: &TokenSet, granted: flow::Granted, now: u64) -> TokenSet {
    TokenSet {
        access_token: granted.access_token,
        // A server that does not rotate keeps the old one valid.
        refresh_token: granted.refresh_token.or_else(|| old.refresh_token.clone()),
        expires_at: granted.expires_in.map(|s| now.saturating_add(s)),
        scope: granted.scope.or_else(|| old.scope.clone()),
        obtained_at: now,
        ..old.clone()
    }
}

/// Refreshes `current`. A refusal deletes the tokens; any failure reports sign-in required.
async fn refresh(
    app: &AppHandle,
    server_id: &str,
    policy: &Policy,
    current: &TokenSet,
) -> Option<Arc<TokenSet>> {
    let refresh_token = current.refresh_token.as_deref()?;
    let client = match client_of(app, server_id, current).await {
        Ok(client) => client,
        Err(error) => {
            log::warn!("mcp: cannot refresh {server_id}: {error}");
            return None;
        }
    };
    match flow::refresh(
        policy,
        &current.token_endpoint,
        &client,
        refresh_token,
        &current.resource,
    )
    .await
    {
        Ok(granted) => {
            match save_tokens(app, server_id, renewed(current, granted, now_secs())).await {
                Ok(tokens) => Some(tokens),
                Err(error) => {
                    log::warn!("mcp: could not keep the refreshed tokens of {server_id}: {error}");
                    None
                }
            }
        }
        Err(TokenError::Rejected(message)) => {
            log::info!("mcp: {server_id} sign-in expired: {message}");
            forget_tokens(app, server_id).await;
            note_required(app, server_id, &current.server_url, Reason::Expired, None);
            None
        }
        Err(TokenError::Failed(message)) => {
            log::warn!("mcp: could not refresh {server_id}: {message}");
            None
        }
    }
}

/// The access token for a request of `server_id`'s session at `url`, refreshed first when it
/// is about to expire. None when the user has not signed in for this URL.
pub async fn bearer(
    app: &AppHandle,
    server_id: &str,
    url: &Url,
    policy: &Policy,
) -> Option<String> {
    let current = bound_tokens(app, server_id, url.as_str()).await?;
    let due = current
        .expires_at
        .is_some_and(|at| at <= now_secs() + REFRESH_MARGIN_SECS);
    if !due || current.refresh_token.is_none() {
        return Some(current.access_token.clone());
    }
    let guard = refresh_lock(app, server_id);
    let _held = guard.lock().await;
    // Another request may have refreshed while this one waited.
    let latest = bound_tokens(app, server_id, url.as_str()).await?;
    if latest.access_token != current.access_token {
        return Some(latest.access_token.clone());
    }
    match refresh(app, server_id, policy, &latest).await {
        Some(fresh) => Some(fresh.access_token.clone()),
        None => bound_tokens(app, server_id, url.as_str())
            .await
            .map(|t| t.access_token.clone()),
    }
}

/// What a 401 means for a session.
#[derive(Debug, PartialEq, Eq)]
pub enum Unauthorized {
    /// Send the request again, once, with this token (a refreshed one).
    Retry(String),
    /// The user has to sign in; reported to Settings.
    SignIn,
    /// Not about sign-in: no token was sent and the server asked for none
    /// (a wrong API key, say).
    Other,
}

/// A request sent with `sent` (or no token) was answered 401 with `challenge` (its `Bearer`
/// challenge, if any).
pub async fn after_unauthorized(
    app: &AppHandle,
    server_id: &str,
    url: &Url,
    policy: &Policy,
    sent: Option<&str>,
    challenge: Option<Challenge>,
) -> Unauthorized {
    let retry = match sent {
        None if challenge.is_none() => return Unauthorized::Other,
        None => None,
        Some(sent) => {
            let guard = refresh_lock(app, server_id);
            let _held = guard.lock().await;
            match bound_tokens(app, server_id, url.as_str()).await {
                Some(latest) if latest.access_token != sent => Some(latest.access_token.clone()),
                Some(latest) => refresh(app, server_id, policy, &latest)
                    .await
                    .map(|fresh| fresh.access_token.clone()),
                None => None,
            }
        }
    };
    match retry {
        Some(token) => Unauthorized::Retry(token),
        None => {
            note_required(
                app,
                server_id,
                url.as_str(),
                Reason::Unauthorized,
                challenge,
            );
            Unauthorized::SignIn
        }
    }
}

/// The response header that tells the page's client the server needs sign-in (the backend has
/// tried refreshing by then), so it waits for the user instead of reconnecting.
pub const SIGN_IN_HEADER: &str = "x-oarlock-sign-in";

// ---- Status ----

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AuthState {
    SignedIn,
    Required,
    None,
}

/// A server's sign-in as Settings shows it. Never a token or a secret.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub server_id: String,
    pub state: AuthState,
    pub reason: Option<Reason>,
    /// The scopes the server asked for, when it asked.
    pub required_scope: Option<String>,
    pub scope: Option<String>,
    pub issuer: Option<String>,
    /// Milliseconds since the Unix epoch.
    pub expires_at_ms: Option<u64>,
    pub can_refresh: bool,
    pub signing_in: bool,
}

fn status_of(
    server_id: &str,
    url: &str,
    tokens: Option<&TokenSet>,
    required: Option<&Required>,
    signing_in: bool,
) -> AuthStatus {
    let tokens = tokens.filter(|t| t.server_url == url);
    let required = required.filter(|r| r.url == url);
    let state = match (tokens, required) {
        (_, Some(_)) => AuthState::Required,
        (Some(_), None) => AuthState::SignedIn,
        (None, None) => AuthState::None,
    };
    AuthStatus {
        server_id: server_id.to_owned(),
        state,
        reason: required.map(|r| r.reason),
        required_scope: required.and_then(|r| r.challenge.as_ref()?.scope.clone()),
        scope: tokens.and_then(|t| t.scope.clone()),
        issuer: tokens.map(|t| t.issuer.clone()),
        expires_at_ms: tokens
            .and_then(|t| t.expires_at)
            .map(|s| s.saturating_mul(1000)),
        can_refresh: tokens.is_some_and(|t| t.refresh_token.is_some()),
        signing_in,
    }
}

async fn status(app: &AppHandle, server_id: &str, url: &str) -> AuthStatus {
    let tokens = tokens(app, server_id).await;
    let required = lock(&state(app).required).get(server_id).cloned();
    let signing_in = lock(&state(app).pending)
        .as_ref()
        .is_some_and(|p| p.server_id == server_id);
    status_of(
        server_id,
        url,
        tokens.as_deref(),
        required.as_ref(),
        signing_in,
    )
}

/// The server URL a sign-in command acts on: a project server's comes from its trusted
/// `.mcp.json` (expanded), never from the page.
async fn server_url(
    app: &AppHandle,
    server_id: &str,
    page_url: &str,
    shell: Option<String>,
) -> Result<Url, String> {
    if super::project::is_project_server(server_id) {
        let app = app.clone();
        let id = server_id.to_owned();
        return crate::modules::fs::blocking(move || super::project::server_url(&app, &id, shell))
            .await;
    }
    http::parse_server_url(page_url)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerRef {
    server_id: String,
    url: String,
}

/// The sign-in state of each server, for Settings.
#[tauri::command]
pub async fn mcp_oauth_status(
    app: AppHandle,
    window: WebviewWindow,
    servers: Vec<ServerRef>,
    shell: Option<String>,
) -> Result<Vec<AuthStatus>, String> {
    require_settings(&window)?;
    let mut out = Vec::with_capacity(servers.len());
    for server in servers.into_iter().take(256) {
        require_server_id(&server.server_id)?;
        let url = match server_url(&app, &server.server_id, &server.url, shell.clone()).await {
            Ok(url) => url.to_string(),
            Err(_) => server.url,
        };
        out.push(status(&app, &server.server_id, &url).await);
    }
    Ok(out)
}

/// Looks for the server's protected resource metadata: a server that publishes it is
/// protected, so Settings shows sign-in required before the first connection fails.
#[tauri::command]
pub async fn mcp_oauth_probe(
    app: AppHandle,
    window: WebviewWindow,
    server_id: String,
    url: String,
    shell: Option<String>,
) -> Result<AuthStatus, String> {
    require_settings(&window)?;
    require_server_id(&server_id)?;
    let url = server_url(&app, &server_id, &url, shell).await?;
    let known = bound_tokens(&app, &server_id, url.as_str()).await.is_some()
        || lock(&state(&app).required).contains_key(&server_id);
    if !known {
        let host = url.host_str().ok_or("mcp: the URL has no host")?;
        let policy = Policy::for_server(&url, crate::modules::net::host_is_private(host).await?);
        if let Ok(Some(_)) = flow::resource_metadata(&policy, &url, None).await {
            note_required(&app, &server_id, url.as_str(), Reason::Metadata, None);
        }
    }
    Ok(status(&app, &server_id, url.as_str()).await)
}

/// A client the user configured for a server.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClientInput {
    client_id: Option<String>,
    /// Its secret is in the keychain (`<server>/oauth/client-secret`).
    #[serde(default)]
    has_secret: bool,
    scopes: Option<String>,
    callback_port: Option<u16>,
}

fn port_of(redirect_uri: &str) -> Option<u16> {
    Url::parse(redirect_uri).ok()?.port()
}

/// Everything up to the browser: discovery, the client, the listener and the URL to open.
struct Prepared {
    discovered: flow::Discovered,
    client: Client,
    listener: callback::Listener,
    scope: Option<String>,
    verifier: String,
    state: String,
    authorization_url: Url,
}

async fn prepare(
    app: &AppHandle,
    server_id: &str,
    server: &Url,
    policy: &Policy,
    input: &ClientInput,
    cancel: &Notify,
) -> Result<Prepared, String> {
    let required = lock(&state(app).required).get(server_id).cloned();
    let challenge = required
        .filter(|r| r.url == server.as_str())
        .and_then(|r| r.challenge);
    let previous = bound_tokens(app, server_id, server.as_str()).await;
    let discovered = flow::discover(policy, server, challenge.as_ref()).await?;
    let auth = &discovered.auth;
    let scope = discovery::select_scope(
        input.scopes.as_deref(),
        challenge.as_ref().and_then(|c| c.scope.as_deref()),
        previous.as_ref().and_then(|t| t.scope.as_deref()),
        discovered
            .resource_metadata
            .as_ref()
            .map_or(&[][..], |prm| &prm.scopes_supported),
        &auth.scopes_supported,
    );
    let bind = |port: u16| async move {
        callback::Listener::bind(port).await.map_err(|e| {
            format!("could not listen for the sign-in response on 127.0.0.1:{port}: {e}")
        })
    };
    let configured = input
        .client_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let (listener, client) = match configured {
        Some(id) => {
            let listener = bind(input.callback_port.unwrap_or(0)).await?;
            let secret = if input.has_secret {
                configured_secret(app, server_id).await?
            } else {
                None
            };
            let client = Client {
                id: id.to_owned(),
                auth: flow::configured_auth(secret.is_some(), &auth.token_endpoint_auth_methods),
                secret,
                source: ClientSource::Configured,
            };
            (listener, client)
        }
        None => {
            let stored = store::read::<Registration>(app, server_id, OauthItem::Client)
                .await?
                .filter(|r| r.issuer == auth.issuer);
            // The port it was registered with, so its redirect URI still matches.
            let mut listener = None;
            if let Some(port) = stored.as_ref().and_then(|r| port_of(&r.redirect_uri)) {
                listener = callback::Listener::bind(port).await.ok();
            }
            let listener = match listener {
                Some(listener) => listener,
                None => bind(input.callback_port.unwrap_or(0)).await?,
            };
            let redirect_uri = listener.redirect_uri();
            let registration = match stored
                .filter(|r| r.usable(&auth.issuer, &redirect_uri, now_secs()))
            {
                Some(registration) => registration,
                None => {
                    let registration =
                        flow::register(policy, auth, &redirect_uri, scope.as_deref(), now_secs())
                            .await?;
                    let guard = refresh_lock(app, server_id);
                    let _held = guard.lock().await;
                    if !lock(&state(app).pending)
                        .as_ref()
                        .is_some_and(|p| std::ptr::eq(p.cancel.as_ref(), cancel))
                    {
                        return Err("sign-in was cancelled".into());
                    }
                    store::write(app, server_id, OauthItem::Client, &registration).await?;
                    registration
                }
            };
            (listener, Client::from(registration))
        }
    };
    let (verifier, code_challenge) = pkce::new_pair()?;
    let state = pkce::random_token(32)?;
    let authorization_url = flow::authorization_url(
        auth,
        &client.id,
        &listener.redirect_uri(),
        &code_challenge,
        &state,
        scope.as_deref(),
        &discovered.resource,
    )?;
    Ok(Prepared {
        discovered,
        client,
        listener,
        scope,
        verifier,
        state,
        authorization_url,
    })
}

/// What the browser came back with: the tokens, or why not.
async fn finish(
    server: &Url,
    policy: &Policy,
    prepared: &Prepared,
    params: &HashMap<String, String>,
) -> Result<TokenSet, String> {
    let auth = &prepared.discovered.auth;
    discovery::check_response_issuer(
        &auth.issuer,
        params.get("iss").map(String::as_str),
        auth.iss_parameter_supported,
    )?;
    if let Some(error) = params.get("error") {
        let description = params
            .get("error_description")
            .map(|d| format!(" ({})", flow::clean(d)))
            .unwrap_or_default();
        return Err(format!(
            "the authorization server did not sign you in: {}{description}",
            flow::clean(error)
        ));
    }
    let code = params
        .get("code")
        .filter(|c| !c.is_empty())
        .ok_or("the sign-in response has no authorization code")?;
    let granted = flow::exchange_code(
        policy,
        &auth.token_endpoint,
        &prepared.client,
        code,
        &prepared.verifier,
        &prepared.listener.redirect_uri(),
        &prepared.discovered.resource,
    )
    .await
    .map_err(|e| e.message().to_owned())?;
    let now = now_secs();
    Ok(TokenSet {
        access_token: granted.access_token,
        refresh_token: granted.refresh_token,
        expires_at: granted.expires_in.map(|s| now.saturating_add(s)),
        scope: granted.scope.or_else(|| prepared.scope.clone()),
        server_url: server.to_string(),
        resource: prepared.discovered.resource.clone(),
        issuer: auth.issuer.clone(),
        token_endpoint: auth.token_endpoint.clone(),
        client_id: prepared.client.id.clone(),
        client_auth: prepared.client.auth,
        client_source: prepared.client.source,
        obtained_at: now,
    })
}

async fn open_browser(app: &AppHandle, url: &Url) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let app = app.clone();
    let url = url.to_string();
    crate::modules::fs::blocking(move || {
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|e| format!("could not open your browser: {e}"))
    })
    .await
}

async fn sign_in(
    app: &AppHandle,
    server_id: &str,
    server: &Url,
    input: &ClientInput,
    cancel: &Notify,
) -> Result<TokenSet, String> {
    let host = server.host_str().ok_or("mcp: the URL has no host")?;
    let policy = Policy::for_server(server, crate::modules::net::host_is_private(host).await?);
    let prepared = prepare(app, server_id, server, &policy, input, cancel).await?;
    if !lock(&state(app).pending)
        .as_ref()
        .is_some_and(|p| std::ptr::eq(p.cancel.as_ref(), cancel))
    {
        return Err("sign-in was cancelled".into());
    }
    open_browser(app, &prepared.authorization_url).await?;
    let waited = tokio::select! {
        got = prepared.listener.wait(&prepared.state) => Ok(got),
        () = cancel.notified() => Err("sign-in was cancelled"),
        () = tokio::time::sleep(SIGN_IN_TIMEOUT) => Err("sign-in timed out; start it again"),
    };
    let (params, mut stream) = waited.map_err(str::to_owned)?;
    let result = finish(server, &policy, &prepared, &params).await;
    let page = match &result {
        Ok(_) => callback::page(
            "Signed in",
            "Oarlock is signed in to the server. You can close this tab.",
        ),
        Err(error) => callback::page(
            "Sign-in failed",
            &format!("{error}. You can close this tab and try again from Oarlock's Settings."),
        ),
    };
    let _ = callback::respond(&mut stream, 200, &page).await;
    result
}

/// Signs in to a server: opens the system browser and waits (up to five minutes) for the
/// authorization server to send it back. The settings window only.
#[tauri::command]
pub async fn mcp_oauth_sign_in(
    app: AppHandle,
    window: WebviewWindow,
    server_id: String,
    url: String,
    client: Option<ClientInput>,
    shell: Option<String>,
) -> Result<AuthStatus, String> {
    require_settings(&window)?;
    require_server_id(&server_id)?;
    let server = server_url(&app, &server_id, &url, shell).await?;
    let input = client.unwrap_or_default();
    let cancel = Arc::new(Notify::new());
    if let Some(previous) = lock(&state(&app).pending).replace(Pending {
        server_id: server_id.clone(),
        cancel: cancel.clone(),
    }) {
        previous.cancel.notify_one();
    }
    announce(&app, &server_id);
    let result = sign_in(&app, &server_id, &server, &input, &cancel).await;
    let guard = refresh_lock(&app, &server_id);
    let _held = guard.lock().await;
    let current = {
        let pending = lock(&state(&app).pending);
        pending
            .as_ref()
            .is_some_and(|p| Arc::ptr_eq(&p.cancel, &cancel))
    };
    if !current {
        return Err("mcp: sign-in was cancelled".into());
    }
    {
        let mut pending = lock(&state(&app).pending);
        if pending
            .as_ref()
            .is_some_and(|p| Arc::ptr_eq(&p.cancel, &cancel))
        {
            *pending = None;
        }
    }
    let outcome = match result {
        Ok(tokens) => save_tokens(&app, &server_id, tokens).await.map(|_| {
            clear_required(&app, &server_id);
        }),
        Err(error) => Err(error),
    };
    announce(&app, &server_id);
    outcome.map_err(|e| format!("mcp: {e}"))?;
    Ok(status(&app, &server_id, server.as_str()).await)
}

#[tauri::command]
pub fn mcp_oauth_cancel(
    app: AppHandle,
    window: WebviewWindow,
    server_id: String,
) -> Result<(), String> {
    require_settings(&window)?;
    cancel_pending(state(&app), &server_id);
    Ok(())
}

/// Deletes the server's tokens and its registration. The settings window only.
#[tauri::command]
pub async fn mcp_oauth_sign_out(
    app: AppHandle,
    window: WebviewWindow,
    server_id: String,
) -> Result<(), String> {
    require_settings(&window)?;
    require_server_id(&server_id)?;
    forget(&app, &server_id).await
}

fn cancel_pending(state: &OAuthState, server_id: &str) {
    let mut pending = lock(&state.pending);
    if pending.as_ref().is_some_and(|p| p.server_id == server_id) {
        if let Some(pending) = pending.take() {
            pending.cancel.notify_one();
        }
    }
}

/// Forgets everything sign-in kept for a server (sign out, or the server was removed).
pub async fn forget(app: &AppHandle, server_id: &str) -> Result<(), String> {
    cancel_pending(state(app), server_id);
    let guard = refresh_lock(app, server_id);
    let _held = guard.lock().await;
    forget_tokens(app, server_id).await;
    store::delete(app, server_id, OauthItem::Client).await?;
    clear_required(app, server_id);
    announce(app, server_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sign_out_serializes_after_an_in_flight_refresh() {
        let state = OAuthState::default();
        let refresh = credential_lock(&state, "server");
        let sign_out = credential_lock(&state, "server");
        let tokens = Arc::new(Mutex::new(Some("old")));
        let held = refresh.lock_owned().await;
        let saved = tokens.clone();
        let task = tokio::spawn(async move {
            let _held = sign_out.lock().await;
            *lock(&saved) = None;
        });
        tokio::task::yield_now().await;
        assert!(!task.is_finished());
        *lock(&tokens) = Some("refreshed");
        drop(held);
        task.await.unwrap();
        assert!(lock(&tokens).is_none());
    }

    #[test]
    fn sign_out_invalidates_a_pending_sign_in_identity() {
        let state = OAuthState::default();
        let cancel = Arc::new(Notify::new());
        *lock(&state.pending) = Some(Pending {
            server_id: "server".into(),
            cancel: cancel.clone(),
        });
        cancel_pending(&state, "other");
        assert!(lock(&state.pending).is_some());
        cancel_pending(&state, "server");
        assert!(lock(&state.pending).is_none());
        let replacement = Arc::new(Notify::new());
        *lock(&state.pending) = Some(Pending {
            server_id: "server".into(),
            cancel: replacement,
        });
        assert!(!lock(&state.pending)
            .as_ref()
            .is_some_and(|p| Arc::ptr_eq(&p.cancel, &cancel)));
    }

    fn tokens(url: &str) -> TokenSet {
        TokenSet {
            access_token: "AT-very-secret".into(),
            refresh_token: Some("RT-very-secret".into()),
            expires_at: Some(1_000),
            scope: Some("read".into()),
            server_url: url.into(),
            resource: url.into(),
            issuer: "https://auth.example.com".into(),
            token_endpoint: "https://auth.example.com/token".into(),
            client_id: "client".into(),
            client_auth: store::ClientAuth::None,
            client_source: ClientSource::Registered,
            obtained_at: 1,
        }
    }

    const URL: &str = "https://mcp.example.com/mcp";

    #[test]
    fn the_status_the_page_gets_never_carries_a_token() {
        let t = tokens(URL);
        let status = status_of("s1", URL, Some(&t), None, false);
        assert_eq!(status.state, AuthState::SignedIn);
        assert_eq!(status.expires_at_ms, Some(1_000_000));
        assert!(status.can_refresh);
        let json = serde_json::to_string(&status).unwrap();
        assert!(!json.contains("AT-very-secret"), "{json}");
        assert!(!json.contains("RT-very-secret"), "{json}");
        assert!(!json.contains("client"), "not even the client id: {json}");
    }

    #[test]
    fn tokens_count_only_for_the_url_they_were_obtained_for() {
        let t = tokens(URL);
        let moved = status_of("s1", "https://other.example.com/mcp", Some(&t), None, false);
        assert_eq!(moved.state, AuthState::None);
        assert_eq!(moved.issuer, None);
    }

    #[test]
    fn a_refusal_or_a_challenge_means_sign_in_required() {
        let t = tokens(URL);
        let required = Required {
            url: URL.into(),
            reason: Reason::Scope,
            challenge: Some(Challenge {
                scope: Some("files:write".into()),
                ..Challenge::default()
            }),
        };
        let status = status_of("s1", URL, Some(&t), Some(&required), true);
        assert_eq!(status.state, AuthState::Required);
        assert_eq!(status.reason, Some(Reason::Scope));
        assert_eq!(status.required_scope.as_deref(), Some("files:write"));
        assert!(status.signing_in);
        // A challenge from the server's previous URL does not count.
        let stale = Required {
            url: "https://old.example.com".into(),
            ..required
        };
        assert_eq!(
            status_of("s1", URL, None, Some(&stale), false).state,
            AuthState::None
        );
    }

    #[test]
    fn a_refresh_keeps_what_the_server_did_not_replace() {
        let old = tokens(URL);
        let fresh = renewed(
            &old,
            flow::Granted {
                access_token: "new".into(),
                refresh_token: None,
                expires_in: Some(100),
                scope: None,
            },
            50,
        );
        assert_eq!(fresh.access_token, "new");
        assert_eq!(fresh.refresh_token, old.refresh_token);
        assert_eq!(fresh.expires_at, Some(150));
        assert_eq!(fresh.scope, old.scope);
        assert_eq!(fresh.server_url, URL);
        let rotated = renewed(
            &old,
            flow::Granted {
                access_token: "new".into(),
                refresh_token: Some("rotated".into()),
                expires_in: None,
                scope: Some("read write".into()),
            },
            50,
        );
        assert_eq!(rotated.refresh_token.as_deref(), Some("rotated"));
        assert_eq!(rotated.expires_at, None);
        assert_eq!(rotated.scope.as_deref(), Some("read write"));
    }

    #[test]
    fn the_page_names_the_same_event_and_marker() {
        let source = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/modules/mcp/lib/auth.ts"),
        )
        .unwrap();
        assert!(source.contains(&format!("MCP_AUTH_EVENT = \"{AUTH_EVENT}\"")));
        assert!(source.contains(&format!("SIGN_IN_HEADER = \"{SIGN_IN_HEADER}\"")));
    }

    #[test]
    fn redirect_ports_are_read_back() {
        assert_eq!(port_of("http://127.0.0.1:5000/callback"), Some(5000));
        assert_eq!(port_of("http://127.0.0.1/callback"), None);
        assert_eq!(port_of("nonsense"), None);
    }
}
