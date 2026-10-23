//! Finding the skills in a folder: each child folder holding a `SKILL.md`, parsed and validated.
//! Parses are cached by the file's size and modification time, so a rescan costs one listing
//! and one `stat` per skill.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;

use super::frontmatter::{parse_skill, SkillMeta};

pub const SKILL_FILE: &str = "SKILL.md";
/// Larger than any instructions a model should load at once.
pub const MAX_SKILL_FILE_BYTES: u64 = 1024 * 1024;
const MAX_SKILLS_PER_SOURCE: usize = 500;
const PARSE_CACHE_CAP: usize = 2048;

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum SourceKind {
    /// Terax's own skills folder.
    Terax,
    /// `~/.claude/skills`.
    User,
    /// A project's `.claude/skills`.
    ClaudeProject,
    /// A project's `.terax/skills`.
    TeraxProject,
}

impl SourceKind {
    pub fn id(self) -> &'static str {
        match self {
            SourceKind::Terax => "terax",
            SourceKind::User => "user",
            SourceKind::ClaudeProject => "claude-project",
            SourceKind::TeraxProject => "terax-project",
        }
    }

    /// A name found in several sources is taken from the highest: a project over the user's
    /// `~/.claude/skills` over Terax's folder, and in a project `.terax/skills` over `.claude/skills`.
    pub fn precedence(self) -> u8 {
        match self {
            SourceKind::Terax => 0,
            SourceKind::User => 1,
            SourceKind::ClaudeProject => 2,
            SourceKind::TeraxProject => 3,
        }
    }

    pub fn is_project(self) -> bool {
        matches!(self, SourceKind::ClaudeProject | SourceKind::TeraxProject)
    }
}

/// A folder of skills.
#[derive(Clone, Debug)]
pub struct Source {
    pub kind: SourceKind,
    /// Where it is read.
    pub dir: PathBuf,
    /// How it is spelled for the user and the model.
    pub display: String,
    /// For a project source, its own real folder: every skill folder must really be inside it,
    /// so the content hash the user trusted covers everything the skills hold.
    pub confine: Option<PathBuf>,
}

/// A valid skill.
#[derive(Clone, Debug)]
pub struct Found {
    pub dir_name: String,
    pub meta: SkillMeta,
    /// Its real folder: everything it reads stays inside.
    pub real_dir: PathBuf,
    pub display_dir: String,
}

