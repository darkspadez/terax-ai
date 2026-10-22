import { describe, expect, it } from "vitest";
import { MOD_PROP } from "@/lib/platform";
import {
  getBindingTokens,
  type KeyBinding,
  defaultShortcuts,
  matchBinding,
  matchShortcut,
  SHORTCUTS,
  type ShortcutId,
  type ShortcutPlatform,
} from "./shortcuts";

// These tests run in the vitest node environment, where the Tauri OS plugin is
// unavailable so `IS_MAC` resolves to false. That makes the non-mac token
// branch deterministic across host platforms.

function event(over: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "",
    code: "",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...over,
  } as KeyboardEvent;
}

describe("getBindingTokens", () => {
  it("returns nothing for an undefined binding", () => {
    expect(getBindingTokens(undefined)).toEqual([]);
  });

  it("lists modifiers in order, then the key", () => {
    const binding: KeyBinding = { key: "k", ctrl: true, shift: true };
    expect(getBindingTokens(binding)).toEqual(["Ctrl", "Shift", "K"]);
  });

  it("labels space and arrow keys", () => {
    expect(getBindingTokens({ key: " ", meta: true })).toEqual([
      "Win",
      "Space",
    ]);
    expect(getBindingTokens({ key: "ArrowUp", alt: true })).toEqual([
      "Alt",
      "↑",
    ]);
  });

  it("uppercases a single-character key", () => {
    expect(getBindingTokens({ key: "c" })).toEqual(["C"]);
  });
});

describe("matchBinding", () => {
  it("matches when key and all modifiers agree", () => {
    expect(
      matchBinding(event({ key: "c", ctrlKey: true }), {
        key: "c",
        ctrl: true,
      }),
    ).toBe(true);
  });

  it("matches the key case-insensitively", () => {
    expect(
      matchBinding(event({ key: "C", ctrlKey: true }), {
        key: "c",
        ctrl: true,
      }),
    ).toBe(true);
  });

  it("fails when a required modifier is missing", () => {
    expect(matchBinding(event({ key: "c" }), { key: "c", ctrl: true })).toBe(
      false,
    );
  });

  it("fails when an extra modifier is pressed", () => {
    expect(
      matchBinding(event({ key: "c", ctrlKey: true, shiftKey: true }), {
        key: "c",
        ctrl: true,
      }),
    ).toBe(false);
  });

  it("falls back to the physical code for alt combinations", () => {
    // Alt often rewrites e.key (here to "ç"); the binding still matches via e.code.
    expect(
      matchBinding(event({ key: "ç", code: "KeyC", altKey: true }), {
        key: "c",
        alt: true,
      }),
    ).toBe(true);
    expect(
      matchBinding(event({ key: "ç", code: "KeyD", altKey: true }), {
        key: "c",
        alt: true,
      }),
    ).toBe(false);
  });

  it("falls back to the physical code for shift combinations", () => {
    // Shift turns Period into ">"; ⌘⇧. still matches the "." binding.
    expect(
      matchBinding(
        event({ key: ">", code: "Period", shiftKey: true, metaKey: true }),
        { key: ".", shift: true, meta: true },
      ),
    ).toBe(true);
    expect(
      matchBinding(
        event({ key: ">", code: "Comma", shiftKey: true, metaKey: true }),
        { key: ".", shift: true, meta: true },
      ),
    ).toBe(false);
  });

  it("does not fall back to the physical code without alt or shift", () => {
    expect(
      matchBinding(event({ key: "ç", code: "KeyC", metaKey: true }), {
        key: "c",
        meta: true,
      }),
    ).toBe(false);
  });

  it("only accepts digit keys for the jump-to-tab shortcut", () => {
    expect(
      matchBinding(event({ key: "3" }), { key: "1" }, "tab.selectByIndex"),
    ).toBe(true);
    expect(
      matchBinding(event({ key: "x" }), { key: "1" }, "tab.selectByIndex"),
    ).toBe(false);
  });
});

describe("SHORTCUTS registry", () => {
  it("binds Mod+S to editor.save", () => {
    const save = SHORTCUTS.find((s) => s.id === "editor.save");
    expect(save).toBeDefined();
    expect(save!.defaultBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "s", [MOD_PROP]: true }),
      ]),
    );
  });
});

