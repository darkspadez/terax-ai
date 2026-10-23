//! The redirect target of sign-in (RFC 8252 section 7.3): a one-shot listener on
//! `127.0.0.1`, on a port the system picks unless a registered client needs a known one, at
//! `/callback`. It answers only the request carrying the `state` it waits for; anything else
//! (another path, a stale or forged `state`) gets a short error page and is ignored, so a
//! local page probing the port can neither end nor answer the sign-in.

use std::collections::HashMap;
use std::time::Duration;

use reqwest::Url;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub const CALLBACK_PATH: &str = "/callback";
const MAX_HEAD: usize = 8 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(10);

pub struct Listener {
    inner: TcpListener,
    pub port: u16,
}

impl Listener {
    /// Binds `127.0.0.1:port` (0: any free port).
    pub async fn bind(port: u16) -> std::io::Result<Self> {
        let inner = TcpListener::bind(("127.0.0.1", port)).await?;
        let port = inner.local_addr()?.port();
        Ok(Self { inner, port })
    }

    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}{CALLBACK_PATH}", self.port)
    }

    /// Waits for the authorization response carrying `state`. Each connection is read on its
    /// own, so one that sends nothing never holds up the browser's. The connection stays open
    /// so the page can say how sign-in ended.
    pub async fn wait(&self, state: &str) -> (HashMap<String, String>, TcpStream) {
        let (found, mut received) = tokio::sync::mpsc::channel(1);
        loop {
            tokio::select! {
                accepted = self.inner.accept() => {
                    let Ok((stream, _)) = accepted else { continue };
                    let found = found.clone();
                    let state = state.to_owned();
                    tokio::spawn(async move {
                        if let Some(callback) = answer(stream, &state).await {
                            let _ = found.send(callback).await;
                        }
                    });
                }
                Some(callback) = received.recv() => return callback,
            }
        }
    }
}

/// Reads one request: the callback for `state` comes back with its open connection, anything
/// else is answered and closed.
async fn answer(
    mut stream: TcpStream,
    state: &str,
) -> Option<(HashMap<String, String>, TcpStream)> {
    let head = tokio::time::timeout(READ_TIMEOUT, read_head(&mut stream))
        .await
        .ok()??;
    match classify(&head, state) {
        Request::Callback(params) => Some((params, stream)),
        Request::Other(status, message) => {
            let _ = respond(&mut stream, status, &page("Terax", message)).await;
            None
        }
    }
}

async fn read_head(stream: &mut TcpStream) -> Option<String> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            buffer.truncate(end);
            return String::from_utf8(buffer).ok();
        }
        if buffer.len() > MAX_HEAD {
            return None;
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Request {
    Callback(HashMap<String, String>),
    Other(u16, &'static str),
}

/// What a request head is: the callback for `state`, or something to turn away.
fn classify(head: &str, state: &str) -> Request {
    let line = head.lines().next().unwrap_or("");
    let mut parts = line.split(' ');
    let (Some(method), Some(target)) = (parts.next(), parts.next()) else {
        return Request::Other(400, "This is not a request Terax understands.");
    };
    let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else {
        return Request::Other(400, "This is not a request Terax understands.");
    };
    if method != "GET" || url.path() != CALLBACK_PATH {
        return Request::Other(404, "Nothing here.");
    }
    let mut params = HashMap::new();
    for (key, value) in url.query_pairs() {
        // A repeated parameter makes the response ambiguous: the first one counts for none.
        if params
            .insert(key.into_owned(), value.into_owned())
            .is_some()
        {
            return Request::Other(400, "This sign-in response is not valid.");
        }
    }
    match params.get("state") {
        Some(got) if super::pkce::same_secret(got, state) => Request::Callback(params),
        _ => Request::Other(
            400,
            "This sign-in response is not the one Terax is waiting for. Start sign-in again from Terax's Settings.",
        ),
    }
}

fn escape(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '&' => "&amp;".to_owned(),
            '<' => "&lt;".to_owned(),
            '>' => "&gt;".to_owned(),
            '"' => "&quot;".to_owned(),
            '\'' => "&#39;".to_owned(),
            c if c.is_control() => " ".to_owned(),
            c => c.to_string(),
        })
        .collect()
}

