use serde::Serialize;

pub(crate) const DEFAULT_TIMEOUT_SECS: u64 = 30;
pub(crate) const NETWORK_TIMEOUT_SECS: u64 = 120;
pub(crate) const MAX_TIMEOUT_SECS: u64 = 180;
// Commit hooks (pre-commit, commit-msg) run inside this budget.
pub(crate) const COMMIT_TIMEOUT_SECS: u64 = MAX_TIMEOUT_SECS;
pub(crate) const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
pub(crate) const MIN_GIT_VERSION: &str = "2.23";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoInfo {
    pub repo_root: String,
    pub branch: String,
    pub upstream: Option<String>,
    pub is_detached: bool,
    /// Set when the work tree is a linked worktree (`git worktree add`), not the main one.
    pub linked_worktree: Option<GitLinkedWorktree>,
}

#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitLinkedWorktree {
    /// The worktree's folder name.
    pub name: String,
    /// The repository it belongs to: its main worktree's folder name, or the bare
    /// repository's without `.git`.
    pub repository_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangedFile {
    pub path: String,
    pub original_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
    pub status_label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusSnapshot {
    pub repo_root: String,
    pub branch: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub is_detached: bool,
    pub truncated: bool,
    pub changed_files: Vec<GitChangedFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPanelSnapshot {
    pub repo: Option<GitRepoInfo>,
    pub status: Option<GitStatusSnapshot>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardEntry {
    pub path: String,
    pub untracked: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResult {
    pub diff_text: String,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffContentResult {
    pub original_content: String,
    pub modified_content: String,
    pub is_binary: bool,
    pub fallback_patch: String,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResult {
    pub commit_sha: String,
    pub summary: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFileChange {
    pub path: String,
    pub original_path: Option<String>,
    pub status: String,
    pub status_label: String,
    pub added: u32,
    pub removed: u32,
    pub is_binary: bool,
}

#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum GitRefKind {
    /// HEAD itself, detached.
    Head,
    Branch,
    Tag,
    Remote,
}

/// A ref pointing at a commit, classified by its namespace (`refs/heads`, `refs/tags`,
/// `refs/remotes`), never by its name: a local branch may well be called `origin/x`.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitLogRef {
    pub kind: GitRefKind,
    /// Without its namespace: `main`, `v1.0`, `origin/main`.
    pub name: String,
    /// HEAD is here: the branch it is on, or HEAD itself when detached.
    pub head: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogEntry {
    pub sha: String,
    pub short_sha: String,
    pub author: String,
    pub author_email: String,
    pub timestamp_secs: i64,
    pub parents: Vec<String>,
    pub refs: Vec<GitLogRef>,
    pub subject: String,
    pub files_changed: u32,
    pub insertions: u32,
    pub deletions: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPushResult {
    pub remote: Option<String>,
    pub branch: Option<String>,
    pub pushed: bool,
}

/// A local branch.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchEntry {
    pub name: String,
    /// Another worktree that has the branch checked out, which no other one can.
    pub worktree_path: Option<String>,
    pub is_head: bool,
    pub is_detached: bool,
}

/// One entry of `git worktree list`.
#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeEntry {
    /// As git spells it.
    pub path: String,
    /// The branch checked out, without `refs/heads/`; None when detached or bare.
    pub branch: Option<String>,
    /// The commit checked out; None for a bare repository.
    pub head: Option<String>,
    /// The main worktree (or the bare repository), always listed first.
    pub is_main: bool,
    pub is_bare: bool,
    /// The worktree the listing was made in.
    pub is_current: bool,
    /// The lock reason (possibly empty) when the worktree is locked.
    pub locked: Option<String>,
    /// Its folder is gone; `git worktree prune` drops the entry.
    pub prunable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchListResult {
    pub branches: Vec<GitBranchEntry>,
    pub worktrees: Vec<GitWorktreeEntry>,
}

/// The branch a new worktree checks out.
#[derive(serde::Deserialize, Debug, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum GitWorktreeBranch {
    /// A new branch from `base` (a commit-ish), HEAD when None.
    New { name: String, base: Option<String> },
    /// A local branch no worktree has checked out.
    Existing { name: String },
}

impl GitWorktreeBranch {
    pub fn name(&self) -> &str {
        match self {
            GitWorktreeBranch::New { name, .. } | GitWorktreeBranch::Existing { name } => name,
        }
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeAddResult {
    /// The new worktree's folder, spelled as other paths of the workspace are.
    pub path: String,
    pub branch: String,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeRemoveResult {
    pub removed: bool,
    /// Uncommitted and untracked entries that kept an unforced removal from running.
    pub changes: u32,
}

pub(crate) struct GitOutput {
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
    pub(crate) exit_code: Option<i32>,
    pub(crate) timed_out: bool,
    pub(crate) truncated: bool,
}

pub(crate) enum TextSource {
    Missing,
    Binary,
    Text(String),
}

impl TextSource {
    pub(crate) fn into_text(self) -> String {
        match self {
            TextSource::Text(text) => text,
            TextSource::Missing | TextSource::Binary => String::new(),
        }
    }
}

#[cfg(test)]
mod serde_shape_tests {
    use super::*;

    #[test]
    fn repo_info_serializes_camel_case() {
        let info = GitRepoInfo {
            repo_root: "/repo".into(),
            branch: "main".into(),
            upstream: Some("origin/main".into()),
            is_detached: false,
            linked_worktree: None,
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "repoRoot": "/repo",
                "branch": "main",
                "upstream": "origin/main",
                "isDetached": false,
                "linkedWorktree": null,
            })
        );
        let linked = GitRepoInfo {
            linked_worktree: Some(GitLinkedWorktree {
                name: "repo-feat".into(),
                repository_name: "repo".into(),
            }),
            ..info
        };
        assert_eq!(
            serde_json::to_value(&linked).unwrap()["linkedWorktree"],
            serde_json::json!({ "name": "repo-feat", "repositoryName": "repo" })
        );
    }

    #[test]
    fn changed_file_serializes_all_fields_camel_case() {
        let file = GitChangedFile {
            path: "src/a.ts".into(),
            original_path: Some("src/old.ts".into()),
            index_status: "R".into(),
            worktree_status: " ".into(),
            staged: true,
            unstaged: false,
            untracked: false,
            status_label: "renamed".into(),
        };
        let json = serde_json::to_value(&file).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "path": "src/a.ts",
                "originalPath": "src/old.ts",
                "indexStatus": "R",
                "worktreeStatus": " ",
                "staged": true,
                "unstaged": false,
                "untracked": false,
                "statusLabel": "renamed",
            })
        );
    }

    #[test]
    fn status_snapshot_nests_changed_files() {
        let snapshot = GitStatusSnapshot {
            repo_root: "/repo".into(),
            branch: "main".into(),
            upstream: None,
            ahead: 2,
            behind: 1,
            is_detached: true,
            truncated: false,
            changed_files: vec![],
        };
        let json = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "repoRoot": "/repo",
                "branch": "main",
                "upstream": null,
                "ahead": 2,
                "behind": 1,
                "isDetached": true,
                "truncated": false,
                "changedFiles": [],
            })
        );
    }

    #[test]
    fn panel_snapshot_allows_null_repo_and_status() {
        let panel = GitPanelSnapshot {
            repo: None,
            status: None,
        };
        let json = serde_json::to_value(&panel).unwrap();
        assert_eq!(json, serde_json::json!({ "repo": null, "status": null }));
    }

    #[test]
    fn diff_content_result_keys_stay_camel_case() {
        let diff = GitDiffContentResult {
            original_content: "a".into(),
            modified_content: "b".into(),
            is_binary: false,
            fallback_patch: "".into(),
            truncated: true,
        };
        let json = serde_json::to_value(&diff).unwrap();
        for key in [
            "originalContent",
            "modifiedContent",
            "isBinary",
            "fallbackPatch",
            "truncated",
        ] {
            assert!(json.get(key).is_some(), "missing key {key}");
        }
    }

    #[test]
    fn commit_result_and_file_change_keep_their_contract() {
        let commit = GitCommitResult {
            commit_sha: "abc123".into(),
            summary: "msg".into(),
        };
        assert_eq!(
            serde_json::to_value(&commit).unwrap(),
            serde_json::json!({ "commitSha": "abc123", "summary": "msg" })
        );

        let change = GitCommitFileChange {
            path: "f.rs".into(),
            original_path: None,
            status: "M".into(),
            status_label: "modified".into(),
            added: 3,
            removed: 4,
            is_binary: false,
        };
        let json = serde_json::to_value(&change).unwrap();
        assert_eq!(json["originalPath"], serde_json::Value::Null);
        for key in [
            "path",
            "status",
            "statusLabel",
            "added",
            "removed",
            "isBinary",
        ] {
            assert!(json.get(key).is_some(), "missing key {key}");
        }
    }

    #[test]
    fn log_entry_stats_use_camel_case_names() {
        let entry = GitLogEntry {
            sha: "deadbeef".into(),
            short_sha: "deadbee".into(),
            author: "A".into(),
            author_email: "a@example.com".into(),
            timestamp_secs: 1_700_000_000,
            parents: vec!["p0".into()],
            refs: vec![GitLogRef {
                kind: GitRefKind::Branch,
                name: "main".into(),
                head: true,
            }],
            subject: "s".into(),
            files_changed: 2,
            insertions: 10,
            deletions: 5,
        };
        let json = serde_json::to_value(&entry).unwrap();
        for key in [
            "shortSha",
            "authorEmail",
            "timestampSecs",
            "filesChanged",
            "insertions",
            "deletions",
        ] {
            assert!(json.get(key).is_some(), "missing key {key}");
        }
        assert_eq!(json["parents"], serde_json::json!(["p0"]));
        assert_eq!(
            json["refs"],
            serde_json::json!([{ "kind": "branch", "name": "main", "head": true }])
        );
    }

    #[test]
    fn push_and_branch_results_serialize_as_named() {
        let push = GitPushResult {
            remote: Some("origin".into()),
            branch: None,
            pushed: true,
        };
        assert_eq!(
            serde_json::to_value(&push).unwrap(),
            serde_json::json!({ "remote": "origin", "branch": null, "pushed": true })
        );

        let branch = GitBranchEntry {
            name: "feature".into(),
            worktree_path: None,
            is_head: false,
            is_detached: false,
        };
        let worktree = GitWorktreeEntry {
            path: "/repo-feature".into(),
            branch: Some("feature".into()),
            head: Some("abc".into()),
            is_main: false,
            is_bare: false,
            is_current: false,
            locked: None,
            prunable: false,
        };
        let list = GitBranchListResult {
            branches: vec![branch],
            worktrees: vec![worktree],
        };
        assert_eq!(
            serde_json::to_value(&list).unwrap(),
            serde_json::json!({
                "branches": [{
                    "name": "feature",
                    "worktreePath": null,
                    "isHead": false,
                    "isDetached": false,
                }],
                "worktrees": [{
                    "path": "/repo-feature",
                    "branch": "feature",
                    "head": "abc",
                    "isMain": false,
                    "isBare": false,
                    "isCurrent": false,
                    "locked": null,
                    "prunable": false,
                }],
            })
        );
    }

    #[test]
    fn worktree_requests_and_results_keep_their_contract() {
        let new: GitWorktreeBranch =
            serde_json::from_str(r#"{ "kind": "new", "name": "feat", "base": "main" }"#).unwrap();
        assert!(matches!(
            &new,
            GitWorktreeBranch::New { name, base: Some(base) } if name == "feat" && base == "main"
        ));
        let from_head: GitWorktreeBranch =
            serde_json::from_str(r#"{ "kind": "new", "name": "feat", "base": null }"#).unwrap();
        assert!(matches!(
            from_head,
            GitWorktreeBranch::New { base: None, .. }
        ));
        let existing: GitWorktreeBranch =
            serde_json::from_str(r#"{ "kind": "existing", "name": "fix" }"#).unwrap();
        assert_eq!(existing.name(), "fix");
        assert!(serde_json::from_str::<GitWorktreeBranch>(r#"{ "kind": "other" }"#).is_err());

        assert_eq!(
            serde_json::to_value(GitWorktreeAddResult {
                path: "/w".into(),
                branch: "feat".into(),
            })
            .unwrap(),
            serde_json::json!({ "path": "/w", "branch": "feat" })
        );
        assert_eq!(
            serde_json::to_value(GitWorktreeRemoveResult {
                removed: false,
                changes: 2,
            })
            .unwrap(),
            serde_json::json!({ "removed": false, "changes": 2 })
        );
    }

    #[test]
    fn discard_entry_deserializes_from_camel_case_json() {
        let entry: DiscardEntry =
            serde_json::from_str(r#"{ "path": "x.txt", "untracked": true }"#).unwrap();
        assert_eq!(entry.path, "x.txt");
        assert!(entry.untracked);
    }
}
