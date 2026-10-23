mod common;

use common::{git_available, GitRepoFixture};
use tempfile::TempDir;
use oarlock_lib::modules::fs::to_canon;
use oarlock_lib::modules::git::errors::GitError;
use oarlock_lib::modules::git::operations;
use oarlock_lib::modules::git::types::DiscardEntry;
use oarlock_lib::modules::workspace::{WorkspaceEnv, WorkspaceRegistry};

fn skip_if_no_git() -> bool {
    if !git_available() {
        eprintln!("skipping: git not on PATH");
        return true;
    }
    false
}

#[test]
fn resolve_repo_returns_none_outside_repo() {
    if skip_if_no_git() {
        return;
    }
    let tmp = TempDir::new().unwrap();
    let canonical = std::fs::canonicalize(tmp.path()).unwrap();
    let registry = WorkspaceRegistry::default();
    registry.authorize(&canonical).unwrap();

    let info = operations::resolve_repo(&registry, &to_canon(&canonical), &WorkspaceEnv::Local)
        .expect("resolve_repo");
    assert!(info.is_none());
}

#[test]
fn resolve_repo_returns_branch_for_real_repo() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("seed.txt", "seed\n");
    fx.run_git(&["add", "seed.txt"]);
    fx.run_git(&["commit", "-q", "-m", "seed"]);

    let info = operations::resolve_repo(&fx.registry, &fx.repo_str(), &fx.workspace)
        .expect("resolve_repo")
        .expect("repo present");
    assert_eq!(info.branch, "main");
    assert!(info.upstream.is_none());
    assert!(!info.is_detached);
}

#[test]
fn resolve_repo_returns_branch_for_unborn_head() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    let info = operations::resolve_repo(&fx.registry, &fx.repo_str(), &fx.workspace)
        .expect("resolve_repo")
        .expect("repo present even without commits");
    assert_eq!(info.branch, "main");
    assert!(info.upstream.is_none());
    assert!(!info.is_detached);
}

#[test]
fn status_on_empty_repo_has_no_files() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    let snap = operations::status(&fx.registry, &fx.repo_str(), &fx.workspace).expect("status");
    assert_eq!(snap.branch, "main");
    assert!(snap.changed_files.is_empty());
    assert_eq!(snap.ahead, 0);
    assert_eq!(snap.behind, 0);
}

#[test]
fn status_lists_untracked_file() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("hello.txt", "hi\n");
    let snap = operations::status(&fx.registry, &fx.repo_str(), &fx.workspace).expect("status");
    let entry = snap
        .changed_files
        .iter()
        .find(|f| f.path == "hello.txt")
        .expect("hello.txt in changed_files");
    assert!(entry.untracked);
    assert!(!entry.staged);
}

#[test]
fn status_expands_small_untracked_directories_into_files() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("seed.txt", "seed\n");
    fx.run_git(&["add", "seed.txt"]);
    fx.run_git(&["commit", "-q", "-m", "seed"]);
    fx.write_file("feature/a.rs", "a\n");
    fx.write_file("feature/deep/b.rs", "b\n");
    fx.write_file(".gitignore", "feature/ignored.log\n");
    fx.write_file("feature/ignored.log", "x\n");

    let snap = operations::status(&fx.registry, &fx.repo_str(), &fx.workspace).expect("status");
    let mut paths: Vec<&str> = snap.changed_files.iter().map(|f| f.path.as_str()).collect();
    paths.sort();
    assert_eq!(
        paths,
        vec![".gitignore", "feature/a.rs", "feature/deep/b.rs"]
    );
    assert!(snap.changed_files.iter().all(|f| f.untracked));
}