/// A folder with a `SKILL.md` that cannot be used, and why.
#[derive(Clone, Debug)]
pub struct Invalid {
    pub dir_name: String,
    pub display_dir: String,
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub struct Scanned {
    pub skills: Vec<Found>,
    pub invalid: Vec<Invalid>,
}

type CacheKey = (PathBuf, String);
type Parsed = Result<SkillMeta, Vec<String>>;
/// A file's size and modification time when it was parsed.
type Stamp = (u64, Option<SystemTime>);

#[derive(Default)]
pub struct ParseCache(HashMap<CacheKey, (Stamp, Parsed)>);

impl ParseCache {
    fn parse(
        &mut self,
        path: &Path,
        dir_name: &str,
        meta: &std::fs::Metadata,
    ) -> Result<SkillMeta, Vec<String>> {
        let key = (path.to_path_buf(), dir_name.to_owned());
        let modified = meta.modified().ok();
        if let Some(((len, cached_modified), parsed)) = self.0.get(&key) {
            if *len == meta.len() && *cached_modified == modified && modified.is_some() {
                return parsed.clone();
            }
        }
        let parsed = read_skill_text(path).and_then(|text| parse_skill(&text, dir_name));
        if self.0.len() >= PARSE_CACHE_CAP {
            self.0.clear();
        }
        self.0.insert(key, ((meta.len(), modified), parsed.clone()));
        parsed
    }
}

/// A `SKILL.md`'s text: at most `MAX_SKILL_FILE_BYTES`, UTF-8.
pub fn read_skill_text(path: &Path) -> Result<String, Vec<String>> {
    let meta = std::fs::metadata(path).map_err(|e| vec![format!("cannot read SKILL.md: {e}")])?;
    if meta.len() > MAX_SKILL_FILE_BYTES {
        return Err(vec![format!(
            "SKILL.md is larger than {} KiB",
            MAX_SKILL_FILE_BYTES / 1024
        )]);
    }
    let bytes = std::fs::read(path).map_err(|e| vec![format!("cannot read SKILL.md: {e}")])?;
    String::from_utf8(bytes).map_err(|_| vec!["SKILL.md is not UTF-8 text".to_owned()])
}

fn skipped(name: &str) -> bool {
    // Claude Code keeps skills it syncs from claude.ai in `synced` and never loads a skill of
    // that name; dot folders hold tool state (`.trash`) and Terax's install staging.
    name.starts_with('.') || name.eq_ignore_ascii_case("synced")
}

/// The skills in `source`, in folder name order. A missing folder has none.
pub fn scan(source: &Source, cache: &mut ParseCache) -> Scanned {
    let mut scanned = Scanned::default();
    let Ok(listing) = std::fs::read_dir(&source.dir) else {
        return scanned;
    };
    let mut names: Vec<String> = listing
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| !skipped(name))
        .collect();
    names.sort();
    for dir_name in names.into_iter().take(MAX_SKILLS_PER_SOURCE) {
        let dir = source.dir.join(&dir_name);
        let display_dir = crate::modules::project_trust::join_display(&source.display, &dir_name);
        let invalid = |errors: Vec<String>| Invalid {
            dir_name: dir_name.clone(),
            display_dir: display_dir.clone(),
            errors,
        };
        let Ok(real_dir) = std::fs::canonicalize(&dir) else {
            continue;
        };
        if !real_dir.is_dir() {
            continue;
        }
        let skill_file = dir.join(SKILL_FILE);
        let Ok(file_meta) = std::fs::metadata(&skill_file) else {
            if let Some(other) = case_variant(&dir) {
                scanned.invalid.push(invalid(vec![format!(
                    "found `{other}`; the file must be named SKILL.md"
                )]));
            }
            continue;
        };
        if let Some(root) = &source.confine {
            if !real_dir.starts_with(root) {
                scanned.invalid.push(invalid(vec![
                    "links outside the project's skills folder".to_owned()
                ]));
                continue;
            }
        }
        match std::fs::canonicalize(&skill_file) {
            Ok(real_file) if real_file.starts_with(&real_dir) && file_meta.is_file() => {}
            _ => {
                scanned.invalid.push(invalid(
                    vec!["SKILL.md links outside its folder".to_owned()],
                ));
                continue;
            }
        }
        match cache.parse(&skill_file, &dir_name, &file_meta) {
            Ok(meta) => scanned.skills.push(Found {
                dir_name: dir_name.clone(),
                meta,
                real_dir,
                display_dir,
            }),
            Err(errors) => scanned.invalid.push(invalid(errors)),
        }
    }
    dedupe_names(&mut scanned);
    scanned
}

fn case_variant(dir: &Path) -> Option<String> {
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .find(|name| name != SKILL_FILE && name.eq_ignore_ascii_case(SKILL_FILE))
}

/// Two folders of one source naming the same skill: the folder of that name keeps it (else the
/// first), the others become invalid.
fn dedupe_names(scanned: &mut Scanned) {
    let mut keep: HashMap<String, usize> = HashMap::new();
    for (i, found) in scanned.skills.iter().enumerate() {
        match keep.get(&found.meta.name) {
            Some(&kept) if scanned.skills[kept].dir_name == found.meta.name => {}
            Some(_) if found.dir_name == found.meta.name => {
                keep.insert(found.meta.name.clone(), i);
            }
            Some(_) => {}
            None => {
                keep.insert(found.meta.name.clone(), i);
            }
        }
    }
    let mut kept = Vec::with_capacity(scanned.skills.len());
    for (i, found) in std::mem::take(&mut scanned.skills).into_iter().enumerate() {
        let owner = keep[&found.meta.name];
        if owner == i {
            kept.push(found);
        } else {
            scanned.invalid.push(Invalid {
                errors: vec![format!(
                    "another folder here also holds a skill named `{}`",
                    found.meta.name
                )],
                dir_name: found.dir_name,
                display_dir: found.display_dir,
            });
        }
    }
    scanned.skills = kept;
    scanned.invalid.sort_by(|a, b| a.dir_name.cmp(&b.dir_name));
}

