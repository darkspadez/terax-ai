//! A project's `TERAX.md`: instructions Terax adds to every AI run in the project (the system
//! prompt's project section), used only through the shared project trust. It is an
//! `ItemKind::TeraxMd` item whose inspector shows its size, line count and first lines, hashed by
//! content, so a change asks again. There is no size limit: the model gets the whole allowed
//! file, and a run whose instructions cannot fit the model's context says so.
//!
//! The model gets it only through `project_memory_read`, which reads the file once and checks the
//! decision against the hash of exactly the bytes it returns. Terax's own writes keep an allowed
//! file allowed (`project_trust::keeping_trust`); a change made anywhere else asks again.

use std::io::Read;
use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Webview};

use crate::modules::fs::blocking;
use crate::modules::project_trust::{
    self, item_path, resolve_project, window_project, Inspected, ItemEntry, ItemKind,
};
use crate::modules::skills::frontmatter::clean_text;
use crate::modules::workspace::{Origin, WorkspaceEnv, WorkspaceRegistry};

pub const FILE: &str = "TERAX.md";
const PREVIEW_LINES: usize = 8;
const PREVIEW_LINE_CHARS: usize = 160;
/// The most of one line the preview keeps before cleaning it, so a line of hidden characters
/// costs no more than this.
const PREVIEW_LINE_KEEP: usize = 4 * 1024;
const CHUNK: usize = 64 * 1024;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn not_text() -> String {
    format!("{FILE} is not a text file")
}

fn not_utf8() -> String {
    format!("{FILE} is not UTF-8 text")
}

/// Whether text holds nothing: only whitespace after any byte order marks.
fn is_blank(text: &str) -> bool {
    text.trim_start_matches('\u{feff}').trim().is_empty()
}

/// The text of a TERAX.md's bytes: None when it holds nothing (empty or blank), an error when it
/// cannot be used.
fn text_of(bytes: &[u8]) -> Option<Result<&str, String>> {
    if memchr::memchr(0, bytes).is_some() {
        return Some(Err(not_text()));
    }
    let Ok(text) = std::str::from_utf8(bytes) else {
        return Some(Err(not_utf8()));
    };
    if is_blank(text) {
        return None;
    }
    Some(Ok(text))
}

// ---- Reading it in chunks ----

/// The lines the prompt previews: from the first that is not blank, at most `PREVIEW_LINES`.
#[derive(Default)]
struct Preview {
    lines: Vec<String>,
    /// The start of the current line.
    line: String,
    /// The current line has a character.
    open: bool,
    /// ...that is not whitespace.
    text: bool,
    done: bool,
}

impl Preview {
    fn push(&mut self, c: char) {
        if c == '\n' {
            self.end_line();
            return;
        }
        self.open = true;
        self.text |= !c.is_whitespace();
        if self.line.len() < PREVIEW_LINE_KEEP {
            self.line.push(c);
        }
    }

    fn end_line(&mut self) {
        let line = std::mem::take(&mut self.line);
        let text = std::mem::replace(&mut self.text, false);
        self.open = false;
        if self.lines.is_empty() && !text {
            return;
        }
        self.lines.push(preview_line(&line));
        self.done = self.lines.len() >= PREVIEW_LINES;
    }

    fn finish(mut self) -> String {
        if self.open && !self.done {
            self.end_line();
        }
        self.lines.join("\n").trim_end().to_owned()
    }
}

/// A TERAX.md read once, in chunks: the SHA-256 of all its bytes, its size and line count,
/// whether it is UTF-8 text without NUL bytes, whether it holds anything, and the lines the
/// prompt previews. It never holds more than a chunk and the preview, whatever the file's size.
struct Scan {
    hasher: Sha256,
    len: u64,
    newlines: u64,
    last: Option<u8>,
    nul: bool,
    invalid: bool,
    /// The start of a character the previous chunk cut.
    partial: Vec<u8>,
    /// Nothing but byte order marks so far.
    at_start: bool,
    blank: bool,
    preview: Preview,
}

/// What a scan found.
#[derive(Debug)]
struct Scanned {
    hash: String,
    len: u64,
    /// Why it cannot be used.
    problem: Option<String>,
    /// It holds nothing (empty or blank).
    blank: bool,
    /// Its size and line count, and its first lines.
    entry: ItemEntry,
}

