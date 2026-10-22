import { describe, expect, it } from "vitest";
import {
  defaultTerminalBehavior,
  normalizeTerminalBehavior,
} from "./terminalBehavior";

describe("terminal behaviour preferences", () => {
  it("defaults to Ghostty's behaviour, with the primary selection on Linux", () => {
    expect(defaultTerminalBehavior("linux").copyOnSelect).toBe("primary");
    expect(defaultTerminalBehavior("macos")).toEqual({
      optionAsAlt: "off",
      copyOnSelect: "off",
      smartCopyPaste: true,
      pasteProtection: true,
      clipboardRead: "ask",
      desktopNotifications: true,
      notifyOnCommandFinish: "unfocused",
      notifyAfterSeconds: 10,
      bellSound: false,
      scrollMultiplier: 3,
      restoreScrollback: true,
      quickTerminalHotkey: "off",
      quickTerminalAutohide: true,
    });
  });

  it("fills missing and invalid fields from the defaults", () => {
    const defaults = defaultTerminalBehavior("windows");
    expect(normalizeTerminalBehavior(undefined, defaults)).toEqual(defaults);
    expect(normalizeTerminalBehavior("nonsense", defaults)).toEqual(defaults);
    expect(
      normalizeTerminalBehavior(
        {
          optionAsAlt: "left",
          copyOnSelect: "everywhere",
          pasteProtection: "yes",
          smartCopyPaste: false,
          clipboardRead: "allow",
          notifyAfterSeconds: 0,
          scrollMultiplier: 99.6,
          restoreScrollback: "no",
          extra: true,
        },
        defaults,
      ),
    ).toEqual({
      ...defaults,
      optionAsAlt: "left",
      smartCopyPaste: false,
      clipboardRead: "allow",
      notifyAfterSeconds: 1,
      scrollMultiplier: 20,
    });
  });

  // The hotkey goes to the system as is, so only offered values survive.
  it("keeps only offered quick terminal hotkeys", () => {
    const defaults = defaultTerminalBehavior("macos");
    const normalize = (quickTerminalHotkey: unknown) =>
      normalizeTerminalBehavior({ quickTerminalHotkey }, defaults)
        .quickTerminalHotkey;
    expect(normalize("Alt+Space")).toBe("Alt+Space");
    expect(normalize("CommandOrControl+`")).toBe("CommandOrControl+`");
    expect(normalize("Control+Alt+Delete")).toBe("off");
    expect(normalize(42)).toBe("off");
    expect(
      normalizeTerminalBehavior({ quickTerminalAutohide: false }, defaults)
        .quickTerminalAutohide,
    ).toBe(false);
  });

  it("restores scrollback unless it was turned off", () => {
    const defaults = defaultTerminalBehavior("linux");
    expect(defaults.restoreScrollback).toBe(true);
    expect(
      normalizeTerminalBehavior({ restoreScrollback: false }, defaults)
        .restoreScrollback,
    ).toBe(false);
    expect(
      normalizeTerminalBehavior({ restoreScrollback: 0 }, defaults)
        .restoreScrollback,
    ).toBe(true);
  });
});
