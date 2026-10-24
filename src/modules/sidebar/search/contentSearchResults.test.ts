import { describe, expect, it } from "vitest";
import type { ContentHit } from "@/modules/command-palette/hooks/useContentSearch";
import {
  contentSearchRows,
  groupContentHits,
  matchRanges,
  previewSegments,
} from "./contentSearchResults";

const hit = (rel: string, line: number, text = "x"): ContentHit => ({
  path: `/repo/${rel}`,
  rel,
  line,
  text,
});

describe("groupContentHits", () => {
  it("groups interleaved hits by file, files in the explorer's order and lines in order", () => {
    const groups = groupContentHits([
      hit("src/b.ts", 9),
      hit("src/file10.ts", 1),
      hit("README.md", 3),
      hit("src/b.ts", 2),
      hit("src/file2.ts", 4),
      hit("src/B2.ts", 1),
    ]);
    expect(groups.map((g) => [g.rel, g.hits.map((h) => h.line)])).toEqual([
      ["README.md", [3]],
      ["src/b.ts", [2, 9]],
      ["src/B2.ts", [1]],
      ["src/file2.ts", [4]],
      ["src/file10.ts", [1]],
    ]);
  });

  it("is empty without hits", () => {
    expect(groupContentHits([])).toEqual([]);
  });
});

describe("contentSearchRows", () => {
  const groups = groupContentHits([
    hit("a.ts", 1),
    hit("a.ts", 5),
    hit("b.ts", 2),
  ]);

  it("lists each file followed by its hits", () => {
    const rows = contentSearchRows(groups, new Set());
    expect(rows.map((r) => r.key)).toEqual([
      "file:/repo/a.ts",
      "hit:/repo/a.ts:1",
      "hit:/repo/a.ts:5",
      "file:/repo/b.ts",
      "hit:/repo/b.ts:2",
    ]);
    const second = rows[2];
    expect(second.kind === "hit" && second.fileKey).toBe("file:/repo/a.ts");
  });

  it("hides the hits of a collapsed file", () => {
    const rows = contentSearchRows(groups, new Set(["/repo/a.ts"]));
    expect(rows.map((r) => r.key)).toEqual([
      "file:/repo/a.ts",
      "file:/repo/b.ts",
      "hit:/repo/b.ts:2",
    ]);
    expect(rows[0].kind === "file" && rows[0].collapsed).toBe(true);
  });
});

describe("matchRanges", () => {
  it("finds every occurrence, ignoring case for a lower-case query", () => {
    expect(matchRanges("Foo foo FOO", "foo")).toEqual([
      [0, 3],
      [4, 7],
      [8, 11],
    ]);
  });

  it("respects case once the query has an upper-case letter", () => {
    expect(matchRanges("Foo foo FOO", "Foo")).toEqual([[0, 3]]);
  });

  it("matches regular expression characters literally", () => {
    expect(matchRanges("a.b axb (x)", "a.b")).toEqual([[0, 3]]);
    expect(matchRanges("call(x) call", "(x)")).toEqual([[4, 7]]);
  });

  it("is empty for an empty query or no occurrence", () => {
    expect(matchRanges("abc", "")).toEqual([]);
    expect(matchRanges("abc", "z")).toEqual([]);
  });
});

describe("previewSegments", () => {
  it("drops the indentation and marks each match", () => {
    expect(previewSegments("    const foo = foo();", "foo")).toEqual([
      { text: "const ", match: false },
      { text: "foo", match: true },
      { text: " = ", match: false },
      { text: "foo", match: true },
      { text: "();", match: false },
    ]);
  });

  it("cuts a long line around its first match", () => {
    const text = `${"a".repeat(100)}needle${"b".repeat(100)}`;
    const segments = previewSegments(text, "needle", 50);
    expect(segments[0]).toEqual({ text: "…", match: false });
    expect(segments[1].text).toBe("a".repeat(32));
    expect(segments[2]).toEqual({ text: "needle", match: true });
    expect(segments[segments.length - 1]).toEqual({ text: "…", match: false });
    const shown = segments
      .slice(1, -1)
      .map((s) => s.text)
      .join("");
    expect(shown).toHaveLength(50);
  });

  it("cuts a match that runs past the end of the preview", () => {
    const segments = previewSegments("xx needle", "needle", 6);
    expect(segments).toEqual([
      { text: "xx ", match: false },
      { text: "nee", match: true },
      { text: "…", match: false },
    ]);
  });

  it("shows a line without a visible match as plain text", () => {
    expect(previewSegments("  plain", "zzz")).toEqual([
      { text: "plain", match: false },
    ]);
  });
});
