//! A skill's own files, read only inside its real folder: a relative path of plain names, never
//! `..`, and a link is followed only to a file that is really inside.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::modules::workspace::is_plain_name;

const MAX_LISTED_FILES: usize = 300;
const MAX_LIST_DEPTH: usize = 6;
const MAX_RELATIVE_PATH: usize = 1024;
/// Text files the model may read; larger ones are refused.
pub const MAX_READ_BYTES: u64 = 1024 * 1024;

fn readable(path: &Path) -> bool {
    use std::sync::OnceLock;
    #[derive(serde::Deserialize)]
    struct Rules {
        basenames: Vec<String>,
        directories: Vec<String>,
    }
    static RULES: OnceLock<(regex::RegexSet, Vec<String>)> = OnceLock::new();
    let (basenames, directories) = RULES.get_or_init(|| {
        let rules: Rules = serde_json::from_str(include_str!(
            "../../../../src/modules/ai/lib/secretPaths.json"
        ))
        .expect("valid shared secret path rules");
        let patterns = regex::RegexSetBuilder::new(&rules.basenames)
            .case_insensitive(true)
            .build()
            .expect("valid shared secret basename patterns");
        (patterns, rules.directories)
    });
    let path = path.to_string_lossy().replace('\\', "/");
    if path.chars().any(char::is_control)
        || basenames.is_match(path.rsplit('/').next().unwrap_or(""))
    {
        return false;
    }
    let comparison = path
        .split('/')
        .map(|part| {
            part.split(':')
                .next()
                .unwrap_or("")
                .trim_end_matches(|c: char| c == '.' || c.is_whitespace())
                .to_lowercase()
        })
        .collect::<Vec<_>>()
        .join("/")
        + "/";
    !directories
        .iter()
        .any(|dir| comparison.contains(&format!("{dir}/")))
}

/// The file at `relative` inside `real_dir` (the skill's canonical folder), as it really is.
pub fn resolve_inside(real_dir: &Path, relative: &str) -> Result<PathBuf, String> {
    let refused = || format!("`{relative}` is not a file inside the skill's folder");
    if relative.is_empty()
        || relative.len() > MAX_RELATIVE_PATH
        || relative.contains('\0')
        || relative.starts_with('/')
        || relative.starts_with('\\')
    {
        return Err(refused());
    }
    let mut path = real_dir.to_path_buf();
    for part in relative.split(['/', '\\']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." || !is_plain_name(std::ffi::OsStr::new(part)) {
            return Err(refused());
        }
        path.push(part);
    }
    if !matches!(
        Path::new(relative).components().next(),
        Some(Component::Normal(_)) | Some(Component::CurDir)
    ) {
        return Err(refused());
    }
    if !readable(&path) {
        return Err("refused: sensitive skill file".into());
    }
    let real = std::fs::canonicalize(&path).map_err(|_| refused())?;
    if !readable(&real) {
        return Err("refused: sensitive skill file".into());
    }
    if !real.starts_with(real_dir) || real == real_dir || !real.is_file() {
        return Err(refused());
    }
    Ok(real)
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ReadOutcome {
    Text { content: String, size: u64 },
    Binary { size: u64 },
    TooLarge { size: u64, limit: u64 },
}

/// A text file's content; binary files and files over `MAX_READ_BYTES` are reported, not read.
pub fn read_text(path: &Path) -> Result<ReadOutcome, String> {
    let size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size > MAX_READ_BYTES {
        return Ok(ReadOutcome::TooLarge {
            size,
            limit: MAX_READ_BYTES,
        });
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return Ok(ReadOutcome::Binary { size });
    }
    match String::from_utf8(bytes) {
        Ok(content) => Ok(ReadOutcome::Text { content, size }),
        Err(_) => Ok(ReadOutcome::Binary { size }),
    }
}

/// The skill's files besides `SKILL.md`, relative and `/`-separated, in name order: dot names
/// skipped, links listed only when they lead to a file inside, folders never followed through a
/// link. True when the list was cut short.
pub fn list_files(real_dir: &Path) -> (Vec<String>, bool) {
    let mut files = Vec::new();
    let truncated = walk(real_dir, real_dir, "", 0, &mut files);
    (files, truncated)
}

