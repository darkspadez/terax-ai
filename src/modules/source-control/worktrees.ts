import type {
  GitBranchEntry,
  GitLinkedWorktree,
  GitWorktreeEntry,
} from "@/modules/ai/lib/native";

/** Most characters the branch contributes to a default worktree folder name. */
const MAX_FOLDER_SLUG_CHARS = 64;
const FOLDER_CHAR = /[\p{Alphabetic}\p{N}._-]/u;

/**
 * A branch name as a folder name: letters, digits, `.`, `_` and `-` kept,
 * every other run of characters (`/` among them) one `-`, no leading or
 * trailing `-` or `.`, at most 64 characters. Mirrors `folder_slug` in
 * `src-tauri/src/modules/git/worktree.rs`.
 */
export function folderSlug(branch: string): string {
  let slug = "";
  for (const c of branch) {
    if (FOLDER_CHAR.test(c)) slug += c;
    else if (!slug.endsWith("-")) slug += "-";
  }
  const capped = Array.from(slug.replace(/^[-.]+|[-.]+$/g, ""))
    .slice(0, MAX_FOLDER_SLUG_CHARS)
    .join("")
    .replace(/[-.]+$/, "");
  return capped || "worktree";
}

/**
 * `<repository folder>-<branch>` beside the repository: `mainRoot` is the
 * main worktree (a bare repository's folder loses its `.git`). Mirrors
 * `default_worktree_path` on the Rust side.
 */
export function defaultWorktreePath(mainRoot: string, branch: string): string {
  const root = mainRoot.replace(/[\\/]+$/, "");
  const cut = Math.max(root.lastIndexOf("/"), root.lastIndexOf("\\"));
  const parent = root.slice(0, cut + 1);
  const folder = root.slice(cut + 1);
  const name =
    folder.endsWith(".git") && folder.length > 4 ? folder.slice(0, -4) : folder;
  return `${parent}${name}-${folderSlug(branch)}`;
}

function hasControlCharacter(text: string): boolean {
  for (const c of text) {
    const code = c.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Why git would refuse `name` as a branch name (`git check-ref-format
 * --branch`, plus never `@`), or null when it is fine. The same rule as
 * `validate_branch_name` on the Rust side, with a message for each case.
 */
export function branchNameProblem(
  name: string,
  existing: readonly string[] = [],
): string | null {
  if (name.length === 0) return "Enter a branch name.";
  if (name.startsWith("-")) return 'A branch name cannot start with "-".';
  if (name === "HEAD" || name === "@") {
    return `"${name}" cannot be a branch name.`;
  }
  if (name.includes(" ")) return "A branch name cannot contain spaces.";
  if (hasControlCharacter(name)) {
    return "A branch name cannot contain control characters.";
  }
  if (/[~^:?*[\\]/.test(name)) {
    return "A branch name cannot contain ~ ^ : ? * [ or \\.";
  }
  if (name.includes("..")) return 'A branch name cannot contain "..".';
  if (name.includes("@{")) return 'A branch name cannot contain "@{".';
  if (name.endsWith(".")) return 'A branch name cannot end with ".".';
  const parts = name.split("/");
  if (parts.some((part) => part === "")) {
    return 'A branch name cannot start or end with "/", or contain "//".';
  }
  if (parts.some((part) => part.startsWith("."))) {
    return 'No part of a branch name can start with ".".';
  }
  if (parts.some((part) => part.endsWith(".lock"))) {
    return 'No part of a branch name can end with ".lock".';
  }
  if (existing.includes(name))
    return `A branch named "${name}" already exists.`;
  return null;
}

/** How the workspace spells absolute paths: WSL and Unix, or Windows. */
export type PathStyle = "posix" | "windows";

function isAbsolutePath(path: string, style: PathStyle): boolean {
  if (style === "posix") return path.startsWith("/");
  // A drive (`C:\`, `C:/`) or a UNC share (`\\server\share`).
  return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path);
}

/**
 * What is wrong with the folder typed for a new worktree, or null. Whether
 * it exists, is empty and has a parent is for the backend to tell.
 */
export function worktreeFolderProblem(
  path: string,
  style: PathStyle,
): string | null {
  const trimmed = path.trim();
  if (trimmed.length === 0) return "Choose a folder for the worktree.";
  if (hasControlCharacter(trimmed)) {
    return "A folder path cannot contain control characters.";
  }
  if (!isAbsolutePath(trimmed, style)) {
    return style === "windows"
      ? "Enter the full path of the folder, starting with a drive such as C:\\."
      : "Enter the full path of the folder, starting with /.";
  }
  return null;
}

/** A worktree's folder name. */
export function worktreeName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return trimmed.slice(cut + 1) || trimmed;
}

/** The branch a worktree has checked out, or its commit when detached. */
export function worktreeBranchLabel(worktree: GitWorktreeEntry): string {
  if (worktree.branch) return worktree.branch;
  if (worktree.head) return `(detached @ ${worktree.head.slice(0, 7)})`;
  return worktreeName(worktree.path);
}

/** Worktrees to switch to: every checkout but the one open. */
export function otherWorktrees(
  worktrees: readonly GitWorktreeEntry[],
): GitWorktreeEntry[] {
  return worktrees.filter((wt) => !wt.isCurrent && !wt.isBare);
}

/** Linked worktrees that may be removed: never the main one nor the one open. */
export function removableWorktrees(
  worktrees: readonly GitWorktreeEntry[],
): GitWorktreeEntry[] {
  return worktrees.filter((wt) => !wt.isMain && !wt.isBare && !wt.isCurrent);
}

/** Why a worktree cannot be removed from here, or null. */
export function worktreeRemoveBlocker(
  worktree: GitWorktreeEntry,
): string | null {
  if (worktree.locked === null) return null;
  return worktree.locked
    ? `Locked: ${worktree.locked}. Unlock it with git worktree unlock first.`
    : "Locked. Unlock it with git worktree unlock first.";
}

/** The main worktree's folder (or the bare repository), for default paths. */
export function mainWorktreeRoot(
  worktrees: readonly GitWorktreeEntry[],
): string | null {
  return worktrees.find((wt) => wt.isMain)?.path ?? null;
}

/** Local branches the current worktree can switch to. */
export function branchesHere(
  branches: readonly GitBranchEntry[],
): GitBranchEntry[] {
  return branches.filter((branch) => branch.worktreePath === null);
}

/** Local branches a new worktree can check out: none has them checked out. */
export function branchesFreeForWorktree(
  branches: readonly GitBranchEntry[],
): string[] {
  return branches
    .filter((branch) => !branch.isHead && branch.worktreePath === null)
    .map((branch) => branch.name);
}

/** The confirmation shown when an unforced removal found changes. */
export function removeWithChangesMessage(
  worktree: GitWorktreeEntry,
  changes: number,
): string {
  const noun = changes === 1 ? "change" : "changes";
  const pronoun = changes === 1 ? "it" : "them";
  return `${worktreeName(worktree.path)} has ${changes} uncommitted or untracked ${noun}. Removing the worktree deletes ${pronoun} for good.`;
}

/**
 * The repository's name in the Source Control header: a linked worktree's
 * repository rather than its folder, which the worktree label shows.
 */
export function repositoryHeaderName(
  displayRepoRoot: string,
  linked: GitLinkedWorktree | null,
): string {
  return linked ? linked.repositoryName : worktreeName(displayRepoRoot);
}
