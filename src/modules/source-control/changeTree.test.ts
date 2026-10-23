import { describe, expect, it } from "vitest";
import {
  type ChangeTreeRow,
  changeFolderKey,
  changeTreeRows,
  toggleCollapsedFolder,
  treeKeyMove,
} from "./changeTree";
import { parseChangeViewMode } from "./changeViewMode";

type Entry = { key: string; path: string };

const entry = (path: string): Entry => ({ key: path, path });

function outline(rows: ChangeTreeRow<Entry>[]): string[] {
  return rows.map((row) =>
    row.kind === "folder"
      ? `${"  ".repeat(row.depth)}${row.label}/ (${row.fileCount})${row.collapsed ? " +" : ""}`
      : `${"  ".repeat(row.depth)}${row.entry.path.split(/[\\/]/).pop()}`,
  );
}

describe("changeTreeRows", () => {
  it("groups files under their folders, folders first, in the explorer's order", () => {
    const rows = changeTreeRows(
      [
        entry("README.md"),
        entry("src/b.ts"),
        entry("src/lib/util.ts"),
        entry("src/a.ts"),
        entry("docs/guide.md"),
        entry("Cargo.toml"),
      ],
      new Set(),
    );
    expect(outline(rows)).toEqual([
      "docs/ (1)",
      "  guide.md",
      "src/ (3)",
      "  lib/ (1)",
      "    util.ts",
      "  a.ts",
      "  b.ts",
      "Cargo.toml",
      "README.md",
    ]);
  });

  it("joins folders that hold nothing but the next folder", () => {
    const rows = changeTreeRows(
      [
        entry("src/modules/git/a.ts"),
        entry("src/modules/git/b.ts"),
        entry("src/modules/tabs/c.ts"),
        entry("x/y/z.txt"),
      ],
      new Set(),
    );
    expect(outline(rows)).toEqual([
      "src/modules/ (3)",
      "  git/ (2)",
      "    a.ts",
      "    b.ts",
      "  tabs/ (1)",
      "    c.ts",
      "x/y/ (1)",
      "  z.txt",
    ]);
    const joined = rows[0];
    expect(joined.kind === "folder" && joined.path).toBe("src/modules");
    expect(joined.kind === "folder" && joined.name).toBe("modules");
  });

  it("hides what is under a collapsed folder, keyed by the joined folder's path", () => {
    const entries = [
      entry("src/modules/git/a.ts"),
      entry("src/modules/tabs/c.ts"),
      entry("top.ts"),
    ];
    const rows = changeTreeRows(entries, new Set(["src/modules"]));
    expect(outline(rows)).toEqual(["src/modules/ (2) +", "top.ts"]);
    const inner = changeTreeRows(entries, new Set(["src/modules/git"]));
    expect(outline(inner)).toEqual([
      "src/modules/ (2)",
      "  git/ (1) +",
      "  tabs/ (1)",
      "    c.ts",
      "top.ts",
    ]);
  });

  it("links each row to the folder row it sits under", () => {
    const rows = changeTreeRows(
      [entry("a/b/one.ts"), entry("a/two.ts"), entry("three.ts")],
      new Set(),
    );
    const parentOf = Object.fromEntries(
      rows.map((row) => [row.key, row.parentKey]),
    );
    expect(parentOf).toEqual({
      [changeFolderKey("a")]: null,
      [changeFolderKey("a/b")]: changeFolderKey("a"),
      "a/b/one.ts": changeFolderKey("a/b"),
      "a/two.ts": changeFolderKey("a"),
      "three.ts": null,
    });
  });

  it("never gives a folder row the key of a file row", () => {
    // A file and a folder may share a name across commits (one deleted, one added).
    const rows = changeTreeRows([entry("lib"), entry("lib/x.ts")], new Set());
    const keys = rows.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("sorts numbers by value and ignores case, like the explorer", () => {
    const rows = changeTreeRows(
      [
        entry("file10.ts"),
        entry("file2.ts"),
        entry("Zeta.ts"),
        entry("alpha.ts"),
      ],
      new Set(),
    );
    expect(outline(rows)).toEqual([
      "alpha.ts",
      "file2.ts",
      "file10.ts",
      "Zeta.ts",
    ]);
  });

  it("reads backslash separators and keeps the entry itself", () => {
    const windows = { key: "k", path: "dir\\file.ts" };
    const rows = changeTreeRows([windows], new Set());
    expect(outline(rows)).toEqual(["dir/ (1)", "  file.ts"]);
    expect(rows[1].kind === "file" && rows[1].entry).toBe(windows);
  });

  it("is empty without changes", () => {
    expect(changeTreeRows([], new Set())).toEqual([]);
  });
});

describe("toggleCollapsedFolder", () => {
  it("closes an open folder and opens a closed one, without touching the input", () => {
    const open = new Set<string>();
    const closed = toggleCollapsedFolder(open, "src");
    expect([...closed]).toEqual(["src"]);
    expect(open.size).toBe(0);
    expect([...toggleCollapsedFolder(closed, "src")]).toEqual([]);
  });
});

describe("parseChangeViewMode", () => {
  it("keeps tree and falls back to today's list", () => {
    expect(parseChangeViewMode("tree")).toBe("tree");
    expect(parseChangeViewMode("list")).toBe("list");
    expect(parseChangeViewMode(undefined)).toBe("list");
    expect(parseChangeViewMode("grid")).toBe("list");
  });
});

describe("treeKeyMove", () => {
  const rows = changeTreeRows(
    [entry("src/lib/a.ts"), entry("src/b.ts"), entry("top.ts")],
    new Set(),
  );
  const [src, lib, a, b, top] = rows;

  it("opens a closed folder on Right, then moves into it", () => {
    const closed = changeTreeRows([entry("src/b.ts")], new Set(["src"]))[0];
    expect(treeKeyMove(closed, undefined, "in")).toEqual({ toggle: "src" });
    expect(treeKeyMove(src, lib, "in")).toEqual({ focus: lib.key });
    expect(treeKeyMove(lib, a, "in")).toEqual({ focus: a.key });
  });

  it("does nothing on Right for a file or an open folder with nothing under it", () => {
    expect(treeKeyMove(a, b, "in")).toBeNull();
    expect(treeKeyMove(top, undefined, "in")).toBeNull();
    // The next row belongs to another folder.
    expect(treeKeyMove(src, top, "in")).toBeNull();
  });

  it("closes an open folder on Left, then moves to the folder above", () => {
    expect(treeKeyMove(lib, a, "out")).toEqual({ toggle: "src/lib" });
    const closedLib = changeTreeRows(
      [entry("src/lib/a.ts"), entry("src/b.ts")],
      new Set(["src/lib"]),
    )[1];
    expect(treeKeyMove(closedLib, undefined, "out")).toEqual({
      focus: src.key,
    });
    expect(treeKeyMove(a, b, "out")).toEqual({ focus: lib.key });
    expect(treeKeyMove(b, top, "out")).toEqual({ focus: src.key });
  });

  it("stops at the top level", () => {
    const closedSrc = changeTreeRows([entry("src/b.ts")], new Set(["src"]))[0];
    expect(treeKeyMove(closedSrc, undefined, "out")).toBeNull();
    expect(treeKeyMove(top, undefined, "out")).toBeNull();
  });
});
