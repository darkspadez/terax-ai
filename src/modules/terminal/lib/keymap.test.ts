import { describe, expect, it } from "vitest";

import {
  isInputMethodKeyDown,
  terminalClipboardAction,
  terminalDeleteSequence,
  terminalLineNavigationSequence,
  terminalReadlineSequence,
  terminalWordNavigationSequence,
  type TerminalKeyEvent,
} from "./keymap";

const evt = (partial: Partial<TerminalKeyEvent>): TerminalKeyEvent => ({
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  key: "",
  code: "",
  ...partial,
});

describe("terminalWordNavigationSequence", () => {
  it("maps Option+Left to readline word-left", () => {
    expect(
      terminalWordNavigationSequence(
        evt({ altKey: true, key: "ArrowLeft", code: "ArrowLeft" }),
      ),
    ).toBe("\x1bb");
  });

  it("maps Option+Right to readline word-right", () => {
    expect(
      terminalWordNavigationSequence(
        evt({ altKey: true, key: "ArrowRight", code: "ArrowRight" }),
      ),
    ).toBe("\x1bf");
  });

  it("does not remap plain arrows", () => {
    expect(
      terminalWordNavigationSequence(
        evt({ key: "ArrowLeft", code: "ArrowLeft" }),
      ),
    ).toBeNull();
  });
});

describe("terminalLineNavigationSequence", () => {
  it("maps Cmd+Left to readline line-start on macOS", () => {
    expect(
      terminalLineNavigationSequence(
        evt({ metaKey: true, key: "ArrowLeft", code: "ArrowLeft" }),
        { isMac: true },
      ),
    ).toBe("\x01");
  });

  it("maps Cmd+Right to readline line-end on macOS", () => {
    expect(
      terminalLineNavigationSequence(
        evt({ metaKey: true, key: "ArrowRight", code: "ArrowRight" }),
        { isMac: true },
      ),
    ).toBe("\x05");
  });

  it("does not remap Cmd+Arrow off macOS", () => {
    expect(
      terminalLineNavigationSequence(
        evt({ metaKey: true, key: "ArrowLeft", code: "ArrowLeft" }),
        { isMac: false },
      ),
    ).toBeNull();
  });

  it("does not remap Cmd+Option+Arrow (selection-style combos pass through)", () => {
    expect(
      terminalLineNavigationSequence(
        evt({ metaKey: true, altKey: true, key: "ArrowLeft", code: "ArrowLeft" }),
        { isMac: true },
      ),
    ).toBeNull();
  });
});

describe("terminalDeleteSequence", () => {
  it("maps Cmd+Backspace to kill-to-line-start on macOS", () => {
    expect(
      terminalDeleteSequence(
        evt({ metaKey: true, key: "Backspace", code: "Backspace" }),
        { isMac: true },
      ),
    ).toBe("\x15");
  });

  it("maps Option+Backspace to kill-word-backward on macOS", () => {
    expect(
      terminalDeleteSequence(
        evt({ altKey: true, key: "Backspace", code: "Backspace" }),
        { isMac: true },
      ),
    ).toBe("\x17");
  });

  it("maps Ctrl+Backspace to kill-word-backward off macOS", () => {
    expect(
      terminalDeleteSequence(
        evt({ ctrlKey: true, key: "Backspace", code: "Backspace" }),
        { isMac: false },
      ),
    ).toBe("\x17");
  });

  it("does not remap Ctrl+Backspace on macOS (reserved for native readline binding)", () => {
    expect(
      terminalDeleteSequence(
        evt({ ctrlKey: true, key: "Backspace", code: "Backspace" }),
        { isMac: true },
      ),
    ).toBeNull();
  });

  it("does not remap Cmd+Backspace off macOS", () => {
    expect(
      terminalDeleteSequence(
        evt({ metaKey: true, key: "Backspace", code: "Backspace" }),
        { isMac: false },
      ),
    ).toBeNull();
  });

  it("does not remap plain Backspace", () => {
    expect(
      terminalDeleteSequence(
        evt({ key: "Backspace", code: "Backspace" }),
        { isMac: true },
      ),
    ).toBeNull();
  });
});

describe("terminalReadlineSequence", () => {
  const remaps = [
    [
      "line navigation",
      evt({ metaKey: true, key: "ArrowLeft", code: "ArrowLeft" }),
      "\x01",
    ],
    [
      "word navigation",
      evt({ altKey: true, key: "ArrowRight", code: "ArrowRight" }),
      "\x1bf",
    ],
    [
      "deletion",
      evt({ metaKey: true, key: "Backspace", code: "Backspace" }),
      "\x15",
    ],
  ] as const;

  it.each(remaps)(
    "applies %s on the normal screen",
    (_name, event, sequence) => {
      expect(
        terminalReadlineSequence(event, {
          isMac: true,
          isAlternateScreen: false,
        }),
      ).toBe(sequence);
    },
  );

  it.each(remaps)("suppresses %s on the alternate screen", (_name, event) => {
    expect(
      terminalReadlineSequence(event, {
        isMac: true,
        isAlternateScreen: true,
      }),
    ).toBeNull();
  });
});

