import { describe, expect, it } from "vitest";
import { defaultShortcuts, type KeyBinding } from "../shortcuts";
import {
  menuAccelerator,
  menuCarriesKey,
  menuShortcutPlan,
  parseMenuShortcut,
} from "./menuShortcuts";

const mac = defaultShortcuts("macos");

function keydown(over: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "",
    code: "",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
    ...over,
  } as KeyboardEvent;
}

describe("menuAccelerator", () => {
  it("names letters, digits and punctuation by their physical key", () => {
    expect(menuAccelerator({ meta: true, key: "t" })).toBe("Cmd+KeyT");
    expect(menuAccelerator({ meta: true, shift: true, key: "T" })).toBe(
      "Cmd+Shift+KeyT",
    );
    expect(menuAccelerator({ meta: true, key: "1" })).toBe("Cmd+Digit1");
    const punctuation: [string, string][] = [
      ["`", "Backquote"],
      ["\\", "Backslash"],
      ["[", "BracketLeft"],
      ["]", "BracketRight"],
      [",", "Comma"],
      ["=", "Equal"],
      ["-", "Minus"],
      [".", "Period"],
      ["'", "Quote"],
      [";", "Semicolon"],
      ["/", "Slash"],
      [" ", "Space"],
    ];
    for (const [key, name] of punctuation) {
      expect(menuAccelerator({ meta: true, key })).toBe(`Cmd+${name}`);
    }
  });

  it("names the keys that type nothing", () => {
    expect(menuAccelerator({ ctrl: true, key: "Tab" })).toBe("Ctrl+Tab");
    expect(menuAccelerator({ ctrl: true, shift: true, key: "Tab" })).toBe(
      "Ctrl+Shift+Tab",
    );
    expect(menuAccelerator({ meta: true, alt: true, key: "ArrowLeft" })).toBe(
      "Cmd+Alt+ArrowLeft",
    );
    expect(menuAccelerator({ meta: true, key: "Enter" })).toBe("Cmd+Enter");
    expect(menuAccelerator({ meta: true, key: "PageDown" })).toBe(
      "Cmd+PageDown",
    );
    expect(menuAccelerator({ meta: true, key: "F5" })).toBe("Cmd+F5");
    expect(menuAccelerator({ shift: true, key: "F12" })).toBe("Shift+F12");
  });

  it("writes every modifier in one order", () => {
    expect(
      menuAccelerator({
        key: "k",
        shift: true,
        alt: true,
        ctrl: true,
        meta: true,
      }),
    ).toBe("Cmd+Ctrl+Alt+Shift+KeyK");
  });

  it("leaves out keys the menu cannot name", () => {
    // Option and Shift chords keep the character they typed.
    expect(menuAccelerator({ meta: true, alt: true, key: "†" })).toBeNull();
    expect(menuAccelerator({ meta: true, shift: true, key: "{" })).toBeNull();
    expect(menuAccelerator({ meta: true, shift: true, key: "!" })).toBeNull();
    expect(menuAccelerator({ meta: true, key: "+" })).toBeNull();
    expect(menuAccelerator({ meta: true, key: "Dead" })).toBeNull();
    expect(menuAccelerator({ meta: true, key: "Unidentified" })).toBeNull();
    expect(menuAccelerator({ meta: true, key: "F21" })).toBeNull();
  });

  it("leaves out chords that would type", () => {
    expect(menuAccelerator({ key: "t" })).toBeNull();
    expect(menuAccelerator({ shift: true, key: "T" })).toBeNull();
    expect(menuAccelerator({ shift: true, key: " " })).toBeNull();
    expect(menuAccelerator({ key: "F5" })).toBeNull();
  });

  it("writes only names and plus signs", () => {
    const keys = [
      "a",
      "z",
      "0",
      "9",
      "`",
      "\\",
      "[",
      "]",
      ",",
      "=",
      "-",
      ".",
      "'",
      ";",
      "/",
      " ",
      "Tab",
      "Enter",
      "Escape",
      "Backspace",
      "Delete",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "F1",
      "F20",
    ];
    for (const key of keys) {
      expect(menuAccelerator({ ctrl: true, meta: true, key }), key).toMatch(
        /^Cmd\+Ctrl\+[A-Za-z0-9]+$/,
      );
    }
  });
});