#[test]
fn status_keeps_huge_untracked_directories_collapsed_instead_of_listing_every_file() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("seed.txt", "seed\n");
    fx.run_git(&["add", "seed.txt"]);
    fx.run_git(&["commit", "-q", "-m", "seed"]);
    for i in 0..650 {
        fx.write_file(&format!("generated/part{i}/f.txt"), "x\n");
    }
    fx.write_file("small/one.txt", "1\n");

    let snap = operations::status(&fx.registry, &fx.repo_str(), &fx.workspace).expect("status");
    let mut paths: Vec<&str> = snap.changed_files.iter().map(|f| f.path.as_str()).collect();
    paths.sort();
    assert_eq!(paths, vec!["generated/", "small/one.txt"]);
}

#[test]
fn discard_and_stage_still_work_on_a_collapsed_untracked_directory() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("seed.txt", "seed\n");
    fx.run_git(&["add", "seed.txt"]);
    fx.run_git(&["commit", "-q", "-m", "seed"]);
    for i in 0..650 {
        fx.write_file(&format!("generated/part{i}/f.txt"), "x\n");
    }
    operations::discard(
        &fx.registry,
        &fx.repo_str(),
        &[DiscardEntry {
            path: "generated/".into(),
            untracked: true,
        }],
        &fx.workspace,
    )
    .expect("discard");
    assert!(!fx.repo_path.join("generated").exists());
}

#[test]
fn stage_then_commit_produces_log_entry() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "alpha\n");
    operations::stage(
        &fx.registry,
        &fx.repo_str(),
        &["a.txt".into()],
        &fx.workspace,
    )
    .expect("stage");

    let snap = operations::status(&fx.registry, &fx.repo_str(), &fx.workspace).unwrap();
    let entry = snap
        .changed_files
        .iter()
        .find(|f| f.path == "a.txt")
        .expect("a.txt staged");
    assert!(entry.staged);
    assert!(!entry.untracked);

    let commit =
        operations::commit(&fx.registry, &fx.repo_str(), "add a", &fx.workspace).expect("commit");
    assert_eq!(commit.summary, "add a");
    assert_eq!(commit.commit_sha.len(), 40);

    let entries =
        operations::log(&fx.registry, &fx.repo_str(), 10, 0, None, &fx.workspace).expect("log");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].sha, commit.commit_sha);
    assert_eq!(entries[0].subject, "add a");
}

#[test]
fn unstage_clears_index_entry() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "alpha\n");
    fx.run_git(&["add", "a.txt"]);
    fx.run_git(&["commit", "-q", "-m", "init"]);
    fx.write_file("a.txt", "beta\n");
    operations::stage(
        &fx.registry,
        &fx.repo_str(),
        &["a.txt".into()],
        &fx.workspace,
    )
    .unwrap();

    operations::unstage(
        &fx.registry,
        &fx.repo_str(),
        &["a.txt".into()],
        &fx.workspace,
    )
    .expect("unstage");

    let snap = operations::status(&fx.registry, &fx.repo_str(), &fx.workspace).unwrap();
    let entry = snap
        .changed_files
        .iter()
        .find(|f| f.path == "a.txt")
        .expect("a.txt present");
    assert!(!entry.staged);
    assert!(entry.unstaged);
}

#[test]
fn commit_with_empty_message_is_rejected() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "alpha\n");
    fx.run_git(&["add", "a.txt"]);

    match operations::commit(&fx.registry, &fx.repo_str(), "   ", &fx.workspace) {
        Err(GitError::EmptyCommitMessage) => {}
        Err(other) => panic!("expected EmptyCommitMessage, got {other}"),
        Ok(_) => panic!("expected error for empty message"),
    }
}

#[test]
fn log_on_empty_repo_returns_empty_list() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    let entries =
        operations::log(&fx.registry, &fx.repo_str(), 10, 0, None, &fx.workspace).expect("log");
    assert!(entries.is_empty());
}

#[test]
fn diff_shows_worktree_change() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "alpha\n");
    fx.run_git(&["add", "a.txt"]);
    fx.run_git(&["commit", "-q", "-m", "init"]);
    fx.write_file("a.txt", "alpha\nbeta\n");

    let diff =
        operations::diff(&fx.registry, &fx.repo_str(), None, false, &fx.workspace).expect("diff");
    assert!(diff.diff_text.contains("+beta"));
}