describe("terminalClipboardAction", () => {
  const key = (
    chord: string,
    partial: Partial<TerminalKeyEvent & { shiftKey: boolean }> = {},
  ) => {
    const parts = chord.split("+");
    const name = parts.pop() ?? "";
    return {
      ...evt({
        ctrlKey: parts.includes("Ctrl"),
        altKey: parts.includes("Alt"),
        metaKey: parts.includes("Cmd"),
        key: name.length === 1 ? name.toLowerCase() : name,
        code: name.length === 1 ? `Key${name.toUpperCase()}` : name,
      }),
      shiftKey: parts.includes("Shift"),
      ...partial,
    };
  };
  const actions = (
    platform: "linux" | "macos" | "windows",
    smartCopyPaste = true,
  ) =>
    Object.fromEntries(
      [
        "Ctrl+C",
        "Ctrl+V",
        "Ctrl+Shift+C",
        "Ctrl+Shift+V",
        "Ctrl+Insert",
        "Shift+Insert",
        "Cmd+C",
        "Cmd+V",
        "Ctrl+Alt+V",
        "Ctrl+Shift+Insert",
        "Ctrl+X",
      ].map((chord) => [
        chord,
        terminalClipboardAction(key(chord), { platform, smartCopyPaste }),
      ]),
    );

  it("follows Windows Terminal on Windows", () => {
    expect(actions("windows")).toEqual({
      "Ctrl+C": "copyAndClear",
      "Ctrl+V": "pasteText",
      "Ctrl+Shift+C": "copy",
      "Ctrl+Shift+V": "paste",
      "Ctrl+Insert": "copy",
      "Shift+Insert": "paste",
      "Cmd+C": null,
      "Cmd+V": null,
      "Ctrl+Alt+V": null,
      "Ctrl+Shift+Insert": null,
      "Ctrl+X": null,
    });
  });

  it("leaves plain Ctrl+C and Ctrl+V to the program when smart keys are off", () => {
    expect(actions("windows", false)).toMatchObject({
      "Ctrl+C": null,
      "Ctrl+V": null,
      "Ctrl+Shift+C": "copy",
      "Ctrl+Shift+V": "paste",
      "Ctrl+Insert": "copy",
      "Shift+Insert": "paste",
    });
  });

  it("keeps Ctrl+Shift+C and Ctrl+Shift+V on Linux, whatever the setting", () => {
    for (const smart of [true, false]) {
      expect(actions("linux", smart)).toEqual({
        ...actions("windows", false),
      });
    }
  });

  it("uses Cmd on macOS and leaves Control to the program", () => {
    expect(actions("macos")).toEqual({
      "Ctrl+C": null,
      "Ctrl+V": null,
      "Ctrl+Shift+C": null,
      "Ctrl+Shift+V": null,
      "Ctrl+Insert": null,
      "Shift+Insert": null,
      "Cmd+C": "copy",
      "Cmd+V": "paste",
      "Ctrl+Alt+V": null,
      "Ctrl+Shift+Insert": null,
      "Ctrl+X": null,
    });
  });

  it("finds C and V by the letter typed, by position for other scripts", () => {
    const opts = { platform: "windows", smartCopyPaste: true } as const;
    // Cyrillic: the C key types "с".
    expect(
      terminalClipboardAction(key("Ctrl+C", { key: "с" }), opts),
    ).toBe("copyAndClear");
    // Dvorak: the key typing "c" sits at QWERTY's I, and QWERTY's C types "j".
    expect(
      terminalClipboardAction(key("Ctrl+C", { code: "KeyI" }), opts),
    ).toBe("copyAndClear");
    expect(
      terminalClipboardAction(key("Ctrl+J", { code: "KeyC" }), opts),
    ).toBeNull();
  });
});

// crynta/terax-ai#1009: WKWebView stamps 229 on Option+Arrow/Backspace.
describe("isInputMethodKeyDown", () => {
  const key = (key: string, keyCode: number, isComposing = false) => ({
    key,
    keyCode,
    isComposing,
  });

  it("leaves navigation and deletion keys stamped 229 to the terminal", () => {
    for (const name of [
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Backspace",
      "Delete",
      "Home",
      "End",
      "PageUp",
      "PageDown",
    ]) {
      expect(isInputMethodKeyDown(key(name, 229), false)).toBe(false);
    }
    expect(isInputMethodKeyDown(key("a", 65), false)).toBe(false);
  });

  it("leaves character keys stamped 229, dead keys and compositions to the IME", () => {
    expect(isInputMethodKeyDown(key("a", 229), false)).toBe(true);
    expect(isInputMethodKeyDown(key("Dead", 222), false)).toBe(true);
    expect(isInputMethodKeyDown(key("Process", 229), false)).toBe(true);
    // Candidate navigation and preedit editing during a composition.
    expect(isInputMethodKeyDown(key("ArrowDown", 229, true), false)).toBe(true);
    expect(isInputMethodKeyDown(key("Backspace", 8), true)).toBe(true);
  });
});
