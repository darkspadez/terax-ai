//! `WWW-Authenticate` parsing (RFC 9110 section 11.6.1): what a protected MCP server says when
//! it refuses a request. Only the `Bearer` challenge matters here: where its protected resource
//! metadata is (`resource_metadata`, RFC 9728 section 5.1), the scopes the request needs
//! (`scope`) and why it failed (`error`, RFC 6750 section 3.1). Pure.

/// The parts of a `Bearer` challenge sign-in uses.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Challenge {
    pub resource_metadata: Option<String>,
    pub scope: Option<String>,
    pub error: Option<String>,
}

impl Challenge {
    /// A 403 that asks for more scopes (step-up authorization).
    pub fn insufficient_scope(&self) -> bool {
        self.error.as_deref() == Some("insufficient_scope")
    }
}

const MAX_VALUE: usize = 2048;

fn is_tchar(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)
}

struct Cursor<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl Cursor<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn skip_spaces(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t')) {
            self.pos += 1;
        }
    }

    fn skip_separators(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b',')) {
            self.pos += 1;
        }
    }

    fn token(&mut self) -> &str {
        let start = self.pos;
        while self.peek().is_some_and(is_tchar) {
            self.pos += 1;
        }
        std::str::from_utf8(&self.bytes[start..self.pos]).unwrap_or("")
    }

    /// A quoted string, the cursor on its opening quote; `\x` stands for `x`.
    fn quoted(&mut self) -> String {
        self.pos += 1;
        let mut out = Vec::new();
        while let Some(b) = self.peek() {
            self.pos += 1;
            match b {
                b'"' => break,
                b'\\' => {
                    if let Some(next) = self.peek() {
                        out.push(next);
                        self.pos += 1;
                    }
                }
                _ => out.push(b),
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }
}

/// Every challenge in the header values, as (scheme, parameters), names lower-cased.
fn challenges<'a>(
    values: impl IntoIterator<Item = &'a str>,
) -> Vec<(String, Vec<(String, String)>)> {
    let mut out = Vec::new();
    for value in values {
        let mut cursor = Cursor {
            bytes: value.as_bytes(),
            pos: 0,
        };
        loop {
            cursor.skip_separators();
            if cursor.peek().is_none() {
                break;
            }
            let scheme = cursor.token().to_ascii_lowercase();
            if scheme.is_empty() {
                // Not a token: skip it, so junk can never stall the parse.
                cursor.pos += 1;
                continue;
            }
            let mut params = Vec::new();
            loop {
                cursor.skip_separators();
                let start = cursor.pos;
                let name = cursor.token().to_ascii_lowercase();
                cursor.skip_spaces();
                if name.is_empty() || cursor.peek() != Some(b'=') {
                    // The next challenge's scheme, or a token68 (nothing we read).
                    if name.is_empty() || cursor.peek().is_some_and(|b| b != b',') {
                        cursor.pos = start;
                    }
                    break;
                }
                cursor.pos += 1;
                cursor.skip_spaces();
                let value = if cursor.peek() == Some(b'"') {
                    cursor.quoted()
                } else {
                    let value = cursor.token().to_owned();
                    // `token68=` padding.
                    while cursor.peek() == Some(b'=') {
                        cursor.pos += 1;
                    }
                    value
                };
                params.push((name, value));
                cursor.skip_spaces();
                if cursor.peek() != Some(b',') {
                    break;
                }
            }
            out.push((scheme, params));
        }
    }
    out
}

/// The first `Bearer` challenge among the header values, if there is one.
pub fn bearer_challenge<'a>(values: impl IntoIterator<Item = &'a str>) -> Option<Challenge> {
    let (_, params) = challenges(values)
        .into_iter()
        .find(|(scheme, _)| scheme == "bearer")?;
    let get = |key: &str| {
        params
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.trim().to_owned())
            .filter(|value| !value.is_empty() && value.len() <= MAX_VALUE)
    };
    Some(Challenge {
        resource_metadata: get("resource_metadata"),
        scope: get("scope"),
        error: get("error"),
    })
}

/// The `Bearer` challenge of a response's `WWW-Authenticate` headers.
pub fn from_headers(headers: &reqwest::header::HeaderMap) -> Option<Challenge> {
    bearer_challenge(
        headers
            .get_all(reqwest::header::WWW_AUTHENTICATE)
            .iter()
            .filter_map(|value| value.to_str().ok()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(value: &str) -> Option<Challenge> {
        bearer_challenge([value])
    }

    #[test]
    fn reads_the_spec_examples() {
        let c = parse(
            r#"Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="files:read""#,
        )
        .unwrap();
        assert_eq!(
            c.resource_metadata.as_deref(),
            Some("https://mcp.example.com/.well-known/oauth-protected-resource")
        );
        assert_eq!(c.scope.as_deref(), Some("files:read"));
        assert!(!c.insufficient_scope());

        let c = parse(
            r#"Bearer error="insufficient_scope", scope="files:write", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", error_description="File write permission required""#,
        )
        .unwrap();
        assert!(c.insufficient_scope());
        assert_eq!(c.scope.as_deref(), Some("files:write"));
    }

    #[test]
    fn finds_bearer_among_other_challenges_and_header_lines() {
        let c = bearer_challenge([
            r#"Basic realm="x", DPoP algs="ES256 PS256""#,
            r#"Bearer realm="api", error=invalid_token, scope="a b""#,
        ])
        .unwrap();
        assert_eq!(c.error.as_deref(), Some("invalid_token"));
        assert_eq!(c.scope.as_deref(), Some("a b"));

        let c = parse(r#"Negotiate abc==, bearer Scope="x""#).unwrap();
        assert_eq!(c.scope.as_deref(), Some("x"));
        assert_eq!(parse(r#"Basic realm="x""#), None);
        assert_eq!(parse(""), None);
    }

    #[test]
    fn quoted_values_keep_commas_and_escapes() {
        let c = parse(r#"Bearer scope="a, b", error="say \"no\"""#).unwrap();
        assert_eq!(c.scope.as_deref(), Some("a, b"));
        assert_eq!(c.error.as_deref(), Some(r#"say "no""#));
    }

    #[test]
    fn a_bare_bearer_challenge_has_no_parameters() {
        assert_eq!(parse("Bearer"), Some(Challenge::default()));
        assert_eq!(parse("Bearer ,"), Some(Challenge::default()));
    }

    #[test]
    fn junk_never_stalls_or_panics() {
        for junk in [
            "///",
            "Bearer =",
            "Bearer a=\"unterminated",
            "=,=,",
            "Bearer a b c",
            "\u{e9}",
            "Bearer scope=\"x\\",
        ] {
            let _ = parse(junk);
        }
        assert_eq!(
            parse("Bearer a=\"unterminated").map(|c| c.scope),
            Some(None)
        );
    }

    #[test]
    fn oversized_values_are_dropped() {
        let long = format!("Bearer scope=\"{}\"", "a".repeat(MAX_VALUE + 1));
        assert_eq!(parse(&long).unwrap().scope, None);
    }
}
