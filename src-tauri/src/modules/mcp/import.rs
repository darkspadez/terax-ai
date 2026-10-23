//! Importing MCP servers from other apps' configuration: Claude Desktop, Claude Code (its user
//! scope), Cursor and VS Code (user `settings.json` and `mcp.json`), each at its fixed path on
//! this OS. The files are outside every folder limit, so nothing here reads anything else, and
//! nothing but parsed server entries leaves: values that look like secrets never do (the import
//! writes them to the keychain itself, `mcp_import_secrets`).
//!
//! The entry parser is shared with a project's `.mcp.json` (Claude Code's format).

use std::collections::HashMap;
use std::io::BufReader;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, WebviewWindow};

use super::names::{
    secret_account, valid_env_name, valid_header_name, valid_value, SecretKind, SECRET_SERVICE,
};
use super::{jsonc, require_server_id, require_settings};

const MAX_FILE: u64 = 8 * 1024 * 1024;
/// `~/.claude.json` also keeps Claude Code's project history; it is streamed, never held.
const MAX_CLAUDE_JSON: u64 = 512 * 1024 * 1024;
const MAX_SERVERS: usize = 200;
const MAX_TEXT: usize = 32 * 1024;
const MAX_ARGS: usize = 256;
/// Headers the backend owns (`http.rs`); an imported one is dropped.
const RESERVED_HEADERS: &[&str] = &[
    "host",
    "content-length",
    "connection",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "transfer-encoding",
    "upgrade",
    "trailer",
    "expect",
    "cookie",
];

/// Whose configuration a file is, which decides how its variables read.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum App {
    ClaudeDesktop,
    ClaudeCode,
    Cursor,
    Vscode,
}

impl App {
    const ALL: [App; 4] = [
        App::ClaudeDesktop,
        App::ClaudeCode,
        App::Cursor,
        App::Vscode,
    ];

    fn label(self) -> &'static str {
        match self {
            App::ClaudeDesktop => "Claude Desktop",
            App::ClaudeCode => "Claude Code",
            App::Cursor => "Cursor",
            App::Vscode => "VS Code",
        }
    }

    /// `${env:NAME}` (VS Code, Cursor) rather than `${NAME}` (Claude).
    fn env_prefix(self) -> &'static str {
        match self {
            App::Cursor | App::Vscode => "env:",
            App::ClaudeDesktop | App::ClaudeCode => "",
        }
    }
}

/// The files an app keeps its servers in, on this OS: `config` is the platform's
/// configuration folder (`~/Library/Application Support`, `%APPDATA%`, `~/.config`).
pub fn paths(app: App, home: &Path, config: &Path) -> Vec<PathBuf> {
    match app {
        App::ClaudeDesktop => vec![config.join("Claude").join("claude_desktop_config.json")],
        App::ClaudeCode => vec![home.join(".claude.json")],
        App::Cursor => vec![home.join(".cursor").join("mcp.json")],
        App::Vscode => {
            let user = config.join("Code").join("User");
            vec![user.join("settings.json"), user.join("mcp.json")]
        }
    }
}

// ---- Entries ----

/// A server's transport as its file has it, values unprocessed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RawTransport {
    Stdio {
        command: String,
        args: Vec<String>,
        env: Vec<(String, String)>,
        cwd: Option<String>,
    },
    Remote {
        sse: bool,
        url: String,
        headers: Vec<(String, String)>,
    },
}

/// A client the entry configures for sign-in (Claude Code's `oauth`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OauthEntry {
    pub client_id: Option<String>,
    pub scopes: Option<String>,
    pub callback_port: Option<u16>,
}

#[derive(Clone, Debug)]
pub struct RawEntry {
    pub name: String,
    pub transport: Option<RawTransport>,
    pub oauth: Option<OauthEntry>,
    pub warnings: Vec<String>,
    /// Why it cannot be used, when it cannot.
    pub problem: Option<String>,
    /// SHA-256 of the entry as written.
    pub fingerprint: String,
}

fn text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
    .filter(|s| s.len() <= MAX_TEXT)
}

fn pairs(value: Option<&Value>, what: &str, warnings: &mut Vec<String>) -> Vec<(String, String)> {
    let Some(value) = value else {
        return Vec::new();
    };
    let Some(map) = value.as_object() else {
        warnings.push(format!(
            "its {what} are not a list of names and values; they were left out"
        ));
        return Vec::new();
    };
    map.iter()
        .filter_map(|(name, value)| match text(value) {
            Some(value) => Some((name.clone(), value)),
            None => {
                warnings.push(format!("{name} has no usable value; it was left out"));
                None
            }
        })
        .collect()
}

