//! Project trust: content a project folder provides that Terax uses only after the user allows
//! it (its `TERAX.md` instructions, its skills, its `.mcp.json` MCP servers). A project is a
//! workspace root a window has
//! open. Each kind of content is an `ItemKind`; for each project the user's decision on each item
//! is kept with the content hash it was made for, so a change asks again. One prompt lists
//! everything a project provides, and Settings revokes a decision.
//!
//! Adding a kind of item: a variant of `ItemKind` with its path and label, its inspector in
//! `inspect` (what it holds, its hash and the entries the prompt lists), and a call to
//! `is_allowed` with the current hash wherever the content is used.

use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use crate::modules::fs::{blocking, to_canon};
use crate::modules::workspace::{resolve_path, WorkspaceEnv};

/// Sent to every window when a decision is made or revoked, or a window opens or leaves a
/// project.
pub const CHANGED_EVENT: &str = "project-trust:changed";
const FILE_NAME: &str = "project-trust.json";

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum ItemKind {
    TeraxMd,
    ClaudeSkills,
    TeraxSkills,
    McpJson,
}

impl ItemKind {
    pub const ALL: [ItemKind; 4] = [
        ItemKind::TeraxMd,
        ItemKind::ClaudeSkills,
        ItemKind::TeraxSkills,
        ItemKind::McpJson,
    ];
    /// The kinds that hold skills.
    pub const SKILLS: [ItemKind; 2] = [ItemKind::ClaudeSkills, ItemKind::TeraxSkills];

    /// The key a decision is stored under.
    pub fn id(self) -> &'static str {
        match self {
            ItemKind::TeraxMd => "terax-md",
            ItemKind::ClaudeSkills => "claude-skills",
            ItemKind::TeraxSkills => "terax-skills",
            ItemKind::McpJson => "mcp-json",
        }
    }

    fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.id() == id)
    }

    /// Where the item lives below the project root, `/`-separated.
    pub fn relative_path(self) -> &'static str {
        match self {
            ItemKind::TeraxMd => crate::modules::project_memory::FILE,
            ItemKind::ClaudeSkills => ".claude/skills",
            ItemKind::TeraxSkills => ".terax/skills",
            ItemKind::McpJson => crate::modules::mcp::project::FILE,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ItemKind::TeraxMd => "Instructions in TERAX.md",
            ItemKind::ClaudeSkills => "Skills in .claude/skills",
            ItemKind::TeraxSkills => "Skills in .terax/skills",
            ItemKind::McpJson => "MCP servers in .mcp.json",
        }
    }
}

/// One thing an item provides, as the prompt lists it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ItemEntry {
    pub title: String,
    pub detail: String,
}

/// What an item of a project holds right now.
#[derive(Debug)]
pub struct Inspected {
    pub kind: ItemKind,
    /// The item's real path.
    pub path: PathBuf,
    /// Its content hash, or why it cannot be reviewed (and so never trusted).
    pub hash: Result<String, String>,
    pub entries: Vec<ItemEntry>,
}

/// What `kind` holds in the project at `root` (a real path), or None when the project has none.
pub fn inspect(root: &Path, kind: ItemKind) -> Option<Inspected> {
    match kind {
        ItemKind::TeraxMd => crate::modules::project_memory::inspect(root),
        ItemKind::ClaudeSkills | ItemKind::TeraxSkills => {
            crate::modules::skills::inspect_project_item(root, kind)
        }
        ItemKind::McpJson => crate::modules::mcp::project::inspect(root),
    }
}

