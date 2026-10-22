import { describe, expect, it } from "vitest";
import { labelFor, paneLabels } from "./tabLabel";
import type { TerminalTab } from "./useTabs";

function terminalTab(over: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 1,
    kind: "terminal",
    spaceId: "default",
    title: "shell",
    paneTree: { kind: "leaf", id: 2 },
    activeLeafId: 2,
    ...over,
  };
}

describe("labelFor (terminal tabs)", () => {
  it("derives the label from the last cwd segment", () => {
    expect(labelFor(terminalTab({ cwd: "/Users/me/projects/terax-ai" }))).toBe(
      "terax-ai",
    );
  });

  it("falls back to the title when there is no cwd", () => {
    expect(labelFor(terminalTab({ title: "private" }))).toBe("private");
  });

  it("prefers a custom title over the cwd-derived name", () => {
    expect(
      labelFor(terminalTab({ cwd: "/Users/me/projects/terax-ai", customTitle: "Server" })),
    ).toBe("Server");
  });

  it("keeps the custom title after the cwd changes (survives cd)", () => {
    const renamed = terminalTab({ cwd: "/Users/me/a", customTitle: "Server" });
    const afterCd = { ...renamed, cwd: "/Users/me/b/c" };
    expect(labelFor(afterCd)).toBe("Server");
  });

  it("handles Windows-style cwd separators", () => {
    expect(labelFor(terminalTab({ cwd: "C:\\Users\\me\\proj" }))).toBe("proj");
  });
});

describe("paneLabels", () => {
  const split = terminalTab({
    cwd: "/code/web",
    paneTree: {
      kind: "split",
      id: 5,
      dir: "row",
      children: [
        { kind: "leaf", id: 2, cwd: "/code/web" },
        { kind: "leaf", id: 3, cwd: "C:\\code\\api" },
        { kind: "leaf", id: 4 },
      ],
    },
    activeLeafId: 3,
  });

  it("names every pane in tree order and marks the active one", () => {
    expect(paneLabels(split)).toEqual([
      { leafId: 2, name: "web", active: false },
      { leafId: 3, name: "api", active: true },
      { leafId: 4, name: "shell", active: false },
    ]);
  });

  it("prefers the title the pane's program set", () => {
    const names = paneLabels(split, (leafId) => (leafId === 2 ? "vim" : null));
    expect(names.map((pane) => pane.name)).toEqual(["vim", "api", "shell"]);
  });
});