fn fingerprint(value: &Value) -> String {
    let digest = Sha256::digest(serde_json::to_vec(value).unwrap_or_default());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// One entry of an `mcpServers` (or VS Code `servers`) map.
pub fn parse_entry(name: &str, value: &Value) -> RawEntry {
    let mut entry = RawEntry {
        name: name.to_owned(),
        transport: None,
        oauth: None,
        warnings: Vec::new(),
        problem: None,
        fingerprint: fingerprint(value),
    };
    let Some(obj) = value.as_object() else {
        entry.problem = Some("not a server entry".into());
        return entry;
    };
    let kind = obj
        .get("type")
        .and_then(Value::as_str)
        .map(|t| t.trim().to_ascii_lowercase());
    let command = obj.get("command").and_then(Value::as_str).map(str::trim);
    let url = obj
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|u| !u.is_empty());
    let stdio = match kind.as_deref() {
        Some("stdio") => true,
        Some("http" | "streamable-http" | "streamablehttp" | "sse") => false,
        Some("ws") => {
            entry.problem = Some("WebSocket servers are not supported".into());
            return entry;
        }
        Some(other) => {
            entry.problem = Some(format!("its type {other:?} is not supported"));
            return entry;
        }
        None if command.is_some() => true,
        None if url.is_some() => {
            entry
                .warnings
                .push("it names no type; it was read as a Streamable HTTP server".into());
            false
        }
        None => {
            entry.problem = Some("it has neither a command nor a URL".into());
            return entry;
        }
    };
    let mut warnings = Vec::new();
    if stdio {
        let Some(command) = command.filter(|c| !c.is_empty() && c.len() <= 4096) else {
            entry.problem = Some("it has no command".into());
            return entry;
        };
        let mut args = Vec::new();
        if let Some(raw) = obj.get("args") {
            match raw.as_array() {
                Some(list) => {
                    for arg in list.iter().take(MAX_ARGS) {
                        match text(arg) {
                            Some(arg) => args.push(arg),
                            None => {
                                warnings.push("an argument that is not text was left out".into())
                            }
                        }
                    }
                }
                None => warnings.push("its arguments are not a list; they were left out".into()),
            }
        }
        if obj.contains_key("envFile") {
            warnings.push("it reads an envFile, which Oarlock does not; add those variables".into());
        }
        entry.transport = Some(RawTransport::Stdio {
            command: command.to_owned(),
            args,
            env: pairs(obj.get("env"), "environment variables", &mut warnings),
            cwd: obj
                .get("cwd")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|c| !c.is_empty())
                .map(str::to_owned),
        });
    } else {
        let Some(url) = url.filter(|u| u.len() <= 4096) else {
            entry.problem = Some("it has no URL".into());
            return entry;
        };
        if obj.contains_key("headersHelper") {
            warnings.push(
                "it gets headers from a helper command, which Oarlock does not run; add the headers it makes"
                    .into(),
            );
        }
        entry.transport = Some(RawTransport::Remote {
            sse: kind.as_deref() == Some("sse"),
            url: url.to_owned(),
            headers: pairs(obj.get("headers"), "headers", &mut warnings),
        });
    }
    if let Some(oauth) = obj.get("oauth").and_then(Value::as_object) {
        if oauth.contains_key("authServerMetadataUrl") {
            warnings.push(
                "its authServerMetadataUrl is not used; Oarlock discovers the server's sign-in"
                    .into(),
            );
        }
        entry.oauth = Some(OauthEntry {
            client_id: oauth
                .get("clientId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty() && s.len() <= 2048)
                .map(str::to_owned),
            scopes: oauth
                .get("scopes")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty() && s.len() <= 2048)
                .map(str::to_owned),
            callback_port: oauth
                .get("callbackPort")
                .and_then(Value::as_u64)
                .and_then(|p| u16::try_from(p).ok())
                .filter(|p| *p > 0),
        });
    }
    if obj.get("disabled").and_then(Value::as_bool) == Some(true) {
        warnings.push("it is turned off there".into());
    }
    entry.warnings.extend(warnings);
    entry
}

/// The entries of a servers map, in name order.
pub fn parse_map(map: &Map<String, Value>) -> Vec<RawEntry> {
    map.iter()
        .take(MAX_SERVERS)
        .map(|(name, value)| parse_entry(name, value))
        .collect()
}

// ---- Variables and secrets ----

/// A placeholder in a value: `${...}`, its inside.
fn placeholders(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else { break };
        out.push(&after[..end]);
        rest = &after[end + 1..];
    }
    out
}

