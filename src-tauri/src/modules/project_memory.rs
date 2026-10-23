//! A project's `TERAX.md`: instructions Terax adds to every AI run in the project (the system
//! prompt's project section), used only through the shared project trust. It is an
//! `ItemKind::TeraxMd` item whose inspector shows its size, line count and first lines, hashed by
//! content, so a change asks again.
//!
//! The model gets it only through `project_memory_read`, which reads the file once and checks the
//! decision against the hash of exactly the bytes it returns. Terax's own writes keep an allowed
//! file allowed (`write_keeping_trust`, called by `fs_write_file`); a change made anywhere else
//! asks again.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Webview};

use crate::modules::fs::blocking;
use crate::modules::project_trust::{
    self, item_path, open_projects, resolve_project, window_project, Inspected, ItemEntry,
    ItemKind, OpenProject,
};
use crate::modules::skills::frontmatter::clean_text;
use crate::modules::workspace::{Origin, WorkspaceEnv, WorkspaceRegistry};

pub const FILE: &str = "TERAX.md";
/// The most Terax sends the model; a larger file is not used at all.
pub const MAX_BYTES: u64 = 32 * 1024;
const PREVIEW_LINES: usize = 8;
const PREVIEW_LINE_CHARS: usize = 160;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The text of a TERAX.md's bytes: None when it holds nothing (empty or blank), an error when it
/// cannot be used.
fn text_of(bytes: &[u8]) -> Option<Result<&str, String>> {
    if bytes.len() as u64 > MAX_BYTES {
        return Some(Err(too_large()));
    }
    if bytes.contains(&0) {
        return Some(Err(format!("{FILE} is not a text file")));
    }
    let Ok(text) = std::str::from_utf8(bytes) else {
        return Some(Err(format!("{FILE} is not UTF-8 text")));
    };
    if text.trim_start_matches('\u{feff}').trim().is_empty() {
        return None;
    }
    Some(Ok(text))
}

fn too_large() -> String {
    format!(
        "{FILE} is larger than {} KB, more than Terax sends the AI",
        MAX_BYTES / 1024
    )
}

/// A project's TERAX.md as read once: its text and the hash of exactly these bytes.
#[derive(Debug)]
pub struct Memory {
    /// Its real path.
    pub path: PathBuf,
    pub hash: String,
    pub text: String,
}

/// The TERAX.md of the project at `root` (a real path), or why it cannot be used. None when the
/// project has none, or one that holds nothing.
pub fn read(root: &Path) -> Option<Result<Memory, String>> {
    let real = match item_path(root, ItemKind::TeraxMd)? {
        Ok(real) => real,
        Err(problem) => return Some(Err(problem)),
    };
    let bytes = match read_capped(&real) {
        Ok(bytes) => bytes,
        Err(problem) => return Some(Err(problem)),
    };
    let text = match text_of(&bytes)? {
        Ok(text) => text.to_owned(),
        Err(problem) => return Some(Err(problem)),
    };
    Some(Ok(Memory {
        path: real,
        hash: hex(&Sha256::digest(&bytes)),
        text,
    }))
}

/// The file's bytes, at most one more than the cap (so a file that grew meanwhile still reads as
/// too large).
fn read_capped(path: &Path) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err(format!("{FILE} is not a file"));
    }
    if meta.len() > MAX_BYTES {
        return Err(too_large());
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    std::fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}

// ---- The trust prompt ----

