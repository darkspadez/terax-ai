//! The requests of sign-in: discovery (protected resource metadata, then the authorization
//! server's), dynamic client registration (RFC 7591), the authorization URL (PKCE S256, `state`,
//! RFC 8707 `resource`), and the token requests (authorization code and refresh). Everything
//! goes through `fetch.rs`, so only URLs the metadata names, checked and pinned, are reached.

use reqwest::{Method, StatusCode, Url};
use serde::Deserialize;

use super::challenge::Challenge;
use super::discovery::{self, AuthServer, ProtectedResource};
use super::fetch::{self, Body, Policy};
use super::pkce;
use super::store::{ClientAuth, ClientSource, Registration};

const MAX_MESSAGE: usize = 300;

/// Where a server's sign-in happens.
#[derive(Clone, Debug)]
pub struct Discovered {
    /// The RFC 8707 resource to ask tokens for.
    pub resource: String,
    pub resource_metadata: Option<ProtectedResource>,
    pub auth: AuthServer,
}

/// The client sign-in acts as.
#[derive(Clone)]
pub struct Client {
    pub id: String,
    pub secret: Option<String>,
    pub auth: ClientAuth,
    pub source: ClientSource,
}

impl From<Registration> for Client {
    fn from(r: Registration) -> Self {
        Self {
            id: r.client_id,
            secret: r.client_secret,
            auth: r.client_auth,
            source: ClientSource::Registered,
        }
    }
}

/// How a configured client with a secret authenticates: Basic unless the server offers only
/// the body form (RFC 8414: Basic is the default when the server lists none).
pub fn configured_auth(secret: bool, methods: &[String]) -> ClientAuth {
    if !secret {
        ClientAuth::None
    } else if methods.is_empty() || methods.iter().any(|m| m == "client_secret_basic") {
        ClientAuth::ClientSecretBasic
    } else if methods.iter().any(|m| m == "client_secret_post") {
        ClientAuth::ClientSecretPost
    } else {
        ClientAuth::ClientSecretBasic
    }
}

/// Text from a server, made safe to show: one line, capped.
pub fn clean(text: &str) -> String {
    let flat: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= MAX_MESSAGE {
        flat
    } else {
        format!(
            "{}…",
            flat.chars().take(MAX_MESSAGE - 1).collect::<String>()
        )
    }
}

/// GETs a metadata document: its body on 200, None when it is not there.
async fn metadata(policy: &Policy, url: Url) -> Result<Option<bytes::Bytes>, String> {
    let fetched = fetch::request(policy, Method::GET, url, Body::None, None).await?;
    Ok((fetched.status == StatusCode::OK).then_some(fetched.body))
}

/// Finds the server's protected resource metadata: the URL its challenge named, else the
/// well-known URIs. None when it publishes none.
pub async fn resource_metadata(
    policy: &Policy,
    server: &Url,
    challenge: Option<&Challenge>,
) -> Result<Option<ProtectedResource>, String> {
    let named = challenge.and_then(|c| c.resource_metadata.as_deref());
    let candidates = match named {
        Some(url) => vec![policy.check(url)?],
        None => discovery::resource_metadata_urls(server),
    };
    for url in candidates {
        if let Some(body) = metadata(policy, url).await? {
            return discovery::parse_resource_metadata(&body, server).map(Some);
        }
    }
    Ok(None)
}

