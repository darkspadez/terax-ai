import type { TerminalTab } from "@/modules/tabs/lib/useTabs";
import { describe, expect, it, vi } from "vitest";
import { planOpenFolder } from "./activeSpace";
import { type OpenFolderDeps, openFolder } from "./openFolder";
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

function term(id: number, spaceId: string, cwd: string): TerminalTab {
  return {
    id,
    kind: "terminal",
    spaceId,
    title: "shell",
    cwd,
    paneTree: { kind: "leaf", id: id * 100, cwd },
    activeLeafId: id * 100,
  };
}

describe("planOpenFolder", () => {
  const spaces = [
    space({ id: "home", root: "/home/me" }),
    space({ id: "repo", root: "/work/repo/" }),
    space({ id: "wsl", root: "/work/wsl", env: { kind: "wsl", distro: "U" } }),
  ];

  it("uses the local space rooted at the folder and its terminal there", () => {
    const tabs = [term(1, "home", "/work/repo"), term(2, "repo", "/work/repo")];
    expect(planOpenFolder(spaces, tabs, "/work/repo")).toEqual({
      space: { kind: "existing", id: "repo" },
      tabId: 2,
    });
  });

  it("asks for a terminal when that space has none in the folder", () => {
    const tabs = [term(1, "home", "/work/repo"), term(2, "repo", "/work")];
    expect(planOpenFolder(spaces, tabs, "/work/repo")).toEqual({
      space: { kind: "existing", id: "repo" },
      tabId: null,
    });
  });

  it("asks for a new local space named after the folder otherwise", () => {
    expect(planOpenFolder(spaces, [], "/work/wsl")).toEqual({
      space: { kind: "new", name: "wsl", root: "/work/wsl" },
      tabId: null,
    });
    expect(planOpenFolder(spaces, [], "C:/Users/me/My Project")).toEqual({
      space: {
        kind: "new",
        name: "My Project",
        root: "C:/Users/me/My Project",
      },
      tabId: null,
    });
  });
});

function deps(over: Partial<OpenFolderDeps> = {}) {
  const calls: string[] = [];
  const base: OpenFolderDeps = {
    pick: vi.fn(async () => "C:\\work\\repo"),
    authorize: vi.fn(async (path: string) => {
      calls.push(`authorize ${path}`);
      return "C:\\Work\\Repo";
    }),
    spaces: () => [space({ id: "home", root: "C:/Users/me" })],
    tabs: () => [term(1, "home", "C:/Users/me")],
    createSpace: vi.fn(({ name, root }) => {
      calls.push(`space ${name} ${root}`);
      return "new";
    }),
    newTerminal: vi.fn((spaceId: string, cwd: string) => {
      calls.push(`terminal ${spaceId} ${cwd}`);
      return 7;
    }),
    activate: vi.fn((spaceId: string, tabId: number) => {
      calls.push(`activate ${spaceId} ${tabId}`);
    }),
    fail: vi.fn(),
  };
  return { deps: { ...base, ...over }, calls };
}

describe("openFolder", () => {
  it("does nothing when the picker is cancelled", async () => {
    const { deps: d, calls } = deps({ pick: async () => null });
    await openFolder(d);
    expect(calls).toEqual([]);
    expect(d.fail).not.toHaveBeenCalled();
  });

  it("authorizes the folder, then opens it in a new space", async () => {
    const { deps: d, calls } = deps();
    await openFolder(d);
    expect(calls).toEqual([
      "authorize C:\\work\\repo",
      "space Repo C:/Work/Repo",
      "terminal new C:/Work/Repo",
      "activate new 7",
    ]);
  });

  it("goes to the terminal already in the folder", async () => {
    const { deps: d, calls } = deps({
      spaces: () => [space({ id: "repo", root: "c:/work/repo" })],
      tabs: () => [term(3, "repo", "C:/work/repo")],
    });
    await openFolder(d);
    expect(calls).toEqual(["authorize C:\\work\\repo", "activate repo 3"]);
  });

  it("opens nothing when the folder cannot be authorized", async () => {
    const error = new Error("No such file or directory");
    const { deps: d, calls } = deps({
      authorize: async () => {
        throw error;
      },
    });
    await openFolder(d);
    expect(calls).toEqual([]);
    expect(d.fail).toHaveBeenCalledWith(error);
  });

  it("reports a picker that fails", async () => {
    const error = new Error("dialog.open not allowed");
    const { deps: d, calls } = deps({
      pick: async () => {
        throw error;
      },
    });
    await openFolder(d);
    expect(calls).toEqual([]);
    expect(d.fail).toHaveBeenCalledWith(error);
  });
});
