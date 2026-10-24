import { describe, expect, it, vi } from "vitest";
import {
  type DroppedPath,
  folderReference,
  insertIntoPrompt,
  planComposerDrop,
  withComposerDrop,
} from "./composerDrop";

function harness(composerUnder: (x: number, y: number) => boolean) {
  const terminal = {
    updateTarget: vi.fn(() => true),
    dropPath: vi.fn(() => true),
    clearTarget: vi.fn(),
  };
  const over: boolean[] = [];
  const delivered: DroppedPath[][] = [];
  const target = withComposerDrop(terminal, {
    composerAt: composerUnder,
    setOver: (value) => over.push(value),
    deliver: (entries) => delivered.push(entries),
  });
  return { terminal, target, over, delivered };
}

const isDir = (path: string) =>
  path === "/repo/src" ? true : path === "/repo/a.ts" ? false : undefined;

// crynta/terax-ai#230, #229, #492: explorer items dropped on the AI composer.
describe("the explorer's drop target", () => {
  it("highlights the composer under a drag and keeps terminals out of it", () => {
    const { terminal, target, over } = harness(() => true);
    expect(target.updateTarget(10, 10)).toBe(true);
    expect(over).toEqual([true]);
    expect(terminal.updateTarget).not.toHaveBeenCalled();
    expect(terminal.clearTarget).toHaveBeenCalledOnce();
  });

  it("hands a drop on the composer its paths, each marked file or folder", () => {
    const { terminal, target, over, delivered } = harness(() => true);
    expect(
      target.dropPath(["/repo/a.ts", "/repo/src", "/x"], 1, 2, isDir),
    ).toBe(true);
    expect(delivered).toEqual([
      [
        { path: "/repo/a.ts", isDir: false },
        { path: "/repo/src", isDir: true },
        // Unknown to the explorer: taken for a file, which reading checks.
        { path: "/x", isDir: false },
      ],
    ]);
    expect(over).toEqual([false]);
    expect(terminal.dropPath).not.toHaveBeenCalled();
  });

  it("leaves every other drop to the terminals, as before", () => {
    const { terminal, target, over, delivered } = harness(() => false);
    expect(target.updateTarget(10, 10)).toBe(true);
    expect(terminal.updateTarget).toHaveBeenCalledWith(10, 10);
    expect(target.dropPath(["/repo/a.ts"], 1, 2, isDir)).toBe(true);
    expect(terminal.dropPath).toHaveBeenCalledWith(["/repo/a.ts"], 1, 2, isDir);
    expect(delivered).toEqual([]);
    expect(over).toEqual([false, false]);
  });

  it("follows a drag from the composer to a terminal", () => {
    let onComposer = true;
    const { terminal, target, over } = harness(() => onComposer);
    target.updateTarget(10, 10);
    onComposer = false;
    target.updateTarget(10, 300);
    expect(over).toEqual([true, false]);
    expect(terminal.updateTarget).toHaveBeenCalledWith(10, 300);
    target.clearTarget();
    expect(over).toEqual([true, false, false]);
    expect(terminal.clearTarget).toHaveBeenCalledTimes(2);
  });
});

describe("planComposerDrop", () => {
  it("attaches files and names folders, each once", () => {
    expect(
      planComposerDrop([
        { path: "/repo/a.ts", isDir: false },
        { path: "/repo/src", isDir: true },
        { path: "/repo/a.ts", isDir: false },
        { path: "", isDir: false },
        { path: "/repo/b.md", isDir: false },
      ]),
    ).toEqual({ files: ["/repo/a.ts", "/repo/b.md"], folders: ["/repo/src"] });
  });
});

describe("folderReference", () => {
  it("names a folder as inline code, never its contents", () => {
    expect(folderReference("/repo/src")).toBe("`/repo/src`");
    expect(folderReference("C:/Users/me/My Project")).toBe(
      "`C:/Users/me/My Project`",
    );
  });

  it("fences a path that holds a backtick", () => {
    expect(folderReference("/repo/odd`name")).toBe("`` /repo/odd`name ``");
  });
});

describe("insertIntoPrompt", () => {
  it("appends at the end, a space apart, when there is no caret", () => {
    expect(insertIntoPrompt("", null, "`/a`")).toEqual({
      value: "`/a` ",
      caret: 5,
    });
    expect(insertIntoPrompt("look at", null, "`/a`")).toEqual({
      value: "look at `/a` ",
      caret: 13,
    });
    expect(insertIntoPrompt("look at ", null, "`/a`")).toEqual({
      value: "look at `/a` ",
      caret: 13,
    });
  });

  it("replaces the selection and keeps the words around it apart", () => {
    expect(
      insertIntoPrompt("fix XX please", { start: 4, end: 6 }, "`/a`"),
    ).toEqual({ value: "fix `/a` please", caret: 8 });
    expect(insertIntoPrompt("fixplease", { start: 3, end: 3 }, "`/a`")).toEqual(
      {
        value: "fix `/a` please",
        caret: 9,
      },
    );
  });

  it("clamps a stale selection to the text", () => {
    expect(insertIntoPrompt("ab", { start: 9, end: 4 }, "`/a`")).toEqual({
      value: "ab `/a` ",
      caret: 8,
    });
  });
});
