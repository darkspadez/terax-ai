//! Where a protected MCP server's authorization lives, and whether what it publishes can be
//! trusted (MCP authorization, revision 2026-07-28): protected resource metadata (RFC 9728),
//! authorization server metadata (RFC 8414, or OpenID Connect Discovery), the resource the
//! tokens are bound to (RFC 8707), the scopes to ask for and the issuer check of the
//! authorization response (RFC 9207). Pure: the fetching is `flow.rs`'s.

use reqwest::Url;
use serde::Deserialize;

const PRM_SUFFIX: &str = "/.well-known/oauth-protected-resource";
const OAUTH_SUFFIX: &str = "/.well-known/oauth-authorization-server";
const OIDC_SUFFIX: &str = "/.well-known/openid-configuration";
const MAX_SCOPES: usize = 64;
const MAX_FIELD: usize = 2048;

/// A URL's path without its terminating slash ("" for the root).
fn trimmed_path(url: &Url) -> &str {
    url.path().trim_end_matches('/')
}

fn origin_url(url: &Url, path: &str) -> Option<Url> {
    let mut out = url.clone();
    out.set_query(None);
    out.set_fragment(None);
    out.set_path(path);
    Some(out)
}

/// Where the server's protected resource metadata may be, in the order to try: the well-known
/// URI with the server's path inserted, then at the root.
pub fn resource_metadata_urls(server: &Url) -> Vec<Url> {
    let path = trimmed_path(server);
    let mut urls = Vec::new();
    if !path.is_empty() {
        urls.extend(origin_url(server, &format!("{PRM_SUFFIX}{path}")));
    }
    urls.extend(origin_url(server, PRM_SUFFIX));
    urls
}

/// Where an authorization server's metadata may be, in the order the MCP specification gives:
/// RFC 8414 with path insertion, OpenID Connect with path insertion, OpenID Connect appended.
pub fn auth_server_metadata_urls(issuer: &Url) -> Vec<Url> {
    let path = trimmed_path(issuer);
    if path.is_empty() {
        [OAUTH_SUFFIX, OIDC_SUFFIX]
            .iter()
            .filter_map(|suffix| origin_url(issuer, suffix))
            .collect()
    } else {
        [
            format!("{OAUTH_SUFFIX}{path}"),
            format!("{OIDC_SUFFIX}{path}"),
            format!("{path}{OIDC_SUFFIX}"),
        ]
        .iter()
        .filter_map(|p| origin_url(issuer, p))
        .collect()
    }
}

/// The canonical URI of a server (RFC 8707 section 2): no fragment or query, no terminating
/// slash (so the root is `https://host`).
pub fn canonical_resource(server: &Url) -> String {
    let path = trimmed_path(server);
    format!("{}{path}", server.origin().ascii_serialization())
}

/// Whether `resource` (from the server's metadata) names the configured server: the same
/// origin, and a path the server's path is within (segment by segment). RFC 9728 section 3.3:
/// metadata for another resource must not be used.
pub fn check_resource(server: &Url, resource: &str) -> Result<String, String> {
    let parsed = Url::parse(resource.trim())
        .map_err(|_| format!("the server's metadata names an invalid resource ({resource})"))?;
    if parsed.fragment().is_some() || parsed.origin() != server.origin() {
        return Err(format!(
            "the server's metadata is for another resource ({resource})"
        ));
    }
    let want = format!("{}/", trimmed_path(&parsed));
    let have = format!("{}/", trimmed_path(server));
    if !have.starts_with(&want) {
        return Err(format!(
            "the server's metadata is for another resource ({resource})"
        ));
    }
    Ok(resource.trim().to_owned())
}

#[derive(Deserialize)]
struct RawResource {
    resource: Option<String>,
    authorization_servers: Option<Vec<serde_json::Value>>,
    scopes_supported: Option<Vec<serde_json::Value>>,
}

/// Protected resource metadata, as sign-in uses it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProtectedResource {
    pub resource: String,
    pub authorization_servers: Vec<String>,
    pub scopes_supported: Vec<String>,
}

fn strings(values: Option<Vec<serde_json::Value>>) -> Vec<String> {
    values
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(str::trim).map(str::to_owned))
        .filter(|v| !v.is_empty() && v.len() <= MAX_FIELD)
        .take(MAX_SCOPES)
        .collect()
}

