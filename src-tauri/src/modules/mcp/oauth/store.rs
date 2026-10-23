//! What sign-in keeps, in the keychain under the MCP service, per server: the tokens with what
//! they are bound to, and a dynamically registered client, each one JSON record
//! (`<server>/oauth/tokens`, `<server>/oauth/client`). Never in a store file, never sent to a
//! page. Access tokens are often longer than Windows keeps in one item; `secrets` splits such a
//! record like any long value.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::super::names::{oauth_account, OauthItem, SECRET_SERVICE};
use crate::modules::secrets;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ClientAuth {
    /// A public client: `client_id` in the request body.
    None,
    /// HTTP Basic with the client secret.
    ClientSecretBasic,
    /// The client secret in the request body.
    ClientSecretPost,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ClientSource {
    /// Registered by Terax (RFC 7591); the secret, if any, is in the client record.
    Registered,
    /// Configured by the user; the secret, if any, is `<server>/oauth/client-secret`.
    Configured,
}

/// The tokens of one server, and everything they are bound to: they are sent only to the
/// server URL they were obtained for, and refreshed only at the token endpoint that issued them.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TokenSet {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Seconds since the Unix epoch; None when the server did not say.
    #[serde(default)]
    pub expires_at: Option<u64>,
    #[serde(default)]
    pub scope: Option<String>,
    /// The server URL as configured when the user signed in.
    pub server_url: String,
    /// The RFC 8707 resource the tokens were requested for.
    pub resource: String,
    pub issuer: String,
    pub token_endpoint: String,
    pub client_id: String,
    pub client_auth: ClientAuth,
    pub client_source: ClientSource,
    pub obtained_at: u64,
}

impl std::fmt::Debug for TokenSet {
    /// Never prints a token, so no log line or panic message can carry one.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenSet")
            .field("server_url", &self.server_url)
            .field("issuer", &self.issuer)
            .field("expires_at", &self.expires_at)
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "<set>"),
            )
            .finish_non_exhaustive()
    }
}

/// A client Terax registered with an authorization server, bound to that server's issuer and
/// to the redirect URI it was registered with.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    pub issuer: String,
    pub client_id: String,
    #[serde(default)]
    pub client_secret: Option<String>,
    /// Seconds since the Unix epoch; 0 or None when it does not expire.
    #[serde(default)]
    pub client_secret_expires_at: Option<u64>,
    pub client_auth: ClientAuth,
    pub redirect_uri: String,
    pub registered_at: u64,
}

impl std::fmt::Debug for Registration {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Registration")
            .field("issuer", &self.issuer)
            .field("client_id", &self.client_id)
            .field("redirect_uri", &self.redirect_uri)
            .finish_non_exhaustive()
    }
}

impl Registration {
    pub fn usable(&self, issuer: &str, redirect_uri: &str, now: u64) -> bool {
        self.issuer == issuer
            && self.redirect_uri == redirect_uri
            && self
                .client_secret_expires_at
                .is_none_or(|at| at == 0 || at > now + 60)
    }
}

/// Reads a record; None when there is none. A damaged one reads as none (signing in again
/// writes a fresh one).
pub async fn read<T: DeserializeOwned>(
    app: &AppHandle,
    server: &str,
    item: OauthItem,
) -> Result<Option<T>, String> {
    let account = oauth_account(server, item)?;
    let Some(json) = secrets::backend_get(app.clone(), SECRET_SERVICE, vec![account])
        .await?
        .pop()
        .flatten()
    else {
        return Ok(None);
    };
    let record = serde_json::from_str(&json).ok();
    if record.is_none() {
        log::warn!("mcp: a sign-in record of {server} is damaged");
    }
    Ok(record)
}

/// Writes a record over the previous one.
pub async fn write<T: Serialize>(
    app: &AppHandle,
    server: &str,
    item: OauthItem,
    value: &T,
) -> Result<(), String> {
    let json = serde_json::to_string(value).map_err(|e| e.to_string())?;
    secrets::backend_set(app.clone(), SECRET_SERVICE, oauth_account(server, item)?, json)
        .await
        .map_err(|e| format!("mcp: the sign-in could not be kept: {e}"))
}

pub async fn delete(app: &AppHandle, server: &str, item: OauthItem) -> Result<(), String> {
    secrets::backend_delete(
        app.clone(),
        SECRET_SERVICE,
        vec![oauth_account(server, item)?],
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens() -> TokenSet {
        TokenSet {
            access_token: "AT-secret".into(),
            refresh_token: Some("RT-secret".into()),
            expires_at: Some(10),
            scope: None,
            server_url: "https://mcp.example.com/mcp".into(),
            resource: "https://mcp.example.com/mcp".into(),
            issuer: "https://auth.example.com".into(),
            token_endpoint: "https://auth.example.com/token".into(),
            client_id: "c".into(),
            client_auth: ClientAuth::None,
            client_source: ClientSource::Registered,
            obtained_at: 1,
        }
    }

    #[test]
    fn debug_output_never_carries_a_token_or_secret() {
        let text = format!("{:?}", tokens());
        assert!(
            !text.contains("AT-secret") && !text.contains("RT-secret"),
            "{text}"
        );
        let registration = Registration {
            issuer: "https://auth.example.com".into(),
            client_id: "c".into(),
            client_secret: Some("CS-secret".into()),
            client_secret_expires_at: None,
            client_auth: ClientAuth::ClientSecretBasic,
            redirect_uri: "http://127.0.0.1:1/callback".into(),
            registered_at: 1,
        };
        assert!(!format!("{registration:?}").contains("CS-secret"));
    }

    #[test]
    fn a_registration_is_reused_only_where_it_was_made() {
        let mut r = Registration {
            issuer: "https://a".into(),
            client_id: "c".into(),
            client_secret: None,
            client_secret_expires_at: Some(0),
            client_auth: ClientAuth::None,
            redirect_uri: "http://127.0.0.1:5000/callback".into(),
            registered_at: 1,
        };
        assert!(r.usable("https://a", "http://127.0.0.1:5000/callback", 100));
        assert!(!r.usable("https://b", "http://127.0.0.1:5000/callback", 100));
        assert!(!r.usable("https://a", "http://127.0.0.1:5001/callback", 100));
        r.client_secret_expires_at = Some(120);
        assert!(!r.usable("https://a", "http://127.0.0.1:5000/callback", 100));
        r.client_secret_expires_at = Some(1000);
        assert!(r.usable("https://a", "http://127.0.0.1:5000/callback", 100));
    }

    #[test]
    fn token_records_round_trip() {
        let json = serde_json::to_string(&tokens()).unwrap();
        let back: TokenSet = serde_json::from_str(&json).unwrap();
        assert!(back == tokens());
    }
}