/// Discovery: the resource metadata (or, for a server that publishes none, the server's own
/// origin as its authorization server, as earlier MCP revisions had it), then the first usable
/// authorization server's metadata, with every endpoint checked.
pub async fn discover(
    policy: &Policy,
    server: &Url,
    challenge: Option<&Challenge>,
) -> Result<Discovered, String> {
    let found = resource_metadata(policy, server, challenge).await?;
    let (resource, issuers) = match &found {
        Some(prm) => (prm.resource.clone(), prm.authorization_servers.clone()),
        None => (
            discovery::canonical_resource(server),
            vec![server.origin().ascii_serialization()],
        ),
    };
    let issuer = issuers
        .iter()
        .find_map(|raw| {
            policy
                .check(raw)
                .ok()
                .filter(|url| url.query().is_none())
                .map(|url| (raw.clone(), url))
        })
        .ok_or("the server names no authorization server Oarlock can use (https only)")?;
    let mut auth = None;
    for url in discovery::auth_server_metadata_urls(&issuer.1) {
        if let Some(body) = metadata(policy, url).await? {
            auth = Some(discovery::parse_auth_server_metadata(&body, &issuer.0)?);
            break;
        }
    }
    let auth = auth.ok_or_else(|| {
        if found.is_some() {
            format!("no authorization server metadata found for {}", issuer.0)
        } else {
            "this server does not say how to sign in (it publishes no protected resource metadata)"
                .to_owned()
        }
    })?;
    policy.check(&auth.authorization_endpoint)?;
    policy.check(&auth.token_endpoint)?;
    if let Some(endpoint) = &auth.registration_endpoint {
        policy.check(endpoint)?;
    }
    Ok(Discovered {
        resource,
        resource_metadata: found,
        auth,
    })
}

#[derive(Deserialize)]
struct RawRegistration {
    client_id: Option<String>,
    client_secret: Option<String>,
    client_secret_expires_at: Option<u64>,
    token_endpoint_auth_method: Option<String>,
}

/// The registration response (RFC 7591 section 3.2.1).
pub fn parse_registration(
    status: StatusCode,
    body: &[u8],
    issuer: &str,
    redirect_uri: &str,
    now: u64,
) -> Result<Registration, String> {
    if !status.is_success() {
        return Err(format!(
            "the authorization server refused to register Oarlock: {}",
            oauth_error(body).unwrap_or_else(|| format!("HTTP {status}"))
        ));
    }
    let raw: RawRegistration = serde_json::from_slice(body)
        .map_err(|e| format!("the registration response is not valid JSON: {e}"))?;
    let client_id = raw
        .client_id
        .filter(|id| !id.is_empty() && id.len() <= 2048)
        .ok_or("the registration response has no client_id")?;
    let client_secret = raw.client_secret.filter(|s| !s.is_empty());
    let client_auth = match raw.token_endpoint_auth_method.as_deref() {
        Some("none") => ClientAuth::None,
        Some("client_secret_basic") => ClientAuth::ClientSecretBasic,
        Some("client_secret_post") => ClientAuth::ClientSecretPost,
        Some(other) => {
            return Err(format!(
            "the authorization server registered Oarlock for {other}, which Oarlock does not support"
        ))
        }
        None if client_secret.is_some() => ClientAuth::ClientSecretBasic,
        None => ClientAuth::None,
    };
    if client_auth != ClientAuth::None && client_secret.is_none() {
        return Err("the registration response has no client secret".into());
    }
    Ok(Registration {
        issuer: issuer.to_owned(),
        client_id,
        client_secret,
        client_secret_expires_at: raw.client_secret_expires_at,
        client_auth,
        redirect_uri: redirect_uri.to_owned(),
        registered_at: now,
    })
}

/// The registration request: a native public client with a loopback redirect.
pub fn registration_request(redirect_uri: &str, scope: Option<&str>) -> Vec<u8> {
    let mut body = serde_json::json!({
        "client_name": "Oarlock",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "application_type": "native",
    });
    if let Some(scope) = scope {
        body["scope"] = serde_json::Value::String(scope.to_owned());
    }
    serde_json::to_vec(&body).unwrap_or_default()
}

pub async fn register(
    policy: &Policy,
    auth: &AuthServer,
    redirect_uri: &str,
    scope: Option<&str>,
    now: u64,
) -> Result<Registration, String> {
    let endpoint = auth.registration_endpoint.as_deref().ok_or(
        "this server needs a client ID (it offers no automatic registration): enter one in the server's settings",
    )?;
    let fetched = fetch::request(
        policy,
        Method::POST,
        policy.check(endpoint)?,
        Body::Json(registration_request(redirect_uri, scope)),
        None,
    )
    .await?;
    parse_registration(
        fetched.status,
        &fetched.body,
        &auth.issuer,
        redirect_uri,
        now,
    )
}

