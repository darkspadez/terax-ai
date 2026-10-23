//! The sign-in requests end to end against a mock MCP server and authorization server on
//! loopback: discovery, registration, the code exchange and refreshes, through the same
//! checked and pinned client the app uses.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use reqwest::Url;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::challenge::Challenge;
use super::fetch::Policy;
use super::flow::{self, Client, TokenError};
use super::store::{ClientAuth, ClientSource};

#[derive(Clone, Debug)]
struct Seen {
    method: String,
    path: String,
    body: String,
    authorization: Option<String>,
}

type Handler = dyn Fn(&Seen, u16) -> (u16, String, Vec<(&'static str, String)>) + Send + Sync;

struct Mock {
    port: u16,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Mock {
    async fn start(handler: Arc<Handler>) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let handler = handler.clone();
                let log = log.clone();
                tokio::spawn(async move {
                    let mut buffer = Vec::new();
                    let mut chunk = [0u8; 4096];
                    let (head, mut body) = loop {
                        let read = stream.read(&mut chunk).await.unwrap_or(0);
                        if read == 0 {
                            return;
                        }
                        buffer.extend_from_slice(&chunk[..read]);
                        if let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&buffer[..end]).into_owned();
                            break (head, buffer[end + 4..].to_vec());
                        }
                    };
                    let mut lines = head.lines();
                    let mut first = lines.next().unwrap_or("").split(' ');
                    let method = first.next().unwrap_or("").to_owned();
                    let path = first.next().unwrap_or("").to_owned();
                    let headers: HashMap<String, String> = lines
                        .filter_map(|l| l.split_once(':'))
                        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned()))
                        .collect();
                    let length: usize = headers
                        .get("content-length")
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(0);
                    while body.len() < length {
                        let read = stream.read(&mut chunk).await.unwrap_or(0);
                        if read == 0 {
                            break;
                        }
                        body.extend_from_slice(&chunk[..read]);
                    }
                    let request = Seen {
                        method,
                        path,
                        body: String::from_utf8_lossy(&body).into_owned(),
                        authorization: headers.get("authorization").cloned(),
                    };
                    log.lock().unwrap().push(request.clone());
                    let (status, text, extra) = handler(&request, port);
                    let mut response = format!(
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
                        text.len()
                    );
                    for (name, value) in extra {
                        response.push_str(&format!("{name}: {value}\r\n"));
                    }
                    response.push_str("\r\n");
                    response.push_str(&text);
                    let _ = stream.write_all(response.as_bytes()).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        Self { port, seen }
    }

    fn url(&self, path: &str) -> Url {
        Url::parse(&format!("http://127.0.0.1:{}{path}", self.port)).unwrap()
    }

    fn requests(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
}

fn form(body: &str) -> HashMap<String, String> {
    Url::parse(&format!("http://x/?{body}"))
        .unwrap()
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect()
}

/// A protected server with its authorization server under `/auth`, as most hosted MCP
/// servers are laid out.
fn authorization_server() -> Arc<Handler> {
    Arc::new(|request: &Seen, port: u16| {
        let base = format!("http://127.0.0.1:{port}");
        let json = |value: serde_json::Value| value.to_string();
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/.well-known/oauth-protected-resource/mcp") => (
                200,
                json(serde_json::json!({
                    "resource": format!("{base}/mcp"),
                    "authorization_servers": [format!("{base}/auth")],
                    "scopes_supported": ["read"],
                })),
                vec![],
            ),
            ("GET", "/.well-known/oauth-authorization-server/auth") => (
                200,
                json(serde_json::json!({
                    "issuer": format!("{base}/auth"),
                    "authorization_endpoint": format!("{base}/auth/authorize"),
                    "token_endpoint": format!("{base}/auth/token"),
                    "registration_endpoint": format!("{base}/auth/register"),
                    "code_challenge_methods_supported": ["S256"],
                    "scopes_supported": ["read", "offline_access"],
                })),
                vec![],
            ),
            ("POST", "/auth/register") => (
                201,
                json(serde_json::json!({"client_id": "registered-client"})),
                vec![],
            ),
            ("POST", "/auth/token") => {
                let fields = form(&request.body);
                match fields.get("grant_type").map(String::as_str) {
                    Some("authorization_code")
                        if fields.get("code").map(String::as_str) == Some("good-code") =>
                    {
                        (
                            200,
                            json(serde_json::json!({
                                "access_token": "access-1", "token_type": "Bearer",
                                "expires_in": 3600, "refresh_token": "refresh-1", "scope": "read offline_access",
                            })),
                            vec![],
                        )
                    }
                    Some("refresh_token")
                        if fields.get("refresh_token").map(String::as_str) == Some("refresh-1") =>
                    {
                        (
                            200,
                            json(
                                serde_json::json!({"access_token": "access-2", "token_type": "Bearer", "expires_in": 60}),
                            ),
                            vec![],
                        )
                    }
                    _ => (
                        400,
                        json(
                            serde_json::json!({"error": "invalid_grant", "error_description": "no"}),
                        ),
                        vec![],
                    ),
                }
            }
            ("GET", "/elsewhere") => (
                302,
                String::new(),
                vec![("Location", "http://localhost:1/x".to_owned())],
            ),
            _ => (404, "{}".into(), vec![]),
        }
    })
}

