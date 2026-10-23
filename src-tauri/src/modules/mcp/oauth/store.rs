//! What sign-in keeps, in the keychain under the MCP service, per server: the tokens with what
//! they are bound to, and a dynamically registered client. Never in a store file, never sent to
//! a page.
//!
//! A record is JSON split into chunks of at most `CHUNK_UNITS` UTF-16 units, one keychain item
//! each (`<server>/oauth/tokens`, `<server>/oauth/tokens.1`, ...): Windows Credential Manager
//! holds at most 2,560 bytes of UTF-16 per item, and access tokens are often longer. The first
//! chunk says how many there are.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::super::names::{oauth_account, OauthItem, SECRET_SERVICE};
use crate::modules::secrets;

/// Below the 1,280 UTF-16 units Windows allows per item, with room for the header.
const CHUNK_UNITS: usize = 1200;
pub const MAX_CHUNKS: usize = 24;
const VERSION: &str = "1";

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

/// Splits `value` into chunks, the first prefixed with the version and the count.
pub fn encode_chunks(value: &str) -> Result<Vec<String>, String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut units = 0;
    for ch in value.chars() {
        let len = ch.len_utf16();
        if units + len > CHUNK_UNITS {
            chunks.push(std::mem::take(&mut current));
            units = 0;
        }
        current.push(ch);
        units += len;
    }
    chunks.push(current);
    if chunks.len() > MAX_CHUNKS {
        return Err("mcp: the sign-in record is too large to keep".into());
    }
    let count = chunks.len();
    chunks[0] = format!("{VERSION}:{count}:{}", chunks[0]);
    Ok(chunks)
}

/// The number of chunks the first one announces, and its own data.
pub fn chunk_header(first: &str) -> Result<(usize, &str), String> {
    let mut parts = first.splitn(3, ':');
    let (Some(VERSION), Some(count), Some(data)) = (parts.next(), parts.next(), parts.next())
    else {
        return Err("mcp: the sign-in record is damaged".into());
    };
    let count: usize = count
        .parse()
        .ok()
        .filter(|n| (1..=MAX_CHUNKS).contains(n))
        .ok_or("mcp: the sign-in record is damaged")?;
    Ok((count, data))
}

fn accounts(
    server: &str,
    item: OauthItem,
    range: std::ops::Range<usize>,
) -> Result<Vec<String>, String> {
    range.map(|i| oauth_account(server, item, i)).collect()
}

/// Reads a record; None when there is none. A damaged one reads as none (signing in again
/// writes a fresh one).
pub async fn read<T: DeserializeOwned>(
    app: &AppHandle,
    server: &str,
    item: OauthItem,
) -> Result<Option<T>, String> {
    let first = secrets::backend_get(app.clone(), SECRET_SERVICE, accounts(server, item, 0..1)?)
        .await?
        .pop()
        .flatten();
    let Some(first) = first else {
        return Ok(None);
    };
    let Ok((count, data)) = chunk_header(&first) else {
        log::warn!("mcp: a sign-in record of {server} is damaged");
        return Ok(None);
    };
    let mut json = data.to_owned();
    if count > 1 {
        let rest = secrets::backend_get(
            app.clone(),
            SECRET_SERVICE,
            accounts(server, item, 1..count)?,
        )
        .await?;
        for part in rest {
            let Some(part) = part else {
                log::warn!("mcp: a sign-in record of {server} is incomplete");
                return Ok(None);
            };
            json.push_str(&part);
        }
    }
    Ok(serde_json::from_str(&json).ok())
}

async fn stored_count(app: &AppHandle, server: &str, item: OauthItem) -> usize {
    let Ok(first) = secrets::backend_get(
        app.clone(),
        SECRET_SERVICE,
        accounts(server, item, 0..1).unwrap_or_default(),
    )
    .await
    else {
        return 0;
    };
    first
        .into_iter()
        .flatten()
        .next()
        .and_then(|first| chunk_header(&first).ok().map(|(count, _)| count))
        .unwrap_or(0)
}

/// Writes a record, then removes the chunks of a longer previous one.
pub async fn write<T: Serialize>(
    app: &AppHandle,
    server: &str,
    item: OauthItem,
    value: &T,
) -> Result<(), String> {
    let json = serde_json::to_string(value).map_err(|e| e.to_string())?;
    let chunks = encode_chunks(&json)?;
    let previous = stored_count(app, server, item).await;
    // The tail first, so a reader never finds a new head with old chunks.
    for (i, chunk) in chunks.iter().enumerate().rev() {
        secrets::backend_set(
            app.clone(),
            SECRET_SERVICE,
            oauth_account(server, item, i)?,
            chunk.clone(),
        )
        .await?;
    }
    if previous > chunks.len() {
        secrets::backend_delete(
            app.clone(),
            SECRET_SERVICE,
            accounts(server, item, chunks.len()..previous)?,
        )
        .await?;
    }
    Ok(())
}

/// Deletes a record, every chunk of it.
pub async fn delete(app: &AppHandle, server: &str, item: OauthItem) -> Result<(), String> {
    let count = stored_count(app, server, item).await.max(1);
    secrets::backend_delete(
        app.clone(),
        SECRET_SERVICE,
        accounts(server, item, 0..count)?,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn join(chunks: &[String]) -> String {
        let (count, first) = chunk_header(&chunks[0]).unwrap();
        assert_eq!(count, chunks.len());
        let mut out = first.to_owned();
        for chunk in &chunks[1..] {
            out.push_str(chunk);
        }
        out
    }

    #[test]
    fn records_split_into_chunks_windows_can_hold() {
        for len in [0, 1, CHUNK_UNITS - 1, CHUNK_UNITS, CHUNK_UNITS + 1, 5000] {
            let value: String = "x".repeat(len);
            let chunks = encode_chunks(&value).unwrap();
            for chunk in &chunks {
                // Windows: 2,560 bytes of UTF-16 at most.
                assert!(chunk.encode_utf16().count() * 2 <= 2560, "{len}");
            }
            assert_eq!(join(&chunks), value);
        }
        // Characters outside the BMP take two units and are never split.
        let wide = "\u{1F600}".repeat(CHUNK_UNITS);
        let chunks = encode_chunks(&wide).unwrap();
        assert!(chunks.iter().all(|c| c.encode_utf16().count() * 2 <= 2560));
        assert_eq!(join(&chunks), wide);
        assert!(encode_chunks(&"x".repeat(CHUNK_UNITS * MAX_CHUNKS + 1)).is_err());
    }

    #[test]
    fn a_damaged_header_is_refused() {
        for bad in ["", "2:1:x", "1:0:x", "1:99:x", "1:x:y", "plain"] {
            assert!(chunk_header(bad).is_err(), "{bad}");
        }
        assert_eq!(chunk_header("1:1:{}").unwrap(), (1, "{}"));
        assert_eq!(chunk_header("1:2:a:b").unwrap(), (2, "a:b"));
    }

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
