import type { Tab } from "@/modules/tabs";
import { findLeafCwd } from "@/modules/terminal/lib/panes";
import { type WorkspaceEnv, workspaceScopeKey } from "@/modules/workspace";
import { basename, freshTerminalTab } from "./serialize";
import { newSpaceId, type SpaceMeta } from "./store";

export function findActiveSpace(
  spaces: SpaceMeta[],
  activeId: string | null,
): SpaceMeta | null {
  if (activeId) {
    const found = spaces.find((s) => s.id === activeId);
    if (found) return found;
  }
  return spaces[0] ?? null;
}

export function activeSpaceEnv(
  spaces: SpaceMeta[],
  activeId: string | null,
): WorkspaceEnv {
  return findActiveSpace(spaces, activeId)?.env ?? { kind: "local" };
}

// A WSL space falls back to null, not the local cwd, so its first tab opens at
// the WSL home instead of a Windows path.
export function freshTabCwd(
  env: WorkspaceEnv,
  restoredHome: string | null,
  launchCwd: string | null,
  home: string | null,
): string | null {
  return restoredHome ?? (env.kind === "local" ? (launchCwd ?? home) : null);
}

export type EnvSwitch =
  | { kind: "stay" }
  | { kind: "activate"; spaceId: string }
  | { kind: "create"; name: string };

/**
 * Where the status-bar environment picker takes the window. A space keeps one
 * environment for its shells, so picking another one moves to a space that
 * has it (the first in order), or to a new one, and never touches the shells
 * of any space.
 */
export function planEnvSwitch(
  spaces: SpaceMeta[],
  activeId: string | null,
  env: WorkspaceEnv,
): EnvSwitch {
  const key = workspaceScopeKey(env);
  if (workspaceScopeKey(activeSpaceEnv(spaces, activeId)) === key) {
    return { kind: "stay" };
  }
  const match = spaces.find((s) => workspaceScopeKey(s.env) === key);
  if (match) return { kind: "activate", spaceId: match.id };
  return { kind: "create", name: env.kind === "wsl" ? env.distro : "Windows" };
}

/**
 * Compares local paths the way the OS does: separators, a trailing slash and
 * (on a Windows drive) case do not matter.
 */
export function localPathKey(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  const trimmed = slashed.replace(/(?<=.)\/+$/, "");
  return /^[A-Za-z]:(\/|$)/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

export type FolderPlan = {
  /** The local space rooted at the folder, else a new one to add. */
  space:
    | { kind: "existing"; id: string }
    | { kind: "new"; name: string; root: string };
  /** A terminal of that space whose active pane is in the folder. */
  tabId: number | null;
};

/**
 * Where a folder Terax is asked to open goes (command line, Open in Terax,
 * Open Folder): the local space rooted at it, else a new one named after it,
 * on a terminal whose active pane is there, else a new terminal there.
 */
export function planOpenFolder(
  spaces: SpaceMeta[],
  tabs: Tab[],
  folder: string,
): FolderPlan {
  const key = localPathKey(folder);
  const space = spaces.find(
    (s) => s.env.kind === "local" && s.root && localPathKey(s.root) === key,
  );
  if (!space) {
    return {
      space: { kind: "new", name: basename(folder), root: folder },
      tabId: null,
    };
  }
  const tab = tabs.find((t) => {
    if (t.kind !== "terminal" || t.spaceId !== space.id) return false;
    const cwd = findLeafCwd(t.paneTree, t.activeLeafId);
    return cwd !== undefined && localPathKey(cwd) === key;
  });
  return { space: { kind: "existing", id: space.id }, tabId: tab?.id ?? null };
}

type ExplicitLaunchDir = {
  spaces: SpaceMeta[];
  tabs: Tab[];
  /** A folder Terax was asked to open (CLI argument, Open in Terax). */
  launchDir: string;
  allocId: () => number;
  now?: () => number;
  makeSpaceId?: () => string;
};

/**
 * Applies `planOpenFolder` to the restored spaces and tabs at boot: a new
 * space joins the end of the list and a new terminal the end of its space.
 */
export function applyExplicitLaunchDir({
  spaces,
  tabs,
  launchDir,
  allocId,
  now = Date.now,
  makeSpaceId = newSpaceId,
}: ExplicitLaunchDir): {
  spaces: SpaceMeta[];
  activeSpaceId: string;
  tabs: Tab[];
  activeTabId: number;
} {
  const plan = planOpenFolder(spaces, tabs, launchDir);
  let nextSpaces = spaces;
  let spaceId: string;
  if (plan.space.kind === "existing") {
    spaceId = plan.space.id;
  } else {
    const timestamp = now();
    spaceId = makeSpaceId();
    nextSpaces = [
      ...spaces,
      {
        id: spaceId,
        name: plan.space.name,
        root: plan.space.root,
        env: { kind: "local" },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ];
  }
  if (plan.tabId !== null) {
    return {
      spaces: nextSpaces,
      activeSpaceId: spaceId,
      tabs,
      activeTabId: plan.tabId,
    };
  }
  const tab = freshTerminalTab(spaceId, launchDir, allocId);
  return {
    spaces: nextSpaces,
    activeSpaceId: spaceId,
    tabs: [...tabs, tab],
    activeTabId: tab.id,
  };
}