/// Words in a name that mark a secret value.
const SECRET_WORDS: &[&str] = &[
    "key",
    "token",
    "secret",
    "password",
    "passwd",
    "pwd",
    "pass",
    "auth",
    "credential",
    "cookie",
    "session",
    "bearer",
    "private",
    "cert",
];
/// Prefixes of well-known credentials.
const SECRET_PREFIXES: &[&str] = &[
    "bearer ",
    "basic ",
    "sk-",
    "sk_",
    "pk_",
    "rk_",
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "github_pat_",
    "glpat-",
    "xoxb-",
    "xoxp-",
    "xapp-",
    "akia",
    "aiza",
    "eyj",
    "ya29.",
    "shpat_",
    "npm_",
];

/// Whether a value is probably a secret, by its name or its look. Errs toward yes: a secret
/// value goes to the keychain, a plain one into the store file.
pub fn looks_secret(name: &str, value: &str) -> bool {
    let name = name.to_ascii_lowercase();
    if SECRET_WORDS.iter().any(|w| name.contains(w)) {
        return true;
    }
    let lower = value.trim().to_ascii_lowercase();
    if SECRET_PREFIXES.iter().any(|p| lower.starts_with(p)) {
        return true;
    }
    // Credentials in a URL: `scheme://user:password@host`.
    if let Some((_, rest)) = lower.split_once("://") {
        let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
        if authority.contains('@') {
            return true;
        }
        return false;
    }
    // A long opaque string: no spaces, not a path, letters and digits mixed.
    let opaque = value.len() >= 24
        && !value.contains(char::is_whitespace)
        && !value.starts_with(['/', '.', '~', '\\'])
        && !value.contains(['\\', '/'])
        && value.chars().any(|c| c.is_ascii_digit())
        && value.chars().any(|c| c.is_ascii_alphabetic());
    opaque
}

/// A value as the import screen shows it. A secret one carries no value: the import writes
/// it to the keychain itself.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportValue {
    pub name: String,
    pub value: Option<String>,
    pub secret: bool,
    /// A VS Code input the user fills in: its description.
    pub input: Option<String>,
    /// How VS Code builds the value from the input, when it is more than the input.
    pub template: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ImportTransport {
    #[serde(rename_all = "camelCase")]
    Stdio {
        command: String,
        args: Vec<String>,
        env: Vec<ImportValue>,
        cwd: Option<String>,
    },
    Http {
        url: String,
        headers: Vec<ImportValue>,
    },
    Sse {
        url: String,
        headers: Vec<ImportValue>,
    },
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportedServer {
    /// Its name in the file.
    pub key: String,
    pub transport: Option<ImportTransport>,
    pub oauth: Option<OauthEntry>,
    pub warnings: Vec<String>,
    pub problem: Option<String>,
    pub fingerprint: String,
}

/// A VS Code input (`inputs` of `mcp.json` or `settings.json`'s `mcp`).
#[derive(Clone, Debug)]
pub struct Input {
    pub description: String,
}

pub fn parse_inputs(value: Option<&Value>) -> HashMap<String, Input> {
    let mut out = HashMap::new();
    for input in value.and_then(Value::as_array).into_iter().flatten() {
        let Some(id) = input.get("id").and_then(Value::as_str) else {
            continue;
        };
        let description = input
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or(id)
            .chars()
            .take(200)
            .collect();
        out.insert(id.to_owned(), Input { description });
    }
    out
}

struct Context<'a> {
    app: App,
    home: &'a str,
    inputs: &'a HashMap<String, Input>,
}

impl Context<'_> {
    /// `${userHome}` (VS Code, Cursor) filled in.
    fn fill(&self, text: &str) -> String {
        match self.app {
            App::Vscode | App::Cursor => text.replace("${userHome}", self.home),
            App::ClaudeDesktop | App::ClaudeCode => text.to_owned(),
        }
    }

    /// Notes the placeholders left in `text` that Oarlock will not fill in.
    fn warn_placeholders(&self, what: &str, text: &str, warnings: &mut Vec<String>) {
        for inner in placeholders(text) {
            warnings.push(format!(
                "{what} uses ${{{inner}}}, which Oarlock does not fill in; edit it before turning the server on"
            ));
        }
    }

    fn input_of<'b>(&self, text: &'b str) -> Option<&'b str> {
        if self.app != App::Vscode {
            return None;
        }
        placeholders(text)
            .into_iter()
            .find_map(|inner| inner.strip_prefix("input:"))
    }

    /// One environment variable or header. None when it is left out (with a note).
    fn value(
        &self,
        name: &str,
        raw: &str,
        header: bool,
        warnings: &mut Vec<String>,
    ) -> Option<ImportValue> {
        let valid = if header {
            valid_header_name(name)
                && !RESERVED_HEADERS.contains(&name.to_ascii_lowercase().as_str())
        } else {
            valid_env_name(name)
        };
        if !valid {
            warnings.push(format!("{name} cannot be set by Oarlock; it was left out"));
            return None;
        }
        let kind = if header {
            SecretKind::Header
        } else {
            SecretKind::Env
        };
        // `NAME: ${NAME}` passes the variable through: the server gets it from the shell
        // environment Oarlock starts it in anyway.
        if !header && raw.trim() == format!("${{{}{name}}}", self.app.env_prefix()) {
            warnings.push(format!("{name} comes from your shell environment"));
            return None;
        }
        let filled = self.fill(raw);
        if let Some(id) = self.input_of(&filled) {
            let description = self
                .inputs
                .get(id)
                .map_or_else(|| id.to_owned(), |input| input.description.clone());
            let whole = filled.trim() == format!("${{input:{id}}}");
            return Some(ImportValue {
                name: name.to_owned(),
                value: None,
                secret: true,
                input: Some(description),
                template: (!whole).then_some(filled),
            });
        }
        self.warn_placeholders(name, &filled, warnings);
        if !valid_value(&filled, kind) {
            warnings.push(format!(
                "{name} has a value Oarlock cannot pass on; it was left out"
            ));
            return None;
        }
        let secret = looks_secret(name, &filled);
        Some(ImportValue {
            name: name.to_owned(),
            value: (!secret).then_some(filled),
            secret,
            input: None,
            template: None,
        })
    }
}

