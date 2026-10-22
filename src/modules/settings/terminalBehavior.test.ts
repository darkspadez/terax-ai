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
      pasteProtection: true,
      clipboardRead: "ask",
      desktopNotifications: true,
      notifyOnCommandFinish: "unfocused",
      notifyAfterSeconds: 10,
      bellSound: false,
      scrollMultiplier: 3,
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
          clipboardRead: "allow",
          notifyAfterSeconds: 0,
          scrollMultiplier: 99.6,
          extra: true,
        },
        defaults,
      ),
    ).toEqual({
      ...defaults,
      optionAsAlt: "left",
      clipboardRead: "allow",
      notifyAfterSeconds: 1,
      scrollMultiplier: 20,
    });
  });
});
