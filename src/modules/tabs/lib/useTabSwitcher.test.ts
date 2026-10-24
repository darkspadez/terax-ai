import { describe, expect, it } from "vitest";
import { switcherTapTarget } from "./useTabSwitcher";

describe("switcherTapTarget", () => {
  // Order is most recently used first, the current tab at its head.
  it("lands where a tap of the keys does", () => {
    expect(switcherTapTarget([5, 3, 9], 1)).toBe(3);
    expect(switcherTapTarget([5, 3, 9], -1)).toBe(9);
  });

  it("goes nowhere with a single tab", () => {
    expect(switcherTapTarget([5], 1)).toBeNull();
    expect(switcherTapTarget([], -1)).toBeNull();
  });
});