describe("menuShortcutPlan", () => {
  it("gives the menu the macOS defaults", () => {
    expect(menuShortcutPlan({}, mac).accelerators).toEqual({
      newTab: "Cmd+KeyT",
      selectTab: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `Cmd+Digit${n}`),
      nextTab: "Ctrl+Tab",
      previousTab: "Ctrl+Shift+Tab",
      commandPalette: "Cmd+KeyP",
      toggleAi: "Cmd+KeyI",
    });
  });

  it("follows the user's own bindings", () => {
    const { accelerators } = menuShortcutPlan(
      {
        "tab.new": [{ meta: true, alt: true, key: "n" }],
        "ai.toggle": [{ ctrl: true, meta: true, key: "l" }],
        "tab.selectByIndex": [{ ctrl: true, key: "1" }],
      },
      mac,
    );
    expect(accelerators.newTab).toBe("Cmd+Alt+KeyN");
    expect(accelerators.toggleAi).toBe("Cmd+Ctrl+KeyL");
    expect(accelerators.selectTab[4]).toBe("Ctrl+Digit5");
  });

  it("leaves an item without a key when its binding has none", () => {
    const { accelerators, chords } = menuShortcutPlan(
      {
        "tab.new": [],
        "commandPalette.open": [{ meta: true, alt: true, key: "π" }],
      },
      mac,
    );
    expect(accelerators.newTab).toBeNull();
    expect(accelerators.commandPalette).toBeNull();
    expect(chords).not.toContainEqual(expect.objectContaining({ key: "π" }));
  });

  it("gives no item a chord the user gave another shortcut", () => {
    const { accelerators, chords } = menuShortcutPlan(
      {
        "view.zenMode": [{ meta: true, key: "t" }],
        "pane.zoom": [{ meta: true, key: "3" }],
      },
      mac,
    );
    expect(accelerators.newTab).toBeNull();
    expect(accelerators.selectTab[2]).toBeNull();
    expect(accelerators.selectTab[3]).toBe("Cmd+Digit4");
    expect(chords).not.toContainEqual({ meta: true, key: "t" });
  });

  it("lists exactly the chords it gives the menu", () => {
    const { chords } = menuShortcutPlan({}, mac);
    const carried = (binding: KeyBinding) =>
      chords.some(
        (c) =>
          c.key === binding.key &&
          !!c.meta === !!binding.meta &&
          !!c.ctrl === !!binding.ctrl &&
          !!c.shift === !!binding.shift &&
          !!c.alt === !!binding.alt,
      );
    expect(chords).toHaveLength(14);
    expect(carried({ meta: true, key: "t" })).toBe(true);
    expect(carried({ meta: true, key: "9" })).toBe(true);
    expect(carried({ ctrl: true, shift: true, key: "Tab" })).toBe(true);
    expect(carried({ meta: true, key: "w" })).toBe(false);
  });
});

describe("menuCarriesKey", () => {
  const { chords } = menuShortcutPlan({}, mac);

  it("marks the menu's keys handled, repeats included", () => {
    expect(menuCarriesKey(keydown({ key: "t", metaKey: true }), chords)).toBe(
      true,
    );
    expect(
      menuCarriesKey(
        keydown({ key: "t", metaKey: true, repeat: true }),
        chords,
      ),
    ).toBe(true);
    expect(menuCarriesKey(keydown({ key: "5", metaKey: true }), chords)).toBe(
      true,
    );
    expect(
      menuCarriesKey(
        keydown({ key: "Tab", ctrlKey: true, shiftKey: true }),
        chords,
      ),
    ).toBe(true);
  });

  it("leaves other keys and an input method's keys alone", () => {
    expect(
      menuCarriesKey(
        keydown({ key: "T", metaKey: true, shiftKey: true }),
        chords,
      ),
    ).toBe(false);
    expect(menuCarriesKey(keydown({ key: "t" }), chords)).toBe(false);
    expect(
      menuCarriesKey(
        keydown({ key: "t", metaKey: true, isComposing: true }),
        chords,
      ),
    ).toBe(false);
  });
});

describe("parseMenuShortcut", () => {
  it("reads the shortcut the menu chose", () => {
    expect(parseMenuShortcut({ id: "tab.new" })).toEqual({ id: "tab.new" });
    expect(parseMenuShortcut({ id: "ai.toggle" })).toEqual({
      id: "ai.toggle",
    });
    expect(parseMenuShortcut({ id: "tab.selectByIndex", tab: 9 })).toEqual({
      id: "tab.selectByIndex",
      tab: 9,
    });
  });

  it("refuses anything else", () => {
    expect(parseMenuShortcut({ id: "tab.close" })).toBeNull();
    expect(parseMenuShortcut({ id: "tab.selectByIndex", tab: 0 })).toBeNull();
    expect(parseMenuShortcut({ id: "tab.selectByIndex", tab: 10 })).toBeNull();
    expect(parseMenuShortcut({ id: "tab.selectByIndex", tab: 2.5 })).toBeNull();
    expect(parseMenuShortcut({ id: "tab.selectByIndex", tab: "3" })).toBeNull();
    expect(parseMenuShortcut({ id: "tab.selectByIndex" })).toBeNull();
    expect(parseMenuShortcut("tab.new")).toBeNull();
    expect(parseMenuShortcut(null)).toBeNull();
  });
});