impl Scanned {
    /// Whether the model could be given it.
    fn usable(&self) -> bool {
        self.problem.is_none() && !self.blank
    }
}

impl Scan {
    fn new() -> Self {
        Self {
            hasher: Sha256::new(),
            len: 0,
            newlines: 0,
            last: None,
            nul: false,
            invalid: false,
            partial: Vec::new(),
            at_start: true,
            blank: true,
            preview: Preview::default(),
        }
    }

    #[cfg(test)]
    fn of(bytes: &[u8]) -> Scanned {
        let mut scan = Self::new();
        scan.feed(bytes);
        scan.finish()
    }

    fn read(mut self, reader: &mut impl Read) -> std::io::Result<Scanned> {
        let mut buffer = vec![0u8; CHUNK];
        loop {
            let read = match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => read,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            };
            self.feed(&buffer[..read]);
        }
        Ok(self.finish())
    }

    fn feed(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.hasher.update(bytes);
        self.len += bytes.len() as u64;
        self.newlines += memchr::memchr_iter(b'\n', bytes).count() as u64;
        self.last = bytes.last().copied();
        self.nul |= memchr::memchr(0, bytes).is_some();
        if self.nul || self.invalid {
            return;
        }
        let joined;
        let data: &[u8] = if self.partial.is_empty() {
            bytes
        } else {
            let mut start = std::mem::take(&mut self.partial);
            start.extend_from_slice(bytes);
            joined = start;
            &joined
        };
        match std::str::from_utf8(data) {
            Ok(text) => self.text(text),
            Err(error) => {
                let (valid, rest) = data.split_at(error.valid_up_to());
                if let Ok(text) = std::str::from_utf8(valid) {
                    self.text(text);
                }
                match error.error_len() {
                    Some(_) => self.invalid = true,
                    // A character the chunk cut: it continues in the next one.
                    None => self.partial = rest.to_vec(),
                }
            }
        }
    }

    fn text(&mut self, text: &str) {
        if self.preview.done && !self.blank && !self.at_start {
            return;
        }
        for c in text.chars() {
            if self.at_start {
                if c == '\u{feff}' {
                    continue;
                }
                self.at_start = false;
            }
            self.blank &= c.is_whitespace();
            if !self.preview.done {
                self.preview.push(c);
            } else if !self.blank {
                return;
            }
        }
    }

    fn finish(self) -> Scanned {
        let problem = if self.nul {
            Some(not_text())
        } else if self.invalid || !self.partial.is_empty() {
            Some(not_utf8())
        } else {
            None
        };
        let lines = self.newlines + u64::from(self.len > 0 && self.last != Some(b'\n'));
        Scanned {
            hash: hex(&self.hasher.finalize()),
            len: self.len,
            problem,
            blank: self.blank,
            entry: ItemEntry {
                title: format!(
                    "{} · {lines} {}",
                    size_text(self.len),
                    if lines == 1 { "line" } else { "lines" }
                ),
                detail: self.preview.finish(),
            },
        }
    }
}

/// The regular file at `path`, opened (never a device or a pipe, which could hold the read up).
fn open_file(path: &Path) -> Result<std::fs::File, String> {
    let not_a_file = || format!("{FILE} is not a file");
    if !std::fs::metadata(path)
        .map_err(|e| e.to_string())?
        .is_file()
    {
        return Err(not_a_file());
    }
    project_trust::open_regular(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::InvalidInput {
            not_a_file()
        } else {
            error.to_string()
        }
    })
}

fn scan_file(path: &Path) -> Result<Scanned, String> {
    let mut file = open_file(path)?;
    Scan::new().read(&mut file).map_err(|e| e.to_string())
}

/// A project's TERAX.md as read for the model.
#[derive(Debug)]
enum ForModel {
    /// Its text, with the hash of exactly these bytes.
    Text { hash: String, text: String },
    /// Larger than the caller can send: what it holds, scanned without keeping it.
    TooLarge(Scanned),
}

