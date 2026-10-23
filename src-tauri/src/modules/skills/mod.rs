//! Agent Skills: folders with a `SKILL.md` (instructions for the model, with optional reference
//! files and scripts) from Oarlock's own skills folder, `~/.claude/skills`, and the open projects'
//! `.claude/skills` and `.terax/skills` once the user trusts them (`project_trust`).
//!
//! The page lists skills, loads one's instructions and reads its files through these commands,
//! never through the file commands: a skill's files are read only inside its real folder, and a
//! project's skills only while the user trusts their current content. Whether a skill is on is
//! kept here too (`skills-state.json` in the app data folder), so a disabled skill can be neither
//! listed for the model nor loaded.

pub mod discover;
pub mod files;
pub mod frontmatter;
pub mod install;
mod trash;
mod watch;

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use crate::modules::fs::{blocking, to_canon};
use crate::modules::project_trust::{
    self, item_path, open_projects, resolve_project, Inspected, ItemEntry, ItemKind, OpenProject,
    ProjectStatus,
};
use crate::modules::workspace::{is_plain_name, Opened, WorkspaceEnv, WorkspaceRegistry};
use discover::{ParseCache, Scanned, Source, SourceKind, SKILL_FILE};
use install::{Candidate, STAGING_PREFIX};

/// Sent to every window when the skills on disk, or their settings, change.
pub const CHANGED_EVENT: &str = "skills:changed";
/// Sent to the app window in front with the `SKILL.md` to open in the editor.
pub const EDIT_EVENT: &str = "oarlock:skill-edit";
const STATE_FILE: &str = "skills-state.json";
const STALE_STAGING: Duration = Duration::from_secs(60 * 60);
const MAX_ENTRY_DETAIL: usize = 200;

fn parse_cache() -> MutexGuard<'static, ParseCache> {
    static CACHE: OnceLock<Mutex<ParseCache>> = OnceLock::new();
    CACHE
        .get_or_init(|| Mutex::new(ParseCache::default()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
struct SkillsSettings {
    #[serde(default)]
    disabled: BTreeSet<String>,
}

struct Staged {
    dir: PathBuf,
    candidates: Vec<Candidate>,
}

#[derive(Default)]
pub struct SkillsState {
    settings: Mutex<Option<SkillsSettings>>,
    installs: Mutex<HashMap<String, Staged>>,
    watch: watch::SkillsWatch,
    signature: Mutex<Option<[u8; 32]>>,
}

fn oarlock_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("skills"))
}

fn user_dir() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".claude").join("skills"))
}

/// The skills source of a project item; None for an item that holds no skills.
fn source_kind(kind: ItemKind) -> Option<SourceKind> {
    match kind {
        ItemKind::ClaudeSkills => Some(SourceKind::ClaudeProject),
        ItemKind::TeraxSkills => Some(SourceKind::TeraxProject),
        ItemKind::TeraxMd | ItemKind::McpJson => None,
    }
}

fn item_kind(kind: SourceKind) -> Option<ItemKind> {
    match kind {
        SourceKind::ClaudeProject => Some(ItemKind::ClaudeSkills),
        SourceKind::TeraxProject => Some(ItemKind::TeraxSkills),
        SourceKind::Oarlock | SourceKind::User => None,
    }
}

fn global_sources(app: &AppHandle) -> Vec<Source> {
    let mut sources = Vec::new();
    if let Ok(dir) = oarlock_dir(app) {
        sources.push(Source {
            kind: SourceKind::Oarlock,
            display: to_canon(&dir),
            dir,
            confine: None,
        });
    }
    if let Some(dir) = user_dir() {
        sources.push(Source {
            kind: SourceKind::User,
            display: to_canon(&dir),
            dir,
            confine: None,
        });
    }
    sources
}

/// The project's skills folder at its real path, unless it is the user's own `~/.claude/skills`
/// (a project opened at the home folder) or not a folder.
fn project_item_dir(root: &Path, kind: ItemKind) -> Option<Result<PathBuf, String>> {
    source_kind(kind)?;
    let found = item_path(root, kind)?;
    if let Ok(real) = &found {
        if !real.is_dir() {
            return None;
        }
        let user = user_dir().and_then(|dir| std::fs::canonicalize(dir).ok());
        if user.as_ref() == Some(real) {
            return None;
        }
    }
    Some(found)
}

fn project_source(project: &OpenProject, kind: SourceKind, item: ItemKind, dir: PathBuf) -> Source {
    Source {
        kind,
        confine: Some(dir.clone()),
        dir,
        display: project.display_path(item.relative_path()),
    }
}

fn truncate(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    let cut: String = flat.chars().take(max - 1).collect();
    format!("{}…", cut.trim_end())
}

