//! Linked worktrees (`git worktree`): listing, adding and removing them, and telling whether a
//! work tree is one.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::modules::git::errors::{GitError, Result};
use crate::modules::git::parser::parse_porcelain_v2;
use crate::modules::git::process::{
    ensure_git_available, ensure_success, git_stdout_lines, run_git,
};
use crate::modules::git::types::{
    GitLinkedWorktree, GitWorktreeAddResult, GitWorktreeBranch, GitWorktreeEntry,
    GitWorktreeRemoveResult, DEFAULT_TIMEOUT_SECS, MAX_TIMEOUT_SECS,
};
use crate::modules::git::utils::{
    authorized_repo_root, display_path, validate_branch_name, ResolvedGitDirectory,
};
use crate::modules::workspace::{resolve_path, WorkspaceEnv, WorkspaceRegistry};

/// Adding checks out the whole tree (hooks and filters such as Git LFS run inside it) and
/// removing deletes it, ignored folders such as `node_modules` included.
const WORKTREE_TIMEOUT_SECS: u64 = MAX_TIMEOUT_SECS;

/// Most characters the branch contributes to a default worktree folder name.
const MAX_FOLDER_SLUG_CHARS: usize = 64;

/// `git rev-parse` arguments for [`locate_work_tree`]: the top level, then what
/// [`linked_worktree`] needs, from one git run.
const LOCATE_ARGS: [&str; 4] = [
    "rev-parse",
    "--show-toplevel",
    "--absolute-git-dir",
    "--git-common-dir",
];

pub(crate) struct WorkTreeLocation {
    pub toplevel: String,
    pub linked_worktree: Option<GitLinkedWorktree>,
}

/// The top level of the work tree `cwd` is in, and whether that is a linked worktree. None
/// outside a work tree (no repository, a bare one, or inside a git directory).
pub(crate) fn locate_work_tree(
    workspace: &WorkspaceEnv,
    cwd: &str,
) -> Result<Option<WorkTreeLocation>> {
    let lines = git_stdout_lines(workspace, cwd, LOCATE_ARGS)?;
    let mut lines = lines.iter().map(|line| line.trim());
    let Some(toplevel) = lines.next().filter(|line| !line.is_empty()) else {
        return Ok(None);
    };
    let linked_worktree = match (lines.next(), lines.next()) {
        (Some(git_dir), Some(common_dir)) => linked_worktree(toplevel, git_dir, common_dir),
        _ => None,
    };
    Ok(Some(WorkTreeLocation {
        toplevel: toplevel.to_string(),
        linked_worktree,
    }))
}

/// A linked worktree's git directory is `<common dir>/worktrees/<id>`, while a main worktree's
/// is the common directory itself, which git may print relative to the current folder. For a
/// linked worktree git prints both as absolute real paths.
pub(crate) fn linked_worktree(
    toplevel: &str,
    git_dir: &str,
    common_dir: &str,
) -> Option<GitLinkedWorktree> {
    let git_dir = git_dir.replace('\\', "/");
    let common_dir = common_dir.replace('\\', "/");
    let common_dir = common_dir.trim_end_matches('/');
    if !is_absolute_git_path(common_dir) {
        return None;
    }
    let (admin_parent, id) = git_dir.trim_end_matches('/').rsplit_once('/')?;
    if id.is_empty() || admin_parent != format!("{common_dir}/worktrees") {
        return None;
    }
    Some(GitLinkedWorktree {
        name: last_component(toplevel).to_string(),
        repository_name: repository_name(common_dir),
    })
}

fn is_absolute_git_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with('/')
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && bytes[2] == b'/')
}

fn last_component(path: &str) -> &str {
    let trimmed = path.trim_end_matches(['/', '\\']);
    trimmed
        .rfind(['/', '\\'])
        .map_or(trimmed, |i| &trimmed[i + 1..])
}

/// The repository a git common directory belongs to: the folder holding `.git`, or a bare
/// repository's folder without its `.git` suffix.
fn repository_name(common_dir: &str) -> String {
    let name = last_component(common_dir);
    if name == ".git" {
        let parent = common_dir.trim_end_matches(['/', '\\']);
        let parent = &parent[..parent.len() - name.len()];
        return last_component(parent).to_string();
    }
    name.strip_suffix(".git")
        .filter(|stem| !stem.is_empty())
        .unwrap_or(name)
        .to_string()
}

/// Parses `git worktree list --porcelain`: one record per worktree, each starting with
/// `worktree <path>`. The first is the main worktree, or the bare repository.
pub(crate) fn parse_worktree_list(stdout: &str) -> Vec<GitWorktreeEntry> {
    let mut worktrees: Vec<GitWorktreeEntry> = Vec::new();
    for line in stdout.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(path) = line.strip_prefix("worktree ") {
            worktrees.push(GitWorktreeEntry {
                path: path.to_string(),
                branch: None,
                head: None,
                is_main: worktrees.is_empty(),
                is_bare: false,
                is_current: false,
                locked: None,
                prunable: false,
            });
            continue;
        }
        let Some(entry) = worktrees.last_mut() else {
            continue;
        };
        if let Some(sha) = line.strip_prefix("HEAD ") {
            entry.head = Some(sha.to_string());
        } else if let Some(full) = line.strip_prefix("branch ") {
            entry.branch = Some(full.strip_prefix("refs/heads/").unwrap_or(full).to_string());
        } else if line == "bare" {
            entry.is_bare = true;
        } else if line == "locked" {
            entry.locked = Some(String::new());
        } else if let Some(reason) = line.strip_prefix("locked ") {
            entry.locked = Some(reason.to_string());
        } else if line == "prunable" || line.starts_with("prunable ") {
            entry.prunable = true;
        }
    }
    worktrees
}

