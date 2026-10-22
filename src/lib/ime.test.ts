import { describe, expect, it } from "vitest";
import { isImeKeyEvent } from "./ime";

describe("isImeKeyEvent", () => {
  it("claims the Enter that confirms a candidate while composing", () => {
    expect(
      isImeKeyEvent({ isComposing: true, keyCode: 13, key: "Enter" }),
    ).toBe(true);
  });

  it("claims WebKit's commit Enter, which arrives after compositionend", () => {
    expect(
      isImeKeyEvent({ isComposing: false, keyCode: 229, key: "Enter" }),
    ).toBe(true);
    expect(
      isImeKeyEvent({ isComposing: false, keyCode: 0, key: "Process" }),
    ).toBe(true);
  });

  it("leaves plain keys alone", () => {
    expect(
      isImeKeyEvent({ isComposing: false, keyCode: 13, key: "Enter" }),
    ).toBe(false);
    expect(isImeKeyEvent({ isComposing: false, keyCode: 65, key: "a" })).toBe(
      false,
    );
  });
});
