//! A project's `.mcp.json` (Claude Code's format: `{"mcpServers": {...}}`), used only through
//! the shared project trust: an `ItemKind::McpJson` item whose inspector lists each server's
//! command or URL, hashed by content, so a change asks again. Its servers belong to the windows
//! that have the project open, run only while the user allows the file's current content, and
//! are never trusted automatically (the page keeps the per-server Trusted switch, bound to the
//! server's own entry).
//!
//! The page lists the servers as written; the backend expands `${VAR}` and `${VAR:-default}`
//! (as Claude Code does) from the shell environment when it starts one, so the values never
//! pass through the page, and checks the trust again then and on every message or request.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use reqwest::Url;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Webview};

use super::import::{self, RawEntry, RawTransport};
use crate::modules::project_trust::{
    self, item_path, open_projects, Inspected, ItemEntry, ItemKind, ItemState, OpenProject,
};

pub const FILE: &str = ".mcp.json";
const MAX_FILE: u64 = 1024 * 1024;
const MAX_ENTRIES: usize = 50;
const ID_PREFIX: &str = "prj-";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A project server's id: stable for the project and the server's name, so its switches in
/// Settings keep, and distinct from every id Settings generates (UUIDs).
pub fn server_id(project_key: &str, name: &str) -> String {
    let project = hex(&Sha256::digest(project_key.as_bytes()));
    let server = hex(&Sha256::digest(name.as_bytes()));
    format!("{ID_PREFIX}{}-{}", &project[..12], &server[..12])
}

pub fn is_project_server(id: &str) -> bool {
    id.starts_with(ID_PREFIX)
}

// ---- Variables ----

fn valid_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    matches!(bytes.next(), Some(b) if b.is_ascii_alphabetic() || b == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Expands `${VAR}` and `${VAR:-default}`. A variable that is not set and has no default is
/// left as written and named in `missing` (Claude Code reports it and goes on). `$VAR` and
/// anything else in braces are left alone.
pub fn expand(
    text: &str,
    lookup: &dyn Fn(&str) -> Option<String>,
    missing: &mut Vec<String>,
) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let inner = &after[..end];
        let (name, default) = match inner.split_once(":-") {
            Some((name, default)) => (name, Some(default)),
            None => (inner, None),
        };
        if valid_name(name) {
            match (lookup(name), default) {
                (Some(value), _) => out.push_str(&value),
                (None, Some(default)) => out.push_str(default),
                (None, None) => {
                    if !missing.iter().any(|m| m == name) {
                        missing.push(name.to_owned());
                    }
                    out.push_str(&rest[start..start + 2 + end + 1]);
                }
            }
        } else {
            out.push_str(&rest[start..start + 2 + end + 1]);
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

/// The variables a text reads.
fn variables(text: &str, out: &mut BTreeSet<String>) {
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else { return };
        let name = after[..end].split(":-").next().unwrap_or("");
        if valid_name(name) {
            out.insert(name.to_owned());
        }
        rest = &after[end + 1..];
    }
}

fn entry_variables(transport: &RawTransport) -> Vec<String> {
    let mut out = BTreeSet::new();
    match transport {
        RawTransport::Stdio {
            command, args, env, ..
        } => {
            variables(command, &mut out);
            for arg in args {
                variables(arg, &mut out);
            }
            for (_, value) in env {
                variables(value, &mut out);
            }
        }
        RawTransport::Remote { url, headers, .. } => {
            variables(url, &mut out);
            for (_, value) in headers {
                variables(value, &mut out);
            }
        }
    }
    out.into_iter().collect()
}

// ---- The file ----

/// A server of a `.mcp.json`.
#[derive(Clone, Debug)]
pub struct ProjectEntry {
    pub id: String,
    pub raw: RawEntry,
    pub variables: Vec<String>,
}

/// The servers a `.mcp.json` declares, by name.
pub fn parse(bytes: &[u8], project_key: &str) -> Result<Vec<ProjectEntry>, String> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|e| format!("not valid JSON: {e}"))?;
    let Some(object) = value.as_object() else {
        return Err("not a JSON object".into());
    };
    let Some(servers) = object.get("mcpServers") else {
        return Ok(Vec::new());
    };
    let servers = servers
        .as_object()
        .ok_or("its mcpServers is not an object")?;
    Ok(import::parse_map(servers)
        .into_iter()
        .map(|raw| ProjectEntry {
            id: server_id(project_key, &raw.name),
            variables: raw
                .transport
                .as_ref()
                .map(entry_variables)
                .unwrap_or_default(),
            raw,
        })
        .collect())
}