#[test]
fn diff_staged_only_shows_index_change() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "alpha\n");
    fx.run_git(&["add", "a.txt"]);
    fx.run_git(&["commit", "-q", "-m", "init"]);
    fx.write_file("a.txt", "alpha\nbeta\n");
    fx.run_git(&["add", "a.txt"]);
    fx.write_file("a.txt", "alpha\nbeta\ngamma\n");

    let staged = operations::diff(&fx.registry, &fx.repo_str(), None, true, &fx.workspace)
        .expect("staged diff");
    assert!(staged.diff_text.contains("+beta"));
    assert!(!staged.diff_text.contains("+gamma"));
}

#[test]
fn discard_tracked_restores_worktree() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "alpha\n");
    fx.run_git(&["add", "a.txt"]);
    fx.run_git(&["commit", "-q", "-m", "init"]);
    fx.write_file("a.txt", "tampered\n");

    operations::discard(
        &fx.registry,
        &fx.repo_str(),
        &[DiscardEntry {
            path: "a.txt".into(),
            untracked: false,
        }],
        &fx.workspace,
    )
    .expect("discard");

    let content = std::fs::read_to_string(fx.repo_path.join("a.txt")).unwrap();
    assert_eq!(content, "alpha\n");
}

#[test]
fn discard_untracked_removes_file() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("garbage.txt", "junk\n");

    operations::discard(
        &fx.registry,
        &fx.repo_str(),
        &[DiscardEntry {
            path: "garbage.txt".into(),
            untracked: true,
        }],
        &fx.workspace,
    )
    .expect("discard");

    assert!(!fx.repo_path.join("garbage.txt").exists());
}

#[test]
fn panel_snapshot_returns_repo_and_status_after_commit() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "alpha\n");
    fx.run_git(&["add", "a.txt"]);
    fx.run_git(&["commit", "-q", "-m", "seed"]);
    fx.write_file("b.txt", "beta\n");

    let snap = operations::panel_snapshot(&fx.registry, &fx.repo_str(), &fx.workspace)
        .expect("panel_snapshot");
    let repo = snap.repo.expect("repo present");
    assert_eq!(repo.branch, "main");
    let status = snap.status.expect("status present");
    assert!(status.changed_files.iter().any(|f| f.path == "b.txt"));
}

#[test]
fn panel_snapshot_outside_repo_is_empty() {
    if skip_if_no_git() {
        return;
    }
    let tmp = TempDir::new().unwrap();
    let canonical = std::fs::canonicalize(tmp.path()).unwrap();
    let registry = WorkspaceRegistry::default();
    registry.authorize(&canonical).unwrap();

    let snap = operations::panel_snapshot(&registry, &to_canon(&canonical), &WorkspaceEnv::Local)
        .expect("panel_snapshot");
    assert!(snap.repo.is_none());
    assert!(snap.status.is_none());
}

#[test]
fn show_commit_diff_returns_patch_for_known_sha() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "alpha\n");
    fx.run_git(&["add", "a.txt"]);
    fx.run_git(&["commit", "-q", "-m", "seed"]);

    let entries =
        operations::log(&fx.registry, &fx.repo_str(), 10, 0, None, &fx.workspace).unwrap();
    let sha = &entries[0].sha;

    let diff = operations::show_commit_diff(&fx.registry, &fx.repo_str(), sha, &fx.workspace)
        .expect("show_commit_diff");
    assert!(diff.diff_text.contains("a.txt"));
    assert!(diff.diff_text.contains("+alpha"));
}

#[test]
fn show_commit_diff_rejects_invalid_sha() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    match operations::show_commit_diff(&fx.registry, &fx.repo_str(), "not-a-sha", &fx.workspace) {
        Err(GitError::CommandFailed { .. }) => {}
        Err(other) => panic!("expected CommandFailed, got {other}"),
        Ok(_) => panic!("expected error for invalid sha"),
    }
}

