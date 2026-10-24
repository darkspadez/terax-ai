import { expect, it } from "vitest";
import { detectTerminalLinks, parseTerminalPathLink } from "./terminalLinks";

it("finds ordinary URLs without swallowing prose punctuation", () => {
  expect(
    detectTerminalLinks(
      "See (https://example.com/a_(b)). mailto:me@example.com",
    ).map((link) => link.uri),
  ).toEqual(["https://example.com/a_(b)", "mailto:me@example.com"]);
});
it("ignores executable protocols and incomplete links", () => {
  expect(
    detectTerminalLinks("javascript:alert(1) data:text/html,x https://"),
  ).toEqual([]);
});
it("trims long mixed wrapper suffixes while preserving balanced URL delimiters", () => {
  const uri = "https://example.com/a_(b)[c]{d}";
  const [link] = detectTerminalLinks(`${uri}${")]}".repeat(10_000)}`);
  expect(link).toEqual({ start: 0, end: uri.length, uri });
  expect(detectTerminalLinks("https://[::1]/a_(b)")[0].uri).toBe(
    "https://[::1]/a_(b)",
  );
});
it("preserves Unicode and query parameters with correct text offsets", () => {
  const text = "日本 https://example.com/日本?q=one&x=2 end";
  const [link] = detectTerminalLinks(text);
  expect(text.slice(link.start, link.end)).toBe(
    "https://example.com/日本?q=one&x=2",
  );
});
it("finds file:// links but not empty ones", () => {
  expect(
    detectTerminalLinks("open file:///Users/me/notes.md and file:///").map(
      (link) => link.uri,
    ),
  ).toEqual(["file:///Users/me/notes.md"]);
});
it("finds file paths with positions, as compilers and tools print them", () => {
  const text = [
    "error: src/main.rs:42:7 mismatched types",
    "./scripts/run.sh",
    "at Object.<anonymous> (/home/me/app/index.js:10:15)",
    "src/app.ts(12,3): error TS2304",
    'File "/usr/lib/python3/x.py", line 88, in f',
    "C:\\Users\\me\\proj\\a.cs(3,9)",
    "see ~/notes/todo.txt.",
    "lib.rs:3 and main.c:10:2",
  ].join("\n");
  expect(detectTerminalLinks(text).map((link) => link.uri)).toEqual([
    "src/main.rs:42:7",
    "./scripts/run.sh",
    "/home/me/app/index.js:10:15",
    "src/app.ts(12,3)",
    "/usr/lib/python3/x.py:88",
    "C:\\Users\\me\\proj\\a.cs(3,9)",
    "~/notes/todo.txt",
    "lib.rs:3",
    "main.c:10:2",
  ]);
});
it("leaves prose, fractions, dates and URL paths alone", () => {
  expect(
    detectTerminalLinks(
      "and/or 1/2 2024/10/22 a/b https://example.com/a/b.txt N/A /",
    ).map((link) => link.uri),
  ).toEqual(["https://example.com/a/b.txt"]);
});
it("splits path links into path and position", () => {
  expect(parseTerminalPathLink("src/main.rs:42:7")).toEqual({
    path: "src/main.rs",
    line: 42,
    column: 7,
  });
  expect(parseTerminalPathLink("a.ts(12,3)")).toEqual({
    path: "a.ts",
    line: 12,
    column: 3,
  });
  expect(parseTerminalPathLink("/etc/hosts")).toEqual({
    path: "/etc/hosts",
    line: null,
    column: null,
  });
});