/// What a project's skills item holds, for the trust prompt (`project_trust::inspect`).
pub fn inspect_project_item(root: &Path, kind: ItemKind) -> Option<Inspected> {
    let source = source_kind(kind)?;
    let real = match project_item_dir(root, kind)? {
        Ok(real) => real,
        Err(problem) => {
            return Some(Inspected {
                kind,
                path: root.join(kind.relative_path()),
                hash: Err(problem),
                entries: Vec::new(),
            })
        }
    };
    let hash = project_trust::tree_hash(&real);
    let scanned = discover::scan(
        &Source {
            kind: source,
            dir: real.clone(),
            display: kind.relative_path().to_owned(),
            confine: Some(real.clone()),
        },
        &mut parse_cache(),
    );
    // A folder with no skill in it provides nothing to ask about.
    if scanned.skills.is_empty() && scanned.invalid.is_empty() {
        return None;
    }
    let mut entries: Vec<ItemEntry> = scanned
        .skills
        .iter()
        .map(|skill| {
            let (files, truncated) = files::list_files(&skill.real_dir);
            let mut detail = truncate(&skill.meta.description, MAX_ENTRY_DETAIL);
            if !files.is_empty() {
                let more = if truncated { "+" } else { "" };
                detail.push_str(&format!(" ({}{more} bundled files)", files.len()));
            }
            ItemEntry {
                title: skill.meta.name.clone(),
                detail,
            }
        })
        .collect();
    if !scanned.invalid.is_empty() {
        entries.push(ItemEntry {
            title: format!(
                "{} folders that are not valid skills",
                scanned.invalid.len()
            ),
            detail: scanned
                .invalid
                .iter()
                .map(|invalid| invalid.dir_name.as_str())
                .collect::<Vec<_>>()
                .join(", "),
        });
    }
    Some(Inspected {
        kind,
        path: real,
        hash,
        entries,
    })
}

// ---- Settings (on and off) ----

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(STATE_FILE))
}

fn with_settings<T>(
    app: &AppHandle,
    f: impl FnOnce(&mut SkillsSettings) -> T,
) -> Result<T, String> {
    let path = settings_path(app)?;
    let state = app.state::<SkillsState>();
    let mut guard = state.settings.lock().unwrap_or_else(|e| e.into_inner());
    let settings = guard.get_or_insert_with(|| {
        std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    });
    Ok(f(settings))
}

fn save_settings(app: &AppHandle, settings: &SkillsSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let parent = path.parent().ok_or("missing app data folder")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    std::io::Write::write_all(&mut temporary, &bytes).map_err(|e| e.to_string())?;
    temporary.persist(&path).map_err(|e| e.error.to_string())?;
    Ok(())
}

// ---- Views ----

/// A skill as the page sees it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SkillView {
    /// `<source>/<folder>`; with `project`, it names the skill.
    pub id: String,
    /// What its on/off state is kept under (a project skill's includes the project).
    pub key: String,
    pub source: SourceKind,
    pub project: Option<OpenProject>,
    pub name: String,
    pub description: String,
    pub when_to_use: Option<String>,
    pub argument_hint: Option<String>,
    pub license: Option<String>,
    pub compatibility: Option<String>,
    pub dir: String,
    pub model_invocable: bool,
    pub user_invocable: bool,
    pub enabled: bool,
    /// False for a project skill whose project content the user has not allowed.
    pub trusted: bool,
    /// The key of the skill that takes this name instead.
    pub overridden_by: Option<String>,
    pub warnings: Vec<String>,
    #[serde(skip)]
    real_dir: PathBuf,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InvalidView {
    pub id: String,
    pub source: SourceKind,
    pub project: Option<OpenProject>,
    pub dir_name: String,
    pub dir: String,
    pub errors: Vec<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub oarlock_dir: String,
    pub user_dir: Option<String>,
    pub skills: Vec<SkillView>,
    pub invalid: Vec<InvalidView>,
    /// With `all`: each open project's trust state.
    pub projects: Vec<ProjectStatus>,
}

fn skill_id(kind: SourceKind, dir_name: &str) -> String {
    format!("{}/{dir_name}", kind.id())
}

fn skill_key(id: &str, project: Option<&OpenProject>) -> String {
    match project {
        Some(project) => format!("{id}@{}", project.key),
        None => id.to_owned(),
    }
}

/// Views of one scanned source.
fn views(
    scanned: Scanned,
    source: &Source,
    project: Option<&OpenProject>,
    trusted: bool,
    disabled: &BTreeSet<String>,
    out: &mut Snapshot,
) {
    for found in scanned.skills {
        let id = skill_id(source.kind, &found.dir_name);
        let key = skill_key(&id, project);
        let meta = found.meta;
        out.skills.push(SkillView {
            enabled: !disabled.contains(&key),
            id,
            key,
            source: source.kind,
            project: project.cloned(),
            name: meta.name,
            description: meta.description,
            when_to_use: meta.when_to_use,
            argument_hint: meta.argument_hint,
            license: meta.license,
            compatibility: meta.compatibility,
            dir: found.display_dir,
            model_invocable: meta.model_invocable,
            user_invocable: meta.user_invocable,
            trusted,
            overridden_by: None,
            warnings: meta.warnings,
            real_dir: found.real_dir,
        });
    }
    for invalid in scanned.invalid {
        out.invalid.push(InvalidView {
            id: skill_id(source.kind, &invalid.dir_name),
            source: source.kind,
            project: project.cloned(),
            dir_name: invalid.dir_name,
            dir: invalid.display_dir,
            errors: invalid.errors,
        });
    }
}