/// The small page the browser shows. It never carries the code, a token or the state.
pub fn page(title: &str, message: &str) -> String {
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{title}</title><style>body{{font:15px/1.5 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#fafafa;color:#1a1a1a}}@media(prefers-color-scheme:dark){{body{{background:#141414;color:#eee}}}}main{{max-width:28rem;padding:2rem;text-align:center}}h1{{font-size:1.15rem;margin:0 0 .5rem}}p{{margin:0;opacity:.75}}</style></head><body><main><h1>{title}</h1><p>{message}</p></main></body></html>",
        title = escape(title),
        message = escape(message),
    )
}

/// Writes a response and closes the connection.
pub async fn respond(stream: &mut TcpStream, status: u16, html: &str) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        _ => "Bad Request",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nConnection: close\r\n\r\n",
        html.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(html.as_bytes()).await?;
    stream.shutdown().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_callback_with_its_state_is_taken() {
        let head = "GET /callback?code=abc&state=s3cret&iss=https%3A%2F%2Fauth HTTP/1.1\r\nHost: 127.0.0.1";
        let Request::Callback(params) = classify(head, "s3cret") else {
            panic!("expected the callback");
        };
        assert_eq!(params["code"], "abc");
        assert_eq!(params["iss"], "https://auth");

        assert!(matches!(classify(head, "other"), Request::Other(400, _)));
        assert!(matches!(
            classify("GET /callback?code=abc HTTP/1.1", "s3cret"),
            Request::Other(400, _)
        ));
        assert!(matches!(
            classify("GET /favicon.ico HTTP/1.1", "s3cret"),
            Request::Other(404, _)
        ));
        assert!(matches!(
            classify("POST /callback?state=s3cret HTTP/1.1", "s3cret"),
            Request::Other(404, _)
        ));
        assert!(matches!(
            classify("GET /callback?state=s3cret&state=x HTTP/1.1", "s3cret"),
            Request::Other(400, _)
        ));
        assert!(matches!(classify("", "s3cret"), Request::Other(400, _)));
        assert!(matches!(
            classify(
                "GET //evil.example/callback?state=s3cret HTTP/1.1",
                "s3cret"
            ),
            Request::Other(_, _)
        ));
    }

    #[test]
    fn the_page_escapes_what_it_shows() {
        let html = page("Sign-in failed", "<script>alert(1)</script> & \"x\"");
        assert!(!html.contains("<script>"));
        assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_silent_connection_never_holds_up_the_callback() {
        let listener = Listener::bind(0).await.unwrap();
        let port = listener.port;
        // Connects and sends nothing, as long as the test runs.
        let _silent = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            stream
                .write_all(b"GET /callback?state=s&code=c HTTP/1.1\r\n\r\n")
                .await
                .unwrap();
            stream
        });
        let waited =
            tokio::time::timeout(std::time::Duration::from_secs(5), listener.wait("s")).await;
        let (params, _) = waited.expect("the callback came through at once");
        assert_eq!(params["code"], "c");
        drop(client.await.unwrap());
    }

    #[tokio::test]
    async fn the_listener_waits_for_its_state_and_ignores_the_rest() {
        let listener = Listener::bind(0).await.unwrap();
        assert!(listener.port > 0);
        assert_eq!(
            listener.redirect_uri(),
            format!("http://127.0.0.1:{}/callback", listener.port)
        );
        let port = listener.port;
        let client = tokio::spawn(async move {
            let mut answers = Vec::new();
            for target in [
                "/callback?state=wrong&code=x",
                "/other",
                "/callback?state=right&code=c1",
            ] {
                let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
                stream
                    .write_all(format!("GET {target} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes())
                    .await
                    .unwrap();
                if target.contains("right") {
                    answers.push(stream);
                    break;
                }
                let mut text = String::new();
                stream.read_to_string(&mut text).await.unwrap();
                assert!(!text.contains("HTTP/1.1 200"), "{text}");
            }
            let mut last = answers.pop().unwrap();
            let mut text = String::new();
            last.read_to_string(&mut text).await.unwrap();
            text
        });
        let (params, mut stream) = listener.wait("right").await;
        assert_eq!(params["code"], "c1");
        respond(
            &mut stream,
            200,
            &page("Signed in", "You can close this tab."),
        )
        .await
        .unwrap();
        let text = client.await.unwrap();
        assert!(text.starts_with("HTTP/1.1 200 OK"));
        assert!(text.contains("You can close this tab."));
        assert!(!text.contains("c1"), "the page never shows the code");
    }
}