/// The worktrees of `repo`'s repository, with `repo`'s own marked current.
pub(crate) fn list_worktrees(
    registry: &WorkspaceRegistry,
    repo: &ResolvedGitDirectory,
) -> Result<Vec<GitWorktreeEntry>> {
    let output = run_git(
        &repo.workspace,
        Some(&repo.git_path),
        ["worktree", "list", "--porcelain"],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git worktree list failed")?;
    let mut worktrees = parse_worktree_list(&String::from_utf8_lossy(&output.stdout));
    if let Some(current) = worktrees
        .iter_mut()
        .find(|wt| !wt.is_bare && is_same_dir(registry, &wt.path, repo))
    {
        current.is_current = true;
    }
    Ok(worktrees)
}

fn is_same_dir(registry: &WorkspaceRegistry, git_path: &str, dir: &ResolvedGitDirectory) -> bool {
    git_path == dir.git_path
        || registry
            .canonicalize_cached(resolve_path(git_path, &dir.workspace))
            .is_ok_and(|canonical| canonical == dir.local_path)
}

/// `<repository folder>-<branch>` beside the repository: `main_root` is the main worktree
/// (a bare repository's folder loses its `.git`), and the branch is made safe for a folder name.
pub(crate) fn default_worktree_path(main_root: &str, branch: &str) -> String {
    let root = main_root.trim_end_matches(['/', '\\']);
    let (parent, folder) = match root.rfind(['/', '\\']) {
        Some(i) => (&root[..=i], &root[i + 1..]),
        None => ("", root),
    };
    let folder = folder
        .strip_suffix(".git")
        .filter(|stem| !stem.is_empty())
        .unwrap_or(folder);
    format!("{parent}{folder}-{}", folder_slug(branch))
}

/// A branch name as a folder name: letters, digits, `.`, `_` and `-` kept, every other run of
/// characters (`/` among them) one `-`, no leading or trailing `-` or `.`, at most 64 characters.
pub(crate) fn folder_slug(branch: &str) -> String {
    let mut slug = String::with_capacity(branch.len());
    for c in branch.chars() {
        if c.is_alphanumeric() || matches!(c, '.' | '_' | '-') {
            slug.push(c);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let capped: String = slug
        .trim_matches(['-', '.'])
        .chars()
        .take(MAX_FOLDER_SLUG_CHARS)
        .collect();
    match capped.trim_end_matches(['-', '.']) {
        "" => "worktree".to_string(),
        slug => slug.to_string(),
    }
}

struct WorktreeFolder {
    /// Handed to git.
    git_path: String,
    local_path: PathBuf,
}

/// The folder a new worktree goes in: an absolute path whose parent folder exists, with nothing
/// there yet or an empty folder (git refuses anything else), never a link.
fn worktree_folder(path: &str, workspace: &WorkspaceEnv) -> Result<WorktreeFolder> {
    let path = path.trim();
    if path.is_empty() || path.chars().any(char::is_control) {
        return Err(GitError::InvalidPath(path.into()));
    }
    let (git_path, absolute) = if workspace.is_wsl() {
        let git_path = path.replace('\\', "/");
        let absolute = git_path.starts_with('/');
        (git_path, absolute)
    } else {
        (path.to_string(), Path::new(path).is_absolute())
    };
    if !absolute {
        return Err(GitError::command(
            "new worktree",
            format!("the folder must be a full path: {path}"),
        ));
    }
    let local_path = resolve_path(&git_path, workspace);
    match std::fs::symlink_metadata(&local_path) {
        Ok(meta) if meta.is_dir() => {
            if std::fs::read_dir(&local_path)?.next().is_some() {
                return Err(GitError::command(
                    "new worktree",
                    format!("the folder is not empty: {path}"),
                ));
            }
        }
        Ok(_) => {
            return Err(GitError::command(
                "new worktree",
                format!("something other than a folder is there: {path}"),
            ));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if !local_path.parent().is_some_and(Path::is_dir) {
                return Err(GitError::command(
                    "new worktree",
                    format!("the folder's parent does not exist: {path}"),
                ));
            }
        }
        Err(e) => return Err(GitError::Io(e)),
    }
    Ok(WorktreeFolder {
        git_path,
        local_path,
    })
}

fn local_branch_exists(repo: &ResolvedGitDirectory, name: &str) -> Result<bool> {
    let output = run_git(
        &repo.workspace,
        Some(&repo.git_path),
        [
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{name}"),
        ],
        DEFAULT_TIMEOUT_SECS,
    )?;
    if output.timed_out {
        return Err(GitError::TimedOut("git rev-parse"));
    }
    Ok(output.exit_code == Some(0))
}

/// Fails unless `base` names a commit. Like branch names it can never be read as an option.
fn ensure_commit(repo: &ResolvedGitDirectory, base: &str) -> Result<()> {
    if base.is_empty()
        || base.starts_with('-')
        || base.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(GitError::command(
            "new worktree",
            format!("invalid base: {base}"),
        ));
    }
    let output = run_git(
        &repo.workspace,
        Some(&repo.git_path),
        [
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{base}^{{commit}}"),
        ],
        DEFAULT_TIMEOUT_SECS,
    )?;
    if output.timed_out {
        return Err(GitError::TimedOut("git rev-parse"));
    }
    if output.exit_code != Some(0) {
        return Err(GitError::command(
            "new worktree",
            format!("{base} is not a commit"),
        ));
    }
    Ok(())
}

/// `git worktree add`, the folder and the commit after `--`.
fn worktree_add_args(branch: &GitWorktreeBranch, path: &str) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["worktree".into(), "add".into()];
    match branch {
        GitWorktreeBranch::New { name, base } => {
            args.extend(["-b".into(), name.into(), "--".into(), path.into()]);
            if let Some(base) = base {
                args.push(base.into());
            }
        }
        GitWorktreeBranch::Existing { name } => {
            args.extend(["--".into(), path.into(), name.into()]);
        }
    }
    args
}

/// Adds a worktree for a new branch, or for a local branch no worktree has checked out, in
/// `path` (or `<repository folder>-<branch>` beside the repository), and authorizes its folder.
pub fn add(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    branch: &GitWorktreeBranch,
    path: Option<&str>,
    workspace: &WorkspaceEnv,
) -> Result<GitWorktreeAddResult> {
    let repo = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo.workspace)?;
    let name = branch.name();
    validate_branch_name(name)?;
    let worktrees = list_worktrees(registry, &repo)?;
    let exists = local_branch_exists(&repo, name)?;
    match branch {
        GitWorktreeBranch::New { base, .. } => {
            if exists {
                return Err(GitError::command(
                    "new worktree",
                    format!("a branch named {name} already exists"),
                ));
            }
            if let Some(base) = base {
                ensure_commit(&repo, base)?;
            }
        }
        GitWorktreeBranch::Existing { .. } => {
            if !exists {
                return Err(GitError::command(
                    "new worktree",
                    format!("there is no local branch named {name}"),
                ));
            }
            if let Some(holder) = worktrees
                .iter()
                .find(|wt| wt.branch.as_deref() == Some(name))
            {
                return Err(GitError::command(
                    "new worktree",
                    format!("{name} is already checked out in {}", holder.path),
                ));
            }
        }
    }
    let path = match path.map(str::trim).filter(|p| !p.is_empty()) {
        Some(path) => path.to_string(),
        None => {
            let main = worktrees.first().ok_or_else(|| {
                GitError::command("new worktree", "the repository lists no worktrees")
            })?;
            default_worktree_path(&main.path, name)
        }
    };
    let folder = worktree_folder(&path, &repo.workspace)?;
    let output = run_git(
        &repo.workspace,
        Some(&repo.git_path),
        worktree_add_args(branch, &folder.git_path),
        WORKTREE_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git worktree add failed")?;
    let canonical = registry.authorize(&folder.local_path)?;
    let path = if repo.workspace.is_wsl() {
        folder.git_path
    } else {
        display_path(&canonical)
    };
    Ok(GitWorktreeAddResult {
        path,
        branch: name.to_string(),
    })
}

fn find_worktree<'a>(
    registry: &WorkspaceRegistry,
    workspace: &WorkspaceEnv,
    worktrees: &'a [GitWorktreeEntry],
    path: &str,
) -> Option<&'a GitWorktreeEntry> {
    if let Some(found) = worktrees.iter().find(|wt| wt.path == path) {
        return Some(found);
    }
    let wanted = registry
        .canonicalize_cached(resolve_path(path, workspace))
        .ok()?;
    worktrees.iter().find(|wt| {
        registry
            .canonicalize_cached(resolve_path(&wt.path, workspace))
            .is_ok_and(|canonical| canonical == wanted)
    })
}

