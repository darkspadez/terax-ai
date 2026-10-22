//! Remote images for the Markdown preview.
//!
//! The webview's CSP loads no remote images: AI chat Markdown renders in the
//! same webview, and an image URL in a prompt-injected answer would leak data
//! without a click. A file the user opened in the preview fetches its https
//! images here instead, under the same rules as the AI proxy: public
//! addresses only, the resolver pinned to the classified addresses, and every
//! redirect hop validated again.

use reqwest::header::{HeaderMap, ACCEPT, CONTENT_TYPE, LOCATION};
use tauri::ipc::Response;

use super::clients::{client_for, Profile};
use super::{classify_and_collect_safe_ips, validate_url};

const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;

fn validate_image_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = validate_url(url, false)?;
    if parsed.scheme() != "https" {
        return Err("only https images are loaded".into());
    }
    Ok(parsed)
}

/// The response's image type, without parameters. Anything else (an HTML
/// error page, a script) is refused.
fn image_content_type(headers: &HeaderMap) -> Result<String, String> {
    let value = headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .ok_or("response has no content type")?;
    let mime = value
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !mime.starts_with("image/") || mime.len() > 255 {
        return Err(format!("not an image: {mime}"));
    }
    Ok(mime)
}

/// `[u8 type length][type][image bytes]`: one binary IPC body, no JSON.
fn encode_image(mime: &str, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(1 + mime.len() + body.len());
    out.push(mime.len() as u8);
    out.extend_from_slice(mime.as_bytes());
    out.extend_from_slice(body);
    out
}

#[tauri::command]
pub async fn markdown_remote_image(url: String) -> Result<Response, String> {
    let mut url = validate_image_url(&url)?;
    for _ in 0..=MAX_REDIRECTS {
        let host = url.host_str().ok_or("missing host")?.to_string();
        let safe_ips = classify_and_collect_safe_ips(&host, false).await?;
        let client = client_for(Profile::Fetch, &host, &safe_ips, false)?;
        let mut response = client
            .get(url.clone())
            .header(ACCEPT, "image/*")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = response.status();
        if status.is_redirection() {
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or("redirect without a location")?;
            let next = url.join(location).map_err(|e| e.to_string())?;
            url = validate_image_url(next.as_str())?;
            continue;
        }
        if !status.is_success() {
            return Err(format!("HTTP {status}"));
        }
        let mime = image_content_type(response.headers())?;
        if response
            .content_length()
            .is_some_and(|len| len > MAX_IMAGE_BYTES as u64)
        {
            return Err("image is too large".into());
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if body.len() + chunk.len() > MAX_IMAGE_BYTES {
                return Err("image is too large".into());
            }
            body.extend_from_slice(&chunk);
        }
        return Ok(Response::new(encode_image(&mime, &body)));
    }
    Err("too many redirects".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;

    fn headers(content_type: &str) -> HeaderMap {
        let mut map = HeaderMap::new();
        map.insert(CONTENT_TYPE, HeaderValue::from_str(content_type).unwrap());
        map
    }

    #[test]
    fn only_https_urls_without_credentials_are_fetched() {
        assert!(validate_image_url("https://img.shields.io/badge/a-b-c").is_ok());
        assert!(validate_image_url("http://example.com/a.png").is_err());
        assert!(validate_image_url("https://user:pw@example.com/a.png").is_err());
        assert!(validate_image_url("https://metadata.google.internal/a").is_err());
        assert!(validate_image_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn only_image_responses_are_accepted() {
        assert_eq!(
            image_content_type(&headers("image/png")).unwrap(),
            "image/png"
        );
        assert_eq!(
            image_content_type(&headers("Image/SVG+XML; charset=utf-8")).unwrap(),
            "image/svg+xml"
        );
        assert!(image_content_type(&headers("text/html")).is_err());
        assert!(image_content_type(&HeaderMap::new()).is_err());
    }

    #[test]
    fn encodes_the_type_ahead_of_the_bytes() {
        assert_eq!(
            encode_image("image/png", &[1, 2]),
            [&[9u8][..], b"image/png", &[1, 2]].concat()
        );
    }
}
