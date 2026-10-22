import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { authorizationSettled } from "@/modules/workspace/authorize";

const FS_CHANGED_EVENT = "fs:changed";

type FsChangedPayload = { paths: string[] };

/**
 * Sends a watch change once any authorization of its paths in flight has
 * settled (the backend watches only authorized folders). A removal waits too,
 * so it never overtakes the addition it undoes.
 */
function sendWatch(
  command: "fs_watch_add" | "fs_watch_remove",
  paths: string[],
  files: string[],
): void {
  if (paths.length === 0 && files.length === 0) return;
  const workspace = currentWorkspaceEnv();
  void Promise.all(
    [...paths, ...files].map((path) => authorizationSettled(path, workspace)),
  )
    .then(() => invoke(command, { paths, files, workspace }))
    .catch(() => {});
}

/**
 * `paths` are directories. `files` (open editor buffers) are reported by their
 * own path when their size or mtime moves, because the native watcher only
 * reports which directory changed.
 */
export function watchAdd(paths: string[], files: string[] = []): void {
  sendWatch("fs_watch_add", paths, files);
}

export function watchRemove(paths: string[], files: string[] = []): void {
  sendWatch("fs_watch_remove", paths, files);
}

export function listenFsChanged(
  handler: (paths: string[]) => void,
): Promise<() => void> {
  return getCurrentWebviewWindow().listen<FsChangedPayload>(
    FS_CHANGED_EVENT,
    (e) => handler(e.payload.paths),
  );
}

/** The folder holding `path`; a drive root keeps its slash (`D:/`, not `D:`). */
export function parentDir(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i <= 0) return path.slice(0, i + 1) || path;
  if (i === 2 && /^[A-Za-z]:[\\/]/.test(path)) return path.slice(0, 3);
  return path.slice(0, i);
}
