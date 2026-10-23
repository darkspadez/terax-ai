//! Putting skills into Terax's folder: a new one from a template, or the skills in a Git
//! repository or a zip file. An install is staged in a dot folder inside Terax's folder (which
//! discovery skips), every skill found there is validated, and only the ones the user then
//! picks are moved into place, by a rename on the same volume.

use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use super::discover::{read_skill_text, SKILL_FILE};
use super::frontmatter::{parse_skill, validate_name, yaml_scalar, MAX_DESCRIPTION_CHARS};
use crate::modules::git::process::{ensure_git_available, ensure_success, run_git};
use crate::modules::git::types::NETWORK_TIMEOUT_SECS;
use crate::modules::git::utils::validate_branch_name;
use crate::modules::workspace::{is_plain_name, WorkspaceEnv};

pub const STAGING_PREFIX: &str = ".install-";
const MAX_URL_LEN: usize = 2048;
const MAX_ZIP_BYTES: u64 = 64 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: u64 = 128 * 1024 * 1024;
const MAX_ZIP_ENTRIES: usize = 5000;
const MAX_ZIP_DEPTH: usize = 32;
const MAX_SKILL_FILES: usize = 2000;
const MAX_SKILL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CANDIDATES: usize = 100;
const CANDIDATE_DEPTH: usize = 3;

/// A Git repository to install from, and the folder in it that holds the skills.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitSource {
    pub url: String,
    pub branch: Option<String>,
    pub subpath: Option<String>,
}

const URL_HELP: &str = "Use an https:// or SSH address of a Git repository";

fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && !host.starts_with('-')
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']' | '_'))
}

fn plain_relative(path: &str) -> Option<String> {
    let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    if parts.is_empty() {
        return None;
    }
    parts
        .iter()
        .all(|part| *part != "." && *part != ".." && is_plain_name(std::ffi::OsStr::new(part)))
        .then(|| parts.join("/"))
}

/// Reads what the user typed: an `https://` or `ssh://` repository address, `user@host:path`,
/// or a GitHub folder address (`https://github.com/<owner>/<repo>/tree/<branch>/<folder>`).
/// Every other transport (`file://`, `ext::`, plain `http://` or `git://`, a local path) is
/// refused, and so is a user name or token inside an https address.
pub fn parse_git_source(input: &str) -> Result<GitSource, String> {
    let input = input.trim();
    if input.is_empty()
        || input.len() > MAX_URL_LEN
        || input.chars().any(|c| c.is_whitespace() || c.is_control())
        || input.starts_with('-')
    {
        return Err(URL_HELP.to_owned());
    }
    if let Some(rest) = input.strip_prefix("https://") {
        let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
        if authority.contains('@') {
            return Err(
                "Remove the user name or token from the address; Git asks your credential helper or uses SSH"
                    .to_owned(),
            );
        }
        if !valid_host(authority) || path.trim_matches('/').is_empty() {
            return Err(URL_HELP.to_owned());
        }
        let host = authority.to_ascii_lowercase();
        if host == "github.com" || host == "www.github.com" {
            let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
            if parts.len() >= 4 && (parts[2] == "tree" || parts[2] == "blob") {
                let repo = parts[1].trim_end_matches(".git");
                let branch = parts[3];
                validate_branch_name(branch).map_err(|_| URL_HELP.to_owned())?;
                let mut folder: Vec<&str> = parts[4..].to_vec();
                if parts[2] == "blob" {
                    folder.pop();
                }
                let subpath = if folder.is_empty() {
                    None
                } else {
                    Some(plain_relative(&folder.join("/")).ok_or_else(|| URL_HELP.to_owned())?)
                };
                return Ok(GitSource {
                    url: format!("https://github.com/{}/{repo}.git", parts[0]),
                    branch: Some(branch.to_owned()),
                    subpath,
                });
            }
        }
        return Ok(GitSource {
            url: input.to_owned(),
            branch: None,
            subpath: None,
        });
    }
    if let Some(rest) = input.strip_prefix("ssh://") {
        let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
        let host = authority
            .rsplit_once('@')
            .map_or(authority, |(_, host)| host);
        if !valid_host(host) || path.trim_matches('/').is_empty() {
            return Err(URL_HELP.to_owned());
        }
        return Ok(GitSource {
            url: input.to_owned(),
            branch: None,
            subpath: None,
        });
    }
    if !input.contains("://") {
        if let Some((user_host, path)) = input.split_once(':') {
            if let Some((user, host)) = user_host.split_once('@') {
                if !user.is_empty()
                    && !user_host.contains('/')
                    && valid_host(host)
                    && !path.is_empty()
                    && !path.starts_with('-')
                {
                    return Ok(GitSource {
                        url: input.to_owned(),
                        branch: None,
                        subpath: None,
                    });
                }
            }
        }
    }
    Err(URL_HELP.to_owned())
}

