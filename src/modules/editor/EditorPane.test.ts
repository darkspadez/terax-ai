import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Source-level regression test (no DOM here to mount CodeMirror). React
 * flushes this pane's effects for a newly ready document before
 * @uiw/react-codemirror creates its view, so work that needs the view on
 * first load must also run from `onCreateEditor`; otherwise go-to-line on
 * a newly opened file and per-file indent detection silently do nothing.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "EditorPane.tsx"), "utf8");
const mount = src.match(/<MountedCodeMirror[\s\S]*?\/>/)?.[0] ?? "";
const onCreate =
  src.match(/const handleCreateEditor = [\s\S]*?\n {4}};/)?.[0] ?? "";

describe("EditorPane first-load wiring", () => {
  it("hands the created view to the pane", () => {
    expect(mount).toMatch(/onCreateEditor=\{handleCreateEditor\}/);
  });

  it("applies the indent unit and pending navigation to the new view", () => {
    expect(onCreate).toMatch(/applyIndent\(view/);
    expect(onCreate).toMatch(/applyPendingGoto\(view\)/);
    expect(onCreate).toMatch(/applyPendingFocus\(view\)/);
  });
});