/// A project's `.mcp.json` as read.
pub struct McpJson {
    /// Its real path.
    pub path: PathBuf,
    /// SHA-256 of its content.
    pub hash: String,
    pub entries: Vec<ProjectEntry>,
}

/// The `.mcp.json` of the project at `root` (a real path), or why it cannot be used. None when
/// the project has none.
pub fn read(root: &Path, project_key: &str) -> Option<Result<McpJson, String>> {
    let real = match item_path(root, ItemKind::McpJson)? {
        Ok(real) => real,
        Err(problem) => return Some(Err(problem)),
    };
    Some((|| {
        let meta = std::fs::metadata(&real).map_err(|e| e.to_string())?;
        if !meta.is_file() {
            return Err(format!("{FILE} is not a file"));
        }
        if meta.len() > MAX_FILE {
            return Err(format!("{FILE} is larger than 1 MiB, too large to review"));
        }
        let bytes = std::fs::read(&real).map_err(|e| e.to_string())?;
        let hash = hex(&Sha256::digest(&bytes));
        let entries = parse(&bytes, project_key).map_err(|e| format!("{FILE} is {e}"))?;
        Ok(McpJson {
            path: real.clone(),
            hash,
            entries,
        })
    })())
}

fn quote(word: &str) -> String {
    if word.is_empty() {
        "\"\"".to_owned()
    } else if word.contains(char::is_whitespace) || word.contains(['"', '\'']) {
        format!("{word:?}")
    } else {
        word.to_owned()
    }
}

/// What the trust prompt says about a server: its command line or URL, and the variables it
/// reads from the user's environment.
pub fn describe(entry: &ProjectEntry) -> String {
    let what = match (&entry.raw.transport, &entry.raw.problem) {
        (_, Some(problem)) => return format!("Cannot be used: {problem}"),
        (Some(RawTransport::Stdio { command, args, .. }), _) => std::iter::once(command)
            .chain(args)
            .map(|w| quote(w))
            .collect::<Vec<_>>()
            .join(" "),
        (Some(RawTransport::Remote { sse, url, .. }), _) => {
            format!("{} {url}", if *sse { "SSE" } else { "Remote (HTTP)" })
        }
        (None, None) => return String::new(),
    };
    if entry.variables.is_empty() {
        what
    } else {
        format!(
            "{what} · reads {} from your environment",
            entry.variables.join(", ")
        )
    }
}

/// Each server as the user reviews it: its name, and what it runs.
fn review(entries: &[ProjectEntry]) -> Vec<ItemEntry> {
    let mut listed: Vec<ItemEntry> = entries
        .iter()
        .take(MAX_ENTRIES)
        .map(|entry| ItemEntry {
            title: entry.raw.name.clone(),
            detail: describe(entry),
        })
        .collect();
    if entries.len() > MAX_ENTRIES {
        listed.push(ItemEntry {
            title: format!("{} more servers", entries.len() - MAX_ENTRIES),
            detail: String::new(),
        });
    }
    listed
}

