//! Remote MCP servers (Streamable HTTP and legacy SSE) reached through the
//! backend's proxy: the page's MCP client hands each request here, so it gets
//! the SSRF and DNS-rebinding defences of `net.rs`, CORS does not apply, and
//! secret header values never enter the page.
//!
//! A session allows exactly one origin, the server URL the user configured.
//! Redirects are never followed here; the client follows one only within that
//! origin, as a new request checked again.

use std::collections::HashMap;

use bytes::Bytes;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use reqwest::Url;

use super::names::{valid_header_name, valid_value, SecretKind};

/// The most a single non-streaming response may carry. Event streams are not
/// capped in total (they live as long as the session), only in flow.
pub const MAX_RESPONSE_BYTES: u64 = 32 * 1024 * 1024;

/// Headers the server's configuration may not set: the proxy owns them.
const RESERVED_HEADERS: &[&str] = &[
    "host",
    "content-length",
    "connection",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "transfer-encoding",
    "upgrade",
    "trailer",
    "expect",
    "cookie",
];

pub struct HttpSession {
    pub owner: String,
    pub server_id: String,
    pub url: Url,
    /// The configured host is local or private, so its requests may resolve
    /// there (decided when the session opened, from that host).
    pub allow_private: bool,
    /// The configured headers, secret values resolved; they replace any
    /// header of the same name the page sends.
    pub headers: HeaderMap,
    /// Sign-in applies (no `Authorization` header is configured): what its
    /// token requests may reach.
    pub oauth: Option<super::oauth::Policy>,
    /// A project server: what it was opened from, checked on every request.
    pub project: Option<super::project::Binding>,
}

/// A server URL as configured: http or https, a host, no user info.
pub fn parse_server_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|e| format!("mcp: invalid URL: {e}"))?;
    match url.scheme() {
        "http" | "https" => {}
        other => return Err(format!("mcp: the URL must be http or https, not {other}")),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("mcp: put credentials in a header, not in the URL".into());
    }
    let host = url.host_str().ok_or("mcp: the URL has no host")?;
    if crate::modules::net::is_blocked_host_name(host) {
        return Err(format!("mcp: host not allowed: {host}"));
    }
    Ok(url)
}

/// Whether `requested` is within the origin of `configured`: the same scheme,
/// host and port, or the https form of an http URL with both on default ports
/// (the MCP SDK's own rule for following redirects). No user info.
pub fn within_origin(configured: &Url, requested: &Url) -> bool {
    if !requested.username().is_empty() || requested.password().is_some() {
        return false;
    }
    if configured.origin() == requested.origin() {
        return true;
    }
    configured.scheme() == "http"
        && requested.scheme() == "https"
        && configured.host_str() == requested.host_str()
        && configured.port().is_none()
        && requested.port().is_none()
}

/// The configured headers (plain values, then secrets), validated.
pub fn session_headers(entries: Vec<(String, String)>) -> Result<HeaderMap, String> {
    let mut map = HeaderMap::new();
    for (name, value) in entries {
        if !valid_header_name(&name) {
            return Err(format!("mcp: invalid header name {name:?}"));
        }
        if RESERVED_HEADERS.contains(&name.to_ascii_lowercase().as_str()) {
            return Err(format!("mcp: the {name} header cannot be set"));
        }
        if !valid_value(&value, SecretKind::Header) {
            return Err(format!("mcp: invalid value for header {name}"));
        }
        let name = HeaderName::from_bytes(name.as_bytes()).map_err(|e| e.to_string())?;
        let value = HeaderValue::from_str(&value).map_err(|e| e.to_string())?;
        map.insert(name, value);
    }
    Ok(map)
}

/// The page's headers (the client's own: content type, accept, session id,
/// protocol version), with the configured ones laid over them.
pub fn request_headers(
    page: Option<HashMap<String, String>>,
    session: &HeaderMap,
) -> Result<HeaderMap, String> {
    let mut map = crate::modules::net::sanitize_headers(page)?;
    for (name, value) in session {
        map.insert(name.clone(), value.clone());
    }
    Ok(map)
}

/// Whether the configuration sets `Authorization` itself (an API key), which
/// sign-in then leaves alone.
pub fn sets_authorization(headers: &HeaderMap) -> bool {
    headers.contains_key(AUTHORIZATION)
}

/// Adds the sign-in token, replacing whatever the page sent; marked sensitive so
/// no debug output shows it.
pub fn with_bearer(mut map: HeaderMap, token: Option<&str>) -> Result<HeaderMap, String> {
    if let Some(token) = token {
        let mut value = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| "mcp: the sign-in token cannot be sent as a header".to_owned())?;
        value.set_sensitive(true);
        map.insert(AUTHORIZATION, value);
    }
    Ok(map)
}

/// Whether a response is an event stream, which is exempt from the total cap.
pub fn is_event_stream(headers: &HeaderMap) -> bool {
    headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .is_some_and(|essence| essence.trim().eq_ignore_ascii_case("text/event-stream"))
}

