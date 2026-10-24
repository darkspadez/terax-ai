import { describe, expect, it } from "vitest";
import type { Tab } from "./useTabs";
import {
  type SpaceCwdInput,
  spaceExplorerRoot,
  spaceNewTabCwd,
} from "./useWorkspaceCwd";

function term(id: number, spaceId: string, cwd?: string): Tab {
  return {
    id,
    kind: "terminal",
    spaceId,
    title: "shell",
    cwd,
    paneTree: { kind: "leaf", id: id * 10, cwd },
    activeLeafId: id * 10,
  };
}

function editor(id: number, spaceId: string, path: string): Tab {
  return {
    id,
    kind: "editor",
    spaceId,
    title: "x.ts",
    path,
    dirty: false,
    preview: false,
  } as Tab;
}

function input(over: Partial<SpaceCwdInput>): SpaceCwdInput {
  return {
    activeTab: undefined,
    tabs: [],
    lastTerminalCwd: undefined,
    spaceRoot: null,
    home: "/home/me",
    ...over,
  };
}

// crynta/terax-ai#1159: after switching to a space whose active tab is an
// editor, the explorer and new terminals kept the previous space's folder.
describe("space working directory", () => {
  it("follows the active terminal of the space", () => {
    const active = term(1, "b", "/work/b/src");
    const state = input({ activeTab: active, tabs: [active] });
    expect(spaceExplorerRoot(state)).toBe("/work/b/src");
    expect(spaceNewTabCwd(state)).toBe("/work/b/src");
  });

  it("uses the space's last terminal while an editor is active", () => {
    const tabs = [term(1, "b", "/work/b"), editor(2, "b", "/work/b/x.ts")];
    const state = input({
      activeTab: tabs[1],
      tabs,
      lastTerminalCwd: "/work/b/lib",
      spaceRoot: "/work/b",
    });
    expect(spaceExplorerRoot(state)).toBe("/work/b/lib");
    expect(spaceNewTabCwd(state)).toBe("/work/b/lib");
  });

  it("falls back to the space's own terminals, then its root", () => {
    const tabs = [editor(2, "b", "/work/b/x.ts"), term(3, "b", "/work/b")];
    expect(spaceExplorerRoot(input({ activeTab: tabs[0], tabs }))).toBe(
      "/work/b",
    );
    const editorOnly = [editor(2, "b", "/work/b/x.ts")];
    const state = input({
      activeTab: editorOnly[0],
      tabs: editorOnly,
      spaceRoot: "/work/b",
    });
    expect(spaceExplorerRoot(state)).toBe("/work/b");
    expect(spaceNewTabCwd(state)).toBe("/work/b");
  });

  it("ignores an active tab of another space", () => {
    // Mid-switch the window's active tab can still be the old space's.
    const state = input({
      activeTab: term(1, "a", "/work/a"),
      tabs: [term(3, "b", "/work/b")],
    });
    expect(spaceExplorerRoot(state)).toBe("/work/b");
  });
});