describe("matchShortcut", () => {
  it("finds the shortcut, preferring the user's bindings", () => {
    const palette = event({ key: "p", code: "KeyP", [`${MOD_PROP}Key`]: true });
    expect(matchShortcut(palette, {})).toBe("commandPalette.open");
    expect(
      matchShortcut(palette, {
        "commandPalette.open": [{ key: "F1" }],
      }),
    ).toBeNull();
  });

  // crynta/terax-ai#1030: a key an IME composes with is not a shortcut.
  it("ignores keys an input method is composing with", () => {
    expect(
      matchShortcut(
        event({
          key: "p",
          code: "KeyP",
          [`${MOD_PROP}Key`]: true,
          isComposing: true,
        }),
        {},
      ),
    ).toBeNull();
  });
});

/** A binding as written in docs: "Ctrl+Alt+Shift+P", "Shift+Cmd+T". */
function chordText(binding: KeyBinding): string {
  return [
    binding.ctrl && "Ctrl",
    binding.alt && "Alt",
    binding.shift && "Shift",
    binding.meta && "Cmd",
    binding.key.length === 1 ? binding.key.toUpperCase() : binding.key,
  ]
    .filter(Boolean)
    .join("+");
}

const SHIFTED: Record<string, [code: string, shifted: string]> = {
  "[": ["BracketLeft", "{"],
  "]": ["BracketRight", "}"],
  "\\": ["Backslash", "|"],
  ";": ["Semicolon", ":"],
  "'": ["Quote", '"'],
  ",": ["Comma", "<"],
  ".": ["Period", ">"],
  "/": ["Slash", "?"],
  "`": ["Backquote", "~"],
  "-": ["Minus", "_"],
  "=": ["Equal", "+"],
  "+": ["Equal", "+"],
  _: ["Minus", "_"],
  " ": ["Space", " "],
};

/** The keydown a binding's chord produces on a US layout. */
function pressed(binding: KeyBinding): KeyboardEvent {
  const { key } = binding;
  const shift = binding.shift ?? false;
  let code = key;
  let typed = key;
  if (/^[a-z]$/i.test(key)) {
    code = `Key${key.toUpperCase()}`;
    typed = shift ? key.toUpperCase() : key.toLowerCase();
  } else if (/^[0-9]$/.test(key)) {
    code = `Digit${key}`;
    typed = shift ? ")!@#$%^&*("[Number(key)] : key;
  } else if (SHIFTED[key]) {
    [code] = SHIFTED[key];
    typed = shift ? SHIFTED[key][1] : key;
  }
  return event({
    key: typed,
    code,
    ctrlKey: binding.ctrl ?? false,
    shiftKey: shift,
    altKey: binding.alt ?? false,
    metaKey: binding.meta ?? false,
  });
}

