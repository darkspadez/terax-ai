import { describe, expect, it, vi } from "vitest";
import { onFocusIntoFrame } from "./frameFocus";

describe("onFocusIntoFrame", () => {
  it("reports a blur that leaves focus in a frame, until stopped", () => {
    const win = new EventTarget();
    const doc = { activeElement: { tagName: "IFRAME" } };
    const onFrameFocus = vi.fn();
    const stop = onFocusIntoFrame(win, doc, onFrameFocus);

    win.dispatchEvent(new Event("blur"));
    expect(onFrameFocus).toHaveBeenCalledOnce();

    stop();
    win.dispatchEvent(new Event("blur"));
    expect(onFrameFocus).toHaveBeenCalledOnce();
  });

  it("ignores the app losing focus to another window", () => {
    const win = new EventTarget();
    const onFrameFocus = vi.fn();
    onFocusIntoFrame(
      win,
      { activeElement: { tagName: "BUTTON" } },
      onFrameFocus,
    );
    onFocusIntoFrame(win, { activeElement: null }, onFrameFocus);

    win.dispatchEvent(new Event("blur"));
    expect(onFrameFocus).not.toHaveBeenCalled();
  });
});
