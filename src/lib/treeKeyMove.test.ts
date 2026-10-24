import { describe, expect, it } from "vitest";
import { type TreeNavRow, treeKeyMove } from "./treeKeyMove";

const branch = (key: string, collapsed: boolean): TreeNavRow => ({
  key,
  parentKey: null,
  branch: { id: key, collapsed },
});
const leaf = (key: string, parentKey: string | null): TreeNavRow => ({
  key,
  parentKey,
});

describe("treeKeyMove", () => {
  it("opens a closed branch, then enters an open one", () => {
    expect(treeKeyMove(branch("f", true), undefined, "in")).toEqual({
      toggle: "f",
    });
    expect(treeKeyMove(branch("f", false), leaf("h", "f"), "in")).toEqual({
      focus: "h",
    });
  });

  it("closes an open branch, then goes up from a leaf", () => {
    expect(treeKeyMove(branch("f", false), leaf("h", "f"), "out")).toEqual({
      toggle: "f",
    });
    expect(treeKeyMove(leaf("h", "f"), undefined, "out")).toEqual({
      focus: "f",
    });
  });

  it("does nothing where there is nowhere to go", () => {
    expect(treeKeyMove(leaf("h", "f"), undefined, "in")).toBeNull();
    expect(treeKeyMove(branch("f", false), branch("g", true), "in")).toBeNull();
    expect(treeKeyMove(branch("f", true), undefined, "out")).toBeNull();
    expect(treeKeyMove(leaf("top", null), undefined, "out")).toBeNull();
  });
});