/// The URL the browser opens.
pub fn authorization_url(
    auth: &AuthServer,
    client_id: &str,
    redirect_uri: &str,
    code_challenge: &str,
    state: &str,
    scope: Option<&str>,
    resource: &str,
) -> Result<Url, String> {
    let mut url = Url::parse(&auth.authorization_endpoint).map_err(|e| e.to_string())?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("code_challenge", code_challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", state)
            .append_pair("resource", resource);
        if let Some(scope) = scope {
            query.append_pair("scope", scope);
        }
    }
    Ok(url)
}

/// What a token endpoint granted.
pub struct Granted {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: Option<u64>,
    pub scope: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TokenError {
    /// The server refused the grant (an OAuth error): the tokens are no good.
    Rejected(String),
    /// It could not be asked or answered unusably: try again later.
    Failed(String),
}

impl TokenError {
    pub fn message(&self) -> &str {
        match self {
            TokenError::Rejected(m) | TokenError::Failed(m) => m,
        }
    }
}

#[derive(Deserialize)]
struct RawError {
    error: Option<String>,
    error_description: Option<String>,
}

/// An OAuth error response's code and description, cleaned. Never the raw body.
fn oauth_error(body: &[u8]) -> Option<String> {
    let raw: RawError = serde_json::from_slice(body).ok()?;
    let error = clean(&raw.error?);
    Some(match raw.error_description.map(|d| clean(&d)) {
        Some(description) if !description.is_empty() => format!("{error} ({description})"),
        _ => error,
    })
}

#[derive(Deserialize)]
struct RawToken {
    access_token: Option<String>,
    token_type: Option<String>,
    expires_in: Option<serde_json::Value>,
    refresh_token: Option<String>,
    scope: Option<String>,
}

pub fn parse_token_response(status: StatusCode, body: &[u8]) -> Result<Granted, TokenError> {
    if status == StatusCode::BAD_REQUEST || status == StatusCode::UNAUTHORIZED {
        return Err(match oauth_error(body) {
            Some(error) => {
                TokenError::Rejected(format!("the authorization server refused: {error}"))
            }
            None => TokenError::Failed(format!("the token request failed (HTTP {status})")),
        });
    }
    if !status.is_success() {
        return Err(TokenError::Failed(format!(
            "the token request failed (HTTP {status})"
        )));
    }
    let raw: RawToken = serde_json::from_slice(body)
        .map_err(|_| TokenError::Failed("the token response is not valid JSON".into()))?;
    let access_token = raw
        .access_token
        .filter(|t| !t.is_empty() && t.len() <= 16 * 1024 && !t.contains(['\r', '\n', '\0']))
        .ok_or_else(|| {
            TokenError::Failed("the token response has no usable access token".into())
        })?;
    match raw.token_type.as_deref() {
        Some(kind) if kind.eq_ignore_ascii_case("bearer") => {}
        Some(kind) => {
            return Err(TokenError::Failed(format!(
                "the server issued a {} token; Oarlock supports Bearer tokens only",
                clean(kind)
            )))
        }
        None => {
            return Err(TokenError::Failed(
                "the token response has no token type".into(),
            ))
        }
    }
    let expires_in = match raw.expires_in {
        Some(serde_json::Value::Number(n)) => n.as_u64(),
        Some(serde_json::Value::String(s)) => s.trim().parse().ok(),
        _ => None,
    };
    Ok(Granted {
        access_token,
        refresh_token: raw
            .refresh_token
            .filter(|t| !t.is_empty() && t.len() <= 16 * 1024),
        expires_in,
        scope: raw.scope.map(|s| clean(&s)).filter(|s| !s.is_empty()),
    })
}

/// A form value as RFC 6749 section 2.3.1 encodes client credentials for Basic.
fn form_value(value: &str) -> String {
    fetch::form(&[("v", value)])[2..].to_owned()
}

/// Sends a token request with the client's authentication.
async fn token_request(
    policy: &Policy,
    token_endpoint: &str,
    client: &Client,
    mut fields: Vec<(&str, &str)>,
) -> Result<Granted, TokenError> {
    let url = policy.check(token_endpoint).map_err(TokenError::Failed)?;
    let basic = match (client.auth, &client.secret) {
        (ClientAuth::ClientSecretBasic, Some(secret)) => Some(pkce::base64(
            format!("{}:{}", form_value(&client.id), form_value(secret)).as_bytes(),
        )),
        _ => None,
    };
    if basic.is_none() {
        fields.push(("client_id", &client.id));
    }
    if let (ClientAuth::ClientSecretPost, Some(secret)) = (client.auth, &client.secret) {
        fields.push(("client_secret", secret));
    }
    let fetched = fetch::request(
        policy,
        Method::POST,
        url,
        Body::Form(fetch::form(&fields)),
        basic,
    )
    .await
    .map_err(TokenError::Failed)?;
    parse_token_response(fetched.status, &fetched.body)
}

pub async fn exchange_code(
    policy: &Policy,
    token_endpoint: &str,
    client: &Client,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
    resource: &str,
) -> Result<Granted, TokenError> {
    token_request(
        policy,
        token_endpoint,
        client,
        vec![
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("code_verifier", verifier),
            ("resource", resource),
        ],
    )
    .await
}

pub async fn refresh(
    policy: &Policy,
    token_endpoint: &str,
    client: &Client,
    refresh_token: &str,
    resource: &str,
) -> Result<Granted, TokenError> {
    token_request(
        policy,
        token_endpoint,
        client,
        vec![
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("resource", resource),
        ],
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth() -> AuthServer {
        AuthServer {
            issuer: "https://auth.example.com".into(),
            authorization_endpoint: "https://auth.example.com/authorize?tenant=a".into(),
            token_endpoint: "https://auth.example.com/token".into(),
            registration_endpoint: Some("https://auth.example.com/register".into()),
            scopes_supported: vec![],
            token_endpoint_auth_methods: vec![],
            iss_parameter_supported: false,
        }
    }

    #[test]
    fn the_authorization_url_carries_pkce_state_and_resource() {
        let url = authorization_url(
            &auth(),
            "client 1",
            "http://127.0.0.1:5000/callback",
            "CHALLENGE",
            "STATE",
            Some("read write"),
            "https://mcp.example.com/mcp",
        )
        .unwrap();
        let pairs: Vec<(String, String)> = url
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        let get = |key: &str| {
            pairs
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.as_str())
        };
        assert_eq!(get("tenant"), Some("a"), "the endpoint's own query is kept");
        assert_eq!(get("response_type"), Some("code"));
        assert_eq!(get("client_id"), Some("client 1"));
        assert_eq!(get("redirect_uri"), Some("http://127.0.0.1:5000/callback"));
        assert_eq!(get("code_challenge"), Some("CHALLENGE"));
        assert_eq!(get("code_challenge_method"), Some("S256"));
        assert_eq!(get("state"), Some("STATE"));
        assert_eq!(get("resource"), Some("https://mcp.example.com/mcp"));
        assert_eq!(get("scope"), Some("read write"));
        let without = authorization_url(&auth(), "c", "r", "x", "s", None, "res").unwrap();
        assert!(!without.query_pairs().any(|(k, _)| k == "scope"));
    }

    #[test]
    fn registration_asks_for_a_native_public_client() {
        let body: serde_json::Value = serde_json::from_slice(&registration_request(
            "http://127.0.0.1:5000/callback",
            Some("read"),
        ))
        .unwrap();
        assert_eq!(body["token_endpoint_auth_method"], "none");
        assert_eq!(body["application_type"], "native");
        assert_eq!(body["redirect_uris"][0], "http://127.0.0.1:5000/callback");
        assert_eq!(body["grant_types"][1], "refresh_token");
        assert_eq!(body["scope"], "read");
    }

    #[test]
    fn registration_responses_are_validated() {
        let ok = parse_registration(
            StatusCode::CREATED,
            br#"{"client_id":"abc","client_secret_expires_at":0}"#,
            "https://auth.example.com",
            "http://127.0.0.1:1/callback",
            5,
        )
        .unwrap();
        assert_eq!(ok.client_id, "abc");
        assert_eq!(ok.client_auth, ClientAuth::None);
        assert_eq!(ok.issuer, "https://auth.example.com");

        let secret = parse_registration(
            StatusCode::OK,
            br#"{"client_id":"abc","client_secret":"s"}"#,
            "i",
            "r",
            5,
        )
        .unwrap();
        assert_eq!(secret.client_auth, ClientAuth::ClientSecretBasic);

        assert!(parse_registration(StatusCode::OK, br#"{"client_id":""}"#, "i", "r", 5).is_err());
        assert!(parse_registration(
            StatusCode::OK,
            br#"{"client_id":"a","token_endpoint_auth_method":"private_key_jwt"}"#,
            "i",
            "r",
            5
        )
        .is_err());
        assert!(parse_registration(
            StatusCode::OK,
            br#"{"client_id":"a","token_endpoint_auth_method":"client_secret_post"}"#,
            "i",
            "r",
            5
        )
        .is_err());
        let refused = parse_registration(
            StatusCode::BAD_REQUEST,
            br#"{"error":"invalid_redirect_uri","error_description":"loopback\nnot allowed"}"#,
            "i",
            "r",
            5,
        )
        .unwrap_err();
        assert!(
            refused.contains("invalid_redirect_uri (loopback not allowed)"),
            "{refused}"
        );
    }

    #[test]
    fn token_responses_are_validated() {
        let granted = parse_token_response(
            StatusCode::OK,
            br#"{"access_token":"at","token_type":"bearer","expires_in":"3600","refresh_token":"rt","scope":"a b"}"#,
        )
        .ok()
        .unwrap();
        assert_eq!(granted.access_token, "at");
        assert_eq!(granted.expires_in, Some(3600));
        assert_eq!(granted.refresh_token.as_deref(), Some("rt"));
        assert_eq!(granted.scope.as_deref(), Some("a b"));

        let numeric = parse_token_response(
            StatusCode::OK,
            br#"{"access_token":"at","token_type":"Bearer","expires_in":60}"#,
        )
        .ok()
        .unwrap();
        assert_eq!(numeric.expires_in, Some(60));
        assert!(numeric.refresh_token.is_none());

        for bad in [
            &br#"{"token_type":"Bearer"}"#[..],
            br#"{"access_token":"at"}"#,
            br#"{"access_token":"at","token_type":"DPoP"}"#,
            br#"{"access_token":"a\nb","token_type":"Bearer"}"#,
            b"<html>",
        ] {
            assert!(matches!(
                parse_token_response(StatusCode::OK, bad),
                Err(TokenError::Failed(_))
            ));
        }
        assert_eq!(
            parse_token_response(
                StatusCode::BAD_REQUEST,
                br#"{"error":"invalid_grant","error_description":"expired"}"#
            )
            .err(),
            Some(TokenError::Rejected(
                "the authorization server refused: invalid_grant (expired)".into()
            ))
        );
        assert!(matches!(
            parse_token_response(StatusCode::BAD_GATEWAY, b""),
            Err(TokenError::Failed(_))
        ));
        assert!(matches!(
            parse_token_response(StatusCode::BAD_REQUEST, b"not json"),
            Err(TokenError::Failed(_))
        ));
    }

    #[test]
    fn errors_never_echo_the_raw_body() {
        let body =
            br#"{"error":"invalid_grant","refresh_token":"RT-secret","error_description":"bad"}"#;
        let error = parse_token_response(StatusCode::BAD_REQUEST, body)
            .err()
            .unwrap();
        assert!(!error.message().contains("RT-secret"));
    }

    #[test]
    fn configured_clients_pick_a_supported_authentication() {
        let methods = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            configured_auth(false, &methods(&["client_secret_basic"])),
            ClientAuth::None
        );
        assert_eq!(configured_auth(true, &[]), ClientAuth::ClientSecretBasic);
        assert_eq!(
            configured_auth(true, &methods(&["client_secret_post"])),
            ClientAuth::ClientSecretPost
        );
        assert_eq!(
            configured_auth(
                true,
                &methods(&["client_secret_post", "client_secret_basic"])
            ),
            ClientAuth::ClientSecretBasic
        );
    }

    #[test]
    fn basic_credentials_are_form_encoded_first() {
        assert_eq!(form_value("a b:c"), "a+b%3Ac");
        assert_eq!(form_value("plain"), "plain");
    }

    #[test]
    fn server_text_is_flattened_and_capped() {
        assert_eq!(clean("a\n\tb  c"), "a b c");
        assert_eq!(clean(&"x".repeat(1000)).chars().count(), MAX_MESSAGE);
    }
}
