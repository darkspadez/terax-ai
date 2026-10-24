import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";

/** The branch a new worktree checks out. */
export type WorktreeBranch =
  /** A new branch from `base` (a commit-ish), or from HEAD when null. */
  | { kind: "new"; name: string; base: string | null }
  /** A local branch no worktree has checked out. */
  | { kind: "existing"; name: string };

export type WorktreeAddResult = {
  /** The new worktree's folder, now authorized. */
  path: string;
  branch: string;
};

export type WorktreeRemoveResult = {
  removed: boolean;
  /** Uncommitted and untracked entries that kept an unforced removal from running. */
  changes: number;
};

// Here rather than in `native`, so the IPC for worktrees loads with Source
// Control instead of with the window.

/** `path` null: `<repository folder>-<branch>` beside the repository. */
export function gitWorktreeAdd(
  repoRoot: string,
  branch: WorktreeBranch,
  path: string | null,
): Promise<WorktreeAddResult> {
  return invoke<WorktreeAddResult>("git_worktree_add", {
    repoRoot,
    branch,
    path,
    workspace: currentWorkspaceEnv(),
  });
}

/** Without `force`, a worktree with changes is left alone and they are counted. */
export function gitWorktreeRemove(
  repoRoot: string,
  path: string,
  force: boolean,
): Promise<WorktreeRemoveResult> {
  return invoke<WorktreeRemoveResult>("git_worktree_remove", {
    repoRoot,
    path,
    force,
    workspace: currentWorkspaceEnv(),
  });
}
