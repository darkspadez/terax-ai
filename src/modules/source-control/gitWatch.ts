import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { WorkspaceEnv } from "@/modules/workspace";

type GitChangedPayload = { repoRoots: string[] };

/**
 * Watches `repoRoot` (its git directory and the watched folders of its work
 * tree) for as long as a Source Control view of it is on screen.
 */
export function gitWatchAdd(repoRoot: string, workspace: WorkspaceEnv): void {
  void invoke("git_watch_add", { repoRoot, workspace }).catch(() => {});
}

export function gitWatchRemove(
  repoRoot: string,
  workspace: WorkspaceEnv,
): void {
  void invoke("git_watch_remove", { repoRoot, workspace }).catch(() => {});
}

/** `repoRoots` are spelled as they were passed to `gitWatchAdd`. */
export function listenGitChanged(
  handler: (repoRoots: string[]) => void,
): Promise<() => void> {
  return getCurrentWebviewWindow().listen<GitChangedPayload>(
    "git:changed",
    (e) => handler(e.payload.repoRoots),
  );
}