#[test]
fn log_paginates_with_skip_from_anchor_sha() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    for i in 0..3 {
        fx.write_file(&format!("f{i}.txt"), &format!("v{i}\n"));
        fx.run_git(&["add", &format!("f{i}.txt")]);
        fx.run_git(&["commit", "-q", "-m", &format!("c{i}")]);
    }

    let first_page =
        operations::log(&fx.registry, &fx.repo_str(), 1, 0, None, &fx.workspace).unwrap();
    assert_eq!(first_page.len(), 1);
    let anchor = first_page[0].sha.clone();

    let second_page = operations::log(
        &fx.registry,
        &fx.repo_str(),
        10,
        1,
        Some(&anchor),
        &fx.workspace,
    )
    .unwrap();
    assert!(second_page.iter().all(|e| e.sha != anchor));
    assert_eq!(second_page.len(), 2);
}

#[test]
fn log_paging_keeps_commits_reachable_only_through_a_merge() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    let commit = |name: &str| {
        fx.write_file(&format!("{name}.txt"), "x\n");
        fx.run_git(&["add", "."]);
        fx.run_git(&["commit", "-q", "-m", name]);
    };
    commit("root");
    fx.run_git(&["checkout", "-q", "-b", "feat"]);
    for n in ["f1", "f2", "f3"] {
        commit(n);
    }
    fx.run_git(&["checkout", "-q", "main"]);
    for n in ["m1", "m2", "m3"] {
        commit(n);
    }
    fx.run_git(&["merge", "--no-ff", "-q", "-m", "merge feat", "feat"]);

    let expected = git_stdout(&fx, &["log", "--format=%H"]);
    assert_eq!(expected.len(), 8);

    for page_size in [1u32, 3, 5] {
        let mut shas: Vec<String> = Vec::new();
        let anchor = expected[0].clone();
        loop {
            let page = operations::log(
                &fx.registry,
                &fx.repo_str(),
                page_size,
                shas.len() as u32,
                Some(&anchor),
                &fx.workspace,
            )
            .unwrap();
            shas.extend(page.iter().map(|e| e.sha.clone()));
            if page.len() < page_size as usize {
                break;
            }
        }
        assert_eq!(shas, expected, "page size {page_size}");
    }
}

#[test]
fn log_paging_is_unaffected_by_new_commits_on_head() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    for i in 0..5 {
        fx.write_file(&format!("f{i}.txt"), "x\n");
        fx.run_git(&["add", "."]);
        fx.run_git(&["commit", "-q", "-m", &format!("c{i}")]);
    }
    let expected = git_stdout(&fx, &["log", "--format=%H"]);
    let first = operations::log(&fx.registry, &fx.repo_str(), 2, 0, None, &fx.workspace).unwrap();
    let anchor = first[0].sha.clone();

    fx.write_file("extra.txt", "x\n");
    fx.run_git(&["add", "."]);
    fx.run_git(&["commit", "-q", "-m", "new head"]);

    let rest = operations::log(
        &fx.registry,
        &fx.repo_str(),
        10,
        2,
        Some(&anchor),
        &fx.workspace,
    )
    .unwrap();
    let rest: Vec<String> = rest.into_iter().map(|e| e.sha).collect();
    assert_eq!(rest, expected[2..]);
}

fn git_stdout(fx: &GitRepoFixture, args: &[&str]) -> Vec<String> {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(&fx.repo_path)
        .output()
        .expect("git on PATH");
    assert!(out.status.success());
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::to_string)
        .collect()
}

#[test]
fn log_with_invalid_cursor_sha_errors() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "x\n");
    fx.run_git(&["add", "a.txt"]);
    fx.run_git(&["commit", "-q", "-m", "seed"]);

    match operations::log(
        &fx.registry,
        &fx.repo_str(),
        10,
        1,
        Some("not-hex"),
        &fx.workspace,
    ) {
        Err(GitError::CommandFailed { .. }) => {}
        Err(other) => panic!("expected CommandFailed, got {other}"),
        Ok(_) => panic!("expected error for bad cursor"),
    }
}

