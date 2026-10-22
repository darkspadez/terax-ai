import { describe, expect, it } from "vitest";
import {
  focusClaimsChord,
  isModChord,
  shouldDisablePaneSwapShortcut,
} from "@/modules/shortcuts/lib/shortcutScope";

describe("shouldDisablePaneSwapShortcut", () => {
  it.each([
    "pane.swapLeft",
    "pane.swapRight",
    "pane.swapUp",
    "pane.swapDown",
  ] as const)("disables %s outside multi-pane terminals", (id) => {
    expect(shouldDisablePaneSwapShortcut(id, null)).toBe(true);
    expect(shouldDisablePaneSwapShortcut(id, 1)).toBe(true);
    expect(shouldDisablePaneSwapShortcut(id, 2)).toBe(false);
  });

  it("rejects unrelated shortcuts", () => {
    expect(shouldDisablePaneSwapShortcut("pane.focusNext", null)).toBe(false);
    expect(shouldDisablePaneSwapShortcut("editor.undo", 1)).toBe(false);
  });
});

describe("focusClaimsChord", () => {
  const chord = (over: Partial<Parameters<typeof isModChord>[0]>) => ({
    key: "g",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  });

  it("lets the focused box keep exactly its own chord", () => {
    expect(focusClaimsChord(chord({ metaKey: true }), "g", true)).toBe(true);
    expect(focusClaimsChord(chord({ ctrlKey: true }), "g", false)).toBe(true);
    expect(
      focusClaimsChord(chord({ ctrlKey: true, key: "G" }), "g", false),
    ).toBe(true);
  });

  it("matches only the platform modifier with no others", () => {
    expect(isModChord(chord({ metaKey: true }), "g", true)).toBe(true);
    expect(isModChord(chord({ ctrlKey: true }), "g", true)).toBe(false);
    expect(isModChord(chord({ ctrlKey: true, altKey: true }), "g", false)).toBe(
      false,
    );
    expect(
      isModChord(chord({ ctrlKey: true, metaKey: true }), "g", false),
    ).toBe(false);
  });

  it("leaves other chords and unclaimed focus to the global shortcut", () => {
    expect(focusClaimsChord(chord({ ctrlKey: true }), null, false)).toBe(false);
    expect(
      focusClaimsChord(chord({ ctrlKey: true, shiftKey: true }), "g", false),
    ).toBe(false);
    expect(focusClaimsChord(chord({ ctrlKey: true }), "g", true)).toBe(false);
    expect(
      focusClaimsChord(chord({ metaKey: true, key: "k" }), "g", true),
    ).toBe(false);
  });
});