/// Which skill wins each name: the one from the highest source among `candidates`
/// (`(source, name)`), by index. Every other candidate is overridden by its name's winner.
pub fn winners(candidates: &[(SourceKind, &str)]) -> Vec<Option<usize>> {
    let mut best: HashMap<&str, usize> = HashMap::new();
    for (i, (kind, name)) in candidates.iter().enumerate() {
        match best.get(name) {
            Some(&j) if candidates[j].0.precedence() >= kind.precedence() => {}
            _ => {
                best.insert(name, i);
            }
        }
    }
    candidates
        .iter()
        .enumerate()
        .map(|(i, (_, name))| {
            let winner = best[name];
            (winner != i).then_some(winner)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn skill_md(name: &str, description: &str) -> String {
        format!("---\nname: {name}\ndescription: {description}\n---\nDo it.\n")
    }

    fn source(dir: &Path, kind: SourceKind) -> Source {
        Source {
            kind,
            dir: dir.to_path_buf(),
            display: "~/skills".to_owned(),
            confine: None,
        }
    }

    #[test]
    fn finds_valid_and_invalid_skills_in_name_order() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("zeta/SKILL.md"), &skill_md("zeta", "Last."));
        write(&root.join("alpha/SKILL.md"), &skill_md("alpha", "First."));
        write(
            &root.join("broken/SKILL.md"),
            "---\nname: Broken\ndescription: x\n---\n",
        );
        write(&root.join("notes/README.md"), "not a skill");
        write(&root.join(".install-1/SKILL.md"), &skill_md("staged", "x"));
        write(&root.join("synced/SKILL.md"), &skill_md("synced", "x"));
        write(&root.join("loose.md"), "a file");
        let scanned = scan(&source(root, SourceKind::Terax), &mut ParseCache::default());
        let names: Vec<_> = scanned
            .skills
            .iter()
            .map(|s| s.meta.name.as_str())
            .collect();
        assert_eq!(names, ["alpha", "zeta"]);
        assert_eq!(scanned.skills[0].display_dir, "~/skills/alpha");
        assert_eq!(scanned.invalid.len(), 1);
        assert_eq!(scanned.invalid[0].dir_name, "broken");
        assert!(scanned.invalid[0].errors[0].contains("uppercase"));
    }

    #[test]
    fn a_missing_folder_has_no_skills() {
        let scanned = scan(
            &source(Path::new("/nonexistent/terax/skills"), SourceKind::User),
            &mut ParseCache::default(),
        );
        assert!(scanned.skills.is_empty() && scanned.invalid.is_empty());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_lowercase_skill_file_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("x/skill.md"), &skill_md("x", "d"));
        let scanned = scan(
            &source(dir.path(), SourceKind::User),
            &mut ParseCache::default(),
        );
        assert!(scanned.invalid[0].errors[0].contains("must be named SKILL.md"));
    }

    #[test]
    fn the_folder_named_like_the_skill_keeps_a_duplicate_name() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join("a-copy/SKILL.md"),
            &skill_md("tool", "copy"),
        );
        write(
            &dir.path().join("tool/SKILL.md"),
            &skill_md("tool", "original"),
        );
        write(
            &dir.path().join("z-copy/SKILL.md"),
            &skill_md("tool", "another"),
        );
        let scanned = scan(
            &source(dir.path(), SourceKind::User),
            &mut ParseCache::default(),
        );
        assert_eq!(scanned.skills.len(), 1);
        assert_eq!(scanned.skills[0].dir_name, "tool");
        let invalid: Vec<_> = scanned
            .invalid
            .iter()
            .map(|i| i.dir_name.as_str())
            .collect();
        assert_eq!(invalid, ["a-copy", "z-copy"]);
    }

    #[test]
    fn the_cache_reparses_a_changed_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("x/SKILL.md");
        write(&file, &skill_md("x", "before"));
        let mut cache = ParseCache::default();
        let src = source(dir.path(), SourceKind::User);
        assert_eq!(scan(&src, &mut cache).skills[0].meta.description, "before");
        write(&file, &skill_md("x", "after, longer"));
        assert_eq!(
            scan(&src, &mut cache).skills[0].meta.description,
            "after, longer"
        );
    }

    #[test]
    fn an_oversized_skill_file_is_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("x/SKILL.md");
        write(&file, "");
        std::fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_len(MAX_SKILL_FILE_BYTES + 1)
            .unwrap();
        let scanned = scan(
            &source(dir.path(), SourceKind::User),
            &mut ParseCache::default(),
        );
        assert!(scanned.invalid[0].errors[0].contains("larger than"));
    }

    #[cfg(unix)]
    #[test]
    fn project_skills_must_stay_inside_their_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let project = root.join("p");
        let skills = project.join(".claude/skills");
        write(
            &root.join("elsewhere/SKILL.md"),
            &skill_md("elsewhere", "d"),
        );
        write(&skills.join("inside/SKILL.md"), &skill_md("inside", "d"));
        write(&skills.join("real/SKILL.md"), &skill_md("alias", "d"));
        write(&project.join("tools/SKILL.md"), &skill_md("tools", "d"));
        write(&root.join("secret.md"), &skill_md("leak", "d"));
        std::fs::create_dir_all(skills.join("leaky")).unwrap();
        std::os::unix::fs::symlink(root.join("secret.md"), skills.join("leaky/SKILL.md")).unwrap();
        std::os::unix::fs::symlink(root.join("elsewhere"), skills.join("elsewhere")).unwrap();
        // Inside the project but outside its skills folder: content the trusted hash misses.
        std::os::unix::fs::symlink(project.join("tools"), skills.join("tools")).unwrap();
        std::os::unix::fs::symlink(skills.join("real"), skills.join("alias")).unwrap();
        let scanned = scan(
            &Source {
                kind: SourceKind::ClaudeProject,
                dir: skills.clone(),
                display: "/p/.claude/skills".to_owned(),
                confine: Some(skills.clone()),
            },
            &mut ParseCache::default(),
        );
        let names: Vec<_> = scanned.skills.iter().map(|s| s.dir_name.as_str()).collect();
        assert_eq!(names, ["alias", "inside"]);
        let errors: Vec<_> = scanned
            .invalid
            .iter()
            .map(|i| (i.dir_name.as_str(), i.errors[0].as_str()))
            .collect();
        assert_eq!(
            errors,
            [
                ("elsewhere", "links outside the project's skills folder"),
                ("leaky", "SKILL.md links outside its folder"),
                (
                    "real",
                    "another folder here also holds a skill named `alias`"
                ),
                ("tools", "links outside the project's skills folder"),
            ]
        );
        // The user's own folders may link anywhere: a skill kept in a dotfiles repository.
        let user = scan(
            &source(&skills, SourceKind::User),
            &mut ParseCache::default(),
        );
        assert_eq!(user.skills.len(), 4);
    }

    #[test]
    fn the_highest_source_wins_a_name() {
        let candidates = [
            (SourceKind::Terax, "pdf"),
            (SourceKind::User, "pdf"),
            (SourceKind::ClaudeProject, "pdf"),
            (SourceKind::Terax, "only"),
            (SourceKind::TeraxProject, "pdf"),
            (SourceKind::User, "two"),
            (SourceKind::Terax, "two"),
        ];
        assert_eq!(
            winners(&candidates),
            vec![Some(4), Some(4), Some(4), None, None, None, Some(5)]
        );
    }
}