#[test]
fn commit_files_reports_added_and_modified() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "alpha\n");
    fx.write_file("b.txt", "beta\n");
    fx.run_git(&["add", "a.txt", "b.txt"]);
    fx.run_git(&["commit", "-q", "-m", "seed"]);
    fx.write_file("a.txt", "alpha2\n");
    fx.run_git(&["add", "a.txt"]);
    fx.run_git(&["commit", "-q", "-m", "modify"]);

    let entries =
        operations::log(&fx.registry, &fx.repo_str(), 10, 0, None, &fx.workspace).unwrap();
    let head = &entries[0].sha;

    let files =
        operations::commit_files(&fx.registry, &fx.repo_str(), head, &fx.workspace).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "a.txt");
    assert_eq!(files[0].status, "M");
    assert_eq!(files[0].status_label, "Modified");
}

#[test]
fn commit_file_diff_returns_original_and_modified_text() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "v1\n");
    fx.run_git(&["add", "a.txt"]);
    fx.run_git(&["commit", "-q", "-m", "v1"]);
    fx.write_file("a.txt", "v2\n");
    fx.run_git(&["add", "a.txt"]);
    fx.run_git(&["commit", "-q", "-m", "v2"]);

    let entries =
        operations::log(&fx.registry, &fx.repo_str(), 10, 0, None, &fx.workspace).unwrap();
    let head = &entries[0].sha;

    let diff = operations::commit_file_diff(
        &fx.registry,
        &fx.repo_str(),
        head,
        "a.txt",
        None,
        &fx.workspace,
    )
    .unwrap();
    assert_eq!(diff.original_content, "v1\n");
    assert_eq!(diff.modified_content, "v2\n");
    assert!(!diff.is_binary);
}

#[test]
fn remote_url_returns_none_for_missing_remote() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    let url =
        operations::remote_url(&fx.registry, &fx.repo_str(), "origin", &fx.workspace).unwrap();
    assert!(url.is_none());
}

#[test]
fn remote_url_returns_configured_url() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.run_git(&["remote", "add", "origin", "https://example.com/x.git"]);

    let url =
        operations::remote_url(&fx.registry, &fx.repo_str(), "origin", &fx.workspace).unwrap();
    assert_eq!(url.as_deref(), Some("https://example.com/x.git"));
}

#[test]
fn remote_url_rejects_unsafe_remote_name() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    let url = operations::remote_url(
        &fx.registry,
        &fx.repo_str(),
        "name with space",
        &fx.workspace,
    )
    .unwrap();
    assert!(url.is_none());
}

#[test]
fn unauthorized_path_is_rejected() {
    if skip_if_no_git() {
        return;
    }
    let tmp = TempDir::new().unwrap();
    let canonical = std::fs::canonicalize(tmp.path()).unwrap();
    let registry = WorkspaceRegistry::default();

    match operations::status(&registry, &to_canon(&canonical), &WorkspaceEnv::Local) {
        Err(GitError::PathOutsideWorkspace(_)) => {}
        Err(other) => panic!("expected PathOutsideWorkspace, got {other}"),
        Ok(_) => panic!("expected error for unauthorized dir"),
    }
}

#[test]
fn checkout_branch_rejects_unsafe_names() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();

    let err_empty =
        operations::checkout_branch(&fx.registry, &fx.repo_str(), "", &fx.workspace).unwrap_err();
    assert!(matches!(err_empty, GitError::InvalidBranchName(p) if p.is_empty()));

    let err_dash =
        operations::checkout_branch(&fx.registry, &fx.repo_str(), "-f", &fx.workspace).unwrap_err();
    assert!(matches!(err_dash, GitError::InvalidBranchName(p) if p == "-f"));

    let err_dash_long =
        operations::checkout_branch(&fx.registry, &fx.repo_str(), "--detach", &fx.workspace)
            .unwrap_err();
    assert!(matches!(err_dash_long, GitError::InvalidBranchName(p) if p == "--detach"));
}