/// What the import screen shows for an entry; the secret values stay here.
fn imported(entry: RawEntry, ctx: &Context) -> ImportedServer {
    let mut warnings = entry.warnings;
    let transport = entry.transport.map(|transport| match transport {
        RawTransport::Stdio {
            command,
            args,
            env,
            cwd,
        } => {
            let command = ctx.fill(&command);
            ctx.warn_placeholders("the command", &command, &mut warnings);
            let args: Vec<String> = args.iter().map(|a| ctx.fill(a)).collect();
            for arg in &args {
                ctx.warn_placeholders("an argument", arg, &mut warnings);
            }
            let cwd = cwd.map(|c| ctx.fill(&c));
            if let Some(cwd) = &cwd {
                ctx.warn_placeholders("the working folder", cwd, &mut warnings);
            }
            ImportTransport::Stdio {
                command,
                args,
                env: env
                    .iter()
                    .filter_map(|(name, value)| ctx.value(name, value, false, &mut warnings))
                    .collect(),
                cwd,
            }
        }
        RawTransport::Remote { sse, url, headers } => {
            let url = ctx.fill(&url);
            ctx.warn_placeholders("the URL", &url, &mut warnings);
            let headers = headers
                .iter()
                .filter_map(|(name, value)| ctx.value(name, value, true, &mut warnings))
                .collect();
            if sse {
                ImportTransport::Sse { url, headers }
            } else {
                ImportTransport::Http { url, headers }
            }
        }
    });
    ImportedServer {
        key: entry.name,
        transport,
        oauth: entry.oauth,
        warnings,
        problem: entry.problem,
        fingerprint: entry.fingerprint,
    }
}

/// The secret values of an entry, as the import writes them: (kind, name, value).
fn secret_values(entry: &RawEntry, ctx: &Context) -> Vec<(SecretKind, String, String)> {
    let (values, header) = match &entry.transport {
        Some(RawTransport::Stdio { env, .. }) => (env, false),
        Some(RawTransport::Remote { headers, .. }) => (headers, true),
        None => return Vec::new(),
    };
    let kind = if header {
        SecretKind::Header
    } else {
        SecretKind::Env
    };
    values
        .iter()
        .filter_map(|(name, raw)| {
            let shown = ctx.value(name, raw, header, &mut Vec::new())?;
            (shown.secret && shown.input.is_none()).then(|| (kind, name.clone(), ctx.fill(raw)))
        })
        .collect()
}

// ---- Files ----

#[derive(Deserialize)]
struct ClaudeJson {
    #[serde(rename = "mcpServers", default)]
    mcp_servers: Option<Map<String, Value>>,
}

fn read_text(path: &Path) -> Result<Option<String>, String> {
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > MAX_FILE {
        return Err("too large to read".into());
    }
    std::fs::read_to_string(path)
        .map(Some)
        .map_err(|e| e.to_string())
}

/// An app's server entries and the VS Code inputs they may refer to.
type Parsed = (Vec<RawEntry>, HashMap<String, Input>);