/// The TERAX.md at `path` (its real path) for the model: its text, or when it is larger than
/// `limit` bytes only what a scan finds. None when it holds nothing.
fn read_file(path: &Path, limit: u64) -> Option<Result<ForModel, String>> {
    let mut file = match open_file(path) {
        Ok(file) => file,
        Err(problem) => return Some(Err(problem)),
    };
    let size = file.metadata().map_or(0, |meta| meta.len());
    let too_large = |file: &mut std::fs::File, read: &[u8]| {
        let mut scan = Scan::new();
        scan.feed(read);
        scan.read(file)
            .map(ForModel::TooLarge)
            .map_err(|e| e.to_string())
    };
    if size > limit {
        return Some(too_large(&mut file, &[]));
    }
    let mut bytes = Vec::with_capacity(size as usize);
    if let Err(error) = (&mut file)
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
    {
        return Some(Err(error.to_string()));
    }
    if bytes.len() as u64 > limit {
        // It grew past the limit while being read.
        return Some(too_large(&mut file, &bytes));
    }
    let hash = hex(&Sha256::digest(&bytes));
    match text_of(&bytes)? {
        Err(problem) => Some(Err(problem)),
        Ok(_) => Some(String::from_utf8(bytes).map_or_else(
            |_| Err(not_utf8()),
            |text| Ok(ForModel::Text { hash, text }),
        )),
    }
}

// ---- The trust prompt ----

fn size_text(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    match bytes {
        0..1024 => format!("{bytes} bytes"),
        1024..1_048_576 => format!("{:.1} KB", bytes as f64 / KB),
        _ => format!("{:.1} MB", bytes as f64 / (KB * KB)),
    }
}

/// A line as the prompt shows it: plain text, without control, bidirectional or zero-width
/// characters, a tab as a space, capped.
fn preview_line(line: &str) -> String {
    clean_text(line)
        .chars()
        .filter(|&c| c != '\n' && c != '\u{2028}' && c != '\u{2029}')
        .map(|c| if c == '\t' { ' ' } else { c })
        .take(PREVIEW_LINE_CHARS)
        .collect()
}

/// The trust prompt's view of a project's TERAX.md (`project_trust::inspect`): its size and line
/// count as the title and its first lines (from the first that is not blank) as the detail,
/// read in chunks, so a file of any size costs a chunk.
pub fn inspect(root: &Path) -> Option<Inspected> {
    let unusable = |problem: String| {
        Some(Inspected {
            kind: ItemKind::TeraxMd,
            path: root.join(FILE),
            hash: Err(problem),
            entries: Vec::new(),
        })
    };
    let real = match item_path(root, ItemKind::TeraxMd)? {
        Ok(real) => real,
        Err(problem) => return unusable(problem),
    };
    let scanned = match scan_file(&real) {
        Ok(scanned) => scanned,
        Err(problem) => return unusable(problem),
    };
    if let Some(problem) = scanned.problem {
        return unusable(problem);
    }
    if scanned.blank {
        return None;
    }
    Some(Inspected {
        kind: ItemKind::TeraxMd,
        path: real,
        hash: Ok(scanned.hash),
        entries: vec![scanned.entry],
    })
}

// ---- What the model gets ----

/// What `project_memory_read` returns: the project's TERAX.md as the user allowed it.
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct ProjectMemory {
    /// Its size in bytes.
    pub size: u64,
    /// Its whole text; None when it is larger than the caller can send, so the run can say it
    /// does not fit instead of failing at the provider.
    pub text: Option<String>,
}

/// What the model gets of the TERAX.md of the project at `root` (a real path): only when the AI's
/// file tools reach it and the user allows exactly the content read; its text, or only its size
/// when it is larger than `limit` bytes.
fn usable_memory(
    root: &Path,
    limit: u64,
    reaches: impl Fn(&Path) -> bool,
    allowed: impl Fn(&str) -> bool,
) -> Option<ProjectMemory> {
    let real = item_path(root, ItemKind::TeraxMd)?.ok()?;
    if !reaches(&real) {
        return None;
    }
    match read_file(&real, limit)?.ok()? {
        ForModel::Text { hash, text } => allowed(&hash).then_some(ProjectMemory {
            size: text.len() as u64,
            text: Some(text),
        }),
        ForModel::TooLarge(scanned) => {
            (scanned.usable() && allowed(&scanned.hash)).then_some(ProjectMemory {
                size: scanned.len,
                text: None,
            })
        }
    }
}