/// Marks the skills among `members` (indices into `skills`) that another of them overrides.
/// Only enabled, trusted skills take part: turning one off lets the next in line take its name.
fn resolve_overrides(skills: &mut [SkillView], members: &[usize]) {
    let live: Vec<usize> = members
        .iter()
        .copied()
        .filter(|&i| skills[i].enabled && skills[i].trusted)
        .collect();
    let candidates: Vec<(SourceKind, &str)> = live
        .iter()
        .map(|&i| (skills[i].source, skills[i].name.as_str()))
        .collect();
    let winners = discover::winners(&candidates);
    let resolved: Vec<(usize, String)> = live
        .iter()
        .zip(winners)
        .filter_map(|(&i, winner)| winner.map(|w| (i, skills[live[w]].key.clone())))
        .collect();
    for (i, key) in resolved {
        skills[i].overridden_by = Some(key);
    }
}

enum Scope<'a> {
    /// What a conversation working in this project (if any) may use: no untrusted content.
    Agent(Option<&'a OpenProject>),
    /// Everything, for Settings: the open projects' skills whether trusted or not.
    All,
}

fn collect(app: &AppHandle, scope: Scope) -> Snapshot {
    let disabled = with_settings(app, |settings| settings.disabled.clone()).unwrap_or_default();
    let all = matches!(scope, Scope::All);
    let projects: Vec<OpenProject> = match scope {
        Scope::Agent(project) => project.cloned().into_iter().collect(),
        Scope::All => open_projects(app),
    };
    let allowed = |project: &OpenProject, kind: ItemKind, hash: &str| {
        project_trust::is_allowed(app, &project.key, kind, hash)
    };
    let mut snapshot = collect_from(&global_sources(app), &projects, all, &disabled, &allowed);
    snapshot.oarlock_dir = oarlock_dir(app).map(|dir| to_canon(&dir)).unwrap_or_default();
    snapshot.user_dir = user_dir().map(|dir| to_canon(&dir));
    if all {
        snapshot.projects = projects
            .iter()
            .filter_map(|project| project_trust::status(app, project).ok())
            .collect();
    }
    snapshot
}

/// The skills of `globals` and of `projects`' items: a project item only when `allowed` holds
/// for its current content, unless `all` (Settings) lists it as untrusted. Overrides are
/// resolved per conversation context: with `all`, the global folders among themselves and each
/// project's items among themselves; otherwise everything together.
fn collect_from(
    globals: &[Source],
    projects: &[OpenProject],
    all: bool,
    disabled: &BTreeSet<String>,
    allowed: &dyn Fn(&OpenProject, ItemKind, &str) -> bool,
) -> Snapshot {
    let mut snapshot = Snapshot::default();
    for source in globals {
        let scanned = discover::scan(source, &mut parse_cache());
        views(scanned, source, None, true, disabled, &mut snapshot);
    }
    let globals: Vec<usize> = (0..snapshot.skills.len()).collect();
    if all || projects.is_empty() {
        resolve_overrides(&mut snapshot.skills, &globals);
    }
    for project in projects {
        let start = snapshot.skills.len();
        for kind in ItemKind::SKILLS {
            let (Some(skills_kind), Some(Ok(dir))) =
                (source_kind(kind), project_item_dir(&project.real, kind))
            else {
                continue;
            };
            let trusted =
                project_trust::tree_hash(&dir).is_ok_and(|hash| allowed(project, kind, &hash));
            if !trusted && !all {
                continue;
            }
            let source = project_source(project, skills_kind, kind, dir);
            let scanned = discover::scan(&source, &mut parse_cache());
            views(
                scanned,
                &source,
                Some(project),
                trusted,
                disabled,
                &mut snapshot,
            );
        }
        let members: Vec<usize> = if all {
            (start..snapshot.skills.len()).collect()
        } else {
            (0..snapshot.skills.len()).collect()
        };
        resolve_overrides(&mut snapshot.skills, &members);
    }
    snapshot
}

/// Where the watcher looks: the global folders and every open project's items.
fn watch_targets(app: &AppHandle) -> Vec<watch::Target> {
    let mut targets = Vec::new();
    if let Ok(dir) = oarlock_dir(app) {
        if let Some(parent) = dir.parent() {
            targets.push(watch::Target {
                stop: parent.to_path_buf(),
                path: dir,
            });
        }
    }
    if let (Some(dir), Some(home)) = (user_dir(), dirs::home_dir()) {
        targets.push(watch::Target {
            path: dir,
            stop: home,
        });
    }
    for project in open_projects(app) {
        for kind in ItemKind::ALL {
            let path = kind
                .relative_path()
                .split('/')
                .fold(project.real.clone(), |path, part| path.join(part));
            targets.push(watch::Target {
                path,
                stop: project.real.clone(),
            });
        }
    }
    targets
}

