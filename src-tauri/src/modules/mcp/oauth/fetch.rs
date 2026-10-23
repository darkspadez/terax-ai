//! The network side of sign-in: metadata, registration and token requests. They may go to the
//! authorization server's own host, but only to URLs the server's metadata names, through the
//! same SSRF classification and DNS pinning as every other request (`net.rs`), never following
//! a redirect to another origin.

use std::net::IpAddr;
use std::time::Duration;

use bytes::Bytes;
use reqwest::header::{HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, LOCATION, USER_AGENT};
use reqwest::{Method, StatusCode, Url};

use crate::modules::net;

/// Metadata and token responses are small; anything larger is refused.
const MAX_BODY: usize = 1024 * 1024;
const MAX_REDIRECTS: usize = 3;
const TIMEOUT: Duration = Duration::from_secs(30);

/// What sign-in may reach, decided from the server URL the user configured.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Policy {
    /// The server's host is local or private, so its authorization may be too.
    pub allow_private: bool,
    /// The server is a plain-http loopback URL: then (and only then) loopback http is allowed.
    pub allow_http_loopback: bool,
}

/// `localhost` or a loopback address literal.
pub fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']);
    host.eq_ignore_ascii_case("localhost")
        || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

impl Policy {
    /// The policy for a server URL. `allow_private` comes from resolving its host
    /// (`net::host_is_private`), as the server's own session does.
    pub fn for_server(server: &Url, allow_private: bool) -> Self {
        Self {
            allow_private,
            allow_http_loopback: server.scheme() == "http"
                && server.host_str().is_some_and(is_loopback_host),
        }
    }

    /// A URL sign-in may use: https (or loopback http for a loopback server), a host, no user
    /// info or fragment, never a metadata host.
    pub fn check(&self, raw: &str) -> Result<Url, String> {
        let url = Url::parse(raw.trim()).map_err(|_| format!("invalid URL in sign-in: {raw}"))?;
        let host = url.host_str().ok_or_else(|| format!("no host in {raw}"))?;
        match url.scheme() {
            "https" => {}
            "http" if self.allow_http_loopback && is_loopback_host(host) => {}
            _ => return Err(format!("sign-in uses https only, not {raw}")),
        }
        if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
            return Err(format!("sign-in refuses {raw}"));
        }
        if net::is_blocked_host_name(host) {
            return Err(format!("host not allowed: {host}"));
        }
        Ok(url)
    }
}

pub struct Fetched {
    pub status: StatusCode,
    pub body: Bytes,
}

pub enum Body {
    None,
    Form(String),
    Json(Vec<u8>),
}

/// Encodes form fields (`application/x-www-form-urlencoded`).
pub fn form(pairs: &[(&str, &str)]) -> String {
    let mut url = Url::parse("http://form.invalid/").expect("static URL");
    url.query_pairs_mut().extend_pairs(pairs);
    url.query().unwrap_or("").to_owned()
}

fn user_agent() -> HeaderValue {
    HeaderValue::from_static(concat!("Oarlock/", env!("CARGO_PKG_VERSION")))
}

