import {
  isLeaf,
  leafIds,
  type PaneNode,
  type SplitDir,
} from "@/modules/terminal/lib/panes";
import type {
  EditorTab,
  MarkdownTab,
  PreviewTab,
  Tab,
  TerminalTab,
} from "@/modules/tabs/lib/useTabs";

type SerializedNode =
  | { kind: "leaf"; cwd?: string; active?: boolean; scrollback?: string }
  | { kind: "split"; dir: SplitDir; children: SerializedNode[] };

/** The saved-scrollback key of a live leaf, if it has one. */
export type ScrollbackKeyOf = (leafId: number) => string | undefined;
/** Hands a restored leaf the scrollback key its pane had before. */
export type AdoptScrollbackKey = (leafId: number, key: string) => void;

const noScrollbackKey: ScrollbackKeyOf = () => undefined;

export type SerializedTab =
  | {
      kind: "terminal";
      tree: SerializedNode;
      blocks?: boolean;
      customTitle?: string;
    }
  | { kind: "editor"; path: string }
  | { kind: "preview"; url: string }
  | { kind: "markdown"; path: string };

export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function titleFromUrl(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url || "preview";
  }
}

function serializeNode(
  node: PaneNode,
  activeLeafId: number,
  scrollbackKeyOf: ScrollbackKeyOf,
): SerializedNode {
  if (isLeaf(node)) {
    const scrollback = scrollbackKeyOf(node.id);
    return {
      kind: "leaf",
      ...(node.cwd !== undefined && { cwd: node.cwd }),
      ...(node.id === activeLeafId && { active: true }),
      ...(scrollback !== undefined && { scrollback }),
    };
  }
  return {
    kind: "split",
    dir: node.dir,
    children: node.children.map((c) =>
      serializeNode(c, activeLeafId, scrollbackKeyOf),
    ),
  };
}

export function isSerializableTab(tab: Tab): boolean {
  switch (tab.kind) {
    case "terminal":
      return !tab.private;
    case "editor":
    case "preview":
    case "markdown":
      return true;
    default:
      return false;
  }
}

/** Leaves of every terminal whose tabs persist; private tabs never do. */
export function persistedTerminalLeafIds(tabs: readonly Tab[]): number[] {
  const out: number[] = [];
  for (const tab of tabs) {
    if (tab.kind === "terminal" && isSerializableTab(tab)) {
      out.push(...leafIds(tab.paneTree));
    }
  }
  return out;
}

function serializeTab(
  tab: Tab,
  scrollbackKeyOf: ScrollbackKeyOf,
): SerializedTab | null {
  if (!isSerializableTab(tab)) return null;
  switch (tab.kind) {
    case "terminal":
      return {
        kind: "terminal",
        tree: serializeNode(tab.paneTree, tab.activeLeafId, scrollbackKeyOf),
        ...(tab.blocks && { blocks: true }),
        ...(tab.customTitle !== undefined && { customTitle: tab.customTitle }),
      };
    case "editor":
      return { kind: "editor", path: tab.path };
    case "preview":
      return { kind: "preview", url: tab.url };
    case "markdown":
      return { kind: "markdown", path: tab.path };
    default:
      return null;
  }
}

export function serializeTabs(
  tabs: Tab[],
  scrollbackKeyOf: ScrollbackKeyOf = noScrollbackKey,
): SerializedTab[] {
  const out: SerializedTab[] = [];
  for (const tab of tabs) {
    const s = serializeTab(tab, scrollbackKeyOf);
    if (s) out.push(s);
  }
  return out;
}

type HydratedTree = {
  tree: PaneNode;
  activeLeafId: number;
  firstLeafCwd?: string;
  scrollback: HydrateAcc["scrollback"];
};

type HydrateAcc = {
  activeLeafId: number | null;
  scrollback: Array<{ leafId: number; key: string }>;
};