/// A digest of everything windows show about skills: the full listing and every open project's
/// trust state, so content that changed under a decision is noticed too.
fn signature(app: &AppHandle) -> [u8; 32] {
    let snapshot = collect(app, Scope::All);
    let bytes = serde_json::to_vec(&snapshot).unwrap_or_default();
    Sha256::digest(&bytes).into()
}

fn on_disk_change(app: &AppHandle) {
    let next = signature(app);
    let state = app.state::<SkillsState>();
    let moved = {
        let mut current = state.signature.lock().unwrap_or_else(|e| e.into_inner());
        let moved = current.as_ref() != Some(&next);
        *current = Some(next);
        moved
    };
    state.watch.sync(app, &watch_targets(app), on_disk_change);
    if moved {
        let _ = app.emit(CHANGED_EVENT, ());
    }
}

fn ensure_watching(app: &AppHandle) {
    let state = app.state::<SkillsState>();
    let first = {
        let mut signature = state.signature.lock().unwrap_or_else(|e| e.into_inner());
        if signature.is_some() {
            false
        } else {
            *signature = Some([0; 32]);
            true
        }
    };
    if first {
        state.watch.sync(app, &watch_targets(app), on_disk_change);
        let next = signature(app);
        *state.signature.lock().unwrap_or_else(|e| e.into_inner()) = Some(next);
    }
}

/// A window opened or left a project: watch what the open projects provide now, so a change
/// to a project's skills reaches its trust prompt.
pub fn open_projects_changed(app: &AppHandle) {
    let state = app.state::<SkillsState>();
    let watching = state
        .signature
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some();
    if watching {
        state.watch.sync(app, &watch_targets(app), on_disk_change);
    } else {
        ensure_watching(app);
    }
}

/// A trust decision changed which project skills are usable.
pub fn project_content_changed(app: &AppHandle) {
    let next = signature(app);
    *app.state::<SkillsState>()
        .signature
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(next);
    let _ = app.emit(CHANGED_EVENT, ());
}

fn changed(app: &AppHandle) {
    project_content_changed(app);
}

// ---- Resolving a skill the page names ----

/// A project as the page names it.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInput {
    pub root: String,
    pub workspace: Option<WorkspaceEnv>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SkillRef {
    pub id: String,
    pub project: Option<ProjectInput>,
}

fn parse_id(id: &str) -> Result<(SourceKind, String), String> {
    let (source, dir_name) = id.split_once('/').ok_or("unknown skill")?;
    let kind = [
        SourceKind::Oarlock,
        SourceKind::User,
        SourceKind::ClaudeProject,
        SourceKind::TeraxProject,
    ]
    .into_iter()
    .find(|kind| kind.id() == source)
    .ok_or("unknown skill")?;
    if dir_name.is_empty() || dir_name.starts_with('.') || !is_plain_name(dir_name.as_ref()) {
        return Err("unknown skill".to_owned());
    }
    Ok((kind, dir_name.to_owned()))
}

fn project_of(input: Option<ProjectInput>) -> Result<Option<OpenProject>, String> {
    input
        .map(|project| resolve_project(&project.root, project.workspace))
        .transpose()
}

/// A skill the model may use in a conversation working in `project`: valid, on, trusted and
/// not overridden.
fn usable(app: &AppHandle, skill: SkillRef) -> Result<SkillView, String> {
    let project = project_of(skill.project)?;
    let snapshot = collect(app, Scope::Agent(project.as_ref()));
    let view = snapshot
        .skills
        .into_iter()
        .find(|view| view.id == skill.id)
        .ok_or_else(|| "this skill is not available".to_owned())?;
    if !view.enabled {
        return Err(format!("the skill `{}` is turned off", view.name));
    }
    if view.overridden_by.is_some() {
        return Err(format!(
            "another skill named `{}` takes precedence",
            view.name
        ));
    }
    Ok(view)
}

/// The `SKILL.md` of a skill, valid or not, for the editor.
fn skill_file_of(app: &AppHandle, skill: &SkillRef) -> Result<PathBuf, String> {
    let (kind, dir_name) = parse_id(&skill.id)?;
    let base = match item_kind(kind) {
        None => {
            let source = global_sources(app)
                .into_iter()
                .find(|source| source.kind == kind)
                .ok_or("unknown skill")?;
            source.dir
        }
        Some(item) => {
            let project = project_of(skill.project.clone())?.ok_or("unknown skill")?;
            project_item_dir(&project.real, item).ok_or("unknown skill")??
        }
    };
    let file = base.join(dir_name).join(SKILL_FILE);
    if !file.is_file() {
        return Err("SKILL.md is gone".to_owned());
    }
    Ok(file)
}

// ---- Commands ----