/// A body stream that fails once more than `cap` bytes arrived.
pub fn capped<S>(
    stream: S,
    cap: Option<u64>,
) -> impl futures_util::Stream<Item = Result<Bytes, String>> + Unpin
where
    S: futures_util::Stream<Item = reqwest::Result<Bytes>> + Unpin,
{
    let mut seen: u64 = 0;
    stream.map(move |item| {
        let chunk = item.map_err(|e| crate::modules::net::error_chain(&e))?;
        seen = seen.saturating_add(chunk.len() as u64);
        match cap {
            Some(cap) if seen > cap => Err(format!(
                "mcp: the response is over the {} MiB limit",
                cap / (1024 * 1024)
            )),
            _ => Ok(chunk),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn server_urls_are_http_with_a_host_and_no_credentials() {
        assert!(parse_server_url("https://mcp.example.com/mcp").is_ok());
        assert!(parse_server_url(" http://localhost:3000/mcp ").is_ok());
        assert!(parse_server_url("ftp://example.com").is_err());
        assert!(parse_server_url("file:///etc/passwd").is_err());
        assert!(parse_server_url("https://user:pw@example.com").is_err());
        assert!(parse_server_url("http://metadata.google.internal/").is_err());
        assert!(parse_server_url("not a url").is_err());
    }

    #[test]
    fn requests_stay_within_the_configured_origin() {
        let configured = url("https://mcp.example.com/mcp");
        for ok in [
            "https://mcp.example.com/mcp",
            "https://mcp.example.com/messages?session=1",
            "https://mcp.example.com:443/other",
        ] {
            assert!(within_origin(&configured, &url(ok)), "{ok}");
        }
        for bad in [
            "http://mcp.example.com/mcp",
            "https://evil.example.com/mcp",
            "https://mcp.example.com:8443/mcp",
            "https://mcp.example.com.evil.com/mcp",
            "https://user@mcp.example.com/mcp",
            "http://127.0.0.1/mcp",
        ] {
            assert!(!within_origin(&configured, &url(bad)), "{bad}");
        }
    }

    #[test]
    fn localhost_is_allowed_when_it_is_what_was_configured() {
        let configured = url("http://localhost:3000/mcp");
        assert!(within_origin(
            &configured,
            &url("http://localhost:3000/sse")
        ));
        assert!(!within_origin(
            &configured,
            &url("http://localhost:3001/mcp")
        ));
        assert!(!within_origin(
            &configured,
            &url("http://127.0.0.1:3000/mcp")
        ));
    }

    #[test]
    fn http_may_move_to_https_on_default_ports_only() {
        assert!(within_origin(
            &url("http://mcp.example.com/mcp"),
            &url("https://mcp.example.com/mcp")
        ));
        assert!(!within_origin(
            &url("http://mcp.example.com:8080/mcp"),
            &url("https://mcp.example.com:8443/mcp")
        ));
        assert!(!within_origin(
            &url("https://mcp.example.com/mcp"),
            &url("http://mcp.example.com/mcp")
        ));
    }

    #[test]
    fn configured_headers_are_validated_and_win_over_the_page() {
        let session = session_headers(vec![
            ("Authorization".into(), "Bearer secret".into()),
            ("X-Team".into(), "a".into()),
        ])
        .unwrap();
        let merged = request_headers(
            Some(HashMap::from([
                ("authorization".to_string(), "Bearer page".to_string()),
                ("content-type".to_string(), "application/json".to_string()),
            ])),
            &session,
        )
        .unwrap();
        assert_eq!(merged["authorization"], "Bearer secret");
        assert_eq!(merged["content-type"], "application/json");
        assert_eq!(merged["x-team"], "a");

        assert!(session_headers(vec![("Host".into(), "x".into())]).is_err());
        assert!(session_headers(vec![("Cookie".into(), "x".into())]).is_err());
        assert!(session_headers(vec![("X-A".into(), "a\r\nX-B: b".into())]).is_err());
        assert!(session_headers(vec![("Bad Name".into(), "x".into())]).is_err());
        assert!(request_headers(
            Some(HashMap::from([("host".to_string(), "x".to_string())])),
            &HeaderMap::new()
        )
        .is_err());
    }

    #[test]
    fn the_sign_in_token_replaces_what_the_page_sent() {
        let page = request_headers(
            Some(HashMap::from([(
                "authorization".to_string(),
                "Bearer from-the-page".to_string(),
            )])),
            &HeaderMap::new(),
        )
        .unwrap();
        let signed = with_bearer(page.clone(), Some("tok")).unwrap();
        assert_eq!(signed["authorization"], "Bearer tok");
        assert!(signed["authorization"].is_sensitive());
        assert!(
            !format!("{signed:?}").contains("tok"),
            "never in debug output"
        );
        assert_eq!(
            with_bearer(page, None).unwrap()["authorization"],
            "Bearer from-the-page"
        );
        assert!(with_bearer(HeaderMap::new(), Some("a\r\nX: y")).is_err());
        let configured =
            session_headers(vec![("Authorization".into(), "Bearer key".into())]).unwrap();
        assert!(sets_authorization(&configured));
        assert!(!sets_authorization(&HeaderMap::new()));
    }

    #[test]
    fn event_streams_are_recognized_by_their_media_type() {
        let mut headers = HeaderMap::new();
        assert!(!is_event_stream(&headers));
        headers.insert(
            CONTENT_TYPE,
            "Text/Event-Stream; charset=utf-8".parse().unwrap(),
        );
        assert!(is_event_stream(&headers));
        headers.insert(CONTENT_TYPE, "application/json".parse().unwrap());
        assert!(!is_event_stream(&headers));
    }

    #[test]
    fn capped_streams_fail_past_the_cap() {
        let chunks: Vec<reqwest::Result<Bytes>> = vec![
            Ok(Bytes::from_static(b"abcd")),
            Ok(Bytes::from_static(b"efgh")),
        ];
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let out: Vec<_> =
            rt.block_on(capped(futures_util::stream::iter(chunks), Some(6)).collect::<Vec<_>>());
        assert_eq!(out[0].as_deref().unwrap(), b"abcd");
        assert!(out[1].is_err());

        let chunks: Vec<reqwest::Result<Bytes>> = vec![Ok(Bytes::from_static(b"abcdefgh"))];
        let out: Vec<_> =
            rt.block_on(capped(futures_util::stream::iter(chunks), None).collect::<Vec<_>>());
        assert!(out[0].is_ok());
    }
}