/// The trust prompt's view of a project's `.mcp.json` (`project_trust::inspect`).
pub fn inspect(root: &Path) -> Option<Inspected> {
    let path = root.join(FILE);
    let key = crate::modules::fs::to_canon(root);
    match read(root, &key)? {
        Err(problem) => Some(Inspected {
            kind: ItemKind::McpJson,
            path,
            hash: Err(problem),
            entries: Vec::new(),
        }),
        // A file with no server in it provides nothing to ask about.
        Ok(file) if file.entries.is_empty() => None,
        Ok(McpJson {
            path: real,
            hash,
            entries,
        }) => Some(Inspected {
            kind: ItemKind::McpJson,
            path: real,
            hash: Ok(hash),
            entries: review(&entries),
        }),
    }
}

// ---- What the page sees ----

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NamedValue {
    name: String,
    secret: bool,
    value: String,
}

/// A transport as the page's configuration has it, values as written.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TransportView {
    Stdio {
        command: String,
        args: Vec<String>,
        env: Vec<NamedValue>,
        cwd: Option<String>,
    },
    Http {
        url: String,
        headers: Vec<NamedValue>,
    },
    Sse {
        url: String,
        headers: Vec<NamedValue>,
    },
}

fn named(values: &[(String, String)]) -> Vec<NamedValue> {
    values
        .iter()
        .map(|(name, value)| NamedValue {
            name: name.clone(),
            secret: false,
            value: value.clone(),
        })
        .collect()
}

fn view(transport: &RawTransport) -> TransportView {
    match transport {
        RawTransport::Stdio {
            command, args, env, ..
        } => TransportView::Stdio {
            command: command.clone(),
            args: args.clone(),
            env: named(env),
            cwd: None,
        },
        RawTransport::Remote { sse, url, headers } => {
            let headers = named(headers);
            if *sse {
                TransportView::Sse {
                    url: url.clone(),
                    headers,
                }
            } else {
                TransportView::Http {
                    url: url.clone(),
                    headers,
                }
            }
        }
    }
}