/// The skills a conversation working in `project` may use (`all` unset), or everything with the
/// open projects' trust states, for Settings (`all`).
#[tauri::command]
pub async fn skills_list(
    app: AppHandle,
    project: Option<ProjectInput>,
    all: Option<bool>,
) -> Result<Snapshot, String> {
    blocking(move || {
        ensure_watching(&app);
        if all == Some(true) {
            return Ok(collect(&app, Scope::All));
        }
        let project =
            project.and_then(|project| resolve_project(&project.root, project.workspace).ok());
        Ok(collect(&app, Scope::Agent(project.as_ref())))
    })
    .await
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LoadedSkill {
    pub id: String,
    pub name: String,
    pub dir: String,
    pub body: String,
    pub files: Vec<String>,
    pub files_truncated: bool,
}

/// A usable skill's instructions (the `SKILL.md` body) and the list of its other files.
#[tauri::command]
pub async fn skills_load(app: AppHandle, skill: SkillRef) -> Result<LoadedSkill, String> {
    blocking(move || {
        let view = usable(&app, skill)?;
        let file = files::resolve_inside(&view.real_dir, SKILL_FILE)?;
        let text = discover::read_skill_text(&file).map_err(|errors| errors.join("; "))?;
        let dir_name = view.id.split_once('/').map_or("", |(_, name)| name);
        let meta = frontmatter::parse_skill(&text, dir_name)
            .map_err(|errors| format!("the skill is no longer valid: {}", errors.join("; ")))?;
        let (files, files_truncated) = files::list_files(&view.real_dir);
        Ok(LoadedSkill {
            id: view.id,
            name: view.name,
            dir: view.dir,
            body: text[meta.body_start..].to_owned(),
            files,
            files_truncated,
        })
    })
    .await
}

/// A text file inside a usable skill's folder.
#[tauri::command]
pub async fn skills_read_file(
    app: AppHandle,
    skill: SkillRef,
    path: String,
) -> Result<files::ReadOutcome, String> {
    blocking(move || {
        let view = usable(&app, skill)?;
        let file = files::resolve_inside(&view.real_dir, &path)?;
        files::read_text(&file)
    })
    .await
}

const MAX_SETTING_KEY: usize = 4096;
const MAX_DISABLED: usize = 10_000;

#[tauri::command]
pub async fn skills_set_enabled(app: AppHandle, key: String, enabled: bool) -> Result<(), String> {
    if key.is_empty() || key.len() > MAX_SETTING_KEY {
        return Err("unknown skill".to_owned());
    }
    blocking(move || {
        let next = with_settings(&app, |settings| {
            let mut next = settings.clone();
            if enabled {
                next.disabled.remove(&key);
            } else if next.disabled.len() < MAX_DISABLED {
                next.disabled.insert(key.clone());
            }
            next
        })?;
        save_settings(&app, &next)?;
        with_settings(&app, |settings| *settings = next)?;
        changed(&app);
        Ok(())
    })
    .await
}

/// Creates a skill in Oarlock's folder from the template; returns its id.
#[tauri::command]
pub async fn skills_create(
    app: AppHandle,
    name: String,
    description: String,
) -> Result<String, String> {
    blocking(move || {
        let dir = oarlock_dir(&app)?;
        install::create(&dir, &name, &description)?;
        changed(&app);
        Ok(skill_id(SourceKind::Oarlock, &name))
    })
    .await
}

/// Opens a skill's `SKILL.md` in the editor of the app window in front: its folder is made
/// reachable for the editor first (`Opened::File`), as when the user opens a file.
#[tauri::command]
pub async fn skills_edit(app: AppHandle, skill: SkillRef) -> Result<(), String> {
    blocking(move || {
        let file = skill_file_of(&app, &skill)?;
        app.state::<WorkspaceRegistry>()
            .authorize_opened(&file, Opened::File)
            .map_err(|e| e.to_string())?;
        let window =
            crate::modules::windows::target_window(&app).ok_or("no Oarlock window is open")?;
        window
            .emit_to(window.label(), EDIT_EVENT, to_canon(&file))
            .map_err(|e| e.to_string())?;
        let _ = window.set_focus();
        Ok(())
    })
    .await
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Deleted {
    pub trashed: bool,
}

/// Deletes a skill from Oarlock's folder: to the trash, or for good with `permanent` (the page
/// asks for that only after the trash refused). A linked skill folder loses only its link.
#[tauri::command]
pub async fn skills_delete(app: AppHandle, id: String, permanent: bool) -> Result<Deleted, String> {
    blocking(move || {
        let (kind, dir_name) = parse_id(&id)?;
        if kind != SourceKind::Oarlock {
            return Err("only skills in Oarlock's folder can be deleted here".to_owned());
        }
        let dir = oarlock_dir(&app)?.join(&dir_name);
        let meta = std::fs::symlink_metadata(&dir).map_err(|_| "the skill is gone".to_owned())?;
        let trashed = if meta.file_type().is_symlink() {
            remove_link(&dir)?;
            false
        } else if permanent {
            std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
            false
        } else {
            trash::trash(&dir).map_err(|error| format!("trash unavailable: {error}"))?;
            true
        };
        let key = skill_key(&id, None);
        let next = with_settings(&app, |settings| {
            let mut next = settings.clone();
            next.disabled.remove(&key);
            next
        })?;
        save_settings(&app, &next)?;
        with_settings(&app, |settings| *settings = next)?;
        changed(&app);
        Ok(Deleted { trashed })
    })
    .await
}

fn remove_link(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        // A directory link (or junction) is removed as a directory, which leaves its target.
        if std::fs::remove_dir(path).is_ok() {
            return Ok(());
        }
    }
    std::fs::remove_file(path).map_err(|e| e.to_string())
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstallPreview {
    pub token: String,
    pub source: String,
    pub candidates: Vec<Candidate>,
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 12];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Removes staging folders no install holds any more and that are an hour old.
fn sweep_staging(app: &AppHandle, skills_dir: &Path) {
    let live: Vec<PathBuf> = app
        .state::<SkillsState>()
        .installs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .map(|staged| staged.dir.clone())
        .collect();
    let Ok(listing) = std::fs::read_dir(skills_dir) else {
        return;
    };
    for entry in listing.filter_map(Result::ok) {
        let path = entry.path();
        let stale = entry
            .file_name()
            .to_string_lossy()
            .starts_with(STAGING_PREFIX)
            && !live.contains(&path)
            && entry
                .metadata()
                .and_then(|meta| meta.modified())
                .is_ok_and(|modified| {
                    SystemTime::now()
                        .duration_since(modified)
                        .is_ok_and(|age| age > STALE_STAGING)
                });
        if stale {
            let _ = std::fs::remove_dir_all(path);
        }
    }
}

/// Stages an install: `fill` downloads or extracts into the staging folder and returns where
/// the skills are; each skill found there is reviewed.
fn stage(
    app: &AppHandle,
    source: String,
    fallback: &str,
    fill: impl FnOnce(&Path) -> Result<PathBuf, String>,
) -> Result<InstallPreview, String> {
    let skills_dir = oarlock_dir(app)?;
    std::fs::create_dir_all(&skills_dir).map_err(|e| e.to_string())?;
    sweep_staging(app, &skills_dir);
    let token = random_token()?;
    let staging = skills_dir.join(format!("{STAGING_PREFIX}{token}"));
    std::fs::create_dir(&staging).map_err(|e| e.to_string())?;
    let reviewed = fill(&staging).and_then(|root| {
        let dirs = install::find_skill_dirs(&root);
        if dirs.is_empty() {
            return Err("no SKILL.md found".to_owned());
        }
        Ok(dirs
            .into_iter()
            .map(|dir| {
                let location = dir
                    .strip_prefix(&root)
                    .ok()
                    .map(to_canon)
                    .filter(|location| !location.is_empty())
                    .unwrap_or_else(|| ".".to_owned());
                let folder = if dir == root {
                    fallback.to_owned()
                } else {
                    dir.file_name()
                        .map_or_else(String::new, |name| name.to_string_lossy().into_owned())
                };
                install::review(&dir, location, &folder, &skills_dir)
            })
            .collect::<Vec<_>>())
    });
    let reviewed = reviewed.map(|mut candidates| {
        install::mark_duplicates(&mut candidates);
        candidates
    });
    let candidates = match reviewed {
        Ok(candidates) => candidates,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }
    };
    app.state::<SkillsState>()
        .installs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            token.clone(),
            Staged {
                dir: staging,
                candidates: candidates.clone(),
            },
        );
    Ok(InstallPreview {
        token,
        source,
        candidates,
    })
}

