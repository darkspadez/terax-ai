//! Validation of what the page names: server ids, environment variable and
//! header names, and the keychain accounts secret values live under. Pure.

/// Keychain service of MCP secrets. The page writes them through
/// `mcp_secret_set` and can never read them back: the generic `secrets_*`
/// commands refuse this service (`secrets::page_may_use_service`).
pub const SECRET_SERVICE: &str = "terax-mcp";

/// `[a-z0-9-]`, 1 to 64 characters: a UUID or a short slug. Part of keychain
/// accounts and log keys, so nothing that could alias another.
pub fn valid_server_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// A portable environment variable name: `[A-Za-z_][A-Za-z0-9_]*`, at most
/// 128 characters.
pub fn valid_env_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    matches!(bytes.next(), Some(b) if b.is_ascii_alphabetic() || b == b'_')
        && name.len() <= 128
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// An HTTP header name (RFC 9110 token), at most 128 characters.
pub fn valid_header_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SecretKind {
    Env,
    Header,
}

/// The keychain account of one secret: `<server>/env/<NAME>` or
/// `<server>/header/<name>` (header names compare case-insensitively).
pub fn secret_account(server: &str, kind: SecretKind, name: &str) -> Result<String, String> {
    if !valid_server_id(server) {
        return Err("mcp: invalid server id".into());
    }
    match kind {
        SecretKind::Env if valid_env_name(name) => Ok(format!("{server}/env/{name}")),
        SecretKind::Header if valid_header_name(name) => {
            Ok(format!("{server}/header/{}", name.to_ascii_lowercase()))
        }
        _ => Err(format!("mcp: invalid name {name:?}")),
    }
}

/// A value placed in a child's environment or a request header: no NUL (it
/// would cut the value) and, for headers, no line breaks.
pub fn valid_value(value: &str, kind: SecretKind) -> bool {
    value.len() <= 32 * 1024
        && !value.bytes().any(|b| match kind {
            SecretKind::Env => b == 0,
            SecretKind::Header => matches!(b, 0 | b'\r' | b'\n'),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_ids_are_plain_slugs() {
        assert!(valid_server_id("6f1c2a5e-0b9d-4c3e-8f7a-1d2e3f4a5b6c"));
        assert!(valid_server_id("github"));
        for bad in ["", "A", "a/b", "a b", "..", "a.b", &"a".repeat(65)] {
            assert!(!valid_server_id(bad), "{bad}");
        }
    }

    #[test]
    fn env_names_are_portable() {
        for good in ["PATH", "_X", "GITHUB_TOKEN", "a1"] {
            assert!(valid_env_name(good), "{good}");
        }
        for bad in ["", "1A", "A-B", "A=B", "A B", "Ä", &"A".repeat(129)] {
            assert!(!valid_env_name(bad), "{bad}");
        }
    }

    #[test]
    fn header_names_are_tokens() {
        for good in ["Authorization", "X-Api-Key", "x_custom.v2"] {
            assert!(valid_header_name(good), "{good}");
        }
        for bad in ["", "A B", "A:B", "A\r\nB", "Ä"] {
            assert!(!valid_header_name(bad), "{bad}");
        }
    }

    #[test]
    fn accounts_are_scoped_to_the_server_and_kind() {
        assert_eq!(
            secret_account("s1", SecretKind::Env, "API_KEY").unwrap(),
            "s1/env/API_KEY"
        );
        assert_eq!(
            secret_account("s1", SecretKind::Header, "X-Api-Key").unwrap(),
            "s1/header/x-api-key"
        );
        assert!(secret_account("S1", SecretKind::Env, "A").is_err());
        assert!(secret_account("s1", SecretKind::Env, "../A").is_err());
        assert!(secret_account("s1", SecretKind::Header, "a/b").is_err());
    }

    #[test]
    fn values_never_carry_terminators_or_line_breaks_into_headers() {
        assert!(valid_value("Bearer abc", SecretKind::Header));
        assert!(!valid_value("a\r\nX-Evil: 1", SecretKind::Header));
        assert!(valid_value("multi\nline", SecretKind::Env));
        assert!(!valid_value("a\0b", SecretKind::Env));
        assert!(!valid_value(&"x".repeat(32 * 1024 + 1), SecretKind::Env));
    }
}
