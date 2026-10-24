import { describe, expect, it } from "vitest";
import { type HState, historyRowsUpdate, PointerMotion } from "./historyPopover";

// crynta/terax-ai#1344: with the pointer resting over the popover, every
// arrow press snapped back to the row under it.
describe("history popover rows", () => {
  const items = ["git status", "ls", "cargo test"];
  const state = (index: number, list = items): HState => ({
    open: true,
    items: list,
    index,
  });

  it("moves the selection without rebuilding the rows", () => {
    expect(historyRowsUpdate(state(0), state(1))).toEqual({
      rebuild: false,
      deselect: 0,
      select: 1,
    });
    expect(historyRowsUpdate(state(2), state(2))).toEqual({
      rebuild: false,
      deselect: null,
      select: 2,
    });
  });

  it("rebuilds when the items change or the popover first shows", () => {
    expect(historyRowsUpdate(null, state(0))).toEqual({
      rebuild: true,
      deselect: null,
      select: 0,
    });
    expect(historyRowsUpdate(state(1), state(0, ["ls"]))).toEqual({
      rebuild: true,
      deselect: null,
      select: 0,
    });
  });

  it("selects on hover only when the pointer really moves", () => {
    const pointer = new PointerMotion();
    // Rows sliding under a resting pointer report where it already was.
    expect(pointer.moved({ screenX: 100, screenY: 200 })).toBe(false);
    expect(pointer.moved({ screenX: 100, screenY: 200 })).toBe(false);
    expect(pointer.moved({ screenX: 100, screenY: 214 })).toBe(true);
    expect(pointer.moved({ screenX: 100, screenY: 214 })).toBe(false);
  });
});