/// `git clone --depth 1` of `source` into `staging/repo`, through the app's git runner with only
/// the https and SSH transports allowed. Returns the folder that holds the skills.
pub fn clone(staging: &Path, source: &GitSource) -> Result<PathBuf, String> {
    let local = WorkspaceEnv::Local;
    ensure_git_available(&local).map_err(|e| e.to_string())?;
    let mut args: Vec<String> = [
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        "-c",
        "protocol.ssh.allow=always",
        "clone",
        "--depth",
        "1",
        "--no-tags",
        "--single-branch",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    if let Some(branch) = &source.branch {
        args.push("--branch".to_owned());
        args.push(branch.clone());
    }
    args.extend(["--".to_owned(), source.url.clone(), "repo".to_owned()]);
    let staging_str = staging.to_string_lossy().into_owned();
    let output = run_git(&local, Some(&staging_str), &args, NETWORK_TIMEOUT_SECS)
        .map_err(|e| e.to_string())?;
    ensure_success(&output, "git clone").map_err(|e| e.to_string())?;
    let repo = std::fs::canonicalize(staging.join("repo")).map_err(|e| e.to_string())?;
    match &source.subpath {
        None => Ok(repo),
        Some(subpath) => {
            let folder = std::fs::canonicalize(repo.join(subpath))
                .map_err(|_| format!("the repository has no folder `{subpath}`"))?;
            if !folder.starts_with(&repo) || !folder.is_dir() {
                return Err(format!("the repository has no folder `{subpath}`"));
            }
            Ok(folder)
        }
    }
}

/// Extracts a zip into `dest` (an empty folder): plain relative names only, no links, no
/// encrypted entries, within the size and entry caps. Any refusal fails the whole extraction.
pub fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let meta = std::fs::metadata(zip_path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".to_owned());
    }
    if meta.len() > MAX_ZIP_BYTES {
        return Err(format!(
            "the zip is larger than {} MiB",
            MAX_ZIP_BYTES / (1024 * 1024)
        ));
    }
    let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("not a readable zip file: {e}"))?;
    if archive.len() > MAX_ZIP_ENTRIES {
        return Err(format!("the zip holds more than {MAX_ZIP_ENTRIES} entries"));
    }
    let mut written: u64 = 0;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("cannot read the zip: {e}"))?;
        let raw_name = entry.name().to_owned();
        if raw_name.starts_with("__MACOSX/") || raw_name.rsplit('/').next() == Some(".DS_Store") {
            continue;
        }
        let relative = safe_entry_path(&raw_name, entry.enclosed_name())?;
        if entry.encrypted() {
            return Err(format!("`{raw_name}` is encrypted"));
        }
        if entry.is_symlink() {
            return Err(format!(
                "the zip holds a link (`{raw_name}`); skills with links are not installed from zips"
            ));
        }
        let target = dest.join(&relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|e| format!("`{raw_name}`: {e}"))?;
        let remaining = MAX_EXTRACTED_BYTES - written;
        let copied = std::io::copy(&mut (&mut entry).take(remaining + 1), &mut out)
            .map_err(|e| format!("`{raw_name}`: {e}"))?;
        if copied > remaining {
            return Err(format!(
                "the zip holds more than {} MiB when extracted",
                MAX_EXTRACTED_BYTES / (1024 * 1024)
            ));
        }
        written += copied;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let executable = entry.unix_mode().is_some_and(|mode| mode & 0o111 != 0);
            let mode = if executable { 0o755 } else { 0o644 };
            let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(mode));
        }
    }
    Ok(())
}