describe.each(["macos", "windows", "linux"] as const)(
  "default shortcuts on %s",
  (platform: ShortcutPlatform) => {
    const shortcuts = defaultShortcuts(platform);

    it("give every chord one action", () => {
      for (const shortcut of shortcuts) {
        for (const binding of shortcut.defaultBindings) {
          const chord = pressed(binding);
          const actions = shortcuts
            .filter((other) =>
              other.defaultBindings.some((b) => matchBinding(chord, b, other.id)),
            )
            .map((other) => other.id);
          expect(actions, chordText(binding)).toEqual([shortcut.id]);
        }
      }
    });

    it("keep ids unique", () => {
      const ids = shortcuts.map((shortcut) => shortcut.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  },
);

describe("default shortcut layout", () => {
  const layout = (platform: ShortcutPlatform) =>
    Object.fromEntries(
      defaultShortcuts(platform).map((shortcut) => [
        shortcut.id,
        shortcut.defaultBindings.map(chordText).join(", "),
      ]),
    ) as Record<ShortcutId, string>;

  // Windows and Linux: Ctrl+Shift first (it works in a focused terminal),
  // the Ctrl binding second; displaced Ctrl+Shift shortcuts take Ctrl+Alt+Shift.
  const ctrlShift: Partial<Record<ShortcutId, string>> = {
    "commandPalette.open": "Ctrl+Shift+P, Ctrl+P",
    "commandPalette.content": "Ctrl+Alt+Shift+P",
    "tab.new": "Ctrl+Shift+T, Ctrl+T",
    "tab.newBlock": "Ctrl+Alt+Shift+T",
    "tab.newPrivate": "Ctrl+Shift+R, Ctrl+R",
    "tab.newEditor": "Ctrl+Shift+E, Ctrl+E",
    "explorer.focus": "Ctrl+Alt+Shift+E",
    "tab.close": "Ctrl+Shift+W, Ctrl+W",
    "pane.splitRight": "Ctrl+Shift+D, Ctrl+D",
    "pane.splitDown": "Ctrl+Alt+Shift+D",
    "search.focus": "Ctrl+Shift+F, Ctrl+F",
    "explorer.search": "Ctrl+Alt+Shift+F",
    "ai.toggle": "Ctrl+Shift+I, Ctrl+I",
    "ai.toggleMini": "Ctrl+Alt+Shift+I",
    "ai.askSelection": "Ctrl+Shift+J, Ctrl+J",
    "pane.source": "Ctrl+Shift+G, Ctrl+G",
    "terminal.toggleInput": "Ctrl+Shift+U, Ctrl+U",
    "sidebar.toggle": "Ctrl+Shift+B, Ctrl+B",
    "pane.focusNext": "Ctrl+Shift+], Ctrl+]",
    "pane.focusPrev": "Ctrl+Shift+[, Ctrl+[",
    "space.next": "Ctrl+Alt+Shift+]",
    "space.prev": "Ctrl+Alt+Shift+[",
    "settings.open": "Ctrl+,",
    "tab.next": "Ctrl+Tab",
    "tab.selectByIndex": "Ctrl+1",
    "view.zoomIn": "Ctrl+=, Ctrl+Shift++",
    "window.new": "Ctrl+Shift+N",
    "tab.newPreview": "Ctrl+Shift+O",
    "space.overview": "Ctrl+Shift+S",
    "pane.zoom": "Ctrl+Shift+Enter",
    "pane.focusLeft": "Ctrl+Shift+ArrowLeft",
    "pane.swapLeft": "Ctrl+Alt+ArrowLeft",
  };

  it("puts Windows app shortcuts on Ctrl+Shift", () => {
    expect(layout("windows")).toMatchObject(ctrlShift);
  });

  it("does the same on Linux, leaving Ctrl+Shift+U to input methods", () => {
    expect(layout("linux")).toMatchObject({
      ...ctrlShift,
      "terminal.toggleInput": "Ctrl+Alt+Shift+U, Ctrl+U",
    });
  });

  it("keeps macOS on Cmd", () => {
    expect(layout("macos")).toMatchObject({
      "commandPalette.open": "Cmd+P",
      "commandPalette.content": "Shift+Cmd+P",
      "tab.new": "Cmd+T",
      "tab.newBlock": "Shift+Cmd+T",
      "tab.newPrivate": "Cmd+R",
      "tab.newEditor": "Cmd+E",
      "explorer.focus": "Shift+Cmd+E",
      "tab.close": "Cmd+W",
      "pane.splitRight": "Cmd+D",
      "pane.splitDown": "Shift+Cmd+D",
      "search.focus": "Cmd+F",
      "explorer.search": "Shift+Cmd+F",
      "ai.toggle": "Cmd+I",
      "ai.toggleMini": "Shift+Cmd+I",
      "ai.askSelection": "Cmd+J",
      "pane.source": "Cmd+G",
      "terminal.toggleInput": "Cmd+U",
      "sidebar.toggle": "Cmd+B, Shift+Cmd+B",
      "pane.focusNext": "Cmd+]",
      "pane.focusPrev": "Cmd+[",
      "space.next": "Shift+Cmd+]",
      "space.prev": "Shift+Cmd+[",
      "settings.open": "Cmd+,",
      "terminal.clear": "Cmd+K",
    });
  });

  // The tests run with the Linux layout (no OS plugin, so not macOS).
  it("keeps a user's own binding on a chord a default now takes", () => {
    const closeTab = pressed({ ctrl: true, shift: true, key: "w" });
    const oldExplorer = pressed({ ctrl: true, shift: true, key: "e" });
    expect(matchShortcut(closeTab, {})).toBe("tab.close");
    expect(matchShortcut(oldExplorer, {})).toBe("tab.newEditor");
    const custom = {
      "view.zenMode": [{ ctrl: true, shift: true, key: "w" }],
      "explorer.focus": [{ ctrl: true, shift: true, key: "e" }],
    };
    expect(matchShortcut(closeTab, custom)).toBe("view.zenMode");
    expect(matchShortcut(oldExplorer, custom)).toBe("explorer.focus");
  });
});

describe("matchBinding with AltGr", () => {
  // Windows reports AltGr as Ctrl+Alt; AltGr+Shift+E types "Ę" in Polish.
  it("leaves AltGr characters to typing", () => {
    const binding: KeyBinding = { ctrl: true, alt: true, shift: true, key: "e" };
    const chord = (altGraph: boolean, key: string) =>
      ({
        ...event({
          key,
          code: "KeyE",
          ctrlKey: true,
          altKey: true,
          shiftKey: true,
        }),
        getModifierState: (modifier: string) =>
          altGraph && modifier === "AltGraph",
      }) as KeyboardEvent;
    expect(matchBinding(chord(true, "Ę"), binding)).toBe(false);
    expect(matchBinding(chord(false, "E"), binding)).toBe(true);
  });
});