fn window_memory(
    app: &AppHandle,
    window: &str,
    root: &str,
    workspace: Option<WorkspaceEnv>,
    limit: u64,
) -> Option<ProjectMemory> {
    let project = window_project(app, window)?;
    // The page's workspace must be the project the window has open (a `cd` it has not
    // registered yet reads nothing).
    if resolve_project(root, workspace).ok()?.key != project.key {
        return None;
    }
    let registry = app.state::<WorkspaceRegistry>();
    let gates = registry.gates(Origin::Ai);
    usable_memory(
        &project.real,
        limit,
        |path| gates.reaches(path),
        |hash| project_trust::is_allowed(app, &project.key, ItemKind::TeraxMd, hash),
    )
}

/// The TERAX.md of the calling window's project for an AI run working in `root`, while the user
/// allows its current content and the AI's file tools reach it, else None (the run goes on
/// without it). Its whole text, or only its size when it is larger than `limit` bytes (more than
/// the run's model could take). Read on every run, so an answer withdrawn or a change takes
/// effect at once.
#[tauri::command]
pub async fn project_memory_read(
    app: AppHandle,
    webview: Webview,
    root: String,
    workspace: Option<WorkspaceEnv>,
    limit: Option<u64>,
) -> Result<Option<ProjectMemory>, String> {
    let label = webview.label().to_owned();
    blocking(move || {
        Ok(window_memory(
            &app,
            &label,
            &root,
            workspace,
            limit.unwrap_or(u64::MAX),
        ))
    })
    .await
}

// ---- Terax's own changes (`project_trust::keeping_trust`) ----

/// The hash of the TERAX.md at `path` (its real path), read in chunks, and whether it holds
/// nothing (empty or blank).
pub fn held(path: &Path) -> Result<(String, bool), String> {
    let scanned = scan_file(path)?;
    let nothing = scanned.problem.is_none() && scanned.blank;
    Ok((scanned.hash, nothing))
}