/// An entry's path as plain names below the extraction folder.
fn safe_entry_path(raw: &str, enclosed: Option<PathBuf>) -> Result<PathBuf, String> {
    let refused = || format!("the zip holds an unsafe path: `{raw}`");
    let enclosed = enclosed.ok_or_else(refused)?;
    if raw.starts_with('/') || raw.starts_with('\\') || raw.split(['/', '\\']).any(|p| p == "..") {
        return Err(refused());
    }
    let mut out = PathBuf::new();
    let mut depth = 0;
    for component in enclosed.components() {
        match component {
            Component::Normal(name) if is_plain_name(name) => {
                out.push(name);
                depth += 1;
            }
            Component::CurDir => {}
            _ => return Err(refused()),
        }
    }
    if depth == 0 || depth > MAX_ZIP_DEPTH {
        return Err(refused());
    }
    Ok(out)
}

/// Folders below `root` (itself included) that hold a `SKILL.md`, a few levels deep; a skill's
/// own subfolders are not searched.
pub fn find_skill_dirs(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    search(root, 0, &mut found);
    found
}

fn search(dir: &Path, depth: usize, found: &mut Vec<PathBuf>) {
    if found.len() >= MAX_CANDIDATES {
        return;
    }
    if dir.join(SKILL_FILE).is_file() {
        found.push(dir.to_path_buf());
        return;
    }
    if depth >= CANDIDATE_DEPTH {
        return;
    }
    let Ok(listing) = std::fs::read_dir(dir) else {
        return;
    };
    let mut children: Vec<PathBuf> = listing
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            !name.starts_with('.') && name != "node_modules"
        })
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
        .map(|entry| entry.path())
        .collect();
    children.sort();
    for child in children {
        search(&child, depth + 1, found);
    }
}

/// A skill found in an install, as the review lists it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// The folder it would be installed as: its `name`.
    pub name: String,
    pub description: Option<String>,
    /// Where it was found inside the download.
    pub location: String,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    /// A skill of this name is already in Terax's folder.
    pub exists: bool,
    #[serde(skip)]
    pub dir: PathBuf,
}

/// Validates a skill found in an install: its `SKILL.md`, and a tree within the caps whose links
/// all lead to files inside it. `fallback` names a skill whose frontmatter has no `name`.
pub fn review(dir: &Path, location: String, fallback: &str, skills_dir: &Path) -> Candidate {
    let mut candidate = Candidate {
        name: fallback.to_owned(),
        description: None,
        location,
        errors: Vec::new(),
        warnings: Vec::new(),
        exists: false,
        dir: dir.to_path_buf(),
    };
    match read_skill_text(&dir.join(SKILL_FILE)).and_then(|text| parse_skill(&text, fallback)) {
        Ok(meta) => {
            candidate.name = meta.name;
            candidate.description = Some(meta.description);
            candidate.warnings = meta
                .warnings
                .into_iter()
                .filter(|warning| !warning.contains("differs from its folder"))
                .collect();
        }
        Err(errors) => candidate.errors = errors,
    }
    if candidate.errors.is_empty() {
        if let Err(error) = check_tree(dir) {
            candidate.errors.push(error);
        }
    }
    candidate.exists = validate_name(&candidate.name).is_ok()
        && std::fs::symlink_metadata(skills_dir.join(&candidate.name)).is_ok();
    candidate
}

