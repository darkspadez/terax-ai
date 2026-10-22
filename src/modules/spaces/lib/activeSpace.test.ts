import type { TerminalTab } from "@/modules/tabs/lib/useTabs";
import type { WorkspaceEnv } from "@/modules/workspace";
import { describe, expect, it } from "vitest";
import {
  activeSpaceEnv,
  applyExplicitLaunchDir,
  findActiveSpace,
  freshTabCwd,
  localPathKey,
  planEnvSwitch,
} from "./activeSpace";
import type { SpaceMeta } from "./store";

function space(over: Partial<SpaceMeta>): SpaceMeta {
  return {
    id: "s1",
    name: "Space",
    root: null,
    env: { kind: "local" },
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe("findActiveSpace", () => {
  it("returns the space matching activeId", () => {
    const spaces = [space({ id: "a" }), space({ id: "b" })];
    expect(findActiveSpace(spaces, "b")?.id).toBe("b");
  });

  it("falls back to the first space when activeId is null or unknown", () => {
    const spaces = [space({ id: "a" }), space({ id: "b" })];
    expect(findActiveSpace(spaces, null)?.id).toBe("a");
    expect(findActiveSpace(spaces, "missing")?.id).toBe("a");
  });

  it("returns null when there are no spaces", () => {
    expect(findActiveSpace([], "a")).toBeNull();
  });
});

describe("activeSpaceEnv", () => {
  it("restores the active space's WSL env", () => {
    const spaces = [
      space({ id: "a", env: { kind: "local" } }),
      space({ id: "b", env: { kind: "wsl", distro: "Ubuntu" } }),
    ];
    expect(activeSpaceEnv(spaces, "b")).toEqual({
      kind: "wsl",
      distro: "Ubuntu",
    });
  });

  it("restores the env of the fallback space when activeId is missing", () => {
    const spaces = [space({ id: "a", env: { kind: "wsl", distro: "Debian" } })];
    expect(activeSpaceEnv(spaces, null)).toEqual({
      kind: "wsl",
      distro: "Debian",
    });
  });

  it("defaults to local when there are no spaces", () => {
    expect(activeSpaceEnv([], "a")).toEqual({ kind: "local" });
  });
});

describe("freshTabCwd", () => {
  const wsl: WorkspaceEnv = { kind: "wsl", distro: "Ubuntu" };
  const local: WorkspaceEnv = { kind: "local" };

  it("prefers the restored home for any env", () => {
    expect(freshTabCwd(wsl, "/home/aj", "C:/Users/me", "C:/Users/me")).toBe(
      "/home/aj",
    );
  });

  it("returns null for a WSL space when its home did not resolve", () => {
    expect(freshTabCwd(wsl, null, "C:/Users/me", "C:/Users/me")).toBeNull();
  });

  it("falls back to the local launch cwd then home for a local space", () => {
    expect(freshTabCwd(local, null, "C:/work", "C:/Users/me")).toBe("C:/work");
    expect(freshTabCwd(local, null, null, "C:/Users/me")).toBe("C:/Users/me");
    expect(freshTabCwd(local, null, null, null)).toBeNull();
  });
});

describe("localPathKey", () => {
  it("ignores separators, trailing slashes and Windows drive case", () => {
    expect(localPathKey("c:\\Work\\Repo\\")).toBe(localPathKey("C:/work/repo"));
    expect(localPathKey("C:\\")).toBe(localPathKey("c:"));
    expect(localPathKey("/home/me/proj/")).toBe("/home/me/proj");
    expect(localPathKey("/")).toBe("/");
  });

  it("keeps case on Unix paths", () => {
    expect(localPathKey("/home/me/Proj")).not.toBe(
      localPathKey("/home/me/proj"),
    );
  });
});

describe("applyExplicitLaunchDir", () => {
  function ids(start = 10): () => number {
    let n = start;
    return () => n++;
  }

  function term(id: number, spaceId: string, ...cwds: string[]): TerminalTab {
    const leaves = cwds.map((cwd, i) => ({
      kind: "leaf" as const,
      id: id * 100 + i,
      cwd,
    }));
    return {
      id,
      kind: "terminal",
      spaceId,
      title: "shell",
      cwd: cwds[0],
      paneTree:
        leaves.length === 1
          ? leaves[0]
          : { kind: "split", id: id * 100 + 99, dir: "row", children: leaves },
      activeLeafId: leaves[leaves.length - 1].id,
    };
  }

  it("activates the local space rooted at the folder and its terminal there", () => {
    const spaces = [
      space({ id: "old", root: "C:/old" }),
      space({ id: "repo", root: "c:\\work\\repo\\" }),
    ];
    const tabs = [term(1, "old", "C:/old"), term(3, "repo", "C:/Work/Repo")];

    const result = applyExplicitLaunchDir({
      spaces,
      tabs,
      launchDir: "C:/work/repo",
      allocId: ids(),
      makeSpaceId: () => "new",
    });

    expect(result).toEqual({
      spaces,
      activeSpaceId: "repo",
      tabs,
      activeTabId: 3,
    });
  });

  it("opens a terminal in the matching space when none is there", () => {
    const spaces = [space({ id: "repo", root: "/work/repo" })];
    // Its first pane is there, but the pane in use is elsewhere.
    const tabs = [term(1, "repo", "/work/repo", "/work/repo/src")];

    const result = applyExplicitLaunchDir({
      spaces,
      tabs,
      launchDir: "/work/repo",
      allocId: ids(20),
    });

    expect(result.spaces).toBe(spaces);
    expect(result.activeSpaceId).toBe("repo");
    expect(result.tabs.slice(0, 1)).toEqual(tabs);
    expect(result.tabs[1]).toMatchObject({
      id: result.activeTabId,
      kind: "terminal",
      spaceId: "repo",
      cwd: "/work/repo",
    });
  });

  it("creates a local space named after the folder when no local root matches", () => {
    const spaces = [
      space({ id: "old", root: "/old" }),
      // Same path, but a WSL space cannot hold a local folder.
      space({
        id: "wsl",
        root: "/work/new-repo",
        env: { kind: "wsl", distro: "Ubuntu" },
      }),
    ];
    const tabs = [term(1, "old", "/old"), term(2, "wsl", "/work/new-repo")];

    const result = applyExplicitLaunchDir({
      spaces,
      tabs,
      launchDir: "/work/new-repo",
      allocId: ids(20),
      now: () => 123,
      makeSpaceId: () => "sp-new",
    });

    expect(result.spaces).toEqual([
      ...spaces,
      {
        id: "sp-new",
        name: "new-repo",
        root: "/work/new-repo",
        env: { kind: "local" },
        createdAt: 123,
        updatedAt: 123,
      },
    ]);
    expect(result.activeSpaceId).toBe("sp-new");
    expect(result.tabs).toHaveLength(3);
    expect(result.tabs[2]).toMatchObject({
      id: result.activeTabId,
      spaceId: "sp-new",
      cwd: "/work/new-repo",
    });
  });
});

describe("planEnvSwitch", () => {
  // crynta/terax-ai#608, #977: the picker used to replace every tab.
  const ubuntu: WorkspaceEnv = { kind: "wsl", distro: "Ubuntu" };
  const spaces = [
    space({ id: "a", env: { kind: "local" } }),
    space({ id: "b", env: ubuntu }),
    space({ id: "c", env: ubuntu }),
  ];

  it("stays when the active space already has the environment", () => {
    expect(planEnvSwitch(spaces, "c", ubuntu)).toEqual({ kind: "stay" });
    expect(planEnvSwitch(spaces, "a", { kind: "local" })).toEqual({
      kind: "stay",
    });
  });

  it("moves to the first space with the environment", () => {
    expect(planEnvSwitch(spaces, "a", ubuntu)).toEqual({
      kind: "activate",
      spaceId: "b",
    });
    expect(planEnvSwitch(spaces, "c", { kind: "local" })).toEqual({
      kind: "activate",
      spaceId: "a",
    });
  });

  it("opens a space for an environment no space has", () => {
    expect(
      planEnvSwitch(spaces, "a", { kind: "wsl", distro: "Debian" }),
    ).toEqual({ kind: "create", name: "Debian" });
    expect(planEnvSwitch(spaces.slice(1), "b", { kind: "local" })).toEqual({
      kind: "create",
      name: "Windows",
    });
  });
});
