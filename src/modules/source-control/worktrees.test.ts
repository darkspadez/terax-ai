import { describe, expect, it } from "vitest";
import type { GitBranchEntry, GitWorktreeEntry } from "@/modules/ai/lib/native";
import {
  branchesFreeForWorktree,
  branchesHere,
  branchNameProblem,
  defaultWorktreePath,
  folderSlug,
  mainWorktreeRoot,
  otherWorktrees,
  removableWorktrees,
  removeWithChangesMessage,
  repositoryHeaderName,
  worktreeBranchLabel,
  worktreeFolderProblem,
  worktreeName,
  worktreeRemoveBlocker,
} from "./worktrees";

function worktree(
  path: string,
  overrides: Partial<GitWorktreeEntry> = {},
): GitWorktreeEntry {
  return {
    path,
    branch: null,
    head: "0123456789abcdef0123456789abcdef01234567",
    isMain: false,
    isBare: false,
    isCurrent: false,
    locked: null,
    prunable: false,
    ...overrides,
  };
}

function branch(
  name: string,
  overrides: Partial<GitBranchEntry> = {},
): GitBranchEntry {
  return {
    name,
    worktreePath: null,
    isHead: false,
    isDetached: false,
    ...overrides,
  };
}

describe("default worktree folder", () => {
  // The same cases as `default_folder_sits_beside_the_repository` and
  // `branch_slugs_are_safe_folder_names` in src-tauri/src/modules/git/worktree.rs.
  it("sits beside the repository, named after it and the branch", () => {
    expect(defaultWorktreePath("/r/app", "feat")).toBe("/r/app-feat");
    expect(defaultWorktreePath("/r/app/", "feature/login")).toBe(
      "/r/app-feature-login",
    );
    expect(defaultWorktreePath("C:/src/app", "fix")).toBe("C:/src/app-fix");
    expect(defaultWorktreePath("C:\\src\\app", "fix")).toBe("C:\\src\\app-fix");
    expect(defaultWorktreePath("/r/app.git", "x")).toBe("/r/app-x");
    expect(defaultWorktreePath("/r/.git", "x")).toBe("/r/.git-x");
    expect(defaultWorktreePath("/app", "x")).toBe("/app-x");
  });

  it("turns the branch into a safe folder name", () => {
    expect(folderSlug("feat")).toBe("feat");
    expect(folderSlug("feature/login")).toBe("feature-login");
    expect(folderSlug("a//b")).toBe("a-b");
    expect(folderSlug("fix-/x")).toBe("fix-x");
    expect(folderSlug("v1.2_rc")).toBe("v1.2_rc");
    expect(folderSlug("größe/ü")).toBe("größe-ü");
    expect(folderSlug('a:b*c?d"e<f>g|h')).toBe("a-b-c-d-e-f-g-h");
    expect(folderSlug(".hidden/")).toBe("hidden");
    expect(folderSlug("x.")).toBe("x");
    expect(folderSlug("///")).toBe("worktree");
    expect(folderSlug("")).toBe("worktree");
    expect(folderSlug(`${"a".repeat(63)}/b`)).toBe("a".repeat(63));
    expect(Array.from(folderSlug("é".repeat(80)))).toHaveLength(64);
  });
});

describe("branchNameProblem", () => {
  // The same names as `branch_names_follow_git_check_ref_format` in
  // src-tauri/src/modules/git/utils.rs, so both sides accept the same set.
  it.each([
    "main",
    "feature/login",
    "fix-1.2",
    "release_2026",
    "größe",
    "a.b/c-d",
    "a-",
    "HEADS",
    "x@y",
  ])("accepts %j", (name) => {
    expect(branchNameProblem(name)).toBeNull();
  });

  it.each([
    "",
    "-b",
    "--force",
    "HEAD",
    "@",
    "a b",
    "a\tb",
    "a\x7fb",
    "a~1",
    "a^",
    "a:b",
    "a?",
    "a*",
    "a[b",
    "a\\b",
    "a..b",
    "a@{1}",
    "a.",
    "/a",
    "a/",
    "a//b",
    ".a",
    "a/.b",
    "a.lock",
    "a.lock/b",
  ])("refuses %j", (name) => {
    expect(branchNameProblem(name)).not.toBeNull();
  });

  it("says what is wrong", () => {
    expect(branchNameProblem("")).toBe("Enter a branch name.");
    expect(branchNameProblem("-x")).toBe(
      'A branch name cannot start with "-".',
    );
    expect(branchNameProblem("HEAD")).toBe('"HEAD" cannot be a branch name.');
    expect(branchNameProblem("my branch")).toBe(
      "A branch name cannot contain spaces.",
    );
    expect(branchNameProblem("a\nb")).toBe(
      "A branch name cannot contain control characters.",
    );
    expect(branchNameProblem("fix:x")).toBe(
      "A branch name cannot contain ~ ^ : ? * [ or \\.",
    );
    expect(branchNameProblem("a..b")).toBe(
      'A branch name cannot contain "..".',
    );
    expect(branchNameProblem("a@{u}")).toBe(
      'A branch name cannot contain "@{".',
    );
    expect(branchNameProblem("v1.")).toBe('A branch name cannot end with ".".');
    expect(branchNameProblem("feat/")).toBe(
      'A branch name cannot start or end with "/", or contain "//".',
    );
    expect(branchNameProblem("feat/.x")).toBe(
      'No part of a branch name can start with ".".',
    );
    expect(branchNameProblem("x.lock/y")).toBe(
      'No part of a branch name can end with ".lock".',
    );
  });

  it("refuses a branch that already exists", () => {
    expect(branchNameProblem("main", ["main", "dev"])).toBe(
      'A branch named "main" already exists.',
    );
    expect(branchNameProblem("main2", ["main", "dev"])).toBeNull();
  });
});

