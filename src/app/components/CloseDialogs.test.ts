import { describe, expect, it } from "vitest";
import { appCloseMessage } from "./CloseDialogs";

describe("the close and quit warning", () => {
  it("says what quitting loses", () => {
    expect(appCloseMessage({ dirtyEditors: 0, busyTerminal: true })).toBe(
      "A process is still running in a terminal. Quitting will terminate it.",
    );
    expect(appCloseMessage({ dirtyEditors: 2, busyTerminal: false })).toBe(
      "2 files have unsaved changes. Quitting will discard them.",
    );
  });

  it("speaks of the window when only it closes", () => {
    expect(
      appCloseMessage({ dirtyEditors: 1, busyTerminal: true }, false),
    ).toBe(
      "A process is still running and 1 file has unsaved changes. Closing this window will terminate it and discard the changes.",
    );
  });
});