/// The servers of one app, parsed from its files' text (pure, for tests).
pub fn entries_from(app: App, texts: &[Option<String>]) -> Result<Parsed, String> {
    let parse = |text: &str| -> Result<Value, String> {
        serde_json::from_str(&jsonc::to_json(text)).map_err(|e| format!("not valid JSON: {e}"))
    };
    let mut entries = Vec::new();
    let mut inputs = HashMap::new();
    match app {
        App::ClaudeDesktop | App::ClaudeCode | App::Cursor => {
            if let Some(Some(text)) = texts.first() {
                let value = parse(text)?;
                if let Some(map) = value.get("mcpServers").and_then(Value::as_object) {
                    entries = parse_map(map);
                }
            }
        }
        App::Vscode => {
            // settings.json (`mcp.servers`), then mcp.json (`servers`), which wins a name.
            let mut by_name: Vec<RawEntry> = Vec::new();
            for (i, text) in texts.iter().enumerate() {
                let Some(text) = text else { continue };
                let value = parse(text)?;
                let section = if i == 0 {
                    value.get("mcp")
                } else {
                    Some(&value)
                };
                let Some(section) = section else { continue };
                inputs.extend(parse_inputs(section.get("inputs")));
                if let Some(map) = section.get("servers").and_then(Value::as_object) {
                    for entry in parse_map(map) {
                        match by_name.iter_mut().find(|e| e.name == entry.name) {
                            Some(slot) => *slot = entry,
                            None => by_name.push(entry),
                        }
                    }
                }
            }
            entries = by_name;
        }
    }
    Ok((entries, inputs))
}

fn read_app(app: App, files: &[PathBuf]) -> Result<Parsed, String> {
    if app == App::ClaudeCode {
        let Some(path) = files.first() else {
            return Ok(Default::default());
        };
        let file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Default::default()),
            Err(e) => return Err(e.to_string()),
        };
        let meta = file.metadata().map_err(|e| e.to_string())?;
        if !meta.is_file() || meta.len() > MAX_CLAUDE_JSON {
            return Err("not a readable file".into());
        }
        let parsed: ClaudeJson = serde_json::from_reader(BufReader::new(file))
            .map_err(|e| format!("not valid JSON: {e}"))?;
        return Ok((
            parsed
                .mcp_servers
                .as_ref()
                .map(parse_map)
                .unwrap_or_default(),
            HashMap::new(),
        ));
    }
    let texts = files
        .iter()
        .map(|path| read_text(path))
        .collect::<Result<Vec<_>, _>>()?;
    entries_from(app, &texts)
}