/// Whether a TERAX.md with this content holds nothing (empty or blank).
pub fn holds_nothing(content: &[u8]) -> bool {
    text_of(content).is_none()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn project_dir() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        (dir, root)
    }

    /// The prompt's entry for a TERAX.md with this text.
    fn review(text: &str) -> ItemEntry {
        Scan::of(text.as_bytes()).entry
    }

    #[test]
    fn the_inspector_hashes_the_content_and_previews_its_first_lines() {
        let (_dir, root) = project_dir();
        assert!(inspect(&root).is_none(), "no file, nothing to ask");
        std::fs::write(root.join(FILE), "  \n\t\n").unwrap();
        assert!(inspect(&root).is_none(), "a blank file provides nothing");
        std::fs::write(root.join(FILE), "\u{feff}\u{feff}\n \r\n").unwrap();
        assert!(inspect(&root).is_none(), "byte order marks are not content");

        let text = "# Rules\n\nAlways\tuse tabs.\n";
        std::fs::write(root.join(FILE), text).unwrap();
        let item = inspect(&root).unwrap();
        assert_eq!(item.kind, ItemKind::TeraxMd);
        assert_eq!(item.path, root.join(FILE));
        let hash = item.hash.unwrap();
        assert_eq!(hash, hex(&Sha256::digest(text.as_bytes())));
        assert_eq!(
            item.entries,
            vec![ItemEntry {
                title: "26 bytes · 3 lines".into(),
                detail: "# Rules\n\nAlways use tabs.".into(),
            }]
        );

        std::fs::write(root.join(FILE), "# Rules\n\nNever ask.\n").unwrap();
        assert_ne!(
            inspect(&root).unwrap().hash.unwrap(),
            hash,
            "a change asks again"
        );
    }

    #[test]
    fn the_preview_is_plain_text_and_short() {
        let hidden = "a\u{202e}b\u{2066}c\u{200b}d\u{7}e\u{1b}[31mf\u{2028}g\r";
        let text = format!("{hidden}\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
        let entry = review(&text);
        assert_eq!(entry.detail.lines().next(), Some("abcde[31mfg"));
        assert_eq!(entry.detail.lines().count(), PREVIEW_LINES);
        assert_eq!(entry.title, format!("{} bytes · 10 lines", text.len()));
        let long = review(&"x".repeat(3000));
        assert_eq!(long.detail.chars().count(), PREVIEW_LINE_CHARS);
        assert_eq!(long.title, "2.9 KB · 1 line");
        assert_eq!(review("\u{feff}# Title").detail, "# Title");
        assert_eq!(review("\n  \n# Title\n\nBody").detail, "# Title\n\nBody");
        assert_eq!(review("# Title\r\nBody\r\n").detail, "# Title\nBody");
        assert_eq!(
            review("one\n\n\n").detail,
            "one",
            "blank lines at the end go"
        );
        // Hidden characters past what a line keeps leave the preview short, never larger.
        let veiled = format!("{}visible", "\u{200b}".repeat(PREVIEW_LINE_KEEP));
        assert_eq!(review(&veiled).detail, "");
        assert_eq!(review(&format!("{veiled}\nnext")).detail, "\nnext");
    }

    #[test]
    fn a_scan_in_chunks_matches_the_whole_text() {
        // Every split of a text with multi-byte characters (one cut inside a character) reads
        // as the whole text does.
        let text = "\u{feff}é intro\n\n## Règles 🚀\nligne\tdeux\n".repeat(3);
        let whole = Scan::of(text.as_bytes());
        assert!(whole.usable());
        for cut in 0..text.len() {
            let mut scan = Scan::new();
            scan.feed(&text.as_bytes()[..cut]);
            scan.feed(&text.as_bytes()[cut..]);
            let split = scan.finish();
            assert_eq!(split.hash, whole.hash, "cut at {cut}");
            assert_eq!(split.entry, whole.entry, "cut at {cut}");
            assert_eq!((split.problem, split.blank), (None, false), "cut at {cut}");
        }
        let mut scan = Scan::new();
        scan.feed("caf".as_bytes());
        scan.feed(&"é".as_bytes()[..1]);
        assert_eq!(
            scan.finish().problem,
            Some(not_utf8()),
            "cut off at the end"
        );
    }

    #[test]
    fn a_file_of_any_size_is_hashed_and_previewed_without_reading_it_whole() {
        let (_dir, root) = project_dir();
        // Larger than several chunks.
        let line = "Use the project's conventions in every change.\n";
        let text = format!("# Large\n{}", line.repeat(20_000));
        std::fs::write(root.join(FILE), &text).unwrap();
        let item = inspect(&root).unwrap();
        assert_eq!(item.hash.unwrap(), hex(&Sha256::digest(text.as_bytes())));
        assert_eq!(item.entries[0].title, "918.0 KB · 20001 lines");
        assert_eq!(item.entries[0].detail.lines().count(), PREVIEW_LINES);
        assert_eq!(size_text(3 * 1024 * 1024 + 512 * 1024), "3.5 MB");
        let blank = " \n".repeat(100_000);
        std::fs::write(root.join(FILE), &blank).unwrap();
        assert!(inspect(&root).is_none(), "a large blank file holds nothing");
        std::fs::write(root.join(FILE), format!("{blank}x")).unwrap();
        assert!(inspect(&root).is_some(), "...until its last byte");
    }

    #[test]
    fn what_cannot_be_used_is_listed_with_the_reason() {
        let (_dir, root) = project_dir();
        let problem = |root: &Path| inspect(root).unwrap().hash.unwrap_err();
        std::fs::write(root.join(FILE), b"caf\xe9").unwrap();
        assert!(problem(&root).contains("not UTF-8"));
        let mut late = "x".repeat(CHUNK * 2).into_bytes();
        late.push(0xff);
        std::fs::write(root.join(FILE), &late).unwrap();
        assert!(problem(&root).contains("not UTF-8"), "past the first chunk");
        std::fs::write(root.join(FILE), b"text\0more").unwrap();
        assert!(problem(&root).contains("not a text file"));
        std::fs::remove_file(root.join(FILE)).unwrap();
        std::fs::create_dir(root.join(FILE)).unwrap();
        assert!(problem(&root).contains("not a file"));
        std::fs::remove_dir(root.join(FILE)).unwrap();
        #[cfg(unix)]
        {
            let (_outside, elsewhere) = project_dir();
            std::fs::write(elsewhere.join("notes.md"), "rules").unwrap();
            std::os::unix::fs::symlink(elsewhere.join("notes.md"), root.join(FILE)).unwrap();
            assert!(problem(&root).contains("outside the project"));
            std::fs::remove_file(root.join(FILE)).unwrap();
            std::fs::create_dir(root.join("docs")).unwrap();
            std::fs::write(root.join("docs/AGENTS.md"), "rules").unwrap();
            std::os::unix::fs::symlink(root.join("docs/AGENTS.md"), root.join(FILE)).unwrap();
            let item = inspect(&root).unwrap();
            assert_eq!(
                item.path,
                root.join("docs/AGENTS.md"),
                "a link inside is fine"
            );
            assert!(item.hash.is_ok());
            // A pipe is never opened, so it cannot hold the read up.
            std::fs::remove_file(root.join(FILE)).unwrap();
            let fifo = std::ffi::CString::new(root.join(FILE).to_str().unwrap()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
            assert!(problem(&root).contains("not a file"));
        }
    }

    #[test]
    fn the_model_gets_exactly_the_allowed_content_whatever_its_size() {
        let (_dir, root) = project_dir();
        let reaches = |_: &Path| true;
        let memory =
            |limit, allowed: &dyn Fn(&str) -> bool| usable_memory(&root, limit, reaches, allowed);
        assert_eq!(memory(u64::MAX, &|_| true), None, "none");

        std::fs::write(root.join(FILE), "# Rules").unwrap();
        let hash = hex(&Sha256::digest(b"# Rules"));
        let allowed = |h: &str| h == hash;
        assert_eq!(
            memory(u64::MAX, &allowed),
            Some(ProjectMemory {
                size: 7,
                text: Some("# Rules".into())
            })
        );
        assert_eq!(
            memory(u64::MAX, &|_| false),
            None,
            "not allowed (or declined, or revoked)"
        );
        assert_eq!(
            usable_memory(&root, u64::MAX, |_| false, allowed),
            None,
            "outside the folders the AI may read"
        );
        std::fs::write(root.join(FILE), "# Rules, changed").unwrap();
        assert_eq!(
            memory(u64::MAX, &allowed),
            None,
            "changed since it was allowed"
        );

        // No size limit: a large file reaches the model whole.
        let large = format!("# Large\n{}", "rule\n".repeat(200_000));
        std::fs::write(root.join(FILE), &large).unwrap();
        let large_hash = hex(&Sha256::digest(large.as_bytes()));
        let allowed = |h: &str| h == large_hash;
        let whole = memory(u64::MAX, &allowed).unwrap();
        assert_eq!(whole.text.as_deref(), Some(large.as_str()));
        assert_eq!(whole.size, large.len() as u64);
        // Larger than the run's model could take: only its size, still only while allowed.
        assert_eq!(
            memory(1024, &allowed),
            Some(ProjectMemory {
                size: large.len() as u64,
                text: None
            })
        );
        assert_eq!(memory(1024, &|_| false), None);
        assert_eq!(
            memory(large.len() as u64, &allowed)
                .unwrap()
                .text
                .as_deref(),
            Some(large.as_str()),
            "the limit itself fits"
        );
        let mut unusable = large.clone().into_bytes();
        unusable.push(0);
        std::fs::write(root.join(FILE), &unusable).unwrap();
        assert_eq!(memory(1024, &|_| true), None, "not text, so never sent");
        assert_eq!(memory(u64::MAX, &|_| true), None);
        std::fs::write(root.join(FILE), " \n".repeat(4096)).unwrap();
        assert_eq!(memory(1024, &|_| true), None, "blank");
        assert_eq!(memory(u64::MAX, &|_| true), None);
    }

    #[test]
    fn what_it_holds_for_terax_s_own_changes() {
        let (_dir, root) = project_dir();
        let path = root.join(FILE);
        std::fs::write(&path, "\u{feff} \n").unwrap();
        assert_eq!(
            held(&path).unwrap(),
            (hex(&Sha256::digest("\u{feff} \n".as_bytes())), true),
            "blank holds nothing"
        );
        std::fs::write(&path, "# Rules").unwrap();
        assert_eq!(
            held(&path).unwrap(),
            (hex(&Sha256::digest(b"# Rules")), false)
        );
        std::fs::write(&path, b"# Rules\0").unwrap();
        assert_eq!(
            held(&path).unwrap(),
            (hex(&Sha256::digest(b"# Rules\0")), false),
            "content that cannot be used is still content"
        );
        assert!(holds_nothing(b""));
        assert!(holds_nothing("\u{feff}\t\r\n".as_bytes()));
        assert!(!holds_nothing(b"# New"));
        assert!(!holds_nothing(b"\0"));
        assert!(!holds_nothing(b"\xff"));
    }
}