/// The last path segment of a repository address without `.git`, a name for a skill at the
/// repository's root whose frontmatter has none.
fn repository_name(url: &str, subpath: Option<&str>) -> String {
    let tail = subpath
        .and_then(|path| path.rsplit('/').next())
        .unwrap_or_else(|| {
            url.trim_end_matches('/')
                .rsplit(['/', ':'])
                .next()
                .unwrap_or("")
        });
    tail.trim_end_matches(".git").to_ascii_lowercase()
}

/// Clones a Git repository (shallow) into a staging folder and reviews the skills in it.
#[tauri::command]
pub async fn skills_install_git(app: AppHandle, url: String) -> Result<InstallPreview, String> {
    blocking(move || {
        let source = install::parse_git_source(&url)?;
        let fallback = repository_name(&source.url, source.subpath.as_deref());
        stage(&app, url.trim().to_owned(), &fallback, |staging| {
            install::clone(staging, &source)
        })
    })
    .await
}

/// Asks for a zip with the system's file picker (over the calling window), extracts it into a
/// staging folder and reviews the skills in it. None when the user cancels.
#[tauri::command]
pub async fn skills_install_zip(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<InstallPreview>, String> {
    blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let picked = app
            .dialog()
            .file()
            .set_title("Install skills from a zip file")
            .add_filter("Zip archives", &["zip", "skill"])
            .set_parent(&window)
            .blocking_pick_file();
        let Some(picked) = picked else {
            return Ok(None);
        };
        let path = picked.into_path().map_err(|e| e.to_string())?;
        let fallback = path.file_stem().map_or_else(String::new, |stem| {
            stem.to_string_lossy().to_ascii_lowercase()
        });
        let source = to_canon(&path);
        stage(&app, source, &fallback, |staging| {
            let dest = staging.join("zip");
            std::fs::create_dir(&dest).map_err(|e| e.to_string())?;
            install::extract_zip(&path, &dest)?;
            Ok(dest)
        })
        .map(Some)
    })
    .await
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub installed: Vec<String>,
    /// `name: reason` of each picked skill that could not be installed.
    pub failed: Vec<String>,
}