fn locations() -> Option<(PathBuf, PathBuf)> {
    Some((dirs::home_dir()?, dirs::config_dir()?))
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportSource {
    pub app: App,
    pub label: &'static str,
    pub paths: Vec<String>,
    /// Any of its files exists.
    pub found: bool,
    pub error: Option<String>,
    pub servers: Vec<ImportedServer>,
}

fn scan_app(app: App, home: &Path, config: &Path) -> ImportSource {
    let files = paths(app, home, config);
    let found = files.iter().any(|p| p.exists());
    let home_text = home.to_string_lossy();
    let mut source = ImportSource {
        app,
        label: app.label(),
        paths: files.iter().map(|p| p.display().to_string()).collect(),
        found,
        error: None,
        servers: Vec::new(),
    };
    if !found {
        return source;
    }
    match read_app(app, &files) {
        Ok((entries, inputs)) => {
            let ctx = Context {
                app,
                home: &home_text,
                inputs: &inputs,
            };
            source.servers = entries.into_iter().map(|e| imported(e, &ctx)).collect();
        }
        Err(error) => source.error = Some(error),
    }
    source
}

/// The servers each app has configured, for the import screen. The settings window only.
#[tauri::command]
pub async fn mcp_import_scan(window: WebviewWindow) -> Result<Vec<ImportSource>, String> {
    require_settings(&window)?;
    crate::modules::fs::blocking(|| {
        let (home, config) = locations().ok_or("no home folder")?;
        Ok(App::ALL
            .into_iter()
            .map(|app| scan_app(app, &home, &config))
            .collect())
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPick {
    app: App,
    key: String,
    fingerprint: String,
    server_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickResult {
    server_id: String,
    error: Option<String>,
}

/// Writes the secret values of the picked entries to the keychain, under the ids the new
/// servers get. Each entry is read again and must be the one the user saw.
#[tauri::command]
pub async fn mcp_import_secrets(
    app: AppHandle,
    window: WebviewWindow,
    picks: Vec<ImportPick>,
) -> Result<Vec<PickResult>, String> {
    require_settings(&window)?;
    for pick in &picks {
        require_server_id(&pick.server_id)?;
    }
    let wanted: Vec<App> = picks.iter().map(|p| p.app).collect();
    let parsed = crate::modules::fs::blocking(move || {
        let (home, config) = locations().ok_or("no home folder")?;
        let home_text = home.to_string_lossy().into_owned();
        let mut out: HashMap<App, Result<Parsed, String>> = HashMap::new();
        for app in wanted {
            out.entry(app)
                .or_insert_with(|| read_app(app, &paths(app, &home, &config)));
        }
        Ok::<_, String>((out, home_text))
    })
    .await?;
    let (files, home) = parsed;
    let mut results = Vec::new();
    for pick in picks {
        let error = async {
            let (entries, inputs) = files
                .get(&pick.app)
                .ok_or("not read")?
                .as_ref()
                .map_err(Clone::clone)?;
            let entry = entries
                .iter()
                .find(|e| e.name == pick.key && e.fingerprint == pick.fingerprint)
                .ok_or("it changed since the list was shown; import it again")?;
            let ctx = Context {
                app: pick.app,
                home: &home,
                inputs,
            };
            for (kind, name, value) in secret_values(entry, &ctx) {
                let account = secret_account(&pick.server_id, kind, &name)?;
                crate::modules::secrets::backend_set(app.clone(), SECRET_SERVICE, account, value)
                    .await?;
            }
            Ok::<(), String>(())
        }
        .await
        .err();
        results.push(PickResult {
            server_id: pick.server_id,
            error,
        });
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx<'a>(app: App, inputs: &'a HashMap<String, Input>) -> Context<'a> {
        Context {
            app,
            home: "/home/me",
            inputs,
        }
    }

    fn import(app: App, texts: &[Option<&str>]) -> Vec<ImportedServer> {
        let texts: Vec<Option<String>> = texts.iter().map(|t| t.map(str::to_owned)).collect();
        let (entries, inputs) = entries_from(app, &texts).unwrap();
        let ctx = ctx(app, &inputs);
        entries.into_iter().map(|e| imported(e, &ctx)).collect()
    }

    fn values(server: &ImportedServer) -> &[ImportValue] {
        match server.transport.as_ref().unwrap() {
            ImportTransport::Stdio { env, .. } => env,
            ImportTransport::Http { headers, .. } | ImportTransport::Sse { headers, .. } => headers,
        }
    }

    #[test]
    fn the_paths_are_each_apps_own() {
        let home = Path::new("/h");
        let config = Path::new("/c");
        assert_eq!(
            paths(App::ClaudeDesktop, home, config),
            [Path::new("/c/Claude/claude_desktop_config.json")]
        );
        assert_eq!(
            paths(App::ClaudeCode, home, config),
            [Path::new("/h/.claude.json")]
        );
        assert_eq!(
            paths(App::Cursor, home, config),
            [Path::new("/h/.cursor/mcp.json")]
        );
        assert_eq!(
            paths(App::Vscode, home, config),
            [
                Path::new("/c/Code/User/settings.json"),
                Path::new("/c/Code/User/mcp.json")
            ]
        );
    }

    const CLAUDE_DESKTOP: &str = r#"{
      "mcpServers": {
        "filesystem": {
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Desktop"]
        },
        "github": {
          "command": "docker",
          "args": ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
          "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_abc123", "LOG_LEVEL": "info" }
        }
      },
      "globalShortcut": "Ctrl+Space"
    }"#;

    #[test]
    fn claude_desktop_servers_are_read_and_secrets_held_back() {
        let servers = import(App::ClaudeDesktop, &[Some(CLAUDE_DESKTOP)]);
        assert_eq!(servers.len(), 2);
        let fs = &servers[0];
        assert_eq!(fs.key, "filesystem");
        let ImportTransport::Stdio { command, args, .. } = fs.transport.as_ref().unwrap() else {
            panic!()
        };
        assert_eq!(command, "npx");
        assert_eq!(args.len(), 3);
        let env = values(&servers[1]);
        assert_eq!(env[0].name, "GITHUB_PERSONAL_ACCESS_TOKEN");
        assert!(env[0].secret);
        assert_eq!(env[0].value, None, "the secret never leaves the backend");
        assert_eq!(env[1].value.as_deref(), Some("info"));
        assert!(!env[1].secret);
    }

    #[test]
    fn claude_code_user_servers_and_their_oauth() {
        let text = r#"{
          "numStartups": 4,
          "projects": {"/p": {"mcpServers": {"local": {"command": "x"}}}},
          "mcpServers": {
            "linear": {"type": "http", "url": "https://mcp.linear.app/mcp"},
            "api": {"type": "http", "url": "https://api.example.com/mcp",
                    "headers": {"Authorization": "Bearer ${API_TOKEN}"},
                    "oauth": {"clientId": "abc", "callbackPort": 8080, "scopes": "read write"}},
            "old": {"type": "sse", "url": "https://old.example.com/sse"},
            "pass": {"command": "srv", "env": {"GITHUB_TOKEN": "${GITHUB_TOKEN}", "MODE": "${MODE:-dev}"}},
            "sock": {"type": "ws", "url": "wss://x"},
            "helper": {"type": "http", "url": "https://h.example.com", "headersHelper": "/bin/get"}
          }
        }"#;
        let servers = import(App::ClaudeCode, &[Some(text)]);
        let names: Vec<&str> = servers.iter().map(|s| s.key.as_str()).collect();
        assert_eq!(names, ["api", "helper", "linear", "old", "pass", "sock"]);
        let api = &servers[0];
        assert_eq!(
            api.oauth,
            Some(OauthEntry {
                client_id: Some("abc".into()),
                scopes: Some("read write".into()),
                callback_port: Some(8080)
            })
        );
        assert!(values(api)[0].secret);
        assert!(api.warnings.iter().any(|w| w.contains("${API_TOKEN}")));
        assert!(servers[1]
            .warnings
            .iter()
            .any(|w| w.contains("helper command")));
        assert!(matches!(
            servers[3].transport,
            Some(ImportTransport::Sse { .. })
        ));
        let pass = &servers[4];
        assert_eq!(
            values(pass).len(),
            1,
            "GITHUB_TOKEN passes through the environment"
        );
        assert_eq!(values(pass)[0].value.as_deref(), Some("${MODE:-dev}"));
        assert!(pass
            .warnings
            .iter()
            .any(|w| w.contains("GITHUB_TOKEN comes from your shell")));
        assert!(servers[5].problem.as_deref().unwrap().contains("WebSocket"));
    }

    #[test]
    fn cursor_servers_with_urls_and_variables() {
        let text = r#"{"mcpServers": {
            "remote": {"url": "https://mcp.example.com/mcp", "headers": {"X-Api-Key": "${env:KEY}"}},
            "local": {"command": "${userHome}/bin/srv", "env": {"HOME_DIR": "${userHome}", "TOKEN": "${env:TOKEN}"}}
        }}"#;
        let servers = import(App::Cursor, &[Some(text)]);
        assert!(matches!(
            servers[1].transport,
            Some(ImportTransport::Http { .. })
        ));
        let ImportTransport::Stdio { command, env, .. } = servers[0].transport.as_ref().unwrap()
        else {
            panic!()
        };
        assert_eq!(command, "/home/me/bin/srv");
        assert_eq!(env.len(), 1);
        assert_eq!(env[0].value.as_deref(), Some("/home/me"));
    }

    #[test]
    fn vscode_reads_both_files_with_comments_and_inputs() {
        let settings = r#"{
          // editor settings
          "editor.fontSize": 13,
          "mcp": {
            "servers": {
              "shared": {"command": "old"},
              "fetch": {"type": "stdio", "command": "uvx", "args": ["mcp-server-fetch"],},
            },
          },
        }"#;
        let mcp = r#"{
          "inputs": [
            {"type": "promptString", "id": "perplexity-key", "description": "Perplexity API Key", "password": true}
          ],
          "servers": {
            "shared": {"command": "new"},
            "Perplexity": {
              "type": "stdio", "command": "npx", "args": ["-y", "server-perplexity-ask"],
              "env": {"PERPLEXITY_API_KEY": "${input:perplexity-key}", "PATH_EXTRA": "${env:HOME}/x"},
              "envFile": "${workspaceFolder}/.env"
            },
            "gh": {"type": "http", "url": "https://api.githubcopilot.com/mcp/",
                   "headers": {"Authorization": "Bearer ${input:perplexity-key}"}}
          }
        }"#;
        let servers = import(App::Vscode, &[Some(settings), Some(mcp)]);
        let names: Vec<&str> = servers.iter().map(|s| s.key.as_str()).collect();
        assert_eq!(names, ["fetch", "shared", "Perplexity", "gh"]);
        let ImportTransport::Stdio { command, .. } = servers[1].transport.as_ref().unwrap() else {
            panic!()
        };
        assert_eq!(command, "new", "mcp.json wins a name");
        let key = values(&servers[2])
            .iter()
            .find(|v| v.name == "PERPLEXITY_API_KEY")
            .unwrap();
        assert_eq!(key.input.as_deref(), Some("Perplexity API Key"));
        assert!(key.secret && key.value.is_none() && key.template.is_none());
        assert!(servers[2].warnings.iter().any(|w| w.contains("envFile")));
        assert!(servers[2]
            .warnings
            .iter()
            .any(|w| w.contains("${env:HOME}")));
        let header = &values(&servers[3])[0];
        assert_eq!(
            header.template.as_deref(),
            Some("Bearer ${input:perplexity-key}")
        );
        // Only one file present works too.
        assert_eq!(import(App::Vscode, &[None, Some(mcp)]).len(), 3);
        assert_eq!(import(App::Vscode, &[Some(settings), None]).len(), 2);
    }

    #[test]
    fn invalid_files_and_entries_are_reported() {
        assert!(entries_from(App::Cursor, &[Some("{not json".into())]).is_err());
        let servers = import(
            App::ClaudeDesktop,
            &[Some(
                r#"{"mcpServers": {"a": 3, "b": {}, "c": {"type": "carrier-pigeon"}, "d": {"url": "https://x"}}}"#,
            )],
        );
        assert!(servers[0].problem.is_some());
        assert!(servers[1].problem.is_some());
        assert!(servers[2]
            .problem
            .as_deref()
            .unwrap()
            .contains("carrier-pigeon"));
        assert!(servers[3].problem.is_none());
        assert!(servers[3].warnings[0].contains("no type"));
        assert!(import(App::ClaudeDesktop, &[Some("{}")]).is_empty());
    }

    #[test]
    fn reserved_and_invalid_names_are_left_out() {
        let servers = import(
            App::Cursor,
            &[Some(
                r#"{"mcpServers": {"r": {"url": "https://x", "headers": {"Cookie": "a", "Bad Name": "b", "X-Ok": "c"}}, "s": {"command": "x", "env": {"A-B": "1", "OK": "a\u0000b"}}}}"#,
            )],
        );
        assert_eq!(values(&servers[0]).len(), 1);
        assert_eq!(values(&servers[0])[0].name, "X-Ok");
        assert!(values(&servers[1]).is_empty());
    }

    #[test]
    fn secrets_are_recognized_by_name_or_look() {
        for (name, value) in [
            ("API_KEY", "x"),
            ("GITHUB_TOKEN", "x"),
            ("Authorization", "x"),
            ("DB_PASSWORD", "x"),
            ("X", "Bearer abc"),
            ("X", "sk-ant-api03-abc"),
            ("X", "ghp_abcdef"),
            ("DATABASE_URL", "postgres://user:pw@db.example.com/x"),
            ("X", "a8f5f167f44f4964e6c998dee827110c"),
            ("X", "eyJhbGciOiJIUzI1NiJ9.e30.x"),
        ] {
            assert!(looks_secret(name, value), "{name}={value}");
        }
        for (name, value) in [
            ("LOG_LEVEL", "debug"),
            ("NODE_ENV", "production"),
            ("ROOT", "/Users/me/projects/some-long-folder-name-2024"),
            ("API_URL", "https://api.example.com/v1"),
            ("REGION", "us-east-1"),
            ("COUNT", "123456789012345678901234567890"),
        ] {
            assert!(!looks_secret(name, value), "{name}={value}");
        }
    }

    #[test]
    fn the_secret_values_written_are_exactly_the_held_back_ones() {
        let (entries, inputs) =
            entries_from(App::ClaudeDesktop, &[Some(CLAUDE_DESKTOP.to_owned())]).unwrap();
        let ctx = ctx(App::ClaudeDesktop, &inputs);
        assert!(secret_values(&entries[0], &ctx).is_empty());
        assert_eq!(
            secret_values(&entries[1], &ctx),
            [(
                SecretKind::Env,
                "GITHUB_PERSONAL_ACCESS_TOKEN".to_owned(),
                "ghp_abc123".to_owned()
            )]
        );
    }

    #[test]
    fn placeholders_are_found() {
        assert_eq!(placeholders("a ${X} b ${env:Y}c ${"), ["X", "env:Y"]);
        assert!(placeholders("no vars").is_empty());
    }

    #[test]
    fn fingerprints_follow_the_entry() {
        let a = parse_entry("a", &serde_json::json!({"command": "x"}));
        let b = parse_entry("a", &serde_json::json!({"command": "y"}));
        assert_ne!(a.fingerprint, b.fingerprint);
        assert_eq!(
            a.fingerprint,
            parse_entry("other", &serde_json::json!({"command": "x"})).fingerprint
        );
    }

    #[test]
    fn a_large_claude_json_is_streamed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude.json");
        let history = "x".repeat(1024);
        let mut text = String::from("{\"projects\": {");
        for i in 0..2000 {
            text.push_str(&format!("\"/p{i}\": {{\"history\": \"{history}\"}},"));
        }
        text.push_str("\"/last\": {}}, \"mcpServers\": {\"a\": {\"command\": \"x\"}}}");
        std::fs::write(&path, text).unwrap();
        let (entries, _) = read_app(App::ClaudeCode, &[path]).unwrap();
        assert_eq!(entries.len(), 1);
        let (none, _) = read_app(App::ClaudeCode, &[dir.path().join("missing")]).unwrap();
        assert!(none.is_empty());
    }
}
