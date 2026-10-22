import { describe, expect, it } from "vitest";
import {
  shouldDeferShortcutToTerminal,
  shouldDisablePaneSwapShortcut,
} from "@/modules/shortcuts/lib/shortcutScope";
import { SHORTCUTS, type ShortcutId } from "@/modules/shortcuts/shortcuts";

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
    for (const [id, key] of [
      ["commandPalette.open", "p"],
      ["pane.splitRight", "d"],
      ["tab.newPrivate", "r"],
      ["tab.close", "w"],
      ["tab.newEditor", "e"],
      ["search.focus", "f"],
      ["tab.new", "t"],
      ["pane.source", "g"],
      ["ai.toggle", "i"],
      ["pane.focusPrev", "["],
      ["pane.focusNext", "]"],
    ] as const) {
      expect(shouldDeferShortcutToTerminal(id, chord(key), terminal)).toBe(
        true,
      );
    }
    // A Cyrillic layout types "з" on the P key.
    expect(
      shouldDeferShortcutToTerminal(
        "commandPalette.open",
        chord("з", { code: "KeyP" }),
        terminal,
      ),
    ).toBe(true);
  });

  it("keeps the app's other chords, macOS and focus elsewhere", () => {
    const keep: [ShortcutId, ReturnType<typeof chord>][] = [
      ["commandPalette.content", chord("P", { shift: true })],
      ["tab.newBlock", chord("T", { shift: true })],
      ["pane.swapLeft", chord("ArrowLeft", { alt: true })],
      ["tab.next", chord("Tab")],
      ["tab.selectByIndex", chord("1")],
      ["settings.open", chord(",", { code: "Comma" })],
      ["view.zoomIn", chord("=", { code: "Equal" })],
      ["blocks.prev", chord("ArrowUp")],
    ];
    for (const [id, event] of keep) {
      expect(shouldDeferShortcutToTerminal(id, event, terminal)).toBe(false);
    }
    expect(
      shouldDeferShortcutToTerminal("tab.close", chord("w"), {
        isMac: false,
        inTerminal: false,
      }),
    ).toBe(false);
    expect(
      shouldDeferShortcutToTerminal("tab.close", chord("w"), {
        isMac: true,
        inTerminal: true,
      }),
    ).toBe(false);
    // Only fires with terminal text selected.
    expect(
      shouldDeferShortcutToTerminal("ai.askSelection", chord("j"), terminal),
    ).toBe(false);
  });

  it("leaves every default Ctrl+Shift binding to the app", () => {
    for (const shortcut of SHORTCUTS) {
      for (const binding of shortcut.defaultBindings) {
        if (!binding.shift) continue;
        expect(
          shouldDeferShortcutToTerminal(
            shortcut.id,
            {
              ctrlKey: true,
              shiftKey: true,
              altKey: binding.alt ?? false,
              metaKey: false,
              key: binding.key,
              code: "",
            },
            terminal,
          ),
        ).toBe(false);
      }
    }
  });
});