#[test]
fn list_branches_keeps_current_branch_local_and_surfaces_worktrees() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "a\n");
    fx.run_git(&["add", "."]);
    fx.run_git(&["commit", "-q", "-m", "init"]);
    fx.run_git(&["branch", "feature"]);

    let wt = TempDir::new().unwrap();
    let wt_path = wt.path().join("linked");
    fx.run_git(&[
        "worktree",
        "add",
        "-q",
        wt_path.to_str().unwrap(),
        "feature",
    ]);

    let result = operations::list_branches(&fx.registry, &fx.repo_str(), &fx.workspace)
        .expect("list_branches");

    // the current branch is head, with no other worktree, though the main worktree is listed
    let main = result
        .branches
        .iter()
        .find(|b| b.name == "main")
        .expect("main branch present");
    assert!(main.is_head);
    assert!(main.worktree_path.is_none());

    let feature: Vec<_> = result
        .branches
        .iter()
        .filter(|b| b.name == "feature")
        .collect();
    assert_eq!(feature.len(), 1);
    assert!(!feature[0].is_head);
    assert!(feature[0].worktree_path.is_some());

    assert_eq!(result.worktrees.len(), 2);
    assert!(result.worktrees[0].is_main && result.worktrees[0].is_current);
    assert_eq!(result.worktrees[1].branch.as_deref(), Some("feature"));
    assert_eq!(
        result.worktrees[1].path,
        feature[0].worktree_path.clone().unwrap()
    );
}

/// Source Control refreshes when the git dir changes, so its own reads must leave the git dir
/// alone or every refresh would trigger the next one.
#[test]
fn reading_status_leaves_the_git_dir_alone() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "a\n");
    fx.write_file("b.txt", "b\n");
    fx.run_git(&["add", "."]);
    fx.run_git(&["commit", "-q", "-m", "seed"]);
    // Same content, newer mtime: the index's stat data is stale, which a plain `git status`
    // repairs by rewriting the index.
    std::thread::sleep(std::time::Duration::from_millis(1100));
    fx.write_file("a.txt", "a\n");
    fx.write_file("b.txt", "changed\n");

    let git_dir = fx.repo_path.join(".git");
    let snapshot = || {
        let mut entries: Vec<(String, u64, Option<std::time::SystemTime>)> =
            std::fs::read_dir(&git_dir)
                .unwrap()
                .map(|entry| {
                    let entry = entry.unwrap();
                    let meta = entry.metadata().unwrap();
                    (
                        entry.file_name().to_string_lossy().into_owned(),
                        meta.len(),
                        meta.modified().ok(),
                    )
                })
                .collect();
        entries.sort();
        entries
    };
    let before = snapshot();
    let snap = operations::panel_snapshot(&fx.registry, &fx.repo_str(), &fx.workspace)
        .expect("panel snapshot");
    assert_eq!(snap.status.expect("status").changed_files.len(), 1);
    operations::status(&fx.registry, &fx.repo_str(), &fx.workspace).expect("status");
    assert_eq!(snapshot(), before);
}

/// Stage All on a deleted folder sends every path at once; a single command line cannot hold
/// them all on Windows (32,767 characters), so they go to git in batches.
#[test]
fn staging_more_paths_than_one_command_line_holds_stages_them_all() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    let dir = "a-folder-with-a-rather-long-name-to-fill-the-command-line-quickly";
    let names: Vec<String> = (0..2_500)
        .map(|i| format!("{dir}/generated-source-file-with-a-long-descriptive-name-{i:05}.ts"))
        .collect();
    for name in &names {
        fx.write_file(name, "x\n");
    }
    // About 320 KB of paths: more than one batch on every platform.
    assert!(names.iter().map(|n| n.len() + 3).sum::<usize>() > 256 * 1024);

    operations::stage(&fx.registry, &fx.repo_str(), &names, &fx.workspace).expect("stage");
    let staged = git_stdout(&fx, &["diff", "--cached", "--name-only"]);
    assert_eq!(staged.len(), names.len());

    operations::unstage(&fx.registry, &fx.repo_str(), &names, &fx.workspace).expect("unstage");
    assert!(git_stdout(&fx, &["diff", "--cached", "--name-only"]).is_empty());
}

