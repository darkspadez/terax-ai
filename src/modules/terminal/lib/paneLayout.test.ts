import { describe, expect, it } from "vitest";
import { movedDivider } from "./paneLayout";

describe("keyboard pane resizing", () => {
  const ids = ["pane-slot-1", "pane-slot-2", "pane-slot-3"];
  const layout = { "pane-slot-1": 30, "pane-slot-2": 40, "pane-slot-3": 30 };

  it("moves one divider and keeps the others", () => {
    expect(movedDivider(layout, ids, 0, 5)).toEqual({
      "pane-slot-1": 35,
      "pane-slot-2": 35,
      "pane-slot-3": 30,
    });
    expect(movedDivider(layout, ids, 1, -5)).toEqual({
      "pane-slot-1": 30,
      "pane-slot-2": 35,
      "pane-slot-3": 35,
    });
  });

  it("stops at the minimum pane size", () => {
    expect(movedDivider(layout, ids, 0, -50)).toEqual({
      "pane-slot-1": 10,
      "pane-slot-2": 60,
      "pane-slot-3": 30,
    });
    expect(
      movedDivider(
        { ...layout, "pane-slot-1": 10, "pane-slot-2": 60 },
        ids,
        0,
        -5,
      ),
    ).toBeNull();
    expect(movedDivider(layout, ["pane-slot-1", "missing"], 0, 5)).toBeNull();
  });
});
