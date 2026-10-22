import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/platform", () => ({ IS_WINDOWS: false }));

import { dropPointToCss } from "./nativeDropPoint";

// crynta/terax-ai#734: a HiDPI Windows drop in the top-left part of the
// window (the explorer, the first pane) was hit-tested at twice its position.
describe("dropPointToCss", () => {
  it("scales Windows' physical client pixels by the device pixel ratio", () => {
    expect(dropPointToCss(600, 400, true, 2)).toEqual({ x: 300, y: 200 });
    expect(dropPointToCss(1400, 1000, true, 2)).toEqual({ x: 700, y: 500 });
    expect(dropPointToCss(300, 150, true, 1.5)).toEqual({ x: 200, y: 100 });
  });

  it("keeps the logical points macOS and Linux report", () => {
    expect(dropPointToCss(600, 400, false, 2)).toEqual({ x: 600, y: 400 });
    expect(dropPointToCss(1400, 1000, false, 2)).toEqual({
      x: 1400,
      y: 1000,
    });
  });
});