pub fn parse_resource_metadata(body: &[u8], server: &Url) -> Result<ProtectedResource, String> {
    let raw: RawResource = serde_json::from_slice(body)
        .map_err(|e| format!("the server's resource metadata is not valid JSON: {e}"))?;
    let resource = check_resource(
        server,
        raw.resource
            .as_deref()
            .ok_or("the server's resource metadata names no resource")?,
    )?;
    let authorization_servers = strings(raw.authorization_servers);
    if authorization_servers.is_empty() {
        return Err("the server's resource metadata names no authorization server".into());
    }
    Ok(ProtectedResource {
        resource,
        authorization_servers,
        scopes_supported: strings(raw.scopes_supported),
    })
}

#[derive(Deserialize)]
struct RawAuthServer {
    issuer: Option<String>,
    authorization_endpoint: Option<String>,
    token_endpoint: Option<String>,
    registration_endpoint: Option<String>,
    scopes_supported: Option<Vec<serde_json::Value>>,
    code_challenge_methods_supported: Option<Vec<serde_json::Value>>,
    token_endpoint_auth_methods_supported: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    authorization_response_iss_parameter_supported: Option<bool>,
}

/// Authorization server metadata, validated. Endpoint URLs are checked against the network
/// policy by the caller.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthServer {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub registration_endpoint: Option<String>,
    pub scopes_supported: Vec<String>,
    pub token_endpoint_auth_methods: Vec<String>,
    /// RFC 9207: the server sends `iss` in its authorization responses.
    pub iss_parameter_supported: bool,
}

/// Whether two issuer identifiers are the same: identical, a terminating slash aside (RFC 8414
/// removes it when building the well-known URL, so both name the same document).
pub fn same_issuer(a: &str, b: &str) -> bool {
    a == b || a.trim_end_matches('/') == b.trim_end_matches('/')
}

/// Validates metadata fetched for `expected` (RFC 8414 section 3.3: the `issuer` in it must
/// be the one the URL was built from) and that PKCE with S256 is supported (the MCP
/// specification: refuse when `code_challenge_methods_supported` is absent).
pub fn parse_auth_server_metadata(body: &[u8], expected: &str) -> Result<AuthServer, String> {
    let raw: RawAuthServer = serde_json::from_slice(body)
        .map_err(|e| format!("the authorization server's metadata is not valid JSON: {e}"))?;
    let issuer = raw
        .issuer
        .filter(|issuer| same_issuer(issuer, expected))
        .ok_or_else(|| {
            format!("the authorization server's metadata is not for {expected}; it was not used")
        })?;
    let methods = strings(raw.code_challenge_methods_supported);
    if !methods.iter().any(|m| m == "S256") {
        return Err(
            "the authorization server does not support PKCE with S256, which sign-in requires"
                .into(),
        );
    }
    let field = |value: Option<String>, name: &str| {
        value
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty() && v.len() <= MAX_FIELD)
            .ok_or_else(|| format!("the authorization server's metadata has no {name}"))
    };
    Ok(AuthServer {
        issuer,
        authorization_endpoint: field(raw.authorization_endpoint, "authorization endpoint")?,
        token_endpoint: field(raw.token_endpoint, "token endpoint")?,
        registration_endpoint: raw
            .registration_endpoint
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty() && v.len() <= MAX_FIELD),
        scopes_supported: strings(raw.scopes_supported),
        token_endpoint_auth_methods: strings(raw.token_endpoint_auth_methods_supported),
        iss_parameter_supported: raw
            .authorization_response_iss_parameter_supported
            .unwrap_or(false),
    })
}

fn push_scopes(out: &mut Vec<String>, scope: &str) {
    for s in scope.split_whitespace() {
        if out.len() < MAX_SCOPES && !out.iter().any(|have| have == s) {
            out.push(s.to_owned());
        }
    }
}

/// The scopes to ask for: the ones the user configured; else the ones the server's challenge
/// names (authoritative for this request), together with those granted before so a step-up
/// keeps them; else the resource metadata's `scopes_supported`; else what was granted before.
/// `offline_access` is added when the authorization server offers it, so a refresh token can
/// be issued. None leaves `scope` out.
pub fn select_scope(
    configured: Option<&str>,
    challenge: Option<&str>,
    previous: Option<&str>,
    resource_scopes: &[String],
    server_scopes: &[String],
) -> Option<String> {
    let mut out = Vec::new();
    match (configured, challenge) {
        (Some(configured), _) if !configured.trim().is_empty() => push_scopes(&mut out, configured),
        (_, Some(challenge)) if !challenge.trim().is_empty() => {
            push_scopes(&mut out, previous.unwrap_or(""));
            push_scopes(&mut out, challenge);
        }
        _ if !resource_scopes.is_empty() => push_scopes(&mut out, &resource_scopes.join(" ")),
        _ => push_scopes(&mut out, previous.unwrap_or("")),
    }
    if out.is_empty() {
        return None;
    }
    if server_scopes.iter().any(|s| s == "offline_access") {
        push_scopes(&mut out, "offline_access");
    }
    Some(out.join(" "))
}