/// Installs the reviewed skills the user picked (by name); `replace` names the installed skills
/// the user agreed to replace, which go to the trash first.
#[tauri::command]
pub async fn skills_install_commit(
    app: AppHandle,
    token: String,
    names: Vec<String>,
    replace: Vec<String>,
) -> Result<Installed, String> {
    blocking(move || {
        let staged = app
            .state::<SkillsState>()
            .installs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&token)
            .ok_or("this install has expired; start it again")?;
        let skills_dir = oarlock_dir(&app)?;
        let mut installed = Vec::new();
        let mut failures = Vec::new();
        for candidate in staged
            .candidates
            .iter()
            .filter(|candidate| names.contains(&candidate.name))
        {
            let replacing = replace.contains(&candidate.name);
            let placed = install::place(candidate, &skills_dir, replacing, |old| {
                trash::trash(old)
                    .or_else(|_| std::fs::remove_dir_all(old).map_err(|e| e.to_string()))
            });
            match placed {
                Ok(_) => installed.push(candidate.name.clone()),
                Err(error) => failures.push(format!("{}: {error}", candidate.name)),
            }
        }
        let _ = std::fs::remove_dir_all(&staged.dir);
        if !installed.is_empty() {
            changed(&app);
        }
        Ok(Installed {
            installed,
            failed: failures,
        })
    })
    .await
}

