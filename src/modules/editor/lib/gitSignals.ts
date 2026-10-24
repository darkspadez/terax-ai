import { pathKey } from "@/lib/pathKey";
import type { Tab } from "@/modules/tabs";

type Listener = (paths: readonly string[]) => void;

const listeners = new Set<Listener>();

/** A git status path (repository-relative) as an absolute path. */
export function repoFilePath(repoRoot: string, path: string): string {
  if (/^([A-Za-z]:)?[\\/]/.test(path)) return path;
  return `${repoRoot.replace(/[\\/]+$/, "")}/${path}`;
}

/** Open editor tabs showing one of `paths` or a file inside one of them. */
export function editorTabsUnder(
  tabs: readonly Tab[],
  paths: readonly string[],
): number[] {
  const roots = paths.map(pathKey);
  return tabs
    .filter((tab) => {
      if (tab.kind !== "editor") return false;
      const key = pathKey(tab.path);
      return roots.some((root) => key === root || key.startsWith(`${root}/`));
    })
    .map((tab) => tab.id);
}

/**
 * Source Control restored these paths from git (or deleted them, for
 * untracked entries). Open editors drop the discarded edits instead of
 * keeping them as unsaved changes.
 */
export function notifyFilesDiscarded(
  repoRoot: string,
  paths: readonly string[],
): void {
  if (paths.length === 0) return;
  const absolute = paths.map((path) => repoFilePath(repoRoot, path));
  for (const listener of listeners) listener(absolute);
}

export function onFilesDiscarded(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const headListeners = new Set<() => void>();

/** A commit or pull in Source Control moved HEAD: change gutters are stale. */
export function notifyHeadMoved(): void {
  for (const listener of headListeners) listener();
}

export function onHeadMoved(listener: () => void): () => void {
  headListeners.add(listener);
  return () => {
    headListeners.delete(listener);
  };
}