/// The real path of an item below `root` (a folder or a file), if present: refused (Err) when a
/// link takes it out of the project.
pub fn item_path(root: &Path, kind: ItemKind) -> Option<Result<PathBuf, String>> {
    let path = kind
        .relative_path()
        .split('/')
        .fold(root.to_path_buf(), |path, part| path.join(part));
    std::fs::symlink_metadata(&path).ok()?;
    let real = match std::fs::canonicalize(&path) {
        Ok(real) => real,
        Err(error) => return Some(Err(error.to_string())),
    };
    if !real.starts_with(root) {
        return Some(Err(format!(
            "{} links outside the project",
            kind.relative_path()
        )));
    }
    Some(Ok(real))
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Decision {
    allowed: bool,
    hash: String,
    /// Seconds since the Unix epoch.
    at: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
struct ProjectRecord {
    /// The root as the window spelled it.
    display: String,
    /// Kept by item id, so a kind this version does not know survives a save.
    #[serde(default)]
    items: BTreeMap<String, Decision>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
struct TrustFile {
    #[serde(default)]
    projects: BTreeMap<String, ProjectRecord>,
}

/// A project a window has open.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenProject {
    /// The real root, the key of its trust record.
    #[serde(skip)]
    pub real: PathBuf,
    pub key: String,
    /// The root as the window spells it (a WSL path in a WSL window).
    pub root: String,
    pub workspace: WorkspaceEnv,
}

impl OpenProject {
    /// `relative` below the root, spelled as the window spells the root.
    pub fn display_path(&self, relative: &str) -> String {
        join_display(&self.root, relative)
    }
}

pub fn join_display(base: &str, relative: &str) -> String {
    if relative.is_empty() {
        base.to_owned()
    } else if base.ends_with('/') || base.ends_with('\\') {
        format!("{base}{relative}")
    } else {
        format!("{base}/{relative}")
    }
}

/// The project a window names: its real root must be an existing folder.
pub fn resolve_project(root: &str, workspace: Option<WorkspaceEnv>) -> Result<OpenProject, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let real = std::fs::canonicalize(resolve_path(root, &workspace))
        .map_err(|e| format!("project folder not accessible: {e}"))?;
    if !real.is_dir() {
        return Err(format!("not a folder: {root}"));
    }
    Ok(OpenProject {
        key: to_canon(&real),
        real,
        root: root.to_owned(),
        workspace,
    })
}

#[derive(Default)]
pub struct ProjectTrustState {
    file: Mutex<Option<TrustFile>>,
    open: Mutex<HashMap<String, OpenProject>>,
}

impl ProjectTrustState {
    fn open_lock(&self) -> MutexGuard<'_, HashMap<String, OpenProject>> {
        self.open.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Forgets the project a window had open (it reloaded or closed). True when one was open.
    pub fn release_window(&self, label: &str) -> bool {
        self.open_lock().remove(label).is_some()
    }
}

/// A window reloaded or closed: the project it had open is no longer watched for it. Called on
/// the main thread, so the watch is updated on a blocking worker.
pub fn release_window(app: &AppHandle, label: &str) {
    let released = app
        .try_state::<ProjectTrustState>()
        .is_some_and(|state| state.release_window(label));
    if released {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::modules::skills::open_projects_changed(&app);
            let _ = app.emit(CHANGED_EVENT, ());
        });
    }
}

/// The project a window has open, if it registered one.
pub fn window_project(app: &AppHandle, label: &str) -> Option<OpenProject> {
    app.try_state::<ProjectTrustState>()?
        .open_lock()
        .get(label)
        .cloned()
}

/// The projects windows have open, each once.
pub fn open_projects(app: &AppHandle) -> Vec<OpenProject> {
    let state = app.state::<ProjectTrustState>();
    let open = state.open_lock();
    let mut seen = std::collections::HashSet::new();
    let mut projects: Vec<OpenProject> = open
        .values()
        .filter(|project| seen.insert(project.key.clone()))
        .cloned()
        .collect();
    projects.sort_by(|a, b| a.key.cmp(&b.key));
    projects
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(FILE_NAME))
}

/// Reads the store; a damaged or unreadable one reads as empty, so every project asks again.
fn load(path: &Path) -> TrustFile {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
            log::warn!("project trust store unreadable, starting over: {error}");
            TrustFile::default()
        }),
        Err(_) => TrustFile::default(),
    }
}