fn walk(root: &Path, dir: &Path, prefix: &str, depth: usize, files: &mut Vec<String>) -> bool {
    let Ok(listing) = std::fs::read_dir(dir) else {
        return false;
    };
    let mut entries: Vec<(String, PathBuf)> = listing
        .filter_map(Result::ok)
        .filter_map(|entry| Some((entry.file_name().into_string().ok()?, entry.path())))
        .filter(|(name, _)| !name.starts_with('.'))
        .collect();
    entries.sort();
    for (name, path) in entries {
        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            if depth + 1 < MAX_LIST_DEPTH && walk(root, &path, &relative, depth + 1, files) {
                return true;
            }
            continue;
        }
        if resolve_inside(root, &relative).is_err() && !meta.is_dir() {
            continue;
        }
        let is_file = if meta.file_type().is_symlink() {
            std::fs::canonicalize(&path).is_ok_and(|real| real.starts_with(root) && real.is_file())
        } else {
            meta.is_file()
        };
        if !is_file || (prefix.is_empty() && name == super::discover::SKILL_FILE) {
            continue;
        }
        if files.len() >= MAX_LISTED_FILES {
            return true;
        }
        files.push(relative);
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill_dir() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap().join("skill");
        std::fs::create_dir_all(root.join("references/deep")).unwrap();
        std::fs::create_dir_all(root.join("scripts")).unwrap();
        std::fs::write(root.join("SKILL.md"), "---\n---\n").unwrap();
        std::fs::write(root.join("references/guide.md"), "guide").unwrap();
        std::fs::write(root.join("references/deep/more.md"), "more").unwrap();
        std::fs::write(root.join("scripts/run.py"), "print(1)").unwrap();
        std::fs::write(root.join(".hidden"), "x").unwrap();
        (dir, root)
    }

    #[test]
    fn refuses_sensitive_files_and_internal_symlink_aliases() {
        let (_dir, root) = skill_dir();
        std::fs::write(root.join(".env"), "fake secret").unwrap();
        assert!(resolve_inside(&root, ".env").is_err());
        assert!(!readable(&root.join(".aws/config")));
        assert!(!readable(&root.join("id_ed25519")));
        assert!(readable(&root.join("guide.md")));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join(".env"), root.join("reference.txt")).unwrap();
            assert!(resolve_inside(&root, "reference.txt").is_err());
            assert!(!list_files(&root).0.contains(&"reference.txt".to_owned()));
        }
    }

    #[test]
    fn resolves_plain_relative_paths_inside() {
        let (_dir, root) = skill_dir();
        assert_eq!(
            resolve_inside(&root, "references/guide.md").unwrap(),
            root.join("references/guide.md")
        );
        assert_eq!(
            resolve_inside(&root, "./scripts/run.py").unwrap(),
            root.join("scripts/run.py")
        );
        assert_eq!(
            resolve_inside(&root, "references\\deep\\more.md").unwrap(),
            root.join("references/deep/more.md")
        );
    }

    #[test]
    fn refuses_anything_that_leaves_the_folder() {
        let (dir, root) = skill_dir();
        std::fs::write(dir.path().join("outside.txt"), "secret").unwrap();
        for bad in [
            "",
            "../outside.txt",
            "references/../../outside.txt",
            "/etc/passwd",
            "\\windows\\system.ini",
            "references",
            "missing.md",
            "a\0b",
            "C:/x",
        ] {
            assert!(resolve_inside(&root, bad).is_err(), "{bad:?} resolved");
        }
    }

    #[cfg(unix)]
    #[test]
    fn follows_links_only_to_files_inside() {
        let (dir, root) = skill_dir();
        std::fs::write(dir.path().join("outside.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(dir.path().join("outside.txt"), root.join("escape.md")).unwrap();
        std::os::unix::fs::symlink(root.join("references/guide.md"), root.join("alias.md"))
            .unwrap();
        std::os::unix::fs::symlink(dir.path(), root.join("up")).unwrap();
        assert!(resolve_inside(&root, "escape.md").is_err());
        assert!(resolve_inside(&root, "up/outside.txt").is_err());
        assert_eq!(
            resolve_inside(&root, "alias.md").unwrap(),
            root.join("references/guide.md")
        );
        let (files, _) = list_files(&root);
        assert!(files.contains(&"alias.md".to_owned()));
        assert!(!files.contains(&"escape.md".to_owned()));
        assert!(!files.iter().any(|f| f.starts_with("up")));
    }

    #[test]
    fn lists_files_without_the_skill_file_or_dot_names() {
        let (_dir, root) = skill_dir();
        let (files, truncated) = list_files(&root);
        assert_eq!(
            files,
            [
                "references/deep/more.md",
                "references/guide.md",
                "scripts/run.py"
            ]
        );
        assert!(!truncated);
    }

    #[test]
    fn the_listing_is_capped() {
        let (_dir, root) = skill_dir();
        for i in 0..MAX_LISTED_FILES + 5 {
            std::fs::write(root.join(format!("f{i:04}.txt")), "").unwrap();
        }
        let (files, truncated) = list_files(&root);
        assert_eq!(files.len(), MAX_LISTED_FILES);
        assert!(truncated);
    }

    #[test]
    fn reads_text_and_reports_binary_and_large_files() {
        let (_dir, root) = skill_dir();
        assert_eq!(
            read_text(&root.join("references/guide.md")).unwrap(),
            ReadOutcome::Text {
                content: "guide".into(),
                size: 5
            }
        );
        std::fs::write(root.join("bin"), [0u8, 1, 2]).unwrap();
        assert_eq!(
            read_text(&root.join("bin")).unwrap(),
            ReadOutcome::Binary { size: 3 }
        );
        let big = root.join("big");
        std::fs::File::create(&big)
            .unwrap()
            .set_len(MAX_READ_BYTES + 1)
            .unwrap();
        assert_eq!(
            read_text(&big).unwrap(),
            ReadOutcome::TooLarge {
                size: MAX_READ_BYTES + 1,
                limit: MAX_READ_BYTES
            }
        );
    }
}
