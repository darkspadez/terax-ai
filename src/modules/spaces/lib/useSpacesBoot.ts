import { usePreferencesStore } from "@/modules/settings/preferences";
import type { Tab } from "@/modules/tabs";
import { DEFAULT_SPACE_ID } from "@/modules/tabs/lib/useTabs";
import { adoptScrollbackKey } from "@/modules/terminal/lib/terminalScrollbackRestore";
import { parseWorkspaceScopeKey, type WorkspaceEnv } from "@/modules/workspace";
import { authorizeRoot } from "@/modules/workspace/authorize";
import { useEffect, useRef } from "react";
import {
  activeSpaceEnv,
  applyExplicitLaunchDir,
  freshTabCwd,
} from "./activeSpace";
import {
  deferRestoreGrants,
  grantRestored,
  planRestoreGrants,
  type RestoredGrant,
} from "./restoreGrants";
import {
  type AdoptScrollbackKey,
  freshTerminalTab,
  hydrateTabs,
} from "./serialize";
import { loadAll, type SpaceMeta, saveActiveId, saveSpacesList } from "./store";
import { useSpaces } from "./useSpaces";

type BootParams = {
  launchCwd: string | null;
  /** A folder Oarlock was asked to open; it wins over the restored spaces. */
  explicitLaunchDir: string | null;
  home: string | null;
  allocId: () => number;
  replaceTabs: (tabs: Tab[], activeId: number) => void;
  setActiveSpaceForNewTabs: (id: string) => void;
  adoptWorkspaceEnv: (env: WorkspaceEnv) => Promise<string | null>;
};

type Params = BootParams & {
  ready: boolean;
  markBooted: () => void;
};

export type BootDependencies = {
  loadAll: typeof loadAll;
  saveSpacesList: typeof saveSpacesList;
  saveActiveId: typeof saveActiveId;
  /** The folder Oarlock was asked to open, in the local environment. */
  authorizeLaunchDir: (path: string) => Promise<unknown>;
  grant: (grant: RestoredGrant) => Promise<unknown>;
  deferGrants: (later: Map<string, RestoredGrant[]>) => void;
  hydrate: (
    spaces: SpaceMeta[],
    activeId: string | null,
    initialActiveIndex?: Record<string, number>,
  ) => void;
  defaultWorkspaceEnv: () => Promise<WorkspaceEnv>;
  adoptScrollbackKey: AdoptScrollbackKey;
};

const defaultDependencies: BootDependencies = {
  loadAll,
  saveSpacesList,
  saveActiveId,
  authorizeLaunchDir: (path) => authorizeRoot(path, { kind: "local" }),
  grant: grantRestored,
  deferGrants: deferRestoreGrants,
  hydrate: (spaces, activeId, initialActiveIndex) =>
    useSpaces.getState().hydrate(spaces, activeId, initialActiveIndex),
  defaultWorkspaceEnv: async () => {
    // Hydrate prefs before reading the saved workspace env.
    await usePreferencesStore
      .getState()
      .init()
      .catch(() => {});
    return parseWorkspaceScopeKey(
      usePreferencesStore.getState().defaultWorkspaceEnv,
    );
  },
  adoptScrollbackKey,
};

/** Authorizes what the restored spaces work in; see `planRestoreGrants`. */
async function grantRestore(
  deps: BootDependencies,
  spaces: SpaceMeta[],
  tabs: Tab[],
  activeId: string,
): Promise<void> {
  const plan = planRestoreGrants(spaces, tabs, activeId);
  deps.deferGrants(plan.later);
  await Promise.allSettled(plan.now.map((grant) => deps.grant(grant)));
}

