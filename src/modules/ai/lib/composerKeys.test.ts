import { describe, expect, it } from "vitest";
import { type ComposerKey, composerKeyAction } from "./composerKeys";

const key = (k: string, extra: Partial<ComposerKey> = {}): ComposerKey => ({
  key: k,
  shiftKey: false,
  isComposing: false,
  keyCode: k === "Enter" ? 13 : 0,
  ...extra,
});
const closed = { open: false, items: 0 };
const open = { open: true, items: 3 };

describe("composerKeyAction", () => {
  it("submits on Enter and leaves Shift+Enter to the textarea", () => {
    expect(composerKeyAction(key("Enter"), closed)).toBe("submit");
    expect(composerKeyAction(key("Enter", { shiftKey: true }), closed)).toBe(
      null,
    );
    expect(composerKeyAction(key("a"), closed)).toBe(null);
  });

  it("leaves the Enter that confirms an IME candidate to the IME", () => {
    const composing = key("Enter", { isComposing: true, keyCode: 229 });
    // WebKit: compositionend has already fired, keyCode is still 229.
    const webkitCommit = key("Enter", { keyCode: 229 });
    for (const picker of [closed, open]) {
      expect(composerKeyAction(composing, picker)).toBe(null);
      expect(composerKeyAction(webkitCommit, picker)).toBe(null);
    }
  });

  it("leaves candidate navigation to the IME while the picker is open", () => {
    for (const k of ["ArrowDown", "ArrowUp", "Tab", "Escape"]) {
      expect(composerKeyAction(key(k, { isComposing: true }), open)).toBe(null);
    }
  });

  it("drives the picker while it is open", () => {
    expect(composerKeyAction(key("ArrowDown"), open)).toBe("picker-next");
    expect(composerKeyAction(key("ArrowUp"), open)).toBe("picker-prev");
    expect(composerKeyAction(key("Enter"), open)).toBe("picker-pick");
    expect(composerKeyAction(key("Tab"), open)).toBe("picker-pick");
    expect(composerKeyAction(key("Escape"), open)).toBe("picker-dismiss");
    // An empty picker does not swallow Enter.
    expect(composerKeyAction(key("Enter"), { open: true, items: 0 })).toBe(
      "submit",
    );
    expect(composerKeyAction(key("Tab"), { open: true, items: 0 })).toBe(null);
  });
});
