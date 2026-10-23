import type { TreeNavRow } from "@/lib/treeKeyMove";

type ChangedPath = { readonly key: string; readonly path: string };

export type ChangeTreeRow<Entry extends ChangedPath> =
  | {
      readonly kind: "folder";
      readonly key: string;
      /** Repository-relative path of the deepest folder the row stands for. */
      readonly path: string;
      /** Folders with nothing else in them are joined: `src/modules`. */
      readonly label: string;
      /** The last folder's own name, for its icon. */
      readonly name: string;
      readonly depth: number;
      readonly fileCount: number;
      readonly collapsed: boolean;
      readonly parentKey: string | null;
    }
  | {
      readonly kind: "file";
      readonly key: string;
      readonly entry: Entry;
      readonly depth: number;
      readonly parentKey: string | null;
    };

type Folder<Entry> = {
  readonly name: string;
  readonly path: string;
  readonly folders: Map<string, Folder<Entry>>;
  readonly files: { name: string; entry: Entry }[];
  fileCount: number;
};

const NAME_ORDER = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

/** The explorer's order: numbers by value, case ignored, then by code point. */
function compareNames(a: string, b: string): number {
  return NAME_ORDER.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * A folder row's key. File rows use the file's path, which never ends in a
 * separator, so the two can never collide.
 */
export function changeFolderKey(path: string): string {
  return `${path}/`;
}

function newFolder<Entry>(name: string, path: string): Folder<Entry> {
  return { name, path, folders: new Map(), files: [], fileCount: 0 };
}

function buildFolders<Entry extends ChangedPath>(
  entries: readonly Entry[],
): Folder<Entry> {
  const root = newFolder<Entry>("", "");
  for (const entry of entries) {
    const parts = entry.path.replace(/\\/g, "/").split("/").filter(Boolean);
    const name = parts.pop();
    if (name === undefined) continue;
    let folder = root;
    folder.fileCount += 1;
    for (const part of parts) {
      let next = folder.folders.get(part);
      if (!next) {
        next = newFolder(part, folder.path ? `${folder.path}/${part}` : part);
        folder.folders.set(part, next);
      }
      next.fileCount += 1;
      folder = next;
    }
    folder.files.push({ name, entry });
  }
  return root;
}

/**
 * Rows for the changed files grouped by folder, folders first and each level
 * in the explorer's order, as the tree shows them with `collapsed` folders
 * (keyed by path) closed. A chain of folders holding only the next one is a
 * single row, as in the explorer of most editors.
 */
export function changeTreeRows<Entry extends ChangedPath>(
  entries: readonly Entry[],
  collapsed: ReadonlySet<string>,
): ChangeTreeRow<Entry>[] {
  const rows: ChangeTreeRow<Entry>[] = [];
  const walk = (
    folder: Folder<Entry>,
    depth: number,
    parentKey: string | null,
  ) => {
    const folders = [...folder.folders.values()].sort((a, b) =>
      compareNames(a.name, b.name),
    );
    for (const child of folders) {
      let last = child;
      let label = child.name;
      while (last.files.length === 0 && last.folders.size === 1) {
        const [only] = last.folders.values();
        last = only;
        label = `${label}/${only.name}`;
      }
      const key = changeFolderKey(last.path);
      const isCollapsed = collapsed.has(last.path);
      rows.push({
        kind: "folder",
        key,
        path: last.path,
        label,
        name: last.name,
        depth,
        fileCount: last.fileCount,
        collapsed: isCollapsed,
        parentKey,
      });
      if (!isCollapsed) walk(last, depth + 1, key);
    }
    const files = [...folder.files].sort((a, b) =>
      compareNames(a.name, b.name),
    );
    for (const { entry } of files) {
      rows.push({ kind: "file", key: entry.key, entry, depth, parentKey });
    }
  };
  walk(buildFolders(entries), 0, null);
  return rows;
}

/** `collapsed` with `path` opened or closed. */
export function toggleCollapsedFolder(
  collapsed: ReadonlySet<string>,
  path: string,
): ReadonlySet<string> {
  const next = new Set(collapsed);
  if (!next.delete(path)) next.add(path);
  return next;
}

/** A tree row as `treeKeyMove` reads it. */
export function changeTreeNavRow(
  row:
    | {
        readonly kind: "folder";
        readonly key: string;
        readonly path: string;
        readonly collapsed: boolean;
        readonly parentKey: string | null;
      }
    | {
        readonly kind: "entry" | "file";
        readonly key: string;
        readonly parentKey: string | null;
      },
): TreeNavRow {
  return row.kind === "folder"
    ? {
        key: row.key,
        parentKey: row.parentKey,
        branch: { id: row.path, collapsed: row.collapsed },
      }
    : { key: row.key, parentKey: row.parentKey };
}