/// RFC 9207 section 2.4, as the MCP specification tabulates it: a present `iss` must be the
/// recorded issuer exactly; an absent one is refused only when the server says it sends it.
pub fn check_response_issuer(
    recorded: &str,
    iss: Option<&str>,
    supported: bool,
) -> Result<(), String> {
    match iss {
        Some(iss) if iss == recorded => Ok(()),
        Some(_) => Err(
            "the sign-in response came from another authorization server; it was refused".into(),
        ),
        None if supported => {
            Err("the sign-in response did not say which server sent it; it was refused".into())
        }
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    fn strs(urls: Vec<Url>) -> Vec<String> {
        urls.into_iter().map(String::from).collect()
    }

    #[test]
    fn resource_metadata_is_looked_for_at_the_path_then_the_root() {
        assert_eq!(
            strs(resource_metadata_urls(&url(
                "https://example.com/public/mcp?x=1#f"
            ))),
            [
                "https://example.com/.well-known/oauth-protected-resource/public/mcp",
                "https://example.com/.well-known/oauth-protected-resource",
            ]
        );
        assert_eq!(
            strs(resource_metadata_urls(&url("https://example.com/mcp/"))),
            [
                "https://example.com/.well-known/oauth-protected-resource/mcp",
                "https://example.com/.well-known/oauth-protected-resource",
            ]
        );
        assert_eq!(
            strs(resource_metadata_urls(&url("http://localhost:3000/"))),
            ["http://localhost:3000/.well-known/oauth-protected-resource"]
        );
    }

    #[test]
    fn authorization_server_metadata_follows_the_spec_order() {
        assert_eq!(
            strs(auth_server_metadata_urls(&url(
                "https://auth.example.com/tenant1"
            ))),
            [
                "https://auth.example.com/.well-known/oauth-authorization-server/tenant1",
                "https://auth.example.com/.well-known/openid-configuration/tenant1",
                "https://auth.example.com/tenant1/.well-known/openid-configuration",
            ]
        );
        assert_eq!(
            strs(auth_server_metadata_urls(&url("https://auth.example.com/"))),
            [
                "https://auth.example.com/.well-known/oauth-authorization-server",
                "https://auth.example.com/.well-known/openid-configuration",
            ]
        );
    }

    #[test]
    fn the_canonical_resource_has_no_fragment_query_or_terminating_slash() {
        assert_eq!(
            canonical_resource(&url("https://MCP.example.com/mcp/?a=1#x")),
            "https://mcp.example.com/mcp"
        );
        assert_eq!(
            canonical_resource(&url("https://mcp.example.com/")),
            "https://mcp.example.com"
        );
        assert_eq!(
            canonical_resource(&url("https://mcp.example.com:8443/server/mcp")),
            "https://mcp.example.com:8443/server/mcp"
        );
    }

    #[test]
    fn metadata_for_another_resource_is_refused() {
        let server = url("https://mcp.example.com/server/mcp");
        for ok in [
            "https://mcp.example.com",
            "https://mcp.example.com/",
            "https://mcp.example.com/server",
            "https://mcp.example.com/server/mcp",
        ] {
            assert_eq!(check_resource(&server, ok).unwrap(), ok, "{ok}");
        }
        for bad in [
            "https://other.example.com/server/mcp",
            "http://mcp.example.com/server/mcp",
            "https://mcp.example.com:444/server/mcp",
            "https://mcp.example.com/serv",
            "https://mcp.example.com/server/mcp/deeper",
            "https://mcp.example.com/server#x",
            "not a url",
        ] {
            assert!(check_resource(&server, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn resource_metadata_must_name_the_server_and_an_authorization_server() {
        let server = url("https://mcp.example.com/mcp");
        let ok = parse_resource_metadata(
            br#"{"resource":"https://mcp.example.com/mcp","authorization_servers":["https://auth.example.com", 3, ""],"scopes_supported":["read","write"]}"#,
            &server,
        )
        .unwrap();
        assert_eq!(ok.authorization_servers, ["https://auth.example.com"]);
        assert_eq!(ok.scopes_supported, ["read", "write"]);
        assert!(parse_resource_metadata(br#"{"authorization_servers":["a"]}"#, &server).is_err());
        assert!(parse_resource_metadata(
            br#"{"resource":"https://mcp.example.com/mcp","authorization_servers":[]}"#,
            &server
        )
        .is_err());
        assert!(parse_resource_metadata(
            br#"{"resource":"https://evil.example.com/mcp","authorization_servers":["a"]}"#,
            &server
        )
        .is_err());
        assert!(parse_resource_metadata(b"<html>", &server).is_err());
    }

    const AS: &str = r#"{
        "issuer": "https://auth.example.com",
        "authorization_endpoint": "https://auth.example.com/authorize",
        "token_endpoint": "https://auth.example.com/token",
        "registration_endpoint": "https://auth.example.com/register",
        "code_challenge_methods_supported": ["plain", "S256"],
        "scopes_supported": ["openid", "offline_access"],
        "authorization_response_iss_parameter_supported": true
    }"#;

    #[test]
    fn authorization_server_metadata_must_be_for_the_issuer_asked() {
        let ok = parse_auth_server_metadata(AS.as_bytes(), "https://auth.example.com").unwrap();
        assert_eq!(ok.token_endpoint, "https://auth.example.com/token");
        assert!(ok.iss_parameter_supported);
        assert!(parse_auth_server_metadata(AS.as_bytes(), "https://auth.example.com/").is_ok());
        let error =
            parse_auth_server_metadata(AS.as_bytes(), "https://honest.example").unwrap_err();
        assert!(error.contains("not for https://honest.example"));
    }

    #[test]
    fn pkce_with_s256_is_required() {
        let without = AS.replace(
            r#""code_challenge_methods_supported": ["plain", "S256"],"#,
            "",
        );
        assert!(
            parse_auth_server_metadata(without.as_bytes(), "https://auth.example.com")
                .unwrap_err()
                .contains("PKCE")
        );
        let plain_only = AS.replace(r#"["plain", "S256"]"#, r#"["plain"]"#);
        assert!(
            parse_auth_server_metadata(plain_only.as_bytes(), "https://auth.example.com").is_err()
        );
        let no_token = AS.replace(r#""token_endpoint": "https://auth.example.com/token","#, "");
        assert!(
            parse_auth_server_metadata(no_token.as_bytes(), "https://auth.example.com")
                .unwrap_err()
                .contains("token endpoint")
        );
    }

    #[test]
    fn scopes_follow_the_selection_order() {
        let none: [String; 0] = [];
        let offline = ["offline_access".to_owned()];
        let prm = ["read".to_owned(), "write".to_owned()];
        assert_eq!(
            select_scope(Some("mine"), Some("files:read"), None, &prm, &none).as_deref(),
            Some("mine")
        );
        assert_eq!(
            select_scope(None, Some("files:read"), None, &prm, &none).as_deref(),
            Some("files:read")
        );
        assert_eq!(
            select_scope(None, None, None, &prm, &offline).as_deref(),
            Some("read write offline_access")
        );
        // A step-up keeps what was granted.
        assert_eq!(
            select_scope(
                None,
                Some("files:write"),
                Some("files:read offline_access"),
                &prm,
                &offline
            )
            .as_deref(),
            Some("files:read offline_access files:write")
        );
        assert_eq!(select_scope(None, None, None, &none, &offline), None);
        assert_eq!(
            select_scope(Some("  "), None, Some("a"), &none, &none).as_deref(),
            Some("a")
        );
    }

    #[test]
    fn the_response_issuer_follows_rfc_9207() {
        let recorded = "https://auth.example.com";
        assert!(check_response_issuer(recorded, Some(recorded), true).is_ok());
        assert!(check_response_issuer(recorded, Some(recorded), false).is_ok());
        assert!(check_response_issuer(recorded, None, false).is_ok());
        assert!(check_response_issuer(recorded, None, true).is_err());
        assert!(check_response_issuer(recorded, Some("https://evil.example"), false).is_err());
        // No normalization: a case or slash difference is a different issuer.
        assert!(check_response_issuer(recorded, Some("https://AUTH.example.com"), true).is_err());
        assert!(check_response_issuer(recorded, Some("https://auth.example.com/"), true).is_err());
    }
}