fn save(path: &Path, file: &TrustFile) -> Result<(), String> {
    let parent = path.parent().ok_or("missing app data folder")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(file).map_err(|e| e.to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    std::io::Write::write_all(&mut temporary, &bytes).map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    temporary.persist(path).map_err(|e| e.error.to_string())?;
    Ok(())
}

fn with_file<T>(app: &AppHandle, f: impl FnOnce(&mut TrustFile) -> T) -> Result<T, String> {
    let path = store_path(app)?;
    let state = app.state::<ProjectTrustState>();
    let mut guard = state.file.lock().unwrap_or_else(|e| e.into_inner());
    let file = guard.get_or_insert_with(|| load(&path));
    Ok(f(file))
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Whether the user allowed `kind` of the project `key` with exactly this content.
pub fn is_allowed(app: &AppHandle, key: &str, kind: ItemKind, hash: &str) -> bool {
    with_file(app, |file| decided(file, key, kind, hash) == Some(true)).unwrap_or(false)
}

/// The state of an item of the project `key` whose content hash (or problem) is `hash`.
pub fn decision_state(
    app: &AppHandle,
    key: &str,
    kind: ItemKind,
    hash: &Result<String, String>,
) -> ItemState {
    with_file(app, |file| item_state(file, key, kind, hash)).unwrap_or(ItemState::Pending)
}

/// The decision on this content, if one was made for it.
fn decided(file: &TrustFile, key: &str, kind: ItemKind, hash: &str) -> Option<bool> {
    file.projects
        .get(key)?
        .items
        .get(kind.id())
        .filter(|decision| decision.hash == hash)
        .map(|decision| decision.allowed)
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ItemState {
    /// Allowed for this content.
    Allowed,
    /// Declined for this content.
    Denied,
    /// Never decided.
    Pending,
    /// Decided for other content: the item changed since.
    Changed,
    /// Cannot be reviewed (too large, a link out of the project): never used.
    Unreviewable,
}

impl ItemState {
    /// Whether the prompt asks about it.
    pub fn asks(self) -> bool {
        matches!(self, ItemState::Pending | ItemState::Changed)
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ItemStatus {
    pub kind: ItemKind,
    pub label: &'static str,
    pub path: String,
    pub hash: Option<String>,
    pub problem: Option<String>,
    pub entries: Vec<ItemEntry>,
    pub state: ItemState,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatus {
    pub project: OpenProject,
    pub items: Vec<ItemStatus>,
}

fn item_state(
    file: &TrustFile,
    key: &str,
    kind: ItemKind,
    hash: &Result<String, String>,
) -> ItemState {
    let Ok(hash) = hash else {
        return ItemState::Unreviewable;
    };
    let decision = file
        .projects
        .get(key)
        .and_then(|record| record.items.get(kind.id()));
    match decision {
        None => ItemState::Pending,
        Some(decision) if decision.hash != *hash => ItemState::Changed,
        Some(decision) if decision.allowed => ItemState::Allowed,
        Some(_) => ItemState::Denied,
    }
}

/// Every item the project provides, with its state.
pub fn status(app: &AppHandle, project: &OpenProject) -> Result<ProjectStatus, String> {
    let inspected: Vec<Inspected> = ItemKind::ALL
        .into_iter()
        .filter_map(|kind| inspect(&project.real, kind))
        .collect();
    with_file(app, |file| ProjectStatus {
        project: project.clone(),
        items: inspected
            .into_iter()
            .map(|item| ItemStatus {
                kind: item.kind,
                label: item.kind.label(),
                path: project.display_path(item.kind.relative_path()),
                state: item_state(file, &project.key, item.kind, &item.hash),
                problem: item.hash.as_ref().err().cloned(),
                hash: item.hash.ok(),
                entries: item.entries,
            })
            .collect(),
    })
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DecisionInput {
    pub kind: ItemKind,
    /// The hash the user saw.
    pub hash: String,
    pub allow: bool,
}

/// Records decisions, each only for the content the user saw: a decision whose hash is no
/// longer the item's fails them all, so the prompt shows the new content.
fn apply_decisions(
    file: &mut TrustFile,
    project: &OpenProject,
    current: &HashMap<ItemKind, Result<String, String>>,
    decisions: &[DecisionInput],
    at: u64,
) -> Result<(), String> {
    for decision in decisions {
        match current.get(&decision.kind) {
            Some(Ok(hash)) if *hash == decision.hash => {}
            Some(Err(problem)) => return Err(problem.clone()),
            _ => {
                return Err(format!(
                    "{} changed while you were reviewing it; review it again",
                    decision.kind.label()
                ))
            }
        }
    }
    let record = file.projects.entry(project.key.clone()).or_default();
    record.display = project.root.clone();
    for decision in decisions {
        record.items.insert(
            decision.kind.id().to_owned(),
            Decision {
                allowed: decision.allow,
                hash: decision.hash.clone(),
                at,
            },
        );
    }
    Ok(())
}

/// Allows content Terax itself wrote over an item the user allowed with the hash `previous` (or
/// that held nothing: `previous` None). Checked against the store as it is now, so an answer
/// withdrawn meanwhile holds. False when nothing changed.
fn keep_own_write(
    file: &mut TrustFile,
    project: &OpenProject,
    kind: ItemKind,
    previous: Option<&str>,
    hash: &str,
    at: u64,
) -> bool {
    if decided(file, &project.key, kind, hash) == Some(true) {
        return false;
    }
    if previous.is_some_and(|previous| decided(file, &project.key, kind, previous) != Some(true)) {
        return false;
    }
    let record = file.projects.entry(project.key.clone()).or_default();
    record.display = project.root.clone();
    record.items.insert(
        kind.id().to_owned(),
        Decision {
            allowed: true,
            hash: hash.to_owned(),
            at,
        },
    );
    true
}

/// Records that Terax's own write of `kind` (content `hash`) keeps the user's trust: see
/// `keep_own_write`. True when it was recorded.
pub fn allow_own_write(
    app: &AppHandle,
    project: &OpenProject,
    kind: ItemKind,
    previous: Option<&str>,
    hash: &str,
) -> Result<bool, String> {
    let path = store_path(app)?;
    let kept = with_file(app, |file| {
        let mut next = file.clone();
        if !keep_own_write(&mut next, project, kind, previous, hash, now_secs()) {
            return Ok(false);
        }
        save(&path, &next)?;
        *file = next;
        Ok::<bool, String>(true)
    })??;
    if kept {
        changed(app);
    }
    Ok(kept)
}

fn revoke_in(file: &mut TrustFile, key: &str, kind: Option<ItemKind>) -> bool {
    match kind {
        None => file.projects.remove(key).is_some(),
        Some(kind) => {
            let Some(record) = file.projects.get_mut(key) else {
                return false;
            };
            let removed = record.items.remove(kind.id()).is_some();
            if record.items.is_empty() {
                file.projects.remove(key);
            }
            removed
        }
    }
}

fn changed(app: &AppHandle) {
    let _ = app.emit(CHANGED_EVENT, ());
    crate::modules::skills::project_content_changed(app);
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecordedItem {
    pub kind: String,
    pub label: String,
    pub allowed: bool,
    pub at: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecordedProject {
    pub key: String,
    pub root: String,
    pub exists: bool,
    pub items: Vec<RecordedItem>,
}

fn recorded(file: &TrustFile, exists: impl Fn(&str) -> bool) -> Vec<RecordedProject> {
    file.projects
        .iter()
        .map(|(key, record)| RecordedProject {
            key: key.clone(),
            root: record.display.clone(),
            exists: exists(key),
            items: record
                .items
                .iter()
                .map(|(id, decision)| RecordedItem {
                    kind: id.clone(),
                    label: ItemKind::from_id(id)
                        .map_or_else(|| id.clone(), |kind| kind.label().to_owned()),
                    allowed: decision.allowed,
                    at: decision.at,
                })
                .collect(),
        })
        .collect()
}

// ---- Content hashes ----

const MAX_TREE_ENTRIES: usize = 10_000;
const MAX_TREE_BYTES: u64 = 64 * 1024 * 1024;
const DIGEST_CACHE_CAP: usize = 8192;

type FileDigest = [u8; 32];
/// A file's size and modification time when its digest was taken.
type Stamp = (u64, Option<std::time::SystemTime>);
type DigestCache = Mutex<HashMap<PathBuf, (Stamp, FileDigest)>>;

/// File digests by path, reused while a file keeps its size and modification time.
fn digest_cache() -> &'static DigestCache {
    static CACHE: OnceLock<DigestCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn file_digest(path: &Path, meta: &std::fs::Metadata) -> std::io::Result<FileDigest> {
    let len = meta.len();
    let modified = meta.modified().ok();
    {
        let cache = digest_cache().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(((cached_len, cached_modified), digest)) = cache.get(path) {
            if *cached_len == len && *cached_modified == modified && modified.is_some() {
                return Ok(*digest);
            }
        }
    }
    let mut hasher = Sha256::new();
    let mut file = std::fs::File::open(path)?;
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let digest: FileDigest = hasher.finalize().into();
    let mut cache = digest_cache().lock().unwrap_or_else(|e| e.into_inner());
    if cache.len() >= DIGEST_CACHE_CAP {
        cache.clear();
    }
    cache.insert(path.to_path_buf(), ((len, modified), digest));
    Ok(digest)
}

/// SHA-256 over a folder's tree: every entry's relative path and kind, each file's content and
/// each link's target, in name order, links never followed. A folder too large to review is an
/// error, so it can never be trusted unseen.
pub fn tree_hash(dir: &Path) -> Result<String, String> {
    let mut hasher = Sha256::new();
    let mut entries = 0usize;
    let mut bytes = 0u64;
    hash_dir(dir, "", &mut hasher, &mut entries, &mut bytes)?;
    Ok(hex(&hasher.finalize()))
}

fn hash_dir(
    dir: &Path,
    prefix: &str,
    hasher: &mut Sha256,
    entries: &mut usize,
    bytes: &mut u64,
) -> Result<(), String> {
    let mut children: Vec<(Vec<u8>, PathBuf, String)> = std::fs::read_dir(dir)
        .map_err(|e| format!("cannot read {}: {e}", dir.display()))?
        .filter_map(Result::ok)
        .map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            (name.as_bytes().to_vec(), entry.path(), name)
        })
        .collect();
    children.sort();
    for (_, path, name) in children {
        *entries += 1;
        if *entries > MAX_TREE_ENTRIES {
            return Err(format!(
                "holds more than {MAX_TREE_ENTRIES} files, too many to review"
            ));
        }
        let relative = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        let meta = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        let file_type = meta.file_type();
        if file_type.is_symlink() {
            let target = std::fs::read_link(&path).map_err(|e| e.to_string())?;
            hasher.update(b"l\0");
            hasher.update(relative.as_bytes());
            hasher.update(b"\0");
            hasher.update(target.to_string_lossy().as_bytes());
            hasher.update(b"\0");
        } else if file_type.is_dir() {
            hasher.update(b"d\0");
            hasher.update(relative.as_bytes());
            hasher.update(b"\0");
            hash_dir(&path, &relative, hasher, entries, bytes)?;
        } else if file_type.is_file() {
            *bytes += meta.len();
            if *bytes > MAX_TREE_BYTES {
                return Err(format!(
                    "holds more than {} MiB, too much to review",
                    MAX_TREE_BYTES / (1024 * 1024)
                ));
            }
            let digest = file_digest(&path, &meta).map_err(|e| e.to_string())?;
            hasher.update(b"f\0");
            hasher.update(relative.as_bytes());
            hasher.update(b"\0");
            hasher.update(digest);
        }
    }
    Ok(())
}

/// SHA-256 of one file's content (a project's `.mcp.json`, for one).
pub fn file_hash(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    file_digest(path, &meta)
        .map(|digest| hex(&digest))
        .map_err(|e| e.to_string())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---- Commands ----

/// The trust state of the project a window has open, which it also registers (one per window):
/// its content is watched while it is open. None when the folder is gone.
#[tauri::command]
pub async fn project_trust_status(
    app: AppHandle,
    webview: tauri::Webview,
    root: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<Option<ProjectStatus>, String> {
    let label = webview.label().to_owned();
    blocking(move || {
        let Ok(project) = resolve_project(&root, workspace) else {
            if app.state::<ProjectTrustState>().release_window(&label) {
                crate::modules::skills::open_projects_changed(&app);
                let _ = app.emit(CHANGED_EVENT, ());
            }
            return Ok(None);
        };
        let moved = {
            let state = app.state::<ProjectTrustState>();
            let mut open = state.open_lock();
            let previous = open.insert(label, project.clone());
            previous.is_none_or(|previous| previous.key != project.key)
        };
        if moved {
            crate::modules::skills::open_projects_changed(&app);
            // What windows run from a project (its MCP servers) follows the open projects.
            let _ = app.emit(CHANGED_EVENT, ());
        }
        status(&app, &project).map(Some)
    })
    .await
}

/// Records the user's answer to the trust prompt.
#[tauri::command]
pub async fn project_trust_decide(
    app: AppHandle,
    root: String,
    workspace: Option<WorkspaceEnv>,
    decisions: Vec<DecisionInput>,
) -> Result<ProjectStatus, String> {
    blocking(move || {
        let project = resolve_project(&root, workspace)?;
        let current: HashMap<ItemKind, Result<String, String>> = decisions
            .iter()
            .filter_map(|decision| inspect(&project.real, decision.kind))
            .map(|item| (item.kind, item.hash))
            .collect();
        let path = store_path(&app)?;
        with_file(&app, |file| {
            let mut next = file.clone();
            apply_decisions(&mut next, &project, &current, &decisions, now_secs())?;
            save(&path, &next)?;
            *file = next;
            Ok::<(), String>(())
        })??;
        changed(&app);
        status(&app, &project)
    })
    .await
}

/// Every project with a recorded decision, for Settings.
#[tauri::command]
pub async fn project_trust_list(app: AppHandle) -> Result<Vec<RecordedProject>, String> {
    blocking(move || with_file(&app, |file| recorded(file, |key| Path::new(key).is_dir()))).await
}

/// Forgets the decisions on a project (or one of its items): it asks again.
#[tauri::command]
pub async fn project_trust_revoke(
    app: AppHandle,
    key: String,
    kind: Option<ItemKind>,
) -> Result<(), String> {
    blocking(move || {
        let path = store_path(&app)?;
        let removed = with_file(&app, |file| {
            let mut next = file.clone();
            if !revoke_in(&mut next, &key, kind) {
                return Ok(false);
            }
            save(&path, &next)?;
            *file = next;
            Ok::<bool, String>(true)
        })??;
        if removed {
            changed(&app);
        }
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(key: &str) -> OpenProject {
        OpenProject {
            real: PathBuf::from(key),
            key: key.to_owned(),
            root: key.to_owned(),
            workspace: WorkspaceEnv::Local,
        }
    }

    fn input(kind: ItemKind, hash: &str, allow: bool) -> DecisionInput {
        DecisionInput {
            kind,
            hash: hash.to_owned(),
            allow,
        }
    }

    #[test]
    fn a_decision_holds_only_for_the_content_it_was_made_for() {
        let mut file = TrustFile::default();
        let p = project("/p");
        let current = HashMap::from([
            (ItemKind::ClaudeSkills, Ok("h1".to_owned())),
            (ItemKind::TeraxSkills, Ok("t1".to_owned())),
        ]);
        apply_decisions(
            &mut file,
            &p,
            &current,
            &[
                input(ItemKind::ClaudeSkills, "h1", true),
                input(ItemKind::TeraxSkills, "t1", false),
            ],
            7,
        )
        .unwrap();
        assert_eq!(
            decided(&file, "/p", ItemKind::ClaudeSkills, "h1"),
            Some(true)
        );
        assert_eq!(
            decided(&file, "/p", ItemKind::TeraxSkills, "t1"),
            Some(false)
        );
        assert_eq!(decided(&file, "/p", ItemKind::ClaudeSkills, "h2"), None);
        assert_eq!(decided(&file, "/q", ItemKind::ClaudeSkills, "h1"), None);
        assert_eq!(
            item_state(&file, "/p", ItemKind::ClaudeSkills, &Ok("h1".into())),
            ItemState::Allowed
        );
        assert_eq!(
            item_state(&file, "/p", ItemKind::ClaudeSkills, &Ok("h2".into())),
            ItemState::Changed
        );
        assert_eq!(
            item_state(&file, "/p", ItemKind::TeraxSkills, &Ok("t1".into())),
            ItemState::Denied
        );
        assert_eq!(
            item_state(&file, "/q", ItemKind::TeraxSkills, &Ok("t1".into())),
            ItemState::Pending
        );
        assert_eq!(
            item_state(&file, "/p", ItemKind::TeraxSkills, &Err("big".into())),
            ItemState::Unreviewable
        );
        assert!(ItemState::Changed.asks() && ItemState::Pending.asks());
        assert!(!ItemState::Denied.asks() && !ItemState::Unreviewable.asks());
    }

    #[test]
    fn a_decision_on_content_that_changed_meanwhile_records_nothing() {
        let mut file = TrustFile::default();
        let current = HashMap::from([
            (ItemKind::ClaudeSkills, Ok("new".to_owned())),
            (ItemKind::TeraxSkills, Ok("t".to_owned())),
        ]);
        let error = apply_decisions(
            &mut file,
            &project("/p"),
            &current,
            &[
                input(ItemKind::TeraxSkills, "t", true),
                input(ItemKind::ClaudeSkills, "old", true),
            ],
            1,
        )
        .unwrap_err();
        assert!(error.contains("changed while you were reviewing"));
        assert_eq!(file, TrustFile::default());
        let unreviewable = HashMap::from([(ItemKind::ClaudeSkills, Err("too big".to_owned()))]);
        assert_eq!(
            apply_decisions(
                &mut file,
                &project("/p"),
                &unreviewable,
                &[input(ItemKind::ClaudeSkills, "x", true)],
                1
            ),
            Err("too big".to_owned())
        );
        assert!(apply_decisions(
            &mut file,
            &project("/p"),
            &HashMap::new(),
            &[input(ItemKind::ClaudeSkills, "x", true)],
            1
        )
        .is_err());
    }

    #[test]
    fn terax_s_own_write_keeps_only_an_answer_that_still_allows() {
        let p = project("/p");
        let keep = |file: &mut TrustFile, previous: Option<&str>, hash: &str, at: u64| {
            keep_own_write(file, &p, ItemKind::TeraxMd, previous, hash, at)
        };
        let memory = |file: &TrustFile, hash: &str| decided(file, "/p", ItemKind::TeraxMd, hash);
        let current = HashMap::from([(ItemKind::TeraxMd, Ok("a".to_owned()))]);
        let mut file = TrustFile::default();
        let allow_a = [input(ItemKind::TeraxMd, "a", true)];
        apply_decisions(&mut file, &p, &current, &allow_a, 1).unwrap();
        assert!(keep(&mut file, Some("a"), "b", 2));
        assert_eq!(memory(&file, "b"), Some(true));
        assert_eq!(memory(&file, "a"), None);
        assert_eq!(file.projects["/p"].items["terax-md"].at, 2);
        assert!(!keep(&mut file, Some("b"), "b", 3), "nothing changed");

        // What it held before was not the content allowed (changed outside Terax since).
        let before = file.clone();
        assert!(!keep(&mut file, Some("x"), "c", 4));
        assert_eq!(file, before);

        // Declined, or withdrawn while the write ran: the answer holds.
        let mut declined = TrustFile::default();
        let decline_a = [input(ItemKind::TeraxMd, "a", false)];
        apply_decisions(&mut declined, &p, &current, &decline_a, 1).unwrap();
        assert!(!keep(&mut declined, Some("a"), "b", 2));
        assert_eq!(memory(&declined, "a"), Some(false));
        assert!(revoke_in(&mut file, "/p", Some(ItemKind::TeraxMd)));
        assert!(!keep(&mut file, Some("b"), "c", 5));
        assert!(file.projects.is_empty());

        // A file Terax creates where there was none is allowed, whatever an older answer on
        // other content said; the project's other items keep their answers.
        let skills = HashMap::from([(ItemKind::ClaudeSkills, Ok("s".to_owned()))]);
        let decline_s = [input(ItemKind::ClaudeSkills, "s", false)];
        apply_decisions(&mut declined, &p, &skills, &decline_s, 1).unwrap();
        assert!(keep(&mut declined, None, "new", 6));
        assert_eq!(memory(&declined, "new"), Some(true));
        assert_eq!(
            decided(&declined, "/p", ItemKind::ClaudeSkills, "s"),
            Some(false)
        );
        let mut empty = TrustFile::default();
        assert!(keep(&mut empty, None, "new", 6));
        assert_eq!(empty.projects["/p"].display, "/p");
    }

    #[test]
    fn revoking_forgets_an_item_or_the_whole_project() {
        let mut file = TrustFile::default();
        let current = HashMap::from([
            (ItemKind::ClaudeSkills, Ok("a".to_owned())),
            (ItemKind::TeraxSkills, Ok("b".to_owned())),
        ]);
        let both = [
            input(ItemKind::ClaudeSkills, "a", true),
            input(ItemKind::TeraxSkills, "b", true),
        ];
        apply_decisions(&mut file, &project("/p"), &current, &both, 1).unwrap();
        assert!(revoke_in(&mut file, "/p", Some(ItemKind::ClaudeSkills)));
        assert_eq!(decided(&file, "/p", ItemKind::ClaudeSkills, "a"), None);
        assert_eq!(decided(&file, "/p", ItemKind::TeraxSkills, "b"), Some(true));
        assert!(revoke_in(&mut file, "/p", Some(ItemKind::TeraxSkills)));
        assert!(file.projects.is_empty(), "an empty record is dropped");
        apply_decisions(&mut file, &project("/p"), &current, &both, 1).unwrap();
        assert!(revoke_in(&mut file, "/p", None));
        assert!(!revoke_in(&mut file, "/p", None));
    }

    #[test]
    fn the_store_keeps_kinds_it_does_not_know_and_survives_damage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        std::fs::write(
            &path,
            r#"{"projects":{"/p":{"display":"/p","items":{"future-kind":{"allowed":true,"hash":"x","at":3},"mcp-json":{"allowed":false,"hash":"m","at":3}}}}}"#,
        )
        .unwrap();
        let mut file = load(&path);
        apply_decisions(
            &mut file,
            &project("/p"),
            &HashMap::from([(ItemKind::ClaudeSkills, Ok("h".to_owned()))]),
            &[input(ItemKind::ClaudeSkills, "h", true)],
            4,
        )
        .unwrap();
        save(&path, &file).unwrap();
        let reread = load(&path);
        assert_eq!(reread, file);
        assert!(reread.projects["/p"].items.contains_key("future-kind"));
        assert_eq!(decided(&reread, "/p", ItemKind::McpJson, "m"), Some(false));
        assert_eq!(ItemKind::from_id("terax-md"), Some(ItemKind::TeraxMd));
        assert_eq!(ItemKind::TeraxMd.relative_path(), "TERAX.md");
        let listed = recorded(&reread, |_| true);
        assert_eq!(listed[0].items.len(), 3);
        assert_eq!(listed[0].items[0].label, "Skills in .claude/skills");
        assert_eq!(listed[0].items[1].label, "future-kind");
        assert_eq!(listed[0].items[2].label, "MCP servers in .mcp.json");
        std::fs::write(&path, b"{not json").unwrap();
        assert_eq!(load(&path), TrustFile::default());
        assert_eq!(load(&dir.path().join("missing.json")), TrustFile::default());
    }

    #[test]
    fn the_tree_hash_follows_names_content_and_links() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("a/scripts")).unwrap();
        std::fs::write(root.join("a/SKILL.md"), "one").unwrap();
        std::fs::write(root.join("a/scripts/run.sh"), "echo").unwrap();
        let first = tree_hash(root).unwrap();
        assert_eq!(first.len(), 64);
        assert_eq!(tree_hash(root).unwrap(), first, "stable");

        std::fs::write(root.join("a/scripts/run.sh"), "rm -rf").unwrap();
        let edited = tree_hash(root).unwrap();
        assert_ne!(edited, first, "content counts");

        std::fs::rename(root.join("a/scripts/run.sh"), root.join("a/scripts/go.sh")).unwrap();
        let renamed = tree_hash(root).unwrap();
        assert_ne!(renamed, edited, "names count");

        std::fs::create_dir(root.join("a/empty")).unwrap();
        let with_dir = tree_hash(root).unwrap();
        assert_ne!(with_dir, renamed, "folders count");

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/passwd", root.join("a/link")).unwrap();
            let linked = tree_hash(root).unwrap();
            assert_ne!(linked, with_dir);
            std::fs::remove_file(root.join("a/link")).unwrap();
            std::os::unix::fs::symlink("/etc/hosts", root.join("a/link")).unwrap();
            assert_ne!(tree_hash(root).unwrap(), linked, "a link's target counts");
        }
    }

    #[test]
    fn a_tree_too_large_to_review_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let file = std::fs::File::create(dir.path().join("big")).unwrap();
        file.set_len(MAX_TREE_BYTES + 1).unwrap();
        assert!(tree_hash(dir.path())
            .unwrap_err()
            .contains("too much to review"));
    }

    #[test]
    fn an_item_that_links_out_of_the_project_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let project = root.join("project");
        std::fs::create_dir_all(project.join(".terax/skills")).unwrap();
        assert_eq!(
            item_path(&project, ItemKind::TeraxSkills),
            Some(Ok(project.join(".terax/skills")))
        );
        assert_eq!(item_path(&project, ItemKind::ClaudeSkills), None);
        std::fs::create_dir_all(project.join(".claude")).unwrap();
        std::fs::write(project.join(".claude/skills"), "a file").unwrap();
        assert_eq!(
            item_path(&project, ItemKind::ClaudeSkills),
            Some(Ok(project.join(".claude/skills")))
        );
        std::fs::remove_file(project.join(".claude/skills")).unwrap();
        #[cfg(unix)]
        {
            std::fs::create_dir_all(root.join("outside")).unwrap();
            std::os::unix::fs::symlink(root.join("outside"), project.join(".claude/skills"))
                .unwrap();
            assert!(item_path(&project, ItemKind::ClaudeSkills)
                .unwrap()
                .unwrap_err()
                .contains("links outside the project"));
        }
    }

    #[test]
    fn display_paths_keep_the_window_spelling() {
        assert_eq!(
            join_display("/home/me/p", ".claude/skills"),
            "/home/me/p/.claude/skills"
        );
        assert_eq!(join_display("C:/p/", "x"), "C:/p/x");
        assert_eq!(join_display("/p", ""), "/p");
    }
}
