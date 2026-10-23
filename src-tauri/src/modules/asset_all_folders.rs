//! The `terax-asset` scheme: what previews load through while "Allow the app to access all
//! folders" is on. Tauri's asset protocol only serves what `asset_scope` granted, and a grant
//! there can never be taken back, so files outside the authorized folders come through this
//! scheme instead, which asks the setting on every request: the moment it is off, it serves no
//! more than the asset protocol does. There is no `**` anywhere.
//!
//! A request is served when the asset protocol would serve the file, or, while the app may
//! access all folders, when no name on the file's real path starts with a dot: the same rule
//! the asset scope's `requireLiteralLeadingDot` applies below a granted root, so `~/.ssh` and
//! `.env` stay out. A link is judged by where it leads. Like the asset protocol, any frame can
//! request it; a request carrying a foreign `Origin` (a page in the preview reading it with
//! `fetch`) is refused, and responses only name the app's own origin.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use tauri::http::{self, header, HeaderValue, Method, StatusCode};
use tauri::utils::mime_type::MimeType;
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use super::pty::AllowedOrigins;
use super::workspace::{Origin, WorkspaceRegistry};

/// The scheme's name, as the page passes it to `convertFileSrc`.
pub const SCHEME: &str = "terax-asset";

/// The most one range response carries, as Tauri's asset protocol does; media players ask for
/// the rest as they go.
const MAX_PART: u64 = 1000 * 1024;

/// How much of a file the content type is sniffed from.
const SNIFF_BYTES: u64 = 8192;

static ORIGINS: OnceLock<AllowedOrigins> = OnceLock::new();

pub fn protocol<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    // Opening and reading the file blocks.
    tauri::async_runtime::spawn_blocking(move || {
        let origins = ORIGINS.get_or_init(|| {
            AllowedOrigins::for_app(
                app.config().build.dev_url.as_ref(),
                tauri::is_dev(),
                cfg!(windows),
            )
        });
        let origin_header = request.headers().get(header::ORIGIN);
        let Some(origin) = origins.check(origin_header.map(HeaderValue::as_bytes)) else {
            responder.respond(status_only(StatusCode::FORBIDDEN, None));
            return;
        };
        let scope = app.asset_protocol_scope();
        let all_folders = app_reaches_all(app.try_state::<WorkspaceRegistry>().as_deref());
        let served = |real: &Path| serves(real, scope.is_allowed(real), all_folders);
        responder.respond(respond(&request, &origin, served));
    });
}

/// The app's setting, read for each request: the AI tools' setting never widens previews.
fn app_reaches_all(registry: Option<&WorkspaceRegistry>) -> bool {
    registry.is_some_and(|registry| registry.all_folders(Origin::App))
}

/// Whether the file at `real` (its real path) is served: the asset protocol would, or the app
/// may access all folders and nothing on the path is a dot name.
fn serves(real: &Path, asset_scope_allows: bool, all_folders: bool) -> bool {
    asset_scope_allows || (all_folders && !has_dot_name(real))
}

/// Whether a name on `path` starts with a dot, as a wildcard with `requireLiteralLeadingDot`
/// would skip it. Drive and share prefixes are not names.
fn has_dot_name(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(name) => name.to_string_lossy().starts_with('.'),
        _ => false,
    })
}

/// The file a request names: its URL path, without the leading slash, percent-decoded, which
/// `convertFileSrc` makes of an absolute path.
fn requested_path(uri_path: &str) -> Option<PathBuf> {
    let encoded = uri_path.strip_prefix('/').unwrap_or(uri_path);
    let path = PathBuf::from(percent_decode(encoded)?);
    path.is_absolute().then_some(path)
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            if !hex.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            out.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out)
        .ok()
        .filter(|path| !path.contains('\0'))
}

/// What a `Range` header asks of a file of `len` bytes, as this scheme answers it.
#[derive(Debug, PartialEq, Eq)]
enum Range {
    /// No usable range: the whole file. A header that does not parse, or asks for several
    /// ranges, is ignored, as HTTP allows.
    Whole,
    /// Bytes `start..=end`, at most `MAX_PART` of them.
    Part {
        start: u64,
        end: u64,
    },
    Unsatisfiable,
}

