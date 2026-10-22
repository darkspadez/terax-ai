import {
  EDITOR_THEME_LABELS,
  EDITOR_THEME_MODE,
  EDITOR_THEMES,
} from "@/modules/settings/store";
import { javascript } from "@codemirror/lang-javascript";
import { ensureSyntaxTree, highlightingFor } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorState } from "@codemirror/state";
import { highlightTree } from "@lezer/highlight";
import { describe, expect, it } from "vitest";
import { dracula, monokaiPro } from "./cmThemes";
import { EDITOR_THEME_EXT } from "./themes";

/** Highlight class of the token at `token`'s first occurrence in `code`. */
function classesAt(theme: Extension, code: string, token: string) {
  const state = EditorState.create({
    doc: code,
    extensions: [javascript(), theme],
  });
  const tree = ensureSyntaxTree(state, state.doc.length, 10_000);
  if (!tree) throw new Error("The parse did not finish");
  const spans: { from: number; to: number; classes: string }[] = [];
  highlightTree(
    tree,
    { style: (tags) => highlightingFor(state, tags) },
    (from, to, classes) => spans.push({ from, to, classes }),
  );
  const pos = code.indexOf(token);
  return spans.find((span) => span.from <= pos && span.to > pos)?.classes;
}

describe("Monokai Pro editor theme", () => {
  it("is registered as a dark theme with its label", () => {
    expect(EDITOR_THEMES).toContain("monokai-pro");
    expect(EDITOR_THEME_EXT["monokai-pro"]).toBe(monokaiPro);
    expect(EDITOR_THEME_MODE["monokai-pro"]).toBe("dark");
    expect(EDITOR_THEME_LABELS["monokai-pro"]).toBe("Monokai Pro");
  });

  it("dims punctuation apart from operators, which keep the keyword colour", () => {
    const code = "call(a + b);";
    const paren = classesAt(monokaiPro, code, "(");
    const plus = classesAt(monokaiPro, code, "+");
    expect(paren).toBeTruthy();
    expect(plus).toBeTruthy();
    expect(paren).not.toBe(plus);
  });

  it("leaves punctuation in the operator colour for palettes without one", () => {
    const code = "call(a + b);";
    expect(classesAt(dracula, code, "(")).toBe(classesAt(dracula, code, "+"));
  });
});
