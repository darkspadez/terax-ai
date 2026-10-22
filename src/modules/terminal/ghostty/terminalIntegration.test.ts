import { describe, expect, it } from "vitest";
import {
  clipboardReadReply,
  colorSchemeFor,
  commandFinishedMessage,
  kittyClipboardAnswer,
  kittyClipboardPolicy,
  pointerCursor,
  promptProgramName,
  shouldNotifyCommandFinished,
} from "./terminalIntegration";

describe("terminal integration", () => {
  it("answers OSC 52 reads with base64 UTF-8 and the request's terminator", () => {
    expect(clipboardReadReply("c", "héllo", "bel")).toBe(
      "\x1b]52;c;aMOpbGxv\x07",
    );
    expect(clipboardReadReply("p", "", "st")).toBe("\x1b]52;p;\x1b\\");
    // Oversized clipboards are answered empty rather than flooding the PTY.
    expect(clipboardReadReply("c", "x".repeat(1024 * 1024 + 1), "st")).toBe(
      "\x1b]52;c;\x1b\\",
    );
  });

  it("answers Kitty reads with the text under each requested text type", () => {
    const hello = new TextEncoder().encode("hello");
    expect(
      kittyClipboardAnswer(["image/png", "text/plain", "UTF8_STRING"], "hello"),
    ).toEqual({
      status: "success",
      available: ["text/plain"],
      contents: [
        { mime: "text/plain", data: hello },
        { mime: "UTF8_STRING", data: hello },
      ],
    });
    // An empty clipboard has nothing on offer; a missing one is unsupported.
    expect(kittyClipboardAnswer(["text/plain"], "")).toEqual({
      status: "success",
      available: [],
      contents: [],
    });
    expect(kittyClipboardAnswer(["text/plain"], null)).toEqual({
      status: "unsupported",
    });
    expect(
      kittyClipboardAnswer(["text/plain"], "x".repeat(2 * 1024 * 1024 + 1)),
    ).toEqual({ status: "io-error" });
  });

  it("shows a program's own name in the prompt without disguises", () => {
    expect(promptProgramName("vim")).toBe("vim");
    // A right-to-left override and a newline are dropped.
    expect(promptProgramName("\u202Eevil\ncat")).toBe("evilcat");
    expect(promptProgramName("x".repeat(100))).toBe(`${"x".repeat(63)}…`);
    expect(promptProgramName("\u0007")).toBe("");
  });

  it("lets the core refuse Kitty reads only when reads are denied", () => {
    expect(kittyClipboardPolicy("deny")).toEqual({
      readsToHost: false,
      writesAllowed: true,
    });
    expect(kittyClipboardPolicy("ask").readsToHost).toBe(true);
    expect(kittyClipboardPolicy("allow").readsToHost).toBe(true);
  });

  it("notifies for long commands only when the mode and focus call for it", () => {
    expect(shouldNotifyCommandFinished("never", 5, 60_000, false)).toBe(false);
    expect(shouldNotifyCommandFinished("unfocused", 5, 4_999, false)).toBe(
      false,
    );
    expect(shouldNotifyCommandFinished("unfocused", 5, 5_000, false)).toBe(
      true,
    );
    expect(shouldNotifyCommandFinished("unfocused", 5, 60_000, true)).toBe(
      false,
    );
    expect(shouldNotifyCommandFinished("always", 5, 60_000, true)).toBe(true);
  });

  it("describes finished commands", () => {
    expect(commandFinishedMessage("make test", 0, 75_400)).toEqual({
      title: "Command finished",
      body: "make test\ntook 1m 15s",
    });
    expect(commandFinishedMessage(null, 2, 9_000)).toEqual({
      title: "Command failed",
      body: "Exit code 2 · took 9s",
    });
  });

  it("maps OSC 22 shapes to CSS cursors, text meaning the default", () => {
    expect(pointerCursor("pointer")).toBe("pointer");
    expect(pointerCursor("ew-resize")).toBe("ew-resize");
    expect(pointerCursor("text")).toBe("");
  });

  it("derives the colour scheme from the background luminance", () => {
    expect(colorSchemeFor([0x1e, 0x1e, 0x2e])).toBe("dark");
    expect(colorSchemeFor([0xef, 0xf1, 0xf5])).toBe("light");
    expect(colorSchemeFor([0x80, 0x80, 0x80])).toBe("light");
    expect(colorSchemeFor([0x60, 0x60, 0x60])).toBe("dark");
  });
});