function hydrateNode(
  node: SerializedNode,
  allocId: () => number,
  acc: HydrateAcc,
): PaneNode {
  if (node.kind === "leaf") {
    const id = allocId();
    if (node.active && acc.activeLeafId === null) acc.activeLeafId = id;
    if (typeof node.scrollback === "string") {
      acc.scrollback.push({ leafId: id, key: node.scrollback });
    }
    return {
      kind: "leaf",
      id,
      ...(node.cwd !== undefined && { cwd: node.cwd }),
    };
  }
  const children = node.children.map((c) => hydrateNode(c, allocId, acc));
  if (children.length === 0) return { kind: "leaf", id: allocId() };
  if (children.length === 1) return children[0];
  return { kind: "split", id: allocId(), dir: node.dir, children };
}

function hydrateTree(
  tree: SerializedNode,
  allocId: () => number,
): HydratedTree {
  const acc: HydrateAcc = { activeLeafId: null, scrollback: [] };
  const paneTree = hydrateNode(tree, allocId, acc);
  const leaves = collectLeaves(paneTree);
  const activeLeafId = acc.activeLeafId ?? leaves[0]?.id ?? allocId();
  const firstLeafCwd =
    leaves.find((l) => l.id === activeLeafId)?.cwd ?? leaves[0]?.cwd;
  return {
    tree: paneTree,
    activeLeafId,
    firstLeafCwd,
    scrollback: acc.scrollback,
  };
}

function collectLeaves(node: PaneNode): Array<{ id: number; cwd?: string }> {
  if (isLeaf(node)) return [{ id: node.id, cwd: node.cwd }];
  return node.children.flatMap(collectLeaves);
}

function hydrateTab(
  s: SerializedTab,
  spaceId: string,
  allocId: () => number,
  adoptScrollback: AdoptScrollbackKey | undefined,
): Tab | null {
  switch (s.kind) {
    case "terminal": {
      const { tree, activeLeafId, firstLeafCwd, scrollback } = hydrateTree(
        s.tree,
        allocId,
      );
      if (adoptScrollback) {
        for (const { leafId, key } of scrollback) adoptScrollback(leafId, key);
      }
      const title =
        s.customTitle ??
        (firstLeafCwd ? basename(firstLeafCwd) : s.blocks ? "blocks" : "shell");
      return {
        id: allocId(),
        kind: "terminal",
        spaceId,
        cold: true,
        title,
        cwd: firstLeafCwd,
        paneTree: tree,
        activeLeafId,
        ...(s.blocks && { blocks: true }),
        ...(s.customTitle !== undefined && { customTitle: s.customTitle }),
      } satisfies TerminalTab;
    }
    case "editor":
      return {
        id: allocId(),
        kind: "editor",
        spaceId,
        cold: true,
        title: basename(s.path),
        path: s.path,
        dirty: false,
        preview: false,
      } satisfies EditorTab;
    case "preview":
      return {
        id: allocId(),
        kind: "preview",
        spaceId,
        cold: true,
        title: titleFromUrl(s.url),
        url: s.url,
      } satisfies PreviewTab;
    case "markdown":
      return {
        id: allocId(),
        kind: "markdown",
        spaceId,
        cold: true,
        title: basename(s.path),
        path: s.path,
      } satisfies MarkdownTab;
    default:
      return null;
  }
}

export function freshTerminalTab(
  spaceId: string,
  cwd: string | null,
  allocId: () => number,
): TerminalTab {
  const leafId = allocId();
  return {
    id: allocId(),
    kind: "terminal",
    spaceId,
    cold: true,
    title: cwd ? basename(cwd) : "shell",
    cwd: cwd ?? undefined,
    paneTree: { kind: "leaf", id: leafId, ...(cwd && { cwd }) },
    activeLeafId: leafId,
  };
}

export function hydrateTabs(
  serialized: SerializedTab[],
  spaceId: string,
  allocId: () => number,
  adoptScrollback?: AdoptScrollbackKey,
): Tab[] {
  if (!Array.isArray(serialized)) return [];
  const out: Tab[] = [];
  for (const s of serialized) {
    try {
      const tab = hydrateTab(s, spaceId, allocId, adoptScrollback);
      if (tab) out.push(tab);
    } catch {
      // Skip corrupted entries rather than failing the whole restore.
    }
  }
  return out;
}