fn parse_range(header: Option<&str>, len: u64) -> Range {
    let Some(spec) = header.and_then(|value| value.trim().strip_prefix("bytes=")) else {
        return Range::Whole;
    };
    if spec.contains(',') {
        return Range::Whole;
    }
    let Some((first, last)) = spec.split_once('-') else {
        return Range::Whole;
    };
    let (first, last) = (first.trim(), last.trim());
    let (start, end) = if first.is_empty() {
        let Ok(suffix) = last.parse::<u64>() else {
            return Range::Whole;
        };
        if suffix == 0 || len == 0 {
            return Range::Unsatisfiable;
        }
        (len.saturating_sub(suffix), len - 1)
    } else {
        let Ok(start) = first.parse::<u64>() else {
            return Range::Whole;
        };
        let end = if last.is_empty() {
            u64::MAX
        } else {
            match last.parse::<u64>() {
                Ok(end) if end >= start => end,
                _ => return Range::Whole,
            }
        };
        if start >= len {
            return Range::Unsatisfiable;
        }
        (start, end.min(len - 1))
    };
    Range::Part {
        start,
        end: end.min(start.saturating_add(MAX_PART - 1)),
    }
}

fn respond(
    request: &http::Request<Vec<u8>>,
    origin: &str,
    served: impl Fn(&Path) -> bool,
) -> http::Response<Vec<u8>> {
    let head = request.method() == Method::HEAD;
    if request.method() != Method::GET && !head {
        return status_only(StatusCode::METHOD_NOT_ALLOWED, Some(origin));
    }
    let Some(path) = requested_path(request.uri().path()) else {
        return status_only(StatusCode::BAD_REQUEST, Some(origin));
    };
    // A missing file outside reads as refused, so the answer never says whether it exists.
    let real = match std::fs::canonicalize(&path) {
        Ok(real) if served(&real) => real,
        _ => return status_only(StatusCode::FORBIDDEN, Some(origin)),
    };
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    match read(&real, range, head) {
        Ok(file) => file.response(origin),
        Err(error) => {
            log::debug!("{SCHEME}: cannot read {}: {error}", real.display());
            status_only(StatusCode::NOT_FOUND, Some(origin))
        }
    }
}

/// A file, or the part of it a range asks for, ready to answer with.
struct Served {
    status: StatusCode,
    mime: String,
    content_range: Option<String>,
    /// The length the response announces; a HEAD response carries no body.
    len: u64,
    body: Vec<u8>,
}

fn read(real: &Path, range: Option<&str>, head: bool) -> std::io::Result<Served> {
    let mut file = File::open(real)?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(std::io::Error::other("not a file"));
    }
    let size = meta.len();
    let mut magic = Vec::new();
    (&mut file)
        .take(size.min(SNIFF_BYTES))
        .read_to_end(&mut magic)?;
    let mime = MimeType::parse(&magic, &real.to_string_lossy());
    let (status, start, len, content_range) = match parse_range(range, size) {
        Range::Whole => (StatusCode::OK, 0, size, None),
        Range::Part { start, end } => (
            StatusCode::PARTIAL_CONTENT,
            start,
            end - start + 1,
            Some(format!("bytes {start}-{end}/{size}")),
        ),
        Range::Unsatisfiable => (
            StatusCode::RANGE_NOT_SATISFIABLE,
            0,
            0,
            Some(format!("bytes */{size}")),
        ),
    };
    let body = if head || len == 0 {
        Vec::new()
    } else if start == 0 && len <= magic.len() as u64 {
        magic.truncate(len as usize);
        magic
    } else {
        file.seek(SeekFrom::Start(start))?;
        let mut body = Vec::with_capacity(len as usize);
        file.take(len).read_to_end(&mut body)?;
        body
    };
    Ok(Served {
        status,
        mime,
        content_range,
        len,
        body,
    })
}

impl Served {
    fn response(self, origin: &str) -> http::Response<Vec<u8>> {
        let mut builder = with_origin(http::Response::builder(), Some(origin))
            .status(self.status)
            .header(header::CONTENT_TYPE, self.mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "content-range")
            .header(header::CONTENT_LENGTH, self.len);
        if let Some(range) = self.content_range {
            builder = builder.header(header::CONTENT_RANGE, range);
        }
        builder
            .body(self.body)
            .unwrap_or_else(|_| status_only(StatusCode::INTERNAL_SERVER_ERROR, Some(origin)))
    }
}

fn with_origin(builder: http::response::Builder, origin: Option<&str>) -> http::response::Builder {
    // Turning the setting off must stop what the webview would otherwise reuse.
    let builder = builder
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::VARY, "Origin");
    match origin {
        Some(origin) => builder.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin),
        None => builder,
    }
}