/// Never the main worktree, nor the one the command runs in, nor a locked one.
fn ensure_removable(worktree: &GitWorktreeEntry) -> Result<()> {
    if worktree.is_main || worktree.is_bare {
        return Err(GitError::command(
            "remove worktree",
            "the main worktree cannot be removed",
        ));
    }
    if worktree.is_current {
        return Err(GitError::command(
            "remove worktree",
            "this worktree is the one open; open another worktree of the repository to remove it",
        ));
    }
    if let Some(reason) = &worktree.locked {
        let reason = if reason.is_empty() {
            String::new()
        } else {
            format!(" ({reason})")
        };
        return Err(GitError::command(
            "remove worktree",
            format!("the worktree is locked{reason}; unlock it with `git worktree unlock` first"),
        ));
    }
    Ok(())
}

/// Uncommitted and untracked entries in a worktree, as `git worktree remove` counts them.
fn count_changes(workspace: &WorkspaceEnv, worktree: &str) -> Result<u32> {
    let output = run_git(
        workspace,
        Some(worktree),
        [
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=normal",
            "--ignore-submodules=none",
        ],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git status failed")?;
    let files = parse_porcelain_v2(&String::from_utf8_lossy(&output.stdout)).files;
    Ok(u32::try_from(files.len()).unwrap_or(u32::MAX))
}

/// Removes a linked worktree, then prunes the records of worktrees whose folder is gone. One
/// with uncommitted or untracked changes is only removed when `force` is set; otherwise the
/// result reports them and nothing changes.
pub fn remove(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    path: &str,
    force: bool,
    workspace: &WorkspaceEnv,
) -> Result<GitWorktreeRemoveResult> {
    let repo = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo.workspace)?;
    let worktrees = list_worktrees(registry, &repo)?;
    let worktree = find_worktree(registry, &repo.workspace, &worktrees, path).ok_or_else(|| {
        GitError::command(
            "remove worktree",
            format!("not a worktree of this repository: {path}"),
        )
    })?;
    ensure_removable(worktree)?;
    // A folder deleted by hand leaves only git's record, which pruning drops.
    let folder_gone = matches!(
        std::fs::symlink_metadata(resolve_path(&worktree.path, &repo.workspace)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound
    );
    if !folder_gone {
        if !force {
            let changes = count_changes(&repo.workspace, &worktree.path)?;
            if changes > 0 {
                return Ok(GitWorktreeRemoveResult {
                    removed: false,
                    changes,
                });
            }
        }
        let mut args: Vec<OsString> = vec!["worktree".into(), "remove".into()];
        if force {
            args.push("--force".into());
        }
        args.extend(["--".into(), worktree.path.clone().into()]);
        let output = run_git(
            &repo.workspace,
            Some(&repo.git_path),
            args,
            WORKTREE_TIMEOUT_SECS,
        )?;
        ensure_success(&output, "git worktree remove failed")?;
    }
    let pruned = run_git(
        &repo.workspace,
        Some(&repo.git_path),
        ["worktree", "prune"],
        DEFAULT_TIMEOUT_SECS,
    )
    .and_then(|output| ensure_success(&output, "git worktree prune failed"));
    if let Err(e) = pruned {
        log::warn!("worktree removed, but pruning failed: {e}");
    }
    Ok(GitWorktreeRemoveResult {
        removed: true,
        changes: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn entry(path: &str) -> GitWorktreeEntry {
        GitWorktreeEntry {
            path: path.into(),
            branch: None,
            head: None,
            is_main: false,
            is_bare: false,
            is_current: false,
            locked: None,
            prunable: false,
        }
    }

    #[test]
    fn parses_the_porcelain_listing() {
        let stdout = "worktree /r/main\nHEAD aaa\nbranch refs/heads/main\n\n\
                      worktree /r/main-feat\nHEAD bbb\nbranch refs/heads/feat/x\nlocked\n\n\
                      worktree /r/detached\nHEAD ccc\ndetached\nlocked on a usb drive\n\n\
                      worktree /r/gone\nHEAD ddd\nbranch refs/heads/gone\nprunable gitdir file points to non-existent location\n\n";
        let parsed = parse_worktree_list(stdout);
        assert_eq!(
            parsed,
            vec![
                GitWorktreeEntry {
                    branch: Some("main".into()),
                    head: Some("aaa".into()),
                    is_main: true,
                    ..entry("/r/main")
                },
                GitWorktreeEntry {
                    branch: Some("feat/x".into()),
                    head: Some("bbb".into()),
                    locked: Some(String::new()),
                    ..entry("/r/main-feat")
                },
                GitWorktreeEntry {
                    head: Some("ccc".into()),
                    locked: Some("on a usb drive".into()),
                    ..entry("/r/detached")
                },
                GitWorktreeEntry {
                    branch: Some("gone".into()),
                    head: Some("ddd".into()),
                    prunable: true,
                    ..entry("/r/gone")
                },
            ]
        );
    }

    #[test]
    fn parses_a_bare_main_and_windows_line_ends() {
        let parsed = parse_worktree_list(
            "worktree C:/r/repo.git\r\nbare\r\n\r\nworktree C:/r/repo-x\r\nHEAD e\r\nbranch refs/heads/x\r\n",
        );
        assert_eq!(parsed.len(), 2);
        assert!(parsed[0].is_main && parsed[0].is_bare && parsed[0].head.is_none());
        assert_eq!(parsed[1].path, "C:/r/repo-x");
        assert_eq!(parsed[1].branch.as_deref(), Some("x"));
        assert!(!parsed[1].is_main);
        assert!(parse_worktree_list("").is_empty());
        assert!(parse_worktree_list("HEAD abc\nbranch refs/heads/x\n").is_empty());
    }

    #[test]
    fn a_linked_worktree_is_told_from_a_main_one() {
        assert_eq!(
            linked_worktree(
                "/r/main-feat",
                "/r/main/.git/worktrees/main-feat",
                "/r/main/.git"
            ),
            Some(GitLinkedWorktree {
                name: "main-feat".into(),
                repository_name: "main".into(),
            })
        );
        // The admin folder keeps git's id even when the folder was renamed or uniquified.
        assert_eq!(
            linked_worktree("/r/elsewhere", "/r/main/.git/worktrees/x1", "/r/main/.git/")
                .map(|w| w.name),
            Some("elsewhere".into())
        );
        // A bare repository's linked worktree.
        assert_eq!(
            linked_worktree("/r/repo-x", "/r/repo.git/worktrees/repo-x", "/r/repo.git")
                .map(|w| w.repository_name),
            Some("repo".into())
        );
        // Windows paths, as git prints them.
        assert_eq!(
            linked_worktree(
                "C:/src/app-fix",
                "C:/src/app/.git/worktrees/app-fix",
                "C:/src/app/.git"
            )
            .map(|w| (w.name, w.repository_name)),
            Some(("app-fix".into(), "app".into()))
        );
        // Main worktrees: the common directory is the git directory, often spelled relative.
        assert_eq!(linked_worktree("/r/main", "/r/main/.git", ".git"), None);
        assert_eq!(linked_worktree("/r/main", "/r/main/.git", "../.git"), None);
        assert_eq!(
            linked_worktree("/r/main", "/r/main/.git", "/r/main/.git"),
            None
        );
        // A separate git directory is not a linked worktree either.
        assert_eq!(
            linked_worktree("/r/main", "/g/main.git", "/g/main.git"),
            None
        );
        // A submodule's git directory lives under `modules`, not `worktrees`.
        assert_eq!(
            linked_worktree(
                "/r/main/sub",
                "/r/main/.git/modules/sub",
                "/r/main/.git/modules/sub"
            ),
            None
        );
        assert_eq!(
            linked_worktree("/r/x", "/r/main/.git/worktrees/", "/r/main/.git"),
            None
        );
    }

    #[test]
    fn default_folder_sits_beside_the_repository() {
        assert_eq!(default_worktree_path("/r/app", "feat"), "/r/app-feat");
        assert_eq!(
            default_worktree_path("/r/app/", "feature/login"),
            "/r/app-feature-login"
        );
        assert_eq!(default_worktree_path("C:/src/app", "fix"), "C:/src/app-fix");
        assert_eq!(default_worktree_path("/r/app.git", "x"), "/r/app-x");
        assert_eq!(default_worktree_path("/r/.git", "x"), "/r/.git-x");
        assert_eq!(default_worktree_path("/app", "x"), "/app-x");
    }

    #[test]
    fn branch_slugs_are_safe_folder_names() {
        assert_eq!(folder_slug("feat"), "feat");
        assert_eq!(folder_slug("feature/login"), "feature-login");
        assert_eq!(folder_slug("a//b"), "a-b");
        assert_eq!(folder_slug("fix-/x"), "fix-x");
        assert_eq!(folder_slug("v1.2_rc"), "v1.2_rc");
        assert_eq!(folder_slug("größe/ü"), "größe-ü");
        assert_eq!(folder_slug("a:b*c?d\"e<f>g|h"), "a-b-c-d-e-f-g-h");
        assert_eq!(folder_slug(".hidden/"), "hidden");
        assert_eq!(folder_slug("x."), "x");
        assert_eq!(folder_slug("///"), "worktree");
        assert_eq!(folder_slug(""), "worktree");
        let long = "a".repeat(63) + "/b";
        assert_eq!(folder_slug(&long), "a".repeat(63));
        assert_eq!(folder_slug(&"é".repeat(80)).chars().count(), 64);
    }

    #[test]
    fn only_linked_unlocked_other_worktrees_are_removable() {
        let linked = entry("/r/x");
        assert!(ensure_removable(&linked).is_ok());
        for (worktree, needle) in [
            (
                GitWorktreeEntry {
                    is_main: true,
                    ..entry("/r/main")
                },
                "main worktree",
            ),
            (
                GitWorktreeEntry {
                    is_bare: true,
                    ..entry("/r/repo.git")
                },
                "main worktree",
            ),
            (
                GitWorktreeEntry {
                    is_current: true,
                    ..entry("/r/x")
                },
                "the one open",
            ),
            (
                GitWorktreeEntry {
                    locked: Some(String::new()),
                    ..entry("/r/x")
                },
                "locked;",
            ),
            (
                GitWorktreeEntry {
                    locked: Some("on a usb drive".into()),
                    ..entry("/r/x")
                },
                "locked (on a usb drive)",
            ),
        ] {
            let message = ensure_removable(&worktree).unwrap_err().to_string();
            assert!(message.contains(needle), "{message}");
        }
    }

    #[test]
    fn add_arguments_put_the_folder_and_commit_after_the_separator() {
        let strings = |args: Vec<OsString>| -> Vec<String> {
            args.into_iter().map(|a| a.into_string().unwrap()).collect()
        };
        assert_eq!(
            strings(worktree_add_args(
                &GitWorktreeBranch::New {
                    name: "feat".into(),
                    base: None,
                },
                "/r/-x",
            )),
            ["worktree", "add", "-b", "feat", "--", "/r/-x"]
        );
        assert_eq!(
            strings(worktree_add_args(
                &GitWorktreeBranch::New {
                    name: "feat".into(),
                    base: Some("origin/main".into()),
                },
                "/r/x",
            )),
            ["worktree", "add", "-b", "feat", "--", "/r/x", "origin/main"]
        );
        assert_eq!(
            strings(worktree_add_args(
                &GitWorktreeBranch::Existing { name: "fix".into() },
                "/r/x",
            )),
            ["worktree", "add", "--", "/r/x", "fix"]
        );
    }

    #[test]
    fn the_folder_must_be_new_or_empty_with_an_existing_parent() {
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let local = WorkspaceEnv::Local;
        let at = |name: &str| base.join(name).to_string_lossy().into_owned();

        assert!(worktree_folder(&at("new"), &local).is_ok());
        std::fs::create_dir(base.join("empty")).unwrap();
        assert!(worktree_folder(&at("empty"), &local).is_ok());

        std::fs::create_dir(base.join("full")).unwrap();
        std::fs::write(base.join("full/a"), "a").unwrap();
        let err = worktree_folder(&at("full"), &local).err().unwrap();
        assert!(err.to_string().contains("not empty"), "{err}");

        std::fs::write(base.join("file"), "x").unwrap();
        let err = worktree_folder(&at("file"), &local).err().unwrap();
        assert!(err.to_string().contains("other than a folder"), "{err}");

        let err = worktree_folder(&at("missing/new"), &local).err().unwrap();
        assert!(err.to_string().contains("parent does not exist"), "{err}");

        let err = worktree_folder("relative/new", &local).err().unwrap();
        assert!(err.to_string().contains("full path"), "{err}");
        assert!(matches!(
            worktree_folder("", &local),
            Err(GitError::InvalidPath(_))
        ));
        assert!(matches!(
            worktree_folder(&format!("{}\0", at("x")), &local),
            Err(GitError::InvalidPath(_))
        ));

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(base.join("empty"), base.join("link")).unwrap();
            let err = worktree_folder(&at("link"), &local).err().unwrap();
            assert!(err.to_string().contains("other than a folder"), "{err}");
        }
    }

    // Integration tests against real repositories.

    fn git(dir: &Path, args: &[&str]) -> std::process::Output {
        Command::new("git")
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git on PATH")
    }

    fn git_ok(dir: &Path, args: &[&str]) -> String {
        let out = git(dir, args);
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        /// The folder holding the repository, for worktrees beside it.
        base: PathBuf,
        main: PathBuf,
        registry: WorkspaceRegistry,
    }

    impl Fixture {
        /// A repository `app` with one commit on `main` and a branch `other`, the repository
        /// folder alone authorized.
        fn new() -> Option<Self> {
            if Command::new("git").arg("--version").output().is_err() {
                return None;
            }
            let dir = tempfile::tempdir().unwrap();
            let base = std::fs::canonicalize(dir.path()).unwrap();
            let main = base.join("app");
            std::fs::create_dir(&main).unwrap();
            git_ok(&main, &["init", "-q", "-b", "main"]);
            std::fs::write(main.join("a.txt"), "a\n").unwrap();
            git_ok(&main, &["add", "a.txt"]);
            git_ok(&main, &["commit", "-q", "-m", "init"]);
            git_ok(&main, &["branch", "other"]);
            let registry = WorkspaceRegistry::default();
            registry.authorize(&main).unwrap();
            Some(Self {
                _dir: dir,
                base,
                main,
                registry,
            })
        }

        /// Spelled as the app spells paths (no `\\?\` prefix on Windows), which git takes.
        fn root(&self) -> String {
            display_path(&self.main)
        }

        fn at(&self, name: &str) -> String {
            display_path(&self.base.join(name))
        }

        fn add(
            &self,
            branch: GitWorktreeBranch,
            path: Option<&str>,
        ) -> Result<GitWorktreeAddResult> {
            add(
                &self.registry,
                &self.root(),
                &branch,
                path,
                &WorkspaceEnv::Local,
            )
        }

        fn remove(&self, path: &str, force: bool) -> Result<GitWorktreeRemoveResult> {
            remove(
                &self.registry,
                &self.root(),
                path,
                force,
                &WorkspaceEnv::Local,
            )
        }

        fn worktree_paths(&self) -> Vec<String> {
            git_ok(&self.main, &["worktree", "list", "--porcelain"])
                .lines()
                .filter_map(|l| l.strip_prefix("worktree ").map(str::to_string))
                .collect()
        }
    }

    fn new_branch(name: &str, base: Option<&str>) -> GitWorktreeBranch {
        GitWorktreeBranch::New {
            name: name.into(),
            base: base.map(str::to_string),
        }
    }

    fn existing(name: &str) -> GitWorktreeBranch {
        GitWorktreeBranch::Existing { name: name.into() }
    }

    #[test]
    fn adds_a_new_branch_from_head_in_the_default_folder_and_authorizes_it() {
        let Some(fx) = Fixture::new() else { return };
        let target = fx.base.join("app-feature-login");
        assert!(!fx.registry.is_authorized(&fx.base));

        let added = fx.add(new_branch("feature/login", None), None).unwrap();

        assert_eq!(added.path, display_path(&target));
        assert_eq!(added.branch, "feature/login");
        assert!(target.join("a.txt").is_file());
        assert_eq!(
            git_ok(&target, &["rev-parse", "--abbrev-ref", "HEAD"]),
            "feature/login"
        );
        assert_eq!(
            git_ok(&target, &["rev-parse", "HEAD"]),
            git_ok(&fx.main, &["rev-parse", "HEAD"])
        );
        assert!(fx.registry.is_authorized(&target));
        assert!(!fx.registry.is_authorized(&fx.base));
    }

    #[test]
    fn adds_a_new_branch_from_a_chosen_base() {
        let Some(fx) = Fixture::new() else { return };
        let first = git_ok(&fx.main, &["rev-parse", "HEAD"]);
        std::fs::write(fx.main.join("b.txt"), "b\n").unwrap();
        git_ok(&fx.main, &["add", "b.txt"]);
        git_ok(&fx.main, &["commit", "-q", "-m", "second"]);

        let path = fx.at("from-other");
        fx.add(new_branch("from-other", Some("other")), Some(&path))
            .unwrap();
        assert_eq!(git_ok(Path::new(&path), &["rev-parse", "HEAD"]), first);

        let err = fx
            .add(
                new_branch("nope", Some("no-such-ref")),
                Some(&fx.at("nope")),
            )
            .unwrap_err();
        assert!(err.to_string().contains("not a commit"), "{err}");
        for base in ["--orphan", "-b", "a b", ""] {
            let err = fx
                .add(new_branch("nope", Some(base)), Some(&fx.at("nope")))
                .unwrap_err();
            assert!(err.to_string().contains("invalid base"), "{base:?}: {err}");
        }
        assert!(!fx.base.join("nope").exists());
    }

    #[test]
    fn a_new_branch_must_not_exist_yet() {
        let Some(fx) = Fixture::new() else { return };
        let err = fx
            .add(new_branch("other", None), Some(&fx.at("x")))
            .unwrap_err();
        assert!(err.to_string().contains("already exists"), "{err}");
        assert!(!fx.base.join("x").exists());
    }

    #[test]
    fn adds_an_existing_branch_not_checked_out_elsewhere() {
        let Some(fx) = Fixture::new() else { return };
        let path = fx.at("app-other");
        fx.add(existing("other"), Some(&path)).unwrap();
        assert_eq!(
            git_ok(Path::new(&path), &["rev-parse", "--abbrev-ref", "HEAD"]),
            "other"
        );

        // `other` is now checked out there, and `main` in the main worktree.
        for name in ["other", "main"] {
            let err = fx.add(existing(name), Some(&fx.at("again"))).unwrap_err();
            assert!(err.to_string().contains("already checked out"), "{err}");
        }
        let err = fx
            .add(existing("missing"), Some(&fx.at("again")))
            .unwrap_err();
        assert!(err.to_string().contains("no local branch"), "{err}");
        assert!(!fx.base.join("again").exists());
    }

    #[test]
    fn branch_names_are_checked_as_for_switching() {
        let Some(fx) = Fixture::new() else { return };
        for name in ["-b", "--detach", "a..b", "a b", "HEAD", ""] {
            for branch in [new_branch(name, None), existing(name)] {
                let err = fx.add(branch, Some(&fx.at("bad"))).unwrap_err();
                assert!(
                    matches!(err, GitError::InvalidBranchName(_)),
                    "{name:?}: {err}"
                );
            }
        }
        assert!(!fx.base.join("bad").exists());
        assert_eq!(fx.worktree_paths().len(), 1);
    }

    #[test]
    fn the_folder_is_validated_before_git_runs() {
        let Some(fx) = Fixture::new() else { return };
        std::fs::create_dir(fx.base.join("full")).unwrap();
        std::fs::write(fx.base.join("full/keep.txt"), "mine").unwrap();
        let err = fx
            .add(new_branch("x", None), Some(&fx.at("full")))
            .unwrap_err();
        assert!(err.to_string().contains("not empty"), "{err}");
        assert_eq!(
            std::fs::read_to_string(fx.base.join("full/keep.txt")).unwrap(),
            "mine"
        );
        let err = fx
            .add(new_branch("x", None), Some(&fx.at("no/parent")))
            .unwrap_err();
        assert!(err.to_string().contains("parent does not exist"), "{err}");
        let err = fx.add(new_branch("x", None), Some("relative")).unwrap_err();
        assert!(err.to_string().contains("full path"), "{err}");
        // Nothing was created: no branch, no worktree.
        assert!(git(
            &fx.main,
            &["rev-parse", "--verify", "--quiet", "refs/heads/x"]
        )
        .stdout
        .is_empty());
        assert_eq!(fx.worktree_paths().len(), 1);

        std::fs::create_dir(fx.base.join("empty")).unwrap();
        fx.add(new_branch("x", None), Some(&fx.at("empty")))
            .unwrap();
        assert!(fx.base.join("empty/a.txt").is_file());
    }

    #[test]
    fn worktrees_of_an_unauthorized_repository_are_refused() {
        let Some(fx) = Fixture::new() else { return };
        let stranger = WorkspaceRegistry::default();
        let err = add(
            &stranger,
            &fx.root(),
            &new_branch("x", None),
            None,
            &WorkspaceEnv::Local,
        )
        .unwrap_err();
        assert!(matches!(err, GitError::PathOutsideWorkspace(_)), "{err}");
        let err = remove(
            &stranger,
            &fx.root(),
            &fx.root(),
            true,
            &WorkspaceEnv::Local,
        )
        .unwrap_err();
        assert!(matches!(err, GitError::PathOutsideWorkspace(_)), "{err}");
        assert!(!fx.base.join("app-x").exists());
    }

    #[test]
    fn lists_worktrees_with_the_current_and_main_marked() {
        let Some(fx) = Fixture::new() else { return };
        let linked = fx.add(existing("other"), None).unwrap();
        let repo = authorized_repo_root(&fx.registry, &fx.root(), &WorkspaceEnv::Local).unwrap();
        let listed = list_worktrees(&fx.registry, &repo).unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed[0].is_main && listed[0].is_current);
        assert_eq!(listed[0].branch.as_deref(), Some("main"));
        assert!(!listed[1].is_main && !listed[1].is_current);
        assert_eq!(listed[1].path, linked.path);
        assert_eq!(listed[1].branch.as_deref(), Some("other"));

        let from_linked =
            authorized_repo_root(&fx.registry, &linked.path, &WorkspaceEnv::Local).unwrap();
        let listed = list_worktrees(&fx.registry, &from_linked).unwrap();
        assert!(listed[0].is_main && !listed[0].is_current);
        assert!(listed[1].is_current);
    }

    #[test]
    fn locates_linked_worktrees_from_any_folder_inside() {
        let Some(fx) = Fixture::new() else { return };
        let linked = fx.add(new_branch("feat", None), None).unwrap();
        std::fs::create_dir(Path::new(&linked.path).join("sub")).unwrap();
        std::fs::create_dir(fx.main.join("sub")).unwrap();
        let local = WorkspaceEnv::Local;

        let found = locate_work_tree(&local, &format!("{}/sub", linked.path))
            .unwrap()
            .unwrap();
        assert_eq!(found.toplevel, linked.path);
        assert_eq!(
            found.linked_worktree,
            Some(GitLinkedWorktree {
                name: "app-feat".into(),
                repository_name: "app".into(),
            })
        );
        for cwd in [fx.root(), format!("{}/sub", fx.root())] {
            let found = locate_work_tree(&local, &cwd).unwrap().unwrap();
            assert_eq!(found.toplevel, fx.root());
            assert_eq!(found.linked_worktree, None);
        }

        // Source Control's snapshot and repository lookup carry it.
        use crate::modules::git::operations::{panel_snapshot, resolve_repo};
        let snapshot = panel_snapshot(&fx.registry, &linked.path, &local).unwrap();
        let repo = snapshot.repo.unwrap();
        assert_eq!(repo.repo_root, linked.path);
        assert_eq!(
            repo.linked_worktree.map(|w| w.repository_name),
            Some("app".into())
        );
        let repo = resolve_repo(&fx.registry, &fx.root(), &local)
            .unwrap()
            .unwrap();
        assert_eq!(repo.linked_worktree, None);
        assert_eq!(
            resolve_repo(&fx.registry, &linked.path, &local)
                .unwrap()
                .unwrap()
                .linked_worktree
                .map(|w| w.name),
            Some("app-feat".into())
        );
        let outside = tempfile::tempdir().unwrap();
        assert!(locate_work_tree(&local, &outside.path().to_string_lossy())
            .unwrap()
            .is_none());
        assert!(locate_work_tree(&local, &format!("{}/.git", fx.root()))
            .unwrap()
            .is_none());
    }

    #[test]
    fn removes_a_clean_worktree_and_prunes() {
        let Some(fx) = Fixture::new() else { return };
        let keep = fx.add(new_branch("keep", None), None).unwrap();
        let gone = fx.add(new_branch("gone", None), None).unwrap();
        // A worktree deleted by hand earlier is pruned too.
        std::fs::remove_dir_all(&gone.path).unwrap();
        let drop = fx.add(new_branch("drop", None), None).unwrap();

        let result = fx.remove(&drop.path, false).unwrap();

        assert_eq!(
            result,
            GitWorktreeRemoveResult {
                removed: true,
                changes: 0,
            }
        );
        assert!(!Path::new(&drop.path).exists());
        assert_eq!(fx.worktree_paths(), vec![fx.root(), keep.path.clone()]);
        // Branches stay.
        assert!(!git_ok(&fx.main, &["branch", "--list", "drop"]).is_empty());
    }

    #[test]
    fn a_worktree_with_changes_is_only_removed_when_forced() {
        let Some(fx) = Fixture::new() else { return };
        let wt = fx.add(new_branch("dirty", None), None).unwrap();
        let dir = PathBuf::from(&wt.path);
        std::fs::write(dir.join("a.txt"), "changed\n").unwrap();
        std::fs::write(dir.join("new.txt"), "untracked\n").unwrap();

        let result = fx.remove(&wt.path, false).unwrap();
        assert_eq!(
            result,
            GitWorktreeRemoveResult {
                removed: false,
                changes: 2,
            }
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("new.txt")).unwrap(),
            "untracked\n"
        );
        assert_eq!(fx.worktree_paths().len(), 2);

        // Untracked files alone count as well.
        git_ok(&dir, &["checkout", "--", "a.txt"]);
        assert_eq!(fx.remove(&wt.path, false).unwrap().changes, 1);

        let result = fx.remove(&wt.path, true).unwrap();
        assert!(result.removed);
        assert!(!dir.exists());
        assert_eq!(fx.worktree_paths(), vec![fx.root()]);
    }

    #[test]
    fn never_removes_the_main_the_current_a_locked_or_a_foreign_worktree() {
        let Some(fx) = Fixture::new() else { return };
        let err = fx.remove(&fx.root(), true).unwrap_err();
        assert!(err.to_string().contains("main worktree"), "{err}");

        let linked = fx.add(new_branch("open", None), None).unwrap();
        // Run from inside the linked worktree: it is the current one, and main is still main.
        let err = remove(
            &fx.registry,
            &linked.path,
            &linked.path,
            true,
            &WorkspaceEnv::Local,
        )
        .unwrap_err();
        assert!(err.to_string().contains("the one open"), "{err}");
        let err = remove(
            &fx.registry,
            &linked.path,
            &fx.root(),
            true,
            &WorkspaceEnv::Local,
        )
        .unwrap_err();
        assert!(err.to_string().contains("main worktree"), "{err}");

        git_ok(
            &fx.main,
            &["worktree", "lock", "--reason", "busy", &linked.path],
        );
        let err = fx.remove(&linked.path, true).unwrap_err();
        assert!(err.to_string().contains("locked (busy)"), "{err}");

        let stranger = fx.at("stranger");
        std::fs::create_dir(&stranger).unwrap();
        let err = fx.remove(&stranger, true).unwrap_err();
        assert!(err.to_string().contains("not a worktree"), "{err}");

        assert!(fx.main.join("a.txt").is_file());
        assert!(Path::new(&linked.path).join("a.txt").is_file());
        assert!(Path::new(&stranger).is_dir());
    }

    #[test]
    fn removes_a_worktree_named_through_another_spelling() {
        let Some(fx) = Fixture::new() else { return };
        let wt = fx.add(new_branch("x", None), None).unwrap();
        let spelled = format!("{}/../app-x", fx.root());
        assert!(fx.remove(&spelled, false).unwrap().removed);
        assert!(!Path::new(&wt.path).exists());
    }
}
