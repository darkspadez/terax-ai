import { create } from "zustand";
import { isAiComposerTarget } from "./aiSurface";

/** Explorer items dropped on the composer (`DroppedPath[]` as the detail). */
export const COMPOSER_DROP_EVENT = "terax:ai-drop-paths";

export type DroppedPath = { path: string; isDir: boolean };

/** What the explorer hands a drop: its paths at a point, and which are folders. */
type PathDropTarget = {
  updateTarget: (clientX: number, clientY: number) => boolean;
  dropPath: (
    paths: string[],
    clientX: number,
    clientY: number,
    isDir?: (path: string) => boolean | undefined,
  ) => boolean;
  clearTarget: () => void;
};

type ComposerDropDeps = {
  composerAt: (clientX: number, clientY: number) => boolean;
  setOver: (over: boolean) => void;
  deliver: (entries: DroppedPath[]) => void;
};

/** An explorer drag is over the composer: it shows where the drop lands. */
export const useComposerDropStore = create<{
  over: boolean;
  setOver: (over: boolean) => void;
}>((set) => ({
  over: false,
  setOver: (over) => set((s) => (s.over === over ? s : { over })),
}));

const browserDeps: ComposerDropDeps = {
  composerAt: (x, y) => isAiComposerTarget(document.elementFromPoint(x, y)),
  setOver: (over) => useComposerDropStore.getState().setOver(over),
  deliver: (entries) =>
    window.dispatchEvent(
      new CustomEvent<DroppedPath[]>(COMPOSER_DROP_EVENT, { detail: entries }),
    ),
};

/**
 * The explorer's drop target with the AI composer in front of `fallback`
 * (the terminals): a drop on the composer hands it the items, anywhere else
 * goes to `fallback` as before.
 */
export function withComposerDrop(
  fallback: PathDropTarget,
  deps: ComposerDropDeps = browserDeps,
): PathDropTarget {
  return {
    updateTarget(clientX, clientY) {
      if (deps.composerAt(clientX, clientY)) {
        fallback.clearTarget();
        deps.setOver(true);
        return true;
      }
      deps.setOver(false);
      return fallback.updateTarget(clientX, clientY);
    },
    dropPath(paths, clientX, clientY, isDir) {
      if (!deps.composerAt(clientX, clientY)) {
        deps.setOver(false);
        return fallback.dropPath(paths, clientX, clientY, isDir);
      }
      deps.setOver(false);
      fallback.clearTarget();
      // A path the explorer cannot place is taken for a file: reading a
      // folder fails, while a file read as a folder would only be named.
      deps.deliver(
        paths.map((path) => ({ path, isDir: isDir?.(path) === true })),
      );
      return true;
    },
    clearTarget() {
      deps.setOver(false);
      fallback.clearTarget();
    },
  };
}

/** Files attach; folders are named in the prompt, never read into it. */
export function planComposerDrop(entries: readonly DroppedPath[]): {
  files: string[];
  folders: string[];
} {
  const files: string[] = [];
  const folders: string[] = [];
  const seen = new Set<string>();
  for (const { path, isDir } of entries) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    (isDir ? folders : files).push(path);
  }
  return { files, folders };
}

/**
 * A folder as the prompt names it: its absolute path as inline code, which
 * the model reads as a path, and which opens neither the `/` nor the `@`
 * picker when the caret lands in it.
 */
export function folderReference(path: string): string {
  const fence = path.includes("`") ? "``" : "`";
  const pad = fence.length > 1 ? " " : "";
  return `${fence}${pad}${path}${pad}${fence}`;
}

/**
 * `text` put into `value` over `selection` (the end when there is none),
 * kept a space apart from the words around it, and the caret after it.
 */
export function insertIntoPrompt(
  value: string,
  selection: { start: number; end: number } | null,
  text: string,
): { value: string; caret: number } {
  const start = Math.min(
    Math.max(selection?.start ?? value.length, 0),
    value.length,
  );
  const end = Math.min(Math.max(selection?.end ?? start, start), value.length);
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = /^\s/.test(after) ? "" : " ";
  const inserted = `${lead}${text}${trail}`;
  return {
    value: `${before}${inserted}${after}`,
    caret: before.length + inserted.length,
  };
}
