import type { Tab, TerminalTab } from "@/modules/tabs/lib/useTabs";
import { findLeafCwd } from "@/modules/terminal/lib/panes";
import type { WorkspaceEnv } from "@/modules/workspace";
import { describe, expect, it, vi } from "vitest";
import type { RestoredGrant } from "./restoreGrants";
import type { SpaceMeta, SpaceState } from "./store";
import { type BootDependencies, bootSpaces } from "./useSpacesBoot";

function space(over: Partial<SpaceMeta> = {}): SpaceMeta {
  return {
    id: "repo",
    name: "Repo",
    root: "C:/work/repo",
    env: { kind: "local" },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function state(cwd: string): SpaceState {
  return {
    tabs: [{ kind: "terminal", tree: { kind: "leaf", cwd, active: true } }],
    activeTabIndex: 0,
  };
}

/** A later task: an event recorded after it proves its caller awaited it. */
const laterTask = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup({
  spaces = [
    space(),
    space({ id: "other", name: "Other", root: "C:/work/other" }),
  ],
  activeId = "other",
  states = new Map([
    ["repo", state("C:/work/repo")],
    ["other", state("C:/work/other")],
  ]),
}: {
  spaces?: SpaceMeta[];
  activeId?: string | null;
  states?: Map<string, SpaceState>;
} = {}) {
  const events: string[] = [];
  const deps = {
    loadAll: vi.fn().mockResolvedValue({ spaces, activeId, states }),
    saveSpacesList: vi.fn(async (_spaces: SpaceMeta[]) => {
      await laterTask();
      events.push("saved-spaces");
    }),
    saveActiveId: vi.fn(async (_id: string | null) => {
      await laterTask();
      events.push("saved-active");
    }),
    authorizeLaunchDir: vi.fn(async (path: string) => {
      await laterTask();
      events.push(`authorized:${path}`);
    }),
    grant: vi.fn(async (grant: RestoredGrant) => {
      await laterTask();
      events.push(`authorized:${grant.path}`);
    }),
    deferGrants: vi.fn((_later: Map<string, RestoredGrant[]>) => {}),
    hydrate: vi.fn(() => {
      events.push("hydrate");
    }),
    defaultWorkspaceEnv: vi.fn(async () => ({
      kind: "wsl" as const,
      distro: "Ubuntu",
    })),
    adoptScrollbackKey: vi.fn(),
  } satisfies BootDependencies;
  let next = 10;
  const replaced: { tabs: Tab[]; activeId: number }[] = [];
  const params = {
    launchCwd: "C:/fallback",
    explicitLaunchDir: null as string | null,
    home: "C:/Users/test",
    allocId: () => next++,
    replaceTabs: vi.fn((tabs: Tab[], activeTabId: number) => {
      events.push("replace-tabs");
      replaced.push({ tabs, activeId: activeTabId });
    }),
    setActiveSpaceForNewTabs: vi.fn(),
    adoptWorkspaceEnv: vi.fn(
      async (_env: WorkspaceEnv): Promise<string | null> => {
        await laterTask();
        events.push("adopted");
        return "C:/Users/test";
      },
    ),
  };
  const activeTab = () => {
    const { tabs, activeId: id } = replaced[replaced.length - 1];
    return tabs.find((t) => t.id === id) as TerminalTab;
  };
  const activeCwd = () => {
    const tab = activeTab();
    return findLeafCwd(tab.paneTree, tab.activeLeafId);
  };
  return { deps, events, params, activeTab, activeCwd };
}

describe("bootSpaces", () => {
  it("restores the saved active space when no folder was given", async () => {
    // The process's directory is not a request to open it (crynta/terax-ai#1382).
    const { deps, params, activeTab, activeCwd } = setup();

    await bootSpaces(params, deps);

    expect(params.setActiveSpaceForNewTabs).toHaveBeenCalledWith("other");
    expect(activeTab().spaceId).toBe("other");
    expect(activeCwd()).toBe("C:/work/other");
    expect(deps.saveSpacesList).not.toHaveBeenCalled();
  });

  it("opens a folder given at launch over the restored tabs", async () => {
    // crynta/terax-ai#1382, #1048, #844: Open in Oarlock after a first session.
    const { deps, events, params, activeTab, activeCwd } = setup();
    params.explicitLaunchDir = "C:/work/repo";

    await bootSpaces(params, deps);

    expect(params.setActiveSpaceForNewTabs).toHaveBeenCalledWith("repo");
    expect(params.adoptWorkspaceEnv).toHaveBeenCalledWith({ kind: "local" });
    expect(activeTab().spaceId).toBe("repo");
    expect(activeCwd()).toBe("C:/work/repo");
    // The restored terminal there is reused, nothing is lost elsewhere.
    expect(params.replaceTabs.mock.calls[0][0]).toHaveLength(2);
    expect(deps.saveActiveId).toHaveBeenCalledWith("repo");
    // Everything is settled before the spaces show.
    for (const event of [
      "adopted",
      "saved-spaces",
      "saved-active",
      "authorized:C:/work/repo",
      "authorized:C:/work/other",
    ]) {
      expect(events.indexOf(event)).toBeGreaterThan(-1);
      expect(events.indexOf(event)).toBeLessThan(events.indexOf("hydrate"));
    }
    expect(events.indexOf("hydrate")).toBeLessThan(
      events.indexOf("replace-tabs"),
    );
  });

  it("gives a launch folder no saved space matches a space of its own", async () => {
    const { deps, params, activeTab, activeCwd } = setup();
    params.explicitLaunchDir = "D:/test";

    await bootSpaces(params, deps);

    const [saved] = deps.saveSpacesList.mock.calls[0];
    expect(saved.map((s) => s.root)).toEqual([
      "C:/work/repo",
      "C:/work/other",
      "D:/test",
    ]);
    const created = saved[2];
    expect(created).toMatchObject({ name: "test", env: { kind: "local" } });
    expect(deps.hydrate).toHaveBeenCalledWith(saved, created.id, {
      repo: 0,
      other: 0,
    });
    expect(activeTab().spaceId).toBe(created.id);
    expect(activeCwd()).toBe("D:/test");
    expect(deps.grant).toHaveBeenCalledWith({
      path: "D:/test",
      file: false,
      env: { kind: "local" },
    });
  });

  it("roots the first space at a launch folder, as a local space", async () => {
    const { deps, events, params } = setup({
      spaces: [],
      activeId: null,
      states: new Map(),
    });
    params.explicitLaunchDir = "C:/work/repo";

    await bootSpaces(params, deps);

    const [saved] = deps.saveSpacesList.mock.calls[0];
    expect(saved).toEqual([
      expect.objectContaining({
        id: "default",
        root: "C:/work/repo",
        env: { kind: "local" },
      }),
    ]);
    expect(deps.defaultWorkspaceEnv).not.toHaveBeenCalled();
    expect(events.indexOf("adopted")).toBeLessThan(events.indexOf("hydrate"));
    expect(events.indexOf("authorized:C:/work/repo")).toBeLessThan(
      events.indexOf("hydrate"),
    );
    // The window's first tab is already there.
    expect(params.replaceTabs).not.toHaveBeenCalled();
  });

  it("roots the first space at the launch directory without a folder", async () => {
    const { deps, params } = setup({
      spaces: [],
      activeId: null,
      states: new Map(),
    });

    await bootSpaces(params, deps);

    expect(deps.saveSpacesList).toHaveBeenCalledWith([
      expect.objectContaining({
        root: "C:/fallback",
        env: { kind: "wsl", distro: "Ubuntu" },
      }),
    ]);
    expect(params.adoptWorkspaceEnv).not.toHaveBeenCalled();
  });

  it("authorizes the restored files' folders before the tabs show", async () => {
    const { deps, events, params } = setup({
      states: new Map([
        [
          "repo",
          {
            tabs: [
              { kind: "editor", path: "D:/notes/todo.txt" },
              { kind: "markdown", path: "E:/docs/readme.md" },
            ],
            activeTabIndex: 0,
          },
        ],
        ["other", state("C:/work/other")],
      ]),
    });

    await bootSpaces(params, deps);

    expect(deps.grant).toHaveBeenCalledWith({
      path: "D:/notes/todo.txt",
      file: true,
      env: { kind: "local" },
    });
    expect(deps.grant).toHaveBeenCalledWith({
      path: "C:/work/repo",
      file: false,
      env: { kind: "local" },
    });
    for (const event of [
      "authorized:D:/notes/todo.txt",
      "authorized:E:/docs/readme.md",
      "authorized:C:/work/other",
    ]) {
      expect(events.indexOf(event)).toBeGreaterThan(-1);
      expect(events.indexOf(event)).toBeLessThan(events.indexOf("hydrate"));
    }
  });

  it("leaves an inactive WSL space's folders until it is activated", async () => {
    const ubuntu = { kind: "wsl", distro: "Ubuntu" } as const;
    const { deps, params } = setup({
      spaces: [
        space({ id: "linux", root: "/home/me/app", env: ubuntu }),
        space({ id: "other", name: "Other", root: "C:/work/other" }),
      ],
      states: new Map([
        ["linux", state("/home/me/app")],
        ["other", state("C:/work/other")],
      ]),
    });

    await bootSpaces(params, deps);

    const granted = deps.grant.mock.calls.map(([grant]) => grant.path);
    expect(granted).toEqual(["C:/work/other"]);
    expect(deps.deferGrants).toHaveBeenCalledWith(
      new Map([
        ["linux", [{ path: "/home/me/app", file: false, env: ubuntu }]],
      ]),
    );
  });

  it("still shows the spaces when saving or authorizing fails", async () => {
    const { deps, events, params } = setup();
    params.explicitLaunchDir = "C:/work/repo";
    deps.saveSpacesList.mockRejectedValue(new Error("save spaces"));
    deps.saveActiveId.mockRejectedValue(new Error("save active"));
    deps.grant.mockRejectedValue(new Error("authorize"));
    params.adoptWorkspaceEnv.mockRejectedValue(new Error("adopt"));

    await bootSpaces(params, deps);

    expect(deps.hydrate).toHaveBeenCalledOnce();
    expect(params.replaceTabs).toHaveBeenCalledOnce();
    expect(events).toEqual(["hydrate", "replace-tabs"]);
  });
});