fn status_only(status: StatusCode, origin: Option<&str>) -> http::Response<Vec<u8>> {
    with_origin(http::Response::builder(), origin)
        .status(status)
        .body(Vec::new())
        .expect("static response headers are valid")
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: &str = "tauri://localhost";

    fn get(path: &Path, range: Option<&str>) -> http::Request<Vec<u8>> {
        method(Method::GET, path, range)
    }

    fn method(method: Method, path: &Path, range: Option<&str>) -> http::Request<Vec<u8>> {
        let encoded: String = path
            .to_string_lossy()
            .bytes()
            .map(|byte| match byte {
                b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' => {
                    (byte as char).to_string()
                }
                _ => format!("%{byte:02X}"),
            })
            .collect();
        let mut builder = http::Request::builder()
            .method(method)
            .uri(format!("{SCHEME}://localhost/{encoded}"));
        if let Some(range) = range {
            builder = builder.header(header::RANGE, range);
        }
        builder.body(Vec::new()).unwrap()
    }

    fn folder() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::write(root.join("notes.txt"), b"0123456789").unwrap();
        (dir, root)
    }

    #[test]
    fn only_the_apps_setting_serves_files_outside_the_asset_scope() {
        let registry = WorkspaceRegistry::default();
        assert!(!app_reaches_all(None));
        assert!(!app_reaches_all(Some(&registry)));
        registry.set_all_folders(Origin::Ai, true);
        assert!(!app_reaches_all(Some(&registry)), "the AI tools' setting");
        registry.set_all_folders(Origin::App, true);
        assert!(app_reaches_all(Some(&registry)));
        registry.set_all_folders(Origin::App, false);
        assert!(!app_reaches_all(Some(&registry)), "off again at once");

        let photo = Path::new("/srv/photos/cat.png");
        assert!(!serves(photo, false, false));
        assert!(serves(photo, false, true));
        assert!(serves(photo, true, false), "what the asset scope grants");
    }

    #[test]
    fn dot_names_stay_out_while_every_folder_is_served() {
        for secret in [
            "/home/me/.ssh/id_ed25519",
            "/srv/app/.env",
            "/srv/.git/config",
            "/tmp/.hidden/pic.png",
        ] {
            assert!(!serves(Path::new(secret), false, true), "{secret}");
            assert!(serves(Path::new(secret), true, true), "granted: {secret}");
        }
        assert!(serves(Path::new("/srv/app/env.png"), false, true));
        assert!(serves(Path::new("/srv/app/a.b/c..png"), false, true));
    }

    #[cfg(windows)]
    #[test]
    fn windows_prefixes_are_not_names() {
        assert!(!has_dot_name(Path::new(r"\\?\C:\Users\me\pic.png")));
        assert!(!has_dot_name(Path::new(
            r"\\?\UNC\wsl.localhost\Ubuntu\home\me\pic.png"
        )));
        assert!(has_dot_name(Path::new(r"\\?\C:\Users\me\.ssh\id_rsa")));
    }

    #[cfg(unix)]
    #[test]
    fn the_url_names_an_absolute_path() {
        assert_eq!(
            requested_path("/%2Fhome%2Fme%2Fmy%20pic.png"),
            Some(PathBuf::from("/home/me/my pic.png"))
        );
        assert_eq!(
            requested_path("/%2Fsrv%2F%C3%A9t%C3%A9.png"),
            Some(PathBuf::from("/srv/\u{e9}t\u{e9}.png"))
        );
        assert_eq!(requested_path("/pic.png"), None, "relative");
        assert_eq!(requested_path("/%2Fa%2"), None, "cut escape");
        assert_eq!(requested_path("/%2Fa%zz"), None, "not hex");
        assert_eq!(requested_path("/%2Fa%+1"), None, "a sign is not hex");
        assert_eq!(requested_path("/%2Fa%00b"), None, "NUL");
        assert_eq!(requested_path("/%2Fa%FF"), None, "not UTF-8");
    }

    #[cfg(windows)]
    #[test]
    fn the_url_names_an_absolute_windows_path() {
        assert_eq!(
            requested_path("/C%3A%5CUsers%5Cme%5Cmy%20pic.png"),
            Some(PathBuf::from(r"C:\Users\me\my pic.png"))
        );
        assert_eq!(
            requested_path("/%5C%5Cwsl.localhost%5CUbuntu%5Chome%5Cme%5Cpic.png"),
            Some(PathBuf::from(r"\\wsl.localhost\Ubuntu\home\me\pic.png"))
        );
        assert_eq!(requested_path("/Users%5Cme%5Cpic.png"), None, "relative");
        assert_eq!(requested_path("/%5Cpic.png"), None, "rooted, no drive");
    }

    #[test]
    fn ranges_are_answered_one_part_at_a_time() {
        let part = |start, end| Range::Part { start, end };
        assert_eq!(parse_range(None, 10), Range::Whole);
        assert_eq!(parse_range(Some("bytes=0-"), 10), part(0, 9));
        assert_eq!(parse_range(Some("bytes=2-5"), 10), part(2, 5));
        assert_eq!(parse_range(Some("bytes=8-100"), 10), part(8, 9));
        assert_eq!(parse_range(Some("bytes=-3"), 10), part(7, 9));
        assert_eq!(parse_range(Some("bytes=-30"), 10), part(0, 9));
        assert_eq!(parse_range(Some("bytes=10-"), 10), Range::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=-0"), 10), Range::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=0-"), 0), Range::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=5-2"), 10), Range::Whole);
        assert_eq!(parse_range(Some("bytes=0-1,4-5"), 10), Range::Whole);
        assert_eq!(parse_range(Some("items=0-1"), 10), Range::Whole);
        assert_eq!(parse_range(Some("bytes=x-1"), 10), Range::Whole);
        let big = 10 * MAX_PART;
        assert_eq!(parse_range(Some("bytes=0-"), big), part(0, MAX_PART - 1));
        assert_eq!(
            parse_range(Some("bytes=100-"), big),
            part(100, 100 + MAX_PART - 1)
        );
    }

    #[test]
    fn a_served_file_is_answered_whole_or_in_part() {
        let (_dir, root) = folder();
        let file = root.join("notes.txt");
        let served = |real: &Path| real.starts_with(&root);

        let whole = respond(&get(&file, None), ORIGIN, served);
        assert_eq!(whole.status(), StatusCode::OK);
        assert_eq!(whole.body(), b"0123456789");
        assert_eq!(whole.headers()[header::CONTENT_LENGTH], "10");
        assert_eq!(whole.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], ORIGIN);
        assert_eq!(whole.headers()[header::CACHE_CONTROL], "no-store");

        let part = respond(&get(&file, Some("bytes=2-4")), ORIGIN, served);
        assert_eq!(part.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(part.body(), b"234");
        assert_eq!(part.headers()[header::CONTENT_RANGE], "bytes 2-4/10");

        let past = respond(&get(&file, Some("bytes=20-")), ORIGIN, served);
        assert_eq!(past.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(past.headers()[header::CONTENT_RANGE], "bytes */10");

        let head = respond(&method(Method::HEAD, &file, None), ORIGIN, served);
        assert_eq!(head.status(), StatusCode::OK);
        assert!(head.body().is_empty());
        assert_eq!(head.headers()[header::CONTENT_LENGTH], "10");

        let post = respond(&method(Method::POST, &file, None), ORIGIN, served);
        assert_eq!(post.status(), StatusCode::METHOD_NOT_ALLOWED);

        let folder = respond(&get(&root, None), ORIGIN, served);
        assert_eq!(folder.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn what_is_not_served_is_refused_whether_or_not_it_exists() {
        let (_dir, root) = folder();
        let (_other, elsewhere) = folder();
        let served = |real: &Path| real.starts_with(&root);
        for path in [elsewhere.join("notes.txt"), elsewhere.join("missing.txt")] {
            let response = respond(&get(&path, None), ORIGIN, served);
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{path:?}");
            assert!(response.body().is_empty());
        }
        let up = root
            .join("..")
            .join(elsewhere.file_name().unwrap())
            .join("notes.txt");
        let response = respond(&get(&up, None), ORIGIN, served);
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "`..` leads out");
    }

    #[cfg(unix)]
    #[test]
    fn a_link_is_judged_by_where_it_leads() {
        let (_dir, root) = folder();
        let (_other, elsewhere) = folder();
        std::os::unix::fs::symlink(elsewhere.join("notes.txt"), root.join("innocent.txt")).unwrap();
        let served = |real: &Path| real.starts_with(&root);
        let response = respond(&get(&root.join("innocent.txt"), None), ORIGIN, served);
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}