#[test]
fn log_reports_the_branches_and_tags_on_each_commit() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    for name in ["first", "second"] {
        fx.write_file(&format!("{name}.txt"), "x\n");
        fx.run_git(&["add", "."]);
        fx.run_git(&["commit", "-q", "-m", name]);
    }
    fx.run_git(&["tag", "v1.0", "HEAD~1"]);
    fx.run_git(&["tag", "-a", "-m", "release", "v2.0"]);
    // A local branch whose name looks like a remote one.
    fx.run_git(&["branch", "origin/feature", "HEAD~1"]);

    let log = || operations::log(&fx.registry, &fx.repo_str(), 10, 0, None, &fx.workspace).unwrap();
    let refs =
        |entry: &oarlock_lib::modules::git::types::GitLogEntry| -> Vec<(String, String, bool)> {
            let json = serde_json::to_value(&entry.refs).unwrap();
            json.as_array()
                .unwrap()
                .iter()
                .map(|r| {
                    (
                        r["kind"].as_str().unwrap().to_owned(),
                        r["name"].as_str().unwrap().to_owned(),
                        r["head"].as_bool().unwrap(),
                    )
                })
                .collect()
        };
    let owned = |kind: &str, name: &str, head: bool| (kind.to_owned(), name.to_owned(), head);
    let entries = log();
    assert_eq!(
        refs(&entries[0]),
        vec![owned("branch", "main", true), owned("tag", "v2.0", false)]
    );
    assert_eq!(
        refs(&entries[1]),
        vec![
            owned("branch", "origin/feature", false),
            owned("tag", "v1.0", false)
        ]
    );
    assert_eq!(entries[1].subject, "first");

    fx.run_git(&["checkout", "-q", "--detach", "HEAD~1"]);
    assert_eq!(refs(&log()[0])[0], owned("head", "HEAD", true));
}

fn commit_file(fx: &GitRepoFixture, name: &str) {
    fx.write_file(&format!("{name}.txt"), "x\n");
    fx.run_git(&["add", "."]);
    fx.run_git(&["commit", "-q", "-m", name]);
}

fn head_sha(fx: &GitRepoFixture) -> String {
    git_stdout(fx, &["rev-parse", "HEAD"]).remove(0)
}

#[test]
fn undo_last_commit_moves_its_changes_back_to_the_index() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    commit_file(&fx, "first");
    let first = head_sha(&fx);
    commit_file(&fx, "second");
    let second = head_sha(&fx);

    operations::undo_last_commit(&fx.registry, &fx.repo_str(), &second, &fx.workspace)
        .expect("undo");
    assert_eq!(head_sha(&fx), first);
    assert_eq!(git_stdout(&fx, &["rev-parse", "ORIG_HEAD"]), vec![second]);
    let snap = operations::status(&fx.registry, &fx.repo_str(), &fx.workspace).unwrap();
    let entry = snap
        .changed_files
        .iter()
        .find(|f| f.path == "second.txt")
        .expect("the undone change is back");
    assert!(entry.staged);
}

#[test]
fn undo_last_commit_refuses_a_commit_that_is_no_longer_head() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    commit_file(&fx, "first");
    commit_file(&fx, "second");
    let chosen = head_sha(&fx);
    // A commit lands after the history was loaded.
    commit_file(&fx, "third");
    let third = head_sha(&fx);

    let err = operations::undo_last_commit(&fx.registry, &fx.repo_str(), &chosen, &fx.workspace)
        .expect_err("a stale HEAD must not be undone");
    assert!(err.to_string().contains("HEAD moved"));
    assert_eq!(head_sha(&fx), third, "history is untouched");

    for bad in ["not-a-sha", "abc123", ""] {
        assert!(
            operations::undo_last_commit(&fx.registry, &fx.repo_str(), bad, &fx.workspace).is_err()
        );
    }
    assert_eq!(head_sha(&fx), third);
}

