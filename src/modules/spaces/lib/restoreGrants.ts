import type { Tab } from "@/modules/tabs";
import { isLeaf, type PaneNode } from "@/modules/terminal/lib/panes";
import {
  authorizeFileFolder,
  authorizeRoot,
} from "@/modules/workspace/authorize";
import {
  LOCAL_WORKSPACE,
  type WorkspaceEnv,
  workspaceScopeKey,
} from "@/modules/workspace/env";
import type { SpaceMeta } from "./store";

/** A folder a restored space works in: its root, a terminal's, or an open file's. */
export type RestoredGrant = {
  readonly path: string;
  /** `path` is a file: the folder it is really in is authorized, else `path` is a root. */
  readonly file: boolean;
  readonly env: WorkspaceEnv;
};

export type RestoreGrantPlan = {
  /** Authorized before the tabs are restored. */
  readonly now: RestoredGrant[];
  /** Per space, authorized when the space is first activated. */
  readonly later: Map<string, RestoredGrant[]>;
};

function eachLeafCwd(node: PaneNode, visit: (cwd: string) => void): void {
  if (isLeaf(node)) {
    if (node.cwd) visit(node.cwd);
    return;
  }
  for (const child of node.children) eachLeafCwd(child, visit);
}

/**
 * What restoring a window's spaces authorizes, each in its space's own
 * environment: the space roots, the terminals' folders and the open files'
 * folders (which may lie outside today's folders). A space in WSL that is not
 * the active one waits until it is activated, since reaching its files at
 * launch would start the distro.
 */
export function planRestoreGrants(
  spaces: readonly SpaceMeta[],
  tabs: readonly Tab[],
  activeId: string,
): RestoreGrantPlan {
  const envOf = new Map(spaces.map((space) => [space.id, space.env]));
  const seen = new Set<string>();
  const now: RestoredGrant[] = [];
  const later = new Map<string, RestoredGrant[]>();
  const add = (spaceId: string, path: string, file: boolean) => {
    const env = envOf.get(spaceId) ?? LOCAL_WORKSPACE;
    const key = `${workspaceScopeKey(env)}\u0000${file}\u0000${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    const grant = { path, file, env };
    if (env.kind === "local" || spaceId === activeId) {
      now.push(grant);
      return;
    }
    const list = later.get(spaceId);
    if (list) list.push(grant);
    else later.set(spaceId, [grant]);
  };
  for (const space of spaces) if (space.root) add(space.id, space.root, false);
  for (const tab of tabs) {
    if (tab.kind === "terminal") {
      eachLeafCwd(tab.paneTree, (cwd) => add(tab.spaceId, cwd, false));
    } else if (tab.kind === "editor" || tab.kind === "markdown") {
      add(tab.spaceId, tab.path, true);
    }
  }
  return { now, later };
}

export function grantRestored(grant: RestoredGrant): Promise<boolean> {
  return grant.file
    ? authorizeFileFolder(grant.path, grant.env)
    : authorizeRoot(grant.path, grant.env);
}

const deferred = new Map<string, RestoredGrant[]>();

export function deferRestoreGrants(later: Map<string, RestoredGrant[]>): void {
  for (const [spaceId, grants] of later) deferred.set(spaceId, grants);
}

/**
 * Authorizes what a space restored at launch works in, the first time it is
 * activated. Its tabs' reads wait for these (`authorizationSettled`).
 */
export function grantDeferredSpace(spaceId: string): void {
  const grants = deferred.get(spaceId);
  if (!grants) return;
  deferred.delete(spaceId);
  for (const grant of grants) void grantRestored(grant);
}
