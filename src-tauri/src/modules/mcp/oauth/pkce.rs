//! PKCE (RFC 7636, S256), the `state` value and the base64 forms OAuth uses. Pure, but for the
//! random bytes.

use sha2::{Digest, Sha256};

const STANDARD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL_SAFE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn encode(bytes: &[u8], alphabet: &[u8; 64], pad: bool) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        let symbols = chunk.len() + 1;
        for i in 0..4 {
            if i < symbols {
                out.push(alphabet[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else if pad {
                out.push('=');
            }
        }
    }
    out
}

/// Standard base64 with padding (HTTP Basic credentials).
pub fn base64(bytes: &[u8]) -> String {
    encode(bytes, STANDARD, true)
}

/// base64url without padding (PKCE, `state`).
pub fn base64url(bytes: &[u8]) -> String {
    encode(bytes, URL_SAFE, false)
}

/// `bytes` random bytes as base64url.
pub fn random_token(bytes: usize) -> Result<String, String> {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer).map_err(|e| format!("random: {e}"))?;
    Ok(base64url(&buffer))
}

/// The S256 challenge of a verifier: base64url(SHA-256(verifier)).
pub fn challenge(verifier: &str) -> String {
    base64url(&Sha256::digest(verifier.as_bytes()))
}

/// A code verifier and its challenge: 32 random bytes, 43 characters.
pub fn new_pair() -> Result<(String, String), String> {
    let verifier = random_token(32)?;
    let challenge = challenge(&verifier);
    Ok((verifier, challenge))
}

/// Compares secrets in time that does not depend on where they differ.
pub fn same_secret(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc_4648_vectors() {
        for (input, standard, url) in [
            ("", "", ""),
            ("f", "Zg==", "Zg"),
            ("fo", "Zm8=", "Zm8"),
            ("foo", "Zm9v", "Zm9v"),
            ("foob", "Zm9vYg==", "Zm9vYg"),
            ("fooba", "Zm9vYmE=", "Zm9vYmE"),
            ("foobar", "Zm9vYmFy", "Zm9vYmFy"),
        ] {
            assert_eq!(base64(input.as_bytes()), standard, "{input}");
            assert_eq!(base64url(input.as_bytes()), url, "{input}");
        }
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
        assert_eq!(base64(&[0xfb, 0xff]), "+/8=");
    }

    #[test]
    fn the_challenge_matches_rfc_7636_appendix_b() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn verifiers_are_long_enough_and_unique() {
        let (verifier, challenge) = new_pair().unwrap();
        assert_eq!(verifier.len(), 43);
        assert_eq!(challenge.len(), 43);
        assert!(verifier
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        assert_ne!(new_pair().unwrap().0, verifier);
    }

    #[test]
    fn secrets_compare_exactly() {
        assert!(same_secret("abc", "abc"));
        assert!(!same_secret("abc", "abd"));
        assert!(!same_secret("abc", "abcd"));
        assert!(!same_secret("", "a"));
    }
}