describe("worktreeFolderProblem", () => {
  it("needs a full path in the workspace's style", () => {
    expect(worktreeFolderProblem("/home/me/app-x", "posix")).toBeNull();
    expect(worktreeFolderProblem("  /home/me/app-x  ", "posix")).toBeNull();
    expect(worktreeFolderProblem("C:\\src\\app-x", "windows")).toBeNull();
    expect(worktreeFolderProblem("C:/src/app-x", "windows")).toBeNull();
    expect(worktreeFolderProblem("\\\\server\\share\\x", "windows")).toBeNull();

    expect(worktreeFolderProblem("app-x", "posix")).toBe(
      "Enter the full path of the folder, starting with /.",
    );
    expect(worktreeFolderProblem("C:\\src\\x", "posix")).toBe(
      "Enter the full path of the folder, starting with /.",
    );
    expect(worktreeFolderProblem("/src/x", "windows")).toBe(
      "Enter the full path of the folder, starting with a drive such as C:\\.",
    );
    expect(worktreeFolderProblem("C:x", "windows")).not.toBeNull();
  });

  it("needs a folder at all, without control characters", () => {
    expect(worktreeFolderProblem("", "posix")).toBe(
      "Choose a folder for the worktree.",
    );
    expect(worktreeFolderProblem("   ", "windows")).toBe(
      "Choose a folder for the worktree.",
    );
    expect(worktreeFolderProblem("/a\nb", "posix")).toBe(
      "A folder path cannot contain control characters.",
    );
  });
});

describe("worktree labels", () => {
  it("names a worktree by its folder", () => {
    expect(worktreeName("/r/app-feat")).toBe("app-feat");
    expect(worktreeName("C:/src/app-fix/")).toBe("app-fix");
    expect(worktreeName("C:\\src\\app-fix")).toBe("app-fix");
  });

  it("shows the branch, or the commit when detached", () => {
    expect(worktreeBranchLabel(worktree("/r/x", { branch: "feat/x" }))).toBe(
      "feat/x",
    );
    expect(worktreeBranchLabel(worktree("/r/x"))).toBe("(detached @ 0123456)");
    expect(worktreeBranchLabel(worktree("/r/x", { head: null }))).toBe("x");
  });

  it("names a linked worktree's repository in the header", () => {
    expect(repositoryHeaderName("/r/app", null)).toBe("app");
    expect(
      repositoryHeaderName("/r/app-feat", {
        name: "app-feat",
        repositoryName: "app",
      }),
    ).toBe("app");
  });

  it("explains a locked worktree", () => {
    expect(worktreeRemoveBlocker(worktree("/r/x"))).toBeNull();
    expect(worktreeRemoveBlocker(worktree("/r/x", { locked: "" }))).toBe(
      "Locked. Unlock it with git worktree unlock first.",
    );
    expect(
      worktreeRemoveBlocker(worktree("/r/x", { locked: "on a usb" })),
    ).toBe("Locked: on a usb. Unlock it with git worktree unlock first.");
  });

  it("warns about the changes a forced removal deletes", () => {
    expect(removeWithChangesMessage(worktree("/r/app-x"), 1)).toBe(
      "app-x has 1 uncommitted or untracked change. Removing the worktree deletes it for good.",
    );
    expect(removeWithChangesMessage(worktree("/r/app-x"), 3)).toBe(
      "app-x has 3 uncommitted or untracked changes. Removing the worktree deletes them for good.",
    );
  });
});

describe("worktree lists", () => {
  const main = worktree("/r/app", { branch: "main", isMain: true });
  const current = worktree("/r/app-feat", { branch: "feat", isCurrent: true });
  const other = worktree("/r/app-fix", { branch: "fix" });
  const locked = worktree("/r/app-old", { branch: "old", locked: "" });

  it("offers every checkout but the one open", () => {
    expect(otherWorktrees([main, current, other, locked])).toEqual([
      main,
      other,
      locked,
    ]);
    const bare = worktree("/r/app.git", { isMain: true, isBare: true });
    expect(otherWorktrees([bare, other])).toEqual([other]);
  });

  it("never offers to remove the main worktree or the one open", () => {
    expect(removableWorktrees([main, current, other, locked])).toEqual([
      other,
      locked,
    ]);
    const openMain = { ...main, isCurrent: true };
    expect(removableWorktrees([openMain, other])).toEqual([other]);
  });

  it("finds the main worktree for default folders", () => {
    expect(mainWorktreeRoot([main, other])).toBe("/r/app");
    expect(mainWorktreeRoot([])).toBeNull();
  });

  it("splits branches between this worktree and new ones", () => {
    const branches = [
      branch("(HEAD detached at 0123456)", { isHead: true, isDetached: true }),
      branch("feat", { worktreePath: "/r/app-feat" }),
      branch("free"),
      branch("main", { isHead: true }),
    ];
    expect(branchesHere(branches).map((b) => b.name)).toEqual([
      "(HEAD detached at 0123456)",
      "free",
      "main",
    ]);
    expect(branchesFreeForWorktree(branches)).toEqual(["free"]);
  });
});
