import { describe, expect, it } from "vitest";
import {
  focusClaimsChord,
  isModChord,
  shouldDeferShortcutToTerminal,
  shouldDisablePaneSwapShortcut,
} from "@/modules/shortcuts/lib/shortcutScope";
import {
  defaultShortcuts,
  type KeyBinding,
} from "@/modules/shortcuts/shortcuts";

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

// crynta/terax-ai#603: readline and TUIs need their Ctrl keys.
describe("shouldDeferShortcutToTerminal", () => {
  const chord = (
    key: string,
    mods: { shift?: boolean; alt?: boolean; meta?: boolean; code?: string } = {},
  ) => ({
    ctrlKey: true,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    metaKey: mods.meta ?? false,
    key,
    code:
      mods.code ??
      (/^[a-z]$/i.test(key)
        ? `Key${key.toUpperCase()}`
        : ({ "[": "BracketLeft", "]": "BracketRight", "1": "Digit1" } as Record<
            string,
            string
          >)[key] ?? key),
  });
  const terminal = { isMac: false, inTerminal: true };

  it("gives a focused terminal Ctrl+<letter> and Ctrl+[ off macOS", () => {
    for (const key of ["p", "d", "r", "w", "e", "f", "t", "g", "i", "j", "["]) {
      expect(shouldDeferShortcutToTerminal(chord(key), terminal)).toBe(true);
    }
    // A Cyrillic layout types "з" on the P key.
    expect(
      shouldDeferShortcutToTerminal(chord("з", { code: "KeyP" }), terminal),
    ).toBe(true);
  });

  it("keeps the app's other chords, macOS and focus elsewhere", () => {
    for (const event of [
      chord("P", { shift: true }),
      chord("T", { shift: true, alt: true }),
      chord("ArrowLeft", { alt: true }),
      chord("Tab"),
      chord("1"),
      chord(",", { code: "Comma" }),
      chord("=", { code: "Equal" }),
      chord("ArrowUp"),
    ]) {
      expect(shouldDeferShortcutToTerminal(event, terminal)).toBe(false);
    }
    expect(
      shouldDeferShortcutToTerminal(chord("w"), {
        isMac: false,
        inTerminal: false,
      }),
    ).toBe(false);
    expect(
      shouldDeferShortcutToTerminal(chord("w"), {
        isMac: true,
        inTerminal: true,
      }),
    ).toBe(false);
  });

  // Every app shortcut works from a focused terminal through its first
  // binding; editor shortcuts only run in editor tabs.
  it.each(["windows", "linux"] as const)(
    "reaches every %s shortcut from a focused terminal by its first binding",
    (platform) => {
      const deferred = (binding: KeyBinding) =>
        shouldDeferShortcutToTerminal(
          {
            ctrlKey: binding.ctrl ?? false,
            shiftKey: binding.shift ?? false,
            altKey: binding.alt ?? false,
            metaKey: binding.meta ?? false,
            key: binding.key,
            code: "",
          },
          terminal,
        );
      for (const shortcut of defaultShortcuts(platform)) {
        if (shortcut.group === "Editor") continue;
        const [first] = shortcut.defaultBindings;
        if (first) expect(deferred(first), shortcut.id).toBe(false);
      }
    },
  );
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

  it("lets a box claim several chords", () => {
    expect(
      focusClaimsChord(chord({ ctrlKey: true, key: "p" }), "n p y", false),
    ).toBe(true);
    expect(
      focusClaimsChord(chord({ ctrlKey: true, key: "y" }), "n p y", false),
    ).toBe(true);
    expect(
      focusClaimsChord(chord({ ctrlKey: true, key: "g" }), "n p y", false),
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