fn size_text(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{bytes} bytes")
    } else {
        format!("{:.1} KB", bytes as f64 / 1024.0)
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

/// What the prompt lists for a TERAX.md: one entry, its size and line count as the title and its
/// first lines (from the first that is not blank) as the detail.
pub fn review(text: &str) -> ItemEntry {
    let lines = text.lines().count();
    let preview: Vec<String> = text
        .trim_start_matches('\u{feff}')
        .lines()
        .skip_while(|line| line.trim().is_empty())
        .take(PREVIEW_LINES)
        .map(preview_line)
        .collect();
    ItemEntry {
        title: format!(
            "{} · {lines} {}",
            size_text(text.len()),
            if lines == 1 { "line" } else { "lines" }
        ),
        detail: preview.join("\n").trim_end().to_owned(),
    }
}

/// The trust prompt's view of a project's TERAX.md (`project_trust::inspect`).
pub fn inspect(root: &Path) -> Option<Inspected> {
    match read(root)? {
        Err(problem) => Some(Inspected {
            kind: ItemKind::TeraxMd,
            path: root.join(FILE),
            hash: Err(problem),
            entries: Vec::new(),
        }),
        Ok(memory) => Some(Inspected {
            kind: ItemKind::TeraxMd,
            entries: vec![review(&memory.text)],
            path: memory.path,
            hash: Ok(memory.hash),
        }),
    }
}

// ---- What the model gets ----

/// The text of `memory` for the model: only when the AI's file tools reach it and the user allows
/// exactly the content read.
fn usable_text(
    memory: Option<Result<Memory, String>>,
    reaches: impl Fn(&Path) -> bool,
    allowed: impl Fn(&str) -> bool,
) -> Option<String> {
    let memory = memory?.ok()?;
    (reaches(&memory.path) && allowed(&memory.hash)).then_some(memory.text)
}

fn window_memory(
    app: &AppHandle,
    window: &str,
    root: &str,
    workspace: Option<WorkspaceEnv>,
) -> Option<String> {
    let project = window_project(app, window)?;
    // The page's workspace must be the project the window has open (a `cd` it has not
    // registered yet reads nothing).
    if resolve_project(root, workspace).ok()?.key != project.key {
        return None;
    }
    let registry = app.state::<WorkspaceRegistry>();
    let gates = registry.gates(Origin::Ai);
    usable_text(
        read(&project.real),
        |path| gates.reaches(path),
        |hash| project_trust::is_allowed(app, &project.key, ItemKind::TeraxMd, hash),
    )
}

/// The TERAX.md of the calling window's project for an AI run working in `root`: its text while
/// the user allows its current content and the AI's file tools reach it, else None (the run goes
/// on without it). Read on every run, so an answer withdrawn or a change takes effect at once.
#[tauri::command]
pub async fn project_memory_read(
    app: AppHandle,
    webview: Webview,
    root: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<Option<String>, String> {
    let label = webview.label().to_owned();
    blocking(move || Ok(window_memory(&app, &label, &root, workspace))).await
}

// ---- Terax's own writes ----

/// What a project's TERAX.md held before Terax wrote it.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Before {
    /// No file, or one that held nothing.
    Nothing,
    /// Content with this hash.
    Content(String),
    /// Content that could not be used: never allowed, so the write keeps nothing.
    Unusable,
}

impl Before {
    fn of(root: &Path) -> Self {
        match read(root) {
            None => Before::Nothing,
            Some(Ok(memory)) => Before::Content(memory.hash),
            Some(Err(_)) => Before::Unusable,
        }
    }

    /// The hash the user must have allowed for the write to keep the trust (None: nothing to
    /// have allowed), or None overall when the write keeps nothing.
    fn previous(&self) -> Option<Option<&str>> {
        match self {
            Before::Nothing => Some(None),
            Before::Content(hash) => Some(Some(hash)),
            Before::Unusable => None,
        }
    }
}

/// The hash a TERAX.md with this content is allowed under, when such a file can be used.
fn usable_hash(content: &[u8]) -> Option<String> {
    text_of(content)?.ok()?;
    Some(hex(&Sha256::digest(content)))
}

/// Whether `target` (a real path, as the write gates return it) is the TERAX.md of the project at
/// `root`: the item's real path, or where it would be created.
fn is_memory_of(root: &Path, target: &Path) -> bool {
    match item_path(root, ItemKind::TeraxMd) {
        Some(Ok(real)) => real == target,
        Some(Err(_)) => false,
        None => root.join(FILE) == target,
    }
}

/// Serializes Terax's own TERAX.md writes, so each one sees what the previous one recorded.
fn write_lock() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Runs `write`, Terax's own write of `content` to `target` (a real path: `fs_write_file`, which
/// serves the editor's save and the AI's file writes, every one approved or run under
/// Auto-approve). When `target` is the TERAX.md of a project a window has open, and the user
/// allowed what it held (or it held nothing), the content written is allowed too, so Terax's own
/// edit does not ask again. Decided here from the file itself, never on the page's word: no
/// command marks content allowed, and a change made outside this write (git, another editor, a
/// shell command, a move or copy onto the file) still asks.
pub fn write_keeping_trust<T, E>(
    app: &AppHandle,
    target: &Path,
    content: &[u8],
    write: impl FnOnce() -> Result<T, E>,
) -> Result<T, E> {
    if app
        .try_state::<project_trust::ProjectTrustState>()
        .is_none()
    {
        return write();
    }
    keeping_trust(
        open_projects(app),
        target,
        content,
        write,
        |project, previous, hash| {
            if let Err(error) =
                project_trust::allow_own_write(app, project, ItemKind::TeraxMd, previous, hash)
            {
                log::warn!("could not keep the trust of {}: {error}", target.display());
            }
        },
    )
}

/// `write_keeping_trust` over the open projects: `allow` is asked to allow the content written
/// for each project whose TERAX.md `target` is, with the hash it was allowed with before (None:
/// it held nothing), once the write succeeded.
fn keeping_trust<T, E>(
    open: Vec<OpenProject>,
    target: &Path,
    content: &[u8],
    write: impl FnOnce() -> Result<T, E>,
    mut allow: impl FnMut(&OpenProject, Option<&str>, &str),
) -> Result<T, E> {
    let projects: Vec<OpenProject> = open
        .into_iter()
        .filter(|project| target.starts_with(&project.real) && is_memory_of(&project.real, target))
        .collect();
    if projects.is_empty() {
        return write();
    }
    let _serial = write_lock();
    let before: Vec<(OpenProject, Before)> = projects
        .into_iter()
        .map(|project| {
            let before = Before::of(&project.real);
            (project, before)
        })
        .collect();
    let written = write()?;
    let Some(hash) = usable_hash(content) else {
        return Ok(written);
    };
    for (project, before) in &before {
        if let Some(previous) = before.previous() {
            allow(project, previous, &hash);
        }
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project_dir() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        (dir, root)
    }

    #[test]
    fn the_inspector_hashes_the_content_and_previews_its_first_lines() {
        let (_dir, root) = project_dir();
        assert!(inspect(&root).is_none(), "no file, nothing to ask");
        std::fs::write(root.join(FILE), "  \n\t\n").unwrap();
        assert!(inspect(&root).is_none(), "a blank file provides nothing");

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
    }

    #[test]
    fn what_cannot_be_used_is_listed_with_the_reason() {
        let (_dir, root) = project_dir();
        let problem = |root: &Path| inspect(root).unwrap().hash.unwrap_err();
        std::fs::write(root.join(FILE), vec![b'a'; MAX_BYTES as usize + 1]).unwrap();
        assert!(problem(&root).contains("larger than 32 KB"));
        std::fs::write(root.join(FILE), vec![b'a'; MAX_BYTES as usize]).unwrap();
        assert!(
            inspect(&root).unwrap().hash.is_ok(),
            "the cap itself is fine"
        );
        std::fs::write(root.join(FILE), b"caf\xe9").unwrap();
        assert!(problem(&root).contains("not UTF-8"));
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
        }
    }

    #[test]
    fn the_model_gets_exactly_the_allowed_content() {
        let (_dir, root) = project_dir();
        let reaches = |_: &Path| true;
        assert_eq!(usable_text(read(&root), reaches, |_| true), None, "none");

        std::fs::write(root.join(FILE), "# Rules").unwrap();
        let hash = read(&root).unwrap().unwrap().hash;
        let allowed = |h: &str| h == hash;
        assert_eq!(
            usable_text(read(&root), reaches, allowed).as_deref(),
            Some("# Rules")
        );
        assert_eq!(
            usable_text(read(&root), reaches, |_| false),
            None,
            "not allowed (or declined, or revoked)"
        );
        assert_eq!(
            usable_text(read(&root), |_| false, allowed),
            None,
            "outside the folders the AI may read"
        );
        std::fs::write(root.join(FILE), "# Rules, changed").unwrap();
        assert_eq!(
            usable_text(read(&root), reaches, allowed),
            None,
            "changed since it was allowed"
        );
        std::fs::write(root.join(FILE), vec![b'a'; MAX_BYTES as usize + 1]).unwrap();
        assert_eq!(usable_text(read(&root), reaches, |_| true), None);
    }

    #[test]
    fn a_write_keeps_the_trust_only_of_content_allowed_or_absent() {
        let (_dir, root) = project_dir();
        assert_eq!(Before::of(&root), Before::Nothing);
        assert_eq!(Before::of(&root).previous(), Some(None));
        std::fs::write(root.join(FILE), "\n").unwrap();
        assert_eq!(Before::of(&root), Before::Nothing, "blank holds nothing");
        std::fs::write(root.join(FILE), "# Rules").unwrap();
        let before = Before::of(&root);
        let hash = hex(&Sha256::digest(b"# Rules"));
        assert_eq!(before, Before::Content(hash.clone()));
        assert_eq!(before.previous(), Some(Some(hash.as_str())));
        std::fs::write(root.join(FILE), b"\xff").unwrap();
        assert_eq!(Before::of(&root), Before::Unusable);
        assert_eq!(Before::Unusable.previous(), None);

        assert_eq!(usable_hash(b"# New"), Some(hex(&Sha256::digest(b"# New"))));
        assert_eq!(usable_hash(b"  \n"), None, "nothing to allow");
        assert_eq!(usable_hash(b"\xff"), None);
        assert_eq!(usable_hash(&vec![b'a'; MAX_BYTES as usize + 1]), None);
    }

    #[test]
    fn only_a_project_s_own_terax_md_is_its_item() {
        let (_dir, root) = project_dir();
        assert!(is_memory_of(&root, &root.join(FILE)), "to be created");
        assert!(!is_memory_of(&root, &root.join("sub").join(FILE)));
        assert!(!is_memory_of(&root, &root.join("README.md")));
        std::fs::write(root.join(FILE), "x").unwrap();
        assert!(is_memory_of(&root, &root.join(FILE)));
        #[cfg(unix)]
        {
            std::fs::remove_file(root.join(FILE)).unwrap();
            std::fs::create_dir(root.join("docs")).unwrap();
            std::fs::write(root.join("docs/AGENTS.md"), "rules").unwrap();
            std::os::unix::fs::symlink(root.join("docs/AGENTS.md"), root.join(FILE)).unwrap();
            assert!(
                is_memory_of(&root, &root.join("docs/AGENTS.md")),
                "a write through the link lands in the item"
            );
            assert!(!is_memory_of(&root, &root.join(FILE)));
        }
    }

    fn open(root: &Path) -> OpenProject {
        OpenProject {
            real: root.to_path_buf(),
            key: root.to_string_lossy().into_owned(),
            root: root.to_string_lossy().into_owned(),
            workspace: WorkspaceEnv::Local,
        }
    }

    /// What `keeping_trust` asked to allow: the project's key, the previous hash, the new one.
    type Asked = Vec<(String, Option<String>, String)>;

    /// Writes `content` to `target` as `fs_write_file` does, through `keeping_trust`, and
    /// returns what it asked to allow.
    fn write_through(
        projects: Vec<OpenProject>,
        target: &Path,
        content: &str,
    ) -> (std::io::Result<()>, Asked) {
        let mut asked = Vec::new();
        let result = keeping_trust(
            projects,
            target,
            content.as_bytes(),
            || std::fs::write(target, content),
            |project, previous, hash| {
                asked.push((
                    project.key.clone(),
                    previous.map(str::to_owned),
                    hash.to_owned(),
                ))
            },
        );
        (result, asked)
    }

    #[test]
    fn terax_s_write_asks_to_keep_the_trust_of_what_it_replaced() {
        let (_dir, root) = project_dir();
        let key = root.to_string_lossy().into_owned();
        let target = root.join(FILE);
        let hash = |text: &str| hex(&Sha256::digest(text.as_bytes()));

        let (result, asked) = write_through(vec![open(&root)], &target, "# Created");
        assert!(result.is_ok());
        assert_eq!(asked, vec![(key.clone(), None, hash("# Created"))]);

        let (_, asked) = write_through(vec![open(&root)], &target, "# Edited");
        assert_eq!(
            asked,
            vec![(key.clone(), Some(hash("# Created")), hash("# Edited"))]
        );

        let (_, asked) = write_through(vec![open(&root)], &target, "   ");
        assert!(asked.is_empty(), "a blank file has nothing to allow");
        let (_, asked) = write_through(vec![open(&root)], &target, &"a".repeat(40_000));
        assert!(asked.is_empty(), "too large to use");
        let (_, asked) = write_through(vec![open(&root)], &target, "# Usable again");
        assert!(
            asked.is_empty(),
            "what it replaced could not be used, so it was never allowed"
        );

        let (_, asked) = write_through(vec![open(&root)], &root.join("NOTES.md"), "# Notes");
        assert!(asked.is_empty(), "not the project's TERAX.md");
        let (_, asked) = write_through(Vec::new(), &target, "# No window");
        assert!(asked.is_empty(), "no window has the project open");

        let mut asked = Vec::new();
        let failed: Result<(), &str> = keeping_trust(
            vec![open(&root)],
            &target,
            b"# Never written",
            || Err("disk full"),
            |project, _, _| asked.push(project.key.clone()),
        );
        assert_eq!(failed, Err("disk full"));
        assert!(asked.is_empty(), "a failed write keeps nothing");
    }
}