/// Several skills of one download with the same name: the first keeps it, the others cannot be
/// installed (each would replace the one before).
pub fn mark_duplicates(candidates: &mut [Candidate]) {
    let mut seen = std::collections::HashSet::new();
    for candidate in candidates.iter_mut() {
        if candidate.errors.is_empty() && !seen.insert(candidate.name.clone()) {
            candidate.errors.push(format!(
                "another skill here is also named `{}`",
                candidate.name
            ));
        }
    }
}

fn check_tree(dir: &Path) -> Result<(), String> {
    let real_dir = std::fs::canonicalize(dir).map_err(|e| e.to_string())?;
    let mut files = 0usize;
    let mut bytes = 0u64;
    check_dir(&real_dir, &real_dir, &mut files, &mut bytes)
}

fn check_dir(root: &Path, dir: &Path, files: &mut usize, bytes: &mut u64) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let meta = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .display()
            .to_string();
        if meta.file_type().is_symlink() {
            let inside = std::fs::canonicalize(&path).is_ok_and(|real| real.starts_with(root));
            if !inside {
                return Err(format!("`{relative}` links outside the skill"));
            }
            continue;
        }
        if meta.is_dir() {
            if entry.file_name() == ".git" && dir == root {
                continue;
            }
            check_dir(root, &path, files, bytes)?;
            continue;
        }
        *files += 1;
        *bytes += meta.len();
        if *files > MAX_SKILL_FILES {
            return Err(format!("holds more than {MAX_SKILL_FILES} files"));
        }
        if *bytes > MAX_SKILL_BYTES {
            return Err(format!(
                "holds more than {} MiB",
                MAX_SKILL_BYTES / (1024 * 1024)
            ));
        }
    }
    Ok(())
}

/// Moves a reviewed skill into Terax's folder under its name, without its `.git` folder. An
/// installed skill of that name is replaced only with `replace`, after `discard` took it away.
pub fn place(
    candidate: &Candidate,
    skills_dir: &Path,
    replace: bool,
    discard: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<PathBuf, String> {
    if !candidate.errors.is_empty() {
        return Err(format!("`{}` is not a valid skill", candidate.name));
    }
    validate_name(&candidate.name)?;
    let target = skills_dir.join(&candidate.name);
    if std::fs::symlink_metadata(&target).is_ok() {
        if !replace {
            return Err(format!(
                "a skill named `{}` is already installed",
                candidate.name
            ));
        }
        discard(&target)?;
    }
    let git_dir = candidate.dir.join(".git");
    if std::fs::symlink_metadata(&git_dir).is_ok_and(|meta| meta.is_dir()) {
        std::fs::remove_dir_all(&git_dir).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&candidate.dir, &target).map_err(|e| e.to_string())?;
    Ok(target)
}

/// A new skill folder with a `SKILL.md` to fill in. Returns the file.
pub fn create(skills_dir: &Path, name: &str, description: &str) -> Result<PathBuf, String> {
    validate_name(name)?;
    let description = description.trim();
    if description.is_empty() {
        return Err("Describe what the skill does and when to use it".to_owned());
    }
    if description.chars().count() > MAX_DESCRIPTION_CHARS {
        return Err(format!(
            "The description may have at most {MAX_DESCRIPTION_CHARS} characters"
        ));
    }
    std::fs::create_dir_all(skills_dir).map_err(|e| e.to_string())?;
    let dir = skills_dir.join(name);
    std::fs::create_dir(&dir).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => format!("A skill named `{name}` already exists"),
        _ => e.to_string(),
    })?;
    let file = dir.join(SKILL_FILE);
    let mut out = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&file)
        .map_err(|e| e.to_string())?;
    std::io::Write::write_all(&mut out, template(name, description).as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(file)
}

