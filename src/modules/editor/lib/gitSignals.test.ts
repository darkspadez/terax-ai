import type { Tab } from "@/modules/tabs";
import { describe, expect, it, vi } from "vitest";
import {
  editorTabsUnder,
  notifyFilesDiscarded,
  notifyHeadMoved,
  onFilesDiscarded,
  onHeadMoved,
  repoFilePath,
} from "./gitSignals";

const editor = (id: number, path: string): Tab => ({
  id,
  kind: "editor",
  spaceId: "default",
  title: path,
  path,
  dirty: true,
  preview: false,
});

describe("repoFilePath", () => {
  it("joins status paths onto the repository root", () => {
    expect(repoFilePath("/repo", "src/a.ts")).toBe("/repo/src/a.ts");
    expect(repoFilePath("/repo/", "a.ts")).toBe("/repo/a.ts");
    expect(repoFilePath("C:\\repo", "src/a.ts")).toBe("C:\\repo/src/a.ts");
    expect(repoFilePath("/", "a.ts")).toBe("/a.ts");
  });

  it("keeps absolute paths", () => {
    expect(repoFilePath("/repo", "/other/a.ts")).toBe("/other/a.ts");
    expect(repoFilePath("C:/repo", "D:\\x\\a.ts")).toBe("D:\\x\\a.ts");
  });
});

describe("editorTabsUnder", () => {
  const tabs: Tab[] = [
    editor(1, "/repo/src/a.ts"),
    editor(2, "/repo/src/ab.ts"),
    editor(3, "C:\\repo\\new\\b.ts"),
    {
      id: 4,
      kind: "markdown",
      spaceId: "default",
      title: "a",
      path: "/repo/src/a.ts",
    },
    editor(5, "/repo/src/a.ts"),
  ];

  it("matches every editor tab of a discarded file", () => {
    expect(editorTabsUnder(tabs, ["/repo/src/a.ts"])).toEqual([1, 5]);
  });

  it("matches files inside a discarded untracked directory", () => {
    expect(editorTabsUnder(tabs, ["c:/repo/new/"])).toEqual([3]);
    expect(editorTabsUnder(tabs, ["/repo/src/"])).toEqual([1, 2, 5]);
  });

  it("leaves other files alone", () => {
    expect(editorTabsUnder(tabs, ["/repo/src/a"])).toEqual([]);
    expect(editorTabsUnder(tabs, [])).toEqual([]);
  });
});

describe("notifyFilesDiscarded", () => {
  it("tells listeners the absolute paths until they unsubscribe", () => {
    const listener = vi.fn();
    const off = onFilesDiscarded(listener);
    notifyFilesDiscarded("/repo", ["src/a.ts", "new/"]);
    expect(listener).toHaveBeenCalledWith(["/repo/src/a.ts", "/repo/new/"]);
    off();
    notifyFilesDiscarded("/repo", ["src/a.ts"]);
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe("notifyHeadMoved", () => {
  it("tells change gutters until they unsubscribe", () => {
    const listener = vi.fn();
    const off = onHeadMoved(listener);
    notifyHeadMoved();
    off();
    notifyHeadMoved();
    expect(listener).toHaveBeenCalledOnce();
  });
});