#[tauri::command]
pub async fn skills_install_cancel(app: AppHandle, token: String) -> Result<(), String> {
    blocking(move || {
        let staged = app
            .state::<SkillsState>()
            .installs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&token);
        if let Some(staged) = staged {
            let _ = std::fs::remove_dir_all(staged.dir);
        }
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use discover::Found;
    use frontmatter::SkillMeta;

    fn meta(name: &str) -> SkillMeta {
        SkillMeta {
            name: name.to_owned(),
            description: format!("{name} does things"),
            when_to_use: None,
            argument_hint: None,
            license: None,
            compatibility: None,
            model_invocable: true,
            user_invocable: true,
            body_start: 0,
            warnings: Vec::new(),
        }
    }

    fn scanned(names: &[(&str, &str)]) -> Scanned {
        Scanned {
            skills: names
                .iter()
                .map(|(dir, name)| Found {
                    dir_name: (*dir).to_owned(),
                    meta: meta(name),
                    real_dir: PathBuf::from(dir),
                    display_dir: format!("/s/{dir}"),
                })
                .collect(),
            invalid: Vec::new(),
        }
    }

    fn source(kind: SourceKind) -> Source {
        Source {
            kind,
            dir: PathBuf::from("/s"),
            display: "/s".to_owned(),
            confine: None,
        }
    }

    fn project() -> OpenProject {
        OpenProject {
            real: PathBuf::from("/p"),
            key: "/p".to_owned(),
            root: "/p".to_owned(),
            workspace: WorkspaceEnv::Local,
        }
    }

    #[test]
    fn ids_name_the_source_and_folder_and_keys_the_project() {
        assert_eq!(skill_id(SourceKind::User, "pdf"), "user/pdf");
        assert_eq!(
            skill_key("claude-project/pdf", Some(&project())),
            "claude-project/pdf@/p"
        );
        assert_eq!(
            parse_id("terax-project/pdf"),
            Ok((SourceKind::TeraxProject, "pdf".into()))
        );
        for bad in [
            "pdf",
            "x/pdf",
            "oarlock/",
            "oarlock/..",
            "oarlock/a/b",
            "oarlock/.install-1",
        ] {
            assert!(parse_id(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn overrides_follow_precedence_among_enabled_trusted_skills() {
        let mut snapshot = Snapshot::default();
        let disabled = BTreeSet::from(["claude-project/pdf@/p".to_owned()]);
        views(
            scanned(&[("pdf", "pdf"), ("only", "only")]),
            &source(SourceKind::Oarlock),
            None,
            true,
            &disabled,
            &mut snapshot,
        );
        views(
            scanned(&[("pdf", "pdf")]),
            &source(SourceKind::User),
            None,
            true,
            &disabled,
            &mut snapshot,
        );
        views(
            scanned(&[("pdf", "pdf")]),
            &source(SourceKind::ClaudeProject),
            Some(&project()),
            true,
            &disabled,
            &mut snapshot,
        );
        views(
            scanned(&[("only", "only")]),
            &source(SourceKind::TeraxProject),
            Some(&project()),
            false,
            &disabled,
            &mut snapshot,
        );
        let all: Vec<usize> = (0..snapshot.skills.len()).collect();
        resolve_overrides(&mut snapshot.skills, &all);
        let overridden: Vec<(&str, Option<&str>)> = snapshot
            .skills
            .iter()
            .map(|s| (s.key.as_str(), s.overridden_by.as_deref()))
            .collect();
        // The project's pdf is off, so the user's takes the name; the untrusted project skill
        // takes no part.
        assert_eq!(
            overridden,
            [
                ("oarlock/pdf", Some("user/pdf")),
                ("oarlock/only", None),
                ("user/pdf", None),
                ("claude-project/pdf@/p", None),
                ("terax-project/only@/p", None),
            ]
        );
        assert!(!snapshot.skills[3].enabled);
        assert!(!snapshot.skills[4].trusted);
    }

    fn write_skill(dir: &Path, name: &str) {
        std::fs::create_dir_all(dir.join(name)).unwrap();
        std::fs::write(
            dir.join(name).join(SKILL_FILE),
            format!(
                "---\nname: {name}\ndescription: {name} from {}\n---\nBody\n",
                dir.display()
            ),
        )
        .unwrap();
    }

    #[test]
    fn untrusted_project_skills_never_reach_a_conversation() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let oarlock = root.join("oarlock");
        let user = root.join("user");
        let project_root = root.join("project");
        write_skill(&oarlock, "pdf");
        write_skill(&user, "pdf");
        write_skill(&user, "notes");
        write_skill(&project_root.join(".claude/skills"), "pdf");
        write_skill(&project_root.join(".terax/skills"), "deploy");
        let globals = [
            Source {
                kind: SourceKind::Oarlock,
                dir: oarlock.clone(),
                display: "T".into(),
                confine: None,
            },
            Source {
                kind: SourceKind::User,
                dir: user.clone(),
                display: "U".into(),
                confine: None,
            },
        ];
        let project = OpenProject {
            real: project_root.clone(),
            key: to_canon(&project_root),
            root: "/work/project".into(),
            workspace: WorkspaceEnv::Local,
        };
        let none = BTreeSet::new();
        let listed = |snapshot: &Snapshot| -> Vec<(String, bool)> {
            snapshot
                .skills
                .iter()
                .map(|s| (s.key.clone(), s.overridden_by.is_none()))
                .collect()
        };

        let untrusted = collect_from(
            &globals,
            std::slice::from_ref(&project),
            false,
            &none,
            &|_, _, _| false,
        );
        assert_eq!(
            listed(&untrusted),
            [
                ("oarlock/pdf".to_owned(), false),
                ("user/notes".to_owned(), true),
                ("user/pdf".to_owned(), true),
            ]
        );

        let only_oarlock_item =
            |_: &OpenProject, kind: ItemKind, _: &str| kind == ItemKind::TeraxSkills;
        let partly = collect_from(
            &globals,
            std::slice::from_ref(&project),
            false,
            &none,
            &only_oarlock_item,
        );
        assert!(partly
            .skills
            .iter()
            .all(|s| s.source != SourceKind::ClaudeProject));
        let deploy = partly.skills.iter().find(|s| s.name == "deploy").unwrap();
        assert_eq!(deploy.dir, "/work/project/.terax/skills/deploy");
        assert_eq!(
            deploy.key,
            format!("terax-project/deploy@{}", to_canon(&project_root))
        );

        let trusted = collect_from(
            &globals,
            std::slice::from_ref(&project),
            false,
            &none,
            &|_, _, _| true,
        );
        let winner = trusted
            .skills
            .iter()
            .find(|s| s.name == "pdf" && s.overridden_by.is_none())
            .unwrap();
        assert_eq!(winner.source, SourceKind::ClaudeProject);

        // Settings lists the untrusted items too, marked, and overrides stay within a context.
        let settings = collect_from(
            &globals,
            std::slice::from_ref(&project),
            true,
            &none,
            &|_, _, _| false,
        );
        let project_pdf = settings
            .skills
            .iter()
            .find(|s| s.source == SourceKind::ClaudeProject)
            .unwrap();
        assert!(!project_pdf.trusted);
        let user_pdf = settings
            .skills
            .iter()
            .find(|s| s.key == "user/pdf")
            .unwrap();
        assert!(user_pdf.overridden_by.is_none());
    }

    #[test]
    fn a_repository_names_a_root_skill() {
        assert_eq!(
            repository_name("https://github.com/o/PDF-Tools.git", None),
            "pdf-tools"
        );
        assert_eq!(repository_name("git@host:team/skills.git", None), "skills");
        assert_eq!(
            repository_name("https://github.com/o/r.git", Some("skills/pdf")),
            "pdf"
        );
    }

    #[test]
    fn entry_details_are_single_line_and_capped() {
        assert_eq!(truncate("a\n  b", 10), "a b");
        assert_eq!(truncate(&"x".repeat(300), 10).chars().count(), 10);
    }
}