fn policy(server: &Url) -> Policy {
    Policy::for_server(server, true)
}

#[tokio::test(flavor = "multi_thread")]
async fn signs_in_end_to_end_against_a_mock_server() {
    let mock = Mock::start(authorization_server()).await;
    let server = mock.url("/mcp");
    let policy = policy(&server);

    let discovered = flow::discover(&policy, &server, None).await.unwrap();
    assert_eq!(
        discovered.resource,
        format!("http://127.0.0.1:{}/mcp", mock.port)
    );
    assert_eq!(
        discovered.auth.issuer,
        format!("http://127.0.0.1:{}/auth", mock.port)
    );
    assert_eq!(
        discovered
            .resource_metadata
            .as_ref()
            .unwrap()
            .scopes_supported,
        ["read"]
    );

    let redirect = "http://127.0.0.1:5555/callback";
    let registration = flow::register(&policy, &discovered.auth, redirect, Some("read"), 7)
        .await
        .unwrap();
    assert_eq!(registration.client_id, "registered-client");
    assert_eq!(registration.client_auth, ClientAuth::None);
    let client = Client::from(registration);

    let granted = flow::exchange_code(
        &policy,
        &discovered.auth.token_endpoint,
        &client,
        "good-code",
        "the-verifier",
        redirect,
        &discovered.resource,
    )
    .await
    .ok()
    .unwrap();
    assert_eq!(granted.access_token, "access-1");
    assert_eq!(granted.refresh_token.as_deref(), Some("refresh-1"));

    let refreshed = flow::refresh(
        &policy,
        &discovered.auth.token_endpoint,
        &client,
        "refresh-1",
        &discovered.resource,
    )
    .await
    .ok()
    .unwrap();
    assert_eq!(refreshed.access_token, "access-2");
    assert!(refreshed.refresh_token.is_none());

    let refused = flow::refresh(
        &policy,
        &discovered.auth.token_endpoint,
        &client,
        "stale",
        &discovered.resource,
    )
    .await
    .err()
    .unwrap();
    assert!(matches!(refused, TokenError::Rejected(_)), "{refused:?}");

    let requests = mock.requests();
    let token_requests: Vec<HashMap<String, String>> = requests
        .iter()
        .filter(|r| r.path == "/auth/token")
        .map(|r| form(&r.body))
        .collect();
    let code = &token_requests[0];
    assert_eq!(code["grant_type"], "authorization_code");
    assert_eq!(code["code_verifier"], "the-verifier");
    assert_eq!(code["redirect_uri"], redirect);
    assert_eq!(code["client_id"], "registered-client");
    assert_eq!(
        code["resource"], discovered.resource,
        "RFC 8707 on the token request"
    );
    assert_eq!(token_requests[1]["resource"], discovered.resource);
    let register = requests
        .iter()
        .find(|r| r.path == "/auth/register")
        .unwrap();
    let body: serde_json::Value = serde_json::from_str(&register.body).unwrap();
    assert_eq!(body["redirect_uris"][0], redirect);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_configured_client_with_a_secret_uses_basic_authentication() {
    let mock = Mock::start(authorization_server()).await;
    let server = mock.url("/mcp");
    let policy = policy(&server);
    let client = Client {
        id: "my client".into(),
        secret: Some("s3cret:x".into()),
        auth: ClientAuth::ClientSecretBasic,
        source: ClientSource::Configured,
    };
    let token_endpoint = mock.url("/auth/token").to_string();
    flow::exchange_code(
        &policy,
        &token_endpoint,
        &client,
        "good-code",
        "v",
        "r",
        "res",
    )
    .await
    .ok()
    .unwrap();
    let request = mock.requests().pop().unwrap();
    let fields = form(&request.body);
    assert!(!fields.contains_key("client_id") && !fields.contains_key("client_secret"));
    assert_eq!(
        request.authorization.as_deref(),
        Some(format!("Basic {}", super::pkce::base64(b"my+client:s3cret%3Ax")).as_str())
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn discovery_uses_the_challenge_and_refuses_other_hosts() {
    let mock = Mock::start(authorization_server()).await;
    let server = mock.url("/mcp");
    let policy = policy(&server);
    let named = Challenge {
        resource_metadata: Some(
            mock.url("/.well-known/oauth-protected-resource/mcp")
                .to_string(),
        ),
        ..Challenge::default()
    };
    assert!(flow::discover(&policy, &server, Some(&named)).await.is_ok());

    // A redirect to another origin is never followed.
    let error = super::fetch::request(
        &policy,
        reqwest::Method::GET,
        mock.url("/elsewhere"),
        super::fetch::Body::None,
        None,
    )
    .await
    .err()
    .unwrap();
    assert!(error.contains("another host"), "{error}");

    // A server with no metadata at all cannot be signed in to.
    let quiet = Mock::start(Arc::new(|_: &Seen, _| (404, "{}".into(), vec![]))).await;
    let quiet_server = quiet.url("/mcp");
    assert!(
        flow::discover(&self::policy(&quiet_server), &quiet_server, None)
            .await
            .unwrap_err()
            .contains("does not say how to sign in")
    );

    // Public servers get https only: their sign-in never reaches loopback http.
    let public = Policy::for_server(&Url::parse("https://mcp.example.com/mcp").unwrap(), false);
    assert!(public.check(mock.url("/auth/token").as_str()).is_err());
}