/** Restores the window's spaces and tabs, or creates its first space. */
export async function bootSpaces(
  {
    launchCwd,
    explicitLaunchDir,
    home,
    allocId,
    replaceTabs,
    setActiveSpaceForNewTabs,
    adoptWorkspaceEnv,
  }: BootParams,
  deps: BootDependencies = defaultDependencies,
): Promise<void> {
  const { spaces, activeId, states } = await deps.loadAll();

  if (spaces.length === 0) {
    // The window's first tab already starts in the launch directory.
    const now = Date.now();
    const meta: SpaceMeta = {
      id: DEFAULT_SPACE_ID,
      name: "Default",
      root: explicitLaunchDir ?? launchCwd ?? home ?? null,
      env: explicitLaunchDir
        ? { kind: "local" }
        : await deps.defaultWorkspaceEnv(),
      createdAt: now,
      updatedAt: now,
    };
    if (explicitLaunchDir) {
      await adoptWorkspaceEnv(meta.env).catch(() => null);
      await deps.authorizeLaunchDir(explicitLaunchDir).catch(() => null);
    }
    await deps.saveSpacesList([meta]);
    await deps.saveActiveId(DEFAULT_SPACE_ID);
    setActiveSpaceForNewTabs(DEFAULT_SPACE_ID);
    deps.hydrate([meta], DEFAULT_SPACE_ID);
    return;
  }

  const restored: Tab[] = [];
  for (const space of spaces) {
    const st = states.get(space.id);
    if (!st) continue;
    restored.push(
      ...hydrateTabs(st.tabs, space.id, allocId, deps.adoptScrollbackKey),
    );
  }

  const initialActiveIndex: Record<string, number> = {};
  for (const [id, st] of states) initialActiveIndex[id] = st.activeTabIndex;

  if (explicitLaunchDir) {
    const launched = applyExplicitLaunchDir({
      spaces,
      tabs: restored,
      launchDir: explicitLaunchDir,
      allocId,
    });
    setActiveSpaceForNewTabs(launched.activeSpaceId);
    await adoptWorkspaceEnv({ kind: "local" }).catch(() => null);
    await Promise.allSettled([
      deps.saveSpacesList(launched.spaces),
      deps.saveActiveId(launched.activeSpaceId),
      grantRestore(
        deps,
        launched.spaces,
        launched.tabs,
        launched.activeSpaceId,
      ),
    ]);
    deps.hydrate(launched.spaces, launched.activeSpaceId, initialActiveIndex);
    replaceTabs(launched.tabs, launched.activeTabId);
    return;
  }

  const active =
    activeId && spaces.some((s) => s.id === activeId) ? activeId : spaces[0].id;
  setActiveSpaceForNewTabs(active);

  // Apply the space's env+home before the fresh-tab fallback and spawns
  // below; env is set synchronously so cwd resolution picks WSL vs local.
  const env = activeSpaceEnv(spaces, active);
  const restoredHome = await adoptWorkspaceEnv(env);

  // Active space must never be empty, else its tab list shows nothing.
  if (!restored.some((t) => t.spaceId === active)) {
    const cwd = freshTabCwd(env, restoredHome, launchCwd, home);
    restored.push(freshTerminalTab(active, cwd, allocId));
  }

  await grantRestore(deps, spaces, restored, active);

  deps.hydrate(spaces, active, initialActiveIndex);

  const inActive = restored.filter((t) => t.spaceId === active);
  const idx = states.get(active)?.activeTabIndex ?? 0;
  const activeTab = inActive[idx] ?? inActive[0] ?? restored[0];
  replaceTabs(restored, activeTab.id);
}

export function useSpacesBoot({
  ready,
  launchCwd,
  explicitLaunchDir,
  home,
  allocId,
  replaceTabs,
  markBooted,
  setActiveSpaceForNewTabs,
  adoptWorkspaceEnv,
}: Params) {
  const done = useRef(false);

  useEffect(() => {
    if (!ready || done.current) return;
    done.current = true;

    bootSpaces({
      launchCwd,
      explicitLaunchDir,
      home,
      allocId,
      replaceTabs,
      setActiveSpaceForNewTabs,
      adoptWorkspaceEnv,
    })
      .catch((e) => console.error("[oarlock] spaces boot failed:", e))
      .finally(markBooted);
  }, [
    ready,
    launchCwd,
    explicitLaunchDir,
    home,
    allocId,
    replaceTabs,
    markBooted,
    setActiveSpaceForNewTabs,
    adoptWorkspaceEnv,
  ]);
}