fn entry_hash(raw: &RawEntry) -> String {
    raw.fingerprint.clone()
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectServerView {
    pub id: String,
    pub name: String,
    pub transport: Option<TransportView>,
    /// The entry's own hash: the Trusted switch holds only for the entry it was set for.
    pub entry_hash: String,
    pub variables: Vec<String>,
    pub warnings: Vec<String>,
    pub problem: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectServers {
    pub project: OpenProject,
    /// The file, spelled as the window spells the project.
    pub path: String,
    pub state: ItemState,
    /// The content hash a decision is made for.
    pub hash: Option<String>,
    pub problem: Option<String>,
    /// What each server runs, for review (as the trust prompt lists it).
    pub entries: Vec<ItemEntry>,
    /// Listed only while the user allows the file's current content.
    pub servers: Vec<ProjectServerView>,
}

fn listing(app: &AppHandle, project: &OpenProject) -> Option<ProjectServers> {
    let read = read(&project.real, &project.key)?;
    let hash = read
        .as_ref()
        .map(|file| file.hash.clone())
        .map_err(Clone::clone);
    let state = project_trust::decision_state(app, &project.key, ItemKind::McpJson, &hash);
    let (problem, listed, servers) = match read {
        Err(problem) => (Some(problem), Vec::new(), Vec::new()),
        Ok(file) if file.entries.is_empty() => return None,
        Ok(McpJson { entries, .. }) => (
            None,
            review(&entries),
            if state == ItemState::Allowed {
                entries
                    .into_iter()
                    .map(|entry| ProjectServerView {
                        id: entry.id,
                        name: entry.raw.name.clone(),
                        transport: entry.raw.transport.as_ref().map(view),
                        entry_hash: entry_hash(&entry.raw),
                        variables: entry.variables,
                        warnings: entry.raw.warnings,
                        problem: entry.raw.problem,
                    })
                    .collect()
            } else {
                Vec::new()
            },
        ),
    };
    Some(ProjectServers {
        path: project.display_path(FILE),
        project: project.clone(),
        state,
        hash: hash.ok(),
        problem,
        entries: listed,
        servers,
    })
}

/// The project servers of the calling window's project, or with `all` (Settings) of every
/// open project.
#[tauri::command]
pub async fn mcp_project_servers(
    app: AppHandle,
    webview: Webview,
    all: bool,
) -> Result<Vec<ProjectServers>, String> {
    let label = webview.label().to_owned();
    if all && label != super::SETTINGS_WINDOW {
        return Err("mcp: only Settings lists every project".into());
    }
    crate::modules::fs::blocking(move || {
        let projects = if all {
            open_projects(&app)
        } else {
            project_trust::window_project(&app, &label)
                .into_iter()
                .collect()
        };
        Ok(projects
            .iter()
            .filter_map(|project| listing(&app, project))
            .collect())
    })
    .await
}

// ---- Starting one ----

/// What a running project server was started from; checked again on every message.
#[derive(Clone, Debug)]
pub struct Binding {
    pub window: String,
    pub key: String,
    pub path: PathBuf,
    pub hash: String,
}

/// Whether the server may still run: its window still has the project open, and the user
/// still allows the file's content as it was when the server started.
pub fn still_allowed(app: &AppHandle, binding: &Binding) -> bool {
    project_trust::window_project(app, &binding.window).is_some_and(|p| p.key == binding.key)
        && project_trust::file_hash(&binding.path).is_ok_and(|hash| hash == binding.hash)
        && project_trust::is_allowed(app, &binding.key, ItemKind::McpJson, &binding.hash)
}

/// A server of an allowed `.mcp.json` of `project`.
fn allowed_entry(
    app: &AppHandle,
    project: &OpenProject,
    server_id: &str,
) -> Result<(ProjectEntry, Binding), String> {
    let McpJson {
        path,
        hash,
        entries,
    } = read(&project.real, &project.key).ok_or_else(|| format!("the project has no {FILE}"))??;
    if !project_trust::is_allowed(app, &project.key, ItemKind::McpJson, &hash) {
        return Err(format!(
            "the project's {FILE} is not allowed (or changed since); answer the prompt in its window"
        ));
    }
    let entry = entries
        .into_iter()
        .find(|e| e.id == server_id)
        .ok_or_else(|| format!("the server is no longer in the project's {FILE}"))?;
    if let Some(problem) = &entry.raw.problem {
        return Err(format!("{}: {problem}", entry.raw.name));
    }
    Ok((
        entry,
        Binding {
            window: String::new(),
            key: project.key.clone(),
            path,
            hash,
        },
    ))
}

/// A project server of the calling window's project, with what it is bound to.
pub fn resolve(
    app: &AppHandle,
    window: &str,
    server_id: &str,
) -> Result<(ProjectEntry, OpenProject, Binding), String> {
    let project =
        project_trust::window_project(app, window).ok_or("mcp: this window has no project open")?;
    let (entry, mut binding) = allowed_entry(app, &project, server_id)?;
    binding.window = window.to_owned();
    Ok((entry, project, binding))
}

pub type Lookup = HashMap<String, String>;

/// Looks a variable up in the shell environment Terax gives servers, then its own.
pub fn lookup(shell: &Lookup) -> impl Fn(&str) -> Option<String> + '_ {
    move |name| {
        shell
            .get(name)
            .cloned()
            .or_else(|| std::env::var(name).ok())
    }
}

/// A local server ready to start: every value expanded.
pub struct StdioLaunch {
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub missing: Vec<String>,
}

pub fn stdio_launch(
    entry: &ProjectEntry,
    vars: &dyn Fn(&str) -> Option<String>,
) -> Result<StdioLaunch, String> {
    let Some(RawTransport::Stdio {
        command, args, env, ..
    }) = &entry.raw.transport
    else {
        return Err("mcp: not a local server".into());
    };
    let mut missing = Vec::new();
    Ok(StdioLaunch {
        command: expand(command, vars, &mut missing),
        args: args.iter().map(|a| expand(a, vars, &mut missing)).collect(),
        env: env
            .iter()
            .map(|(name, value)| (name.clone(), expand(value, vars, &mut missing)))
            .collect(),
        missing,
    })
}

/// A remote server ready to open: URL and headers expanded.
pub struct RemoteLaunch {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub missing: Vec<String>,
}

pub fn remote_launch(
    entry: &ProjectEntry,
    vars: &dyn Fn(&str) -> Option<String>,
) -> Result<RemoteLaunch, String> {
    let Some(RawTransport::Remote { url, headers, .. }) = &entry.raw.transport else {
        return Err("mcp: not a remote server".into());
    };
    let mut missing = Vec::new();
    Ok(RemoteLaunch {
        url: expand(url, vars, &mut missing),
        headers: headers
            .iter()
            .map(|(name, value)| (name.clone(), expand(value, vars, &mut missing)))
            .collect(),
        missing,
    })
}

/// The expanded URL of a project's remote server, for sign-in (Settings): looked up among the
/// open projects that allow their `.mcp.json`.
pub fn server_url(app: &AppHandle, server_id: &str, shell: Option<String>) -> Result<Url, String> {
    let env = crate::modules::lsp::env::server_env_overlay(shell);
    let vars = lookup(&env);
    for project in open_projects(app) {
        let Ok((entry, _)) = allowed_entry(app, &project, server_id) else {
            continue;
        };
        let url = remote_launch(&entry, &vars)?.url;
        return super::http::parse_server_url(&url);
    }
    Err("mcp: no open project allows this server".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(name: &str) -> Option<String> {
        match name {
            "HOME" => Some("/home/me".into()),
            "EMPTY" => Some(String::new()),
            "TOKEN" => Some("t0k".into()),
            _ => None,
        }
    }

    fn run(text: &str) -> (String, Vec<String>) {
        let mut missing = Vec::new();
        let out = expand(text, &vars, &mut missing);
        (out, missing)
    }

    #[test]
    fn expands_like_claude_code() {
        assert_eq!(run("${HOME}/bin").0, "/home/me/bin");
        assert_eq!(run("Bearer ${TOKEN}").0, "Bearer t0k");
        assert_eq!(run("${UNSET:-fallback}").0, "fallback");
        assert_eq!(run("${HOME:-fallback}").0, "/home/me");
        assert_eq!(run("${EMPTY:-x}").0, "", "set, even empty, wins");
        assert_eq!(run("${UNSET:-}").0, "");
        assert_eq!(
            run("a${HOME}b${TOKEN}c").0,
            "a/home/meb t0kc".replace(' ', "")
        );
    }

    #[test]
    fn unset_variables_stay_as_written_and_are_reported() {
        let (out, missing) = run("${UNSET}/x ${UNSET} ${ALSO}");
        assert_eq!(out, "${UNSET}/x ${UNSET} ${ALSO}");
        assert_eq!(missing, ["UNSET", "ALSO"]);
    }

    #[test]
    fn other_forms_are_left_alone() {
        for text in [
            "$HOME",
            "${env:HOME}",
            "${1BAD}",
            "${",
            "${HOME",
            "x}",
            "${}",
        ] {
            assert_eq!(run(text), (text.to_owned(), vec![]), "{text}");
        }
    }

    const FILE_TEXT: &str = r#"{
      "mcpServers": {
        "db": {"command": "npx", "args": ["-y", "db-mcp", "--url", "${DB_URL:-postgres://localhost}"],
               "env": {"TOKEN": "${TOKEN}"}},
        "api": {"type": "http", "url": "https://api.example.com/mcp", "headers": {"Authorization": "Bearer ${API_KEY}"}},
        "broken": {"type": "ws", "url": "wss://x"}
      }
    }"#;

    #[test]
    fn the_file_lists_each_server_with_what_it_runs() {
        let entries = parse(FILE_TEXT.as_bytes(), "/p").unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.raw.name.as_str()).collect();
        assert_eq!(names, ["api", "broken", "db"]);
        assert_eq!(entries[0].variables, ["API_KEY"]);
        assert_eq!(
            describe(&entries[0]),
            "Remote (HTTP) https://api.example.com/mcp · reads API_KEY from your environment"
        );
        assert!(describe(&entries[1]).starts_with("Cannot be used"));
        assert_eq!(
            describe(&entries[2]),
            "npx -y db-mcp --url ${DB_URL:-postgres://localhost} · reads DB_URL, TOKEN from your environment"
        );
        assert!(parse(b"[]", "/p").is_err());
        assert!(parse(b"{nope", "/p").is_err());
        assert!(parse(br#"{"mcpServers": 3}"#, "/p").is_err());
        assert!(parse(b"{}", "/p").unwrap().is_empty());
    }

    #[test]
    fn ids_are_stable_per_project_and_name() {
        let a = server_id("/p", "db");
        assert_eq!(a, server_id("/p", "db"));
        assert_ne!(a, server_id("/q", "db"));
        assert_ne!(a, server_id("/p", "db2"));
        assert!(is_project_server(&a));
        assert!(super::super::names::valid_server_id(&a));
        assert!(!is_project_server("6f1c2a5e-0b9d-4c3e-8f7a-1d2e3f4a5b6c"));
    }

    #[test]
    fn launches_expand_every_value() {
        let entries = parse(FILE_TEXT.as_bytes(), "/p").unwrap();
        let launch = stdio_launch(&entries[2], &vars).unwrap();
        assert_eq!(launch.command, "npx");
        assert_eq!(launch.args[3], "postgres://localhost");
        assert_eq!(launch.env, [("TOKEN".to_owned(), "t0k".to_owned())]);
        assert!(launch.missing.is_empty());
        let remote = remote_launch(&entries[0], &vars).unwrap();
        assert_eq!(remote.headers[0].1, "Bearer ${API_KEY}");
        assert_eq!(remote.missing, ["API_KEY"]);
        assert!(stdio_launch(&entries[0], &vars).is_err());
        assert!(remote_launch(&entries[2], &vars).is_err());
    }

    #[test]
    fn the_inspector_hashes_the_file_and_refuses_what_it_cannot_review() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        assert!(inspect(&root).is_none(), "no file, nothing to ask");
        std::fs::write(root.join(FILE), FILE_TEXT).unwrap();
        let first = inspect(&root).unwrap();
        assert_eq!(first.kind, ItemKind::McpJson);
        assert_eq!(first.entries.len(), 3);
        let hash = first.hash.clone().unwrap();
        assert_eq!(hash, project_trust::file_hash(&root.join(FILE)).unwrap());
        std::fs::write(root.join(FILE), FILE_TEXT.replace("db-mcp", "evil-mcp")).unwrap();
        assert_ne!(
            inspect(&root).unwrap().hash.unwrap(),
            hash,
            "a change asks again"
        );
        std::fs::write(root.join(FILE), "{broken").unwrap();
        assert!(inspect(&root).unwrap().hash.is_err());
        std::fs::write(root.join(FILE), r#"{"mcpServers": {}}"#).unwrap();
        assert!(inspect(&root).is_none());
        std::fs::write(root.join(FILE), vec![b' '; MAX_FILE as usize + 1]).unwrap();
        assert!(inspect(&root)
            .unwrap()
            .hash
            .unwrap_err()
            .contains("too large"));
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            std::fs::write(outside.path().join("x.json"), FILE_TEXT).unwrap();
            std::fs::remove_file(root.join(FILE)).unwrap();
            std::os::unix::fs::symlink(outside.path().join("x.json"), root.join(FILE)).unwrap();
            assert!(inspect(&root)
                .unwrap()
                .hash
                .unwrap_err()
                .contains("outside the project"));
        }
    }
}