fn title(name: &str) -> String {
    name.split('-')
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            chars
                .next()
                .map(|first| first.to_ascii_uppercase().to_string() + chars.as_str())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn template(name: &str, description: &str) -> String {
    format!(
        "---\nname: {name}\ndescription: {}\n---\n\n# {}\n\n## When to use\n\nThe situations this skill is for. The description above is what the AI reads to decide when to load it.\n\n## Instructions\n\n1. First step.\n2. Second step.\n\n## Files\n\nMention bundled files by their path relative to this folder, such as `references/guide.md` or `scripts/run.py`. The AI reads them when needed and runs scripts through its shell tool.\n",
        yaml_scalar(description),
        title(name)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn source(url: &str) -> GitSource {
        GitSource {
            url: url.to_owned(),
            branch: None,
            subpath: None,
        }
    }

    #[test]
    fn accepts_https_and_ssh_repositories() {
        for url in [
            "https://github.com/anthropics/skills",
            "https://gitlab.example.com/group/sub/repo.git",
            "ssh://git@example.com:2222/team/repo.git",
            "git@github.com:anthropics/skills.git",
        ] {
            assert_eq!(parse_git_source(url), Ok(source(url)), "{url}");
        }
        assert_eq!(
            parse_git_source("  https://github.com/a/b  "),
            Ok(source("https://github.com/a/b"))
        );
    }

    #[test]
    fn reads_github_folder_addresses() {
        assert_eq!(
            parse_git_source("https://github.com/anthropics/skills/tree/main/skills/pdf"),
            Ok(GitSource {
                url: "https://github.com/anthropics/skills.git".into(),
                branch: Some("main".into()),
                subpath: Some("skills/pdf".into()),
            })
        );
        assert_eq!(
            parse_git_source("https://github.com/o/r.git/blob/v1/tools/x/SKILL.md"),
            Ok(GitSource {
                url: "https://github.com/o/r.git".into(),
                branch: Some("v1".into()),
                subpath: Some("tools/x".into()),
            })
        );
        assert_eq!(
            parse_git_source("https://github.com/o/r/tree/dev"),
            Ok(GitSource {
                url: "https://github.com/o/r.git".into(),
                branch: Some("dev".into()),
                subpath: None,
            })
        );
        assert!(parse_git_source("https://github.com/o/r/tree/-x/a").is_err());
        assert!(parse_git_source("https://github.com/o/r/tree/main/../etc").is_err());
    }

    #[test]
    fn refuses_other_transports_and_credentials() {
        for url in [
            "",
            "http://example.com/repo.git",
            "git://example.com/repo.git",
            "file:///etc",
            "ext::sh -c touch% /tmp/pwned",
            "ext::sh",
            "/home/me/repo",
            "./repo",
            "C:\\repos\\x",
            "-uhttps://x",
            "https://",
            "https://example.com",
            "https://exa mple.com/r",
            "git@host:-oProxyCommand=x",
            "@host:path",
            "fd::17",
        ] {
            assert!(parse_git_source(url).is_err(), "{url:?} accepted");
        }
        assert!(parse_git_source("https://user:token@github.com/o/r")
            .unwrap_err()
            .contains("token"));
    }

    fn write_zip(path: &Path, entries: &[(&str, &[u8], Option<u32>)]) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        for (name, data, mode) in entries {
            let mut options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            if let Some(mode) = mode {
                options = options.unix_permissions(*mode);
            }
            if name.ends_with('/') {
                zip.add_directory(*name, options).unwrap();
            } else {
                zip.start_file(*name, options).unwrap();
                zip.write_all(data).unwrap();
            }
        }
        zip.finish().unwrap();
    }

    #[test]
    fn extracts_a_plain_zip_and_keeps_execute_bits() {
        let dir = tempfile::tempdir().unwrap();
        let zip = dir.path().join("skill.zip");
        write_zip(
            &zip,
            &[
                ("pdf/", b"", None),
                (
                    "pdf/SKILL.md",
                    b"---\nname: pdf\ndescription: d\n---\n",
                    None,
                ),
                ("pdf/scripts/run.sh", b"echo hi", Some(0o755)),
                ("__MACOSX/pdf/._SKILL.md", b"junk", None),
                ("pdf/.DS_Store", b"junk", None),
            ],
        );
        let dest = dir.path().join("out");
        std::fs::create_dir(&dest).unwrap();
        extract_zip(&zip, &dest).unwrap();
        assert!(dest.join("pdf/SKILL.md").is_file());
        assert!(!dest.join("__MACOSX").exists());
        assert!(!dest.join("pdf/.DS_Store").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dest.join("pdf/scripts/run.sh"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o755);
            let mode = std::fs::metadata(dest.join("pdf/SKILL.md"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o644);
        }
        assert_eq!(find_skill_dirs(&dest), vec![dest.join("pdf")]);
    }

    #[test]
    fn refuses_traversal_absolute_paths_and_links() {
        assert!(safe_entry_path("../x", None).is_err());
        assert!(safe_entry_path("a/../../x", Some(PathBuf::from("x"))).is_err());
        assert!(safe_entry_path("/etc/passwd", Some(PathBuf::from("etc/passwd"))).is_err());
        assert!(safe_entry_path("ok/file", Some(PathBuf::from("ok/file"))).is_ok());
        let deep = vec!["d"; MAX_ZIP_DEPTH + 1].join("/");
        assert!(safe_entry_path(&deep, Some(PathBuf::from(&deep))).is_err());

        let dir = tempfile::tempdir().unwrap();
        let zip = dir.path().join("evil.zip");
        let file = std::fs::File::create(&zip).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        writer.add_symlink("skill/link", "/etc", options).unwrap();
        writer.finish().unwrap();
        let dest = dir.path().join("out");
        std::fs::create_dir(&dest).unwrap();
        assert!(extract_zip(&zip, &dest).unwrap_err().contains("link"));
        assert!(!dest.join("skill/link").exists());
    }

    #[test]
    fn refuses_a_zip_that_expands_past_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let zip = dir.path().join("bomb.zip");
        let file = std::fs::File::create(&zip).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .large_file(true);
        writer.start_file("bomb/zeros", options).unwrap();
        let chunk = vec![0u8; 1024 * 1024];
        for _ in 0..(MAX_EXTRACTED_BYTES / chunk.len() as u64 + 1) {
            writer.write_all(&chunk).unwrap();
        }
        writer.finish().unwrap();
        assert!(std::fs::metadata(&zip).unwrap().len() < MAX_ZIP_BYTES);
        let dest = dir.path().join("out");
        std::fs::create_dir(&dest).unwrap();
        assert!(extract_zip(&zip, &dest)
            .unwrap_err()
            .contains("when extracted"));
    }

    #[test]
    fn refuses_what_is_not_a_zip() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("fake.zip");
        std::fs::write(&fake, b"not a zip").unwrap();
        assert!(extract_zip(&fake, dir.path()).unwrap_err().contains("zip"));
    }

    #[test]
    fn finds_skills_at_the_root_or_a_few_levels_down() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for path in [
            "skills/pdf/SKILL.md",
            "skills/docx/SKILL.md",
            "skills/docx/nested/SKILL.md",
            "a/b/c/d/SKILL.md",
            ".git/SKILL.md",
            "node_modules/x/SKILL.md",
        ] {
            let file = root.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, "x").unwrap();
        }
        assert_eq!(
            find_skill_dirs(root),
            vec![root.join("skills/docx"), root.join("skills/pdf")]
        );
        std::fs::write(root.join("SKILL.md"), "x").unwrap();
        assert_eq!(find_skill_dirs(root), vec![root.to_path_buf()]);
    }

    fn staged_skill(root: &Path, folder: &str, name: &str) -> PathBuf {
        let dir = root.join(folder);
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: Does things.\n---\nBody\n"),
        )
        .unwrap();
        std::fs::write(dir.join(".git/HEAD"), "ref").unwrap();
        dir
    }

    #[test]
    fn reviews_and_places_a_skill_under_its_name() {
        let dir = tempfile::tempdir().unwrap();
        let skills = dir.path().join("skills");
        std::fs::create_dir_all(&skills).unwrap();
        let staged = staged_skill(&dir.path().join("stage"), "repo", "pdf-tools");
        let candidate = review(&staged, "repo".into(), "repo", &skills);
        assert_eq!(candidate.name, "pdf-tools");
        assert_eq!(candidate.description.as_deref(), Some("Does things."));
        assert!(candidate.errors.is_empty() && !candidate.exists);
        let placed = place(&candidate, &skills, false, |_| unreachable!()).unwrap();
        assert_eq!(placed, skills.join("pdf-tools"));
        assert!(placed.join("SKILL.md").is_file());
        assert!(
            !placed.join(".git").exists(),
            "the clone's history stays behind"
        );

        let again = staged_skill(&dir.path().join("stage2"), "repo", "pdf-tools");
        let candidate = review(&again, "repo".into(), "repo", &skills);
        assert!(candidate.exists);
        assert!(place(&candidate, &skills, false, |_| Ok(()))
            .unwrap_err()
            .contains("already installed"));
        let mut discarded = None;
        place(&candidate, &skills, true, |old| {
            discarded = Some(old.to_path_buf());
            std::fs::remove_dir_all(old).map_err(|e| e.to_string())
        })
        .unwrap();
        assert_eq!(discarded, Some(skills.join("pdf-tools")));
    }

    #[test]
    fn only_the_first_skill_of_a_name_can_be_installed() {
        let dir = tempfile::tempdir().unwrap();
        let a = staged_skill(&dir.path().join("a"), "x", "pdf");
        let b = staged_skill(&dir.path().join("b"), "y", "pdf");
        let mut candidates = vec![
            review(&a, "a".into(), "x", dir.path()),
            review(&b, "b".into(), "y", dir.path()),
        ];
        mark_duplicates(&mut candidates);
        assert!(candidates[0].errors.is_empty());
        assert_eq!(
            candidates[1].errors,
            vec!["another skill here is also named `pdf`".to_owned()]
        );
    }

    #[test]
    fn an_invalid_skill_is_never_placed() {
        let dir = tempfile::tempdir().unwrap();
        let staged = dir.path().join("Bad Name");
        std::fs::create_dir_all(&staged).unwrap();
        std::fs::write(staged.join("SKILL.md"), "---\ndescription: d\n---\n").unwrap();
        let candidate = review(&staged, "Bad Name".into(), "Bad Name", dir.path());
        assert!(!candidate.errors.is_empty());
        assert!(place(&candidate, dir.path(), true, |_| Ok(())).is_err());
        assert!(staged.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_skill_whose_links_leave_it_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let staged = staged_skill(dir.path(), "x", "x");
        std::os::unix::fs::symlink("/etc/passwd", staged.join("passwd")).unwrap();
        let candidate = review(&staged, "x".into(), "x", dir.path());
        assert_eq!(
            candidate.errors,
            vec!["`passwd` links outside the skill".to_owned()]
        );
        std::fs::remove_file(staged.join("passwd")).unwrap();
        std::os::unix::fs::symlink("SKILL.md", staged.join("alias.md")).unwrap();
        assert!(review(&staged, "x".into(), "x", dir.path())
            .errors
            .is_empty());
    }

    #[test]
    fn creates_a_skill_from_the_template() {
        let dir = tempfile::tempdir().unwrap();
        let skills = dir.path().join("skills");
        let file = create(
            &skills,
            "release-notes",
            "Write release notes: use for tags",
        )
        .unwrap();
        assert_eq!(file, skills.join("release-notes/SKILL.md"));
        let text = std::fs::read_to_string(&file).unwrap();
        let meta = parse_skill(&text, "release-notes").unwrap();
        assert_eq!(meta.name, "release-notes");
        assert_eq!(meta.description, "Write release notes: use for tags");
        assert!(meta.warnings.is_empty(), "{:?}", meta.warnings);
        assert!(text.contains("# Release Notes"));
        assert!(create(&skills, "release-notes", "again")
            .unwrap_err()
            .contains("already exists"));
        assert!(create(&skills, "Bad", "d").is_err());
        assert!(create(&skills, "ok", "  ").is_err());
    }
}