#[test]
fn undo_last_commit_refuses_the_first_commit() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    commit_file(&fx, "first");
    let first = head_sha(&fx);
    let err = operations::undo_last_commit(&fx.registry, &fx.repo_str(), &first, &fx.workspace)
        .expect_err("the root commit has no parent to go back to");
    assert!(err.to_string().contains("first commit"));
    assert_eq!(head_sha(&fx), first);
}

#[test]
fn commit_on_remote_names_a_remote_branch_that_contains_it() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    commit_file(&fx, "first");
    let pushed = head_sha(&fx);
    commit_file(&fx, "second");
    let local = head_sha(&fx);
    fx.run_git(&["update-ref", "refs/remotes/origin/main", &pushed]);

    let on_remote =
        |sha: &str| operations::commit_on_remote(&fx.registry, &fx.repo_str(), sha, &fx.workspace);
    assert_eq!(on_remote(&pushed).unwrap().as_deref(), Some("origin/main"));
    assert_eq!(on_remote(&local).unwrap(), None);
    assert!(on_remote("not-a-sha").is_err());
}

#[test]
fn switching_to_a_missing_branch_never_restores_a_file_of_that_name() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    commit_file(&fx, "notes");
    fx.run_git(&["branch", "feature"]);
    // The branch is deleted after the list was loaded, and a file has its name.
    fx.run_git(&["branch", "-D", "feature"]);
    fx.write_file("feature", "more work\n");
    fx.run_git(&["add", "feature"]);
    fx.write_file("feature", "unstaged work\n");

    assert!(
        operations::checkout_branch(&fx.registry, &fx.repo_str(), "feature", &fx.workspace)
            .is_err()
    );
    assert_eq!(
        std::fs::read_to_string(fx.repo_path.join("feature")).unwrap(),
        "unstaged work\n",
        "the file's changes must survive"
    );

    fx.run_git(&["branch", "other"]);
    operations::checkout_branch(&fx.registry, &fx.repo_str(), "other", &fx.workspace)
        .expect("an existing branch still switches");
    assert_eq!(
        git_stdout(&fx, &["rev-parse", "--abbrev-ref", "HEAD"]),
        vec!["other"]
    );
}

#[test]
fn discover_repos_finds_projects_in_a_folder_that_is_not_one() {
    if skip_if_no_git() {
        return;
    }
    let tmp = TempDir::new().unwrap();
    let root = std::fs::canonicalize(tmp.path()).unwrap();
    let init = |rel: &str| {
        let dir = root.join(rel);
        std::fs::create_dir_all(&dir).unwrap();
        let out = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&dir)
            .output()
            .unwrap();
        assert!(out.status.success());
    };
    init("api");
    init("web");
    init("libs/shared");
    // Not searched: inside a repository, hidden, dependencies, or too deep.
    init("api/vendored");
    init(".cache/tool");
    init("node_modules/pkg");
    init("deep/er/still");
    std::fs::create_dir_all(root.join("docs")).unwrap();
    let registry = WorkspaceRegistry::default();
    let base = to_canon(&root);

    assert!(
        operations::discover_repos(&registry, &base, &WorkspaceEnv::Local).is_err(),
        "an unauthorized folder is not searched"
    );
    registry.authorize(&root).unwrap();
    let found = operations::discover_repos(&registry, &base, &WorkspaceEnv::Local).unwrap();
    assert_eq!(
        found,
        vec![
            format!("{base}/api"),
            format!("{base}/web"),
            format!("{base}/libs/shared"),
        ]
    );
    let with_slash =
        operations::discover_repos(&registry, &format!("{base}/"), &WorkspaceEnv::Local).unwrap();
    assert_eq!(with_slash, found);
}