/// One request through the checked, pinned client. A GET follows redirects within its origin,
/// each checked again; anything else never follows one.
pub async fn request(
    policy: &Policy,
    method: Method,
    url: Url,
    body: Body,
    basic: Option<String>,
) -> Result<Fetched, String> {
    let mut url = url;
    for _ in 0..=MAX_REDIRECTS {
        let host = url.host_str().ok_or("missing host")?.to_owned();
        let ips = net::classify_and_collect_safe_ips(&host, policy.allow_private).await?;
        let client = net::client_for(net::Profile::Fetch, &host, &ips, policy.allow_private)?;
        let mut builder = client
            .request(method.clone(), url.clone())
            .timeout(TIMEOUT)
            .header(ACCEPT, "application/json")
            .header(USER_AGENT, user_agent());
        if let Some(basic) = &basic {
            builder = builder.header(AUTHORIZATION, format!("Basic {basic}"));
        }
        builder = match &body {
            Body::None => builder,
            Body::Form(text) => builder
                .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
                .body(text.clone()),
            Body::Json(bytes) => builder
                .header(CONTENT_TYPE, "application/json")
                .body(bytes.clone()),
        };
        let mut response = builder.send().await.map_err(|e| net::error_chain(&e))?;
        let status = response.status();
        if status.is_redirection() && method == Method::GET {
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or("redirect without a location")?;
            let next = policy.check(url.join(location).map_err(|e| e.to_string())?.as_str())?;
            if next.origin() != url.origin() {
                return Err(format!(
                    "{} redirected to another host; sign-in does not follow it",
                    url.origin().ascii_serialization()
                ));
            }
            url = next;
            continue;
        }
        if status.is_redirection() {
            return Err(format!(
                "{} answered with a redirect; sign-in does not follow it",
                url.origin().ascii_serialization()
            ));
        }
        if response
            .content_length()
            .is_some_and(|len| len > MAX_BODY as u64)
        {
            return Err("the sign-in response is too large".into());
        }
        let mut collected = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| net::error_chain(&e))? {
            if collected.len() + chunk.len() > MAX_BODY {
                return Err("the sign-in response is too large".into());
            }
            collected.extend_from_slice(&chunk);
        }
        return Ok(Fetched {
            status,
            body: Bytes::from(collected),
        });
    }
    Err("too many redirects".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn public() -> Policy {
        Policy::for_server(&Url::parse("https://mcp.example.com/mcp").unwrap(), false)
    }

    #[test]
    fn sign_in_uses_https_only() {
        let p = public();
        assert!(!p.allow_http_loopback);
        assert!(p.check("https://auth.example.com/token").is_ok());
        for bad in [
            "http://auth.example.com/token",
            "http://127.0.0.1/token",
            "ftp://auth.example.com",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "https://user:pw@auth.example.com/token",
            "https://auth.example.com/token#frag",
            "https://metadata.google.internal/token",
            "not a url",
        ] {
            assert!(p.check(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn loopback_http_only_for_a_loopback_http_server() {
        let local = Policy::for_server(&Url::parse("http://localhost:3000/mcp").unwrap(), true);
        assert!(local.allow_http_loopback && local.allow_private);
        assert!(local.check("http://localhost:8080/token").is_ok());
        assert!(local.check("http://127.0.0.1:8080/token").is_ok());
        assert!(local.check("http://[::1]:8080/token").is_ok());
        assert!(local.check("http://auth.example.com/token").is_err());
        assert!(local.check("http://192.168.1.2/token").is_err());

        // An https loopback server, or an http server on the network, gets https only.
        let tls = Policy::for_server(&Url::parse("https://localhost:3000/mcp").unwrap(), true);
        assert!(tls.check("http://localhost:8080/token").is_err());
        let lan = Policy::for_server(&Url::parse("http://10.0.0.5/mcp").unwrap(), true);
        assert!(lan.check("http://10.0.0.5/token").is_err());
        assert!(lan.check("http://localhost/token").is_err());
    }

    #[test]
    fn loopback_hosts_are_recognized() {
        for host in [
            "localhost",
            "LOCALHOST",
            "127.0.0.1",
            "127.5.0.1",
            "[::1]",
            "::1",
        ] {
            assert!(is_loopback_host(host), "{host}");
        }
        for host in ["localhost.evil.com", "10.0.0.1", "example.com", "0.0.0.0"] {
            assert!(!is_loopback_host(host), "{host}");
        }
    }

    #[test]
    fn form_fields_are_encoded() {
        assert_eq!(
            form(&[
                ("a", "b c"),
                ("redirect_uri", "http://127.0.0.1:1/callback"),
                ("x", "&=")
            ]),
            "a=b+c&redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2Fcallback&x=%26%3D"
        );
    }
}
