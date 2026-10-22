import { describe, expect, it } from "vitest";
import {
  canSplitPane,
  findLeafNode,
  firstLeafSlotId,
  leafIds,
  MAX_PANES_PER_TAB,
  leafInDirection,
  type PaneNode,
  splitIds,
  splitLeaf,
  splitResizeTarget,
  swapLeafInDirection,
} from "@/modules/terminal/lib/panes";
import { MAX_WEBGL_RENDERER_SLOTS } from "@/modules/terminal/ghostty/webgl/WebGlTerminalRuntime";

function row(...ids: number[]): PaneNode {
  return {
    kind: "split",
    id: 100,
    dir: "row",
    children: ids.map((id) => ({ kind: "leaf", id })),
  };
}

function col(...ids: number[]): PaneNode {
  return {
    kind: "split",
    id: 200,
    dir: "col",
    children: ids.map((id) => ({ kind: "leaf", id })),
  };
}

describe("swapLeafInDirection", () => {
  it("swaps the active pane with its neighbor to the left", () => {
    expect(leafIds(swapLeafInDirection(row(1, 2, 3), 2, "left"))).toEqual([
      2, 1, 3,
    ]);
  });

  it("wraps right from the rightmost pane to the leftmost pane", () => {
    expect(leafIds(swapLeafInDirection(row(1, 2, 3), 3, "right"))).toEqual([
      3, 2, 1,
    ]);
  });

  it("swaps vertically and wraps upward", () => {
    expect(leafIds(swapLeafInDirection(col(1, 2, 3), 2, "down"))).toEqual([
      1, 3, 2,
    ]);
    expect(leafIds(swapLeafInDirection(col(1, 2, 3), 1, "up"))).toEqual([
      3, 2, 1,
    ]);
  });

  it("chooses the overlapping directional neighbor in a nested layout", () => {
    const tree: PaneNode = {
      kind: "split",
      id: 10,
      dir: "row",
      children: [
        { kind: "leaf", id: 1 },
        {
          kind: "split",
          id: 11,
          dir: "col",
          children: [
            { kind: "leaf", id: 2 },
            { kind: "leaf", id: 3 },
          ],
        },
      ],
    };

    expect(leafIds(swapLeafInDirection(tree, 2, "down"))).toEqual([1, 3, 2]);
    expect(leafIds(swapLeafInDirection(tree, 3, "left"))).toEqual([3, 2, 1]);
  });

  it("uses live pane bounds after splitters are resized", () => {
    const bounds = [
      { id: 1, left: 0, right: 100, top: 0, bottom: 100 },
      { id: 2, left: 200, right: 300, top: 100, bottom: 200 },
      { id: 3, left: 100, right: 200, top: 0, bottom: 100 },
    ];

    expect(
      leafIds(swapLeafInDirection(row(1, 2, 3), 1, "right", bounds)),
    ).toEqual([3, 2, 1]);
  });

  it("falls back to tree geometry when live bounds are incomplete", () => {
    const tree = row(1, 2, 3);
    const incompleteBounds = [
      { id: 1, left: 0, right: 100, top: 0, bottom: 100 },
    ];

    expect(
      leafIds(swapLeafInDirection(tree, 1, "right", incompleteBounds)),
    ).toEqual([2, 1, 3]);
  });

  it("moves pane metadata with the terminal session", () => {
    const tree: PaneNode = {
      kind: "split",
      id: 100,
      dir: "row",
      children: [
        { kind: "leaf", id: 1, cwd: "/one" },
        { kind: "leaf", id: 2, cwd: "/two" },
      ],
    };
    const swapped = swapLeafInDirection(tree, 2, "left");
    expect(swapped.kind).toBe("split");
    if (swapped.kind === "split") {
      expect(swapped.children[0]).toEqual({
        kind: "leaf",
        id: 2,
        slotId: 1,
        cwd: "/two",
      });
      expect(swapped.children[1]).toEqual({
        kind: "leaf",
        id: 1,
        slotId: 2,
        cwd: "/one",
      });
    }
  });

  it("keeps resizable layout slots fixed while sessions move", () => {
    const tree = row(1, 2, 3);
    const swapped = swapLeafInDirection(tree, 2, "left");

    expect(swapped.kind).toBe("split");
    if (swapped.kind === "split") {
      expect(swapped.children.map(firstLeafSlotId)).toEqual([1, 2, 3]);
      expect(leafIds(swapped)).toEqual([2, 1, 3]);
    }

    const restored = swapLeafInDirection(swapped, 2, "right");
    expect(restored.kind).toBe("split");
    if (restored.kind === "split") {
      expect(restored.children.map(firstLeafSlotId)).toEqual([1, 2, 3]);
      expect(leafIds(restored)).toEqual([1, 2, 3]);
    }
  });

  it("does nothing when the tree contains only one pane", () => {
    const tree: PaneNode = { kind: "leaf", id: 1 };
    expect(swapLeafInDirection(tree, 1, "left")).toBe(tree);
  });
});

describe("directional pane focus and resizing", () => {
  // [1 | [2 / 3]]
  const tree: PaneNode = {
    kind: "split",
    id: 10,
    dir: "row",
    children: [
      { kind: "leaf", id: 1 },
      {
        kind: "split",
        id: 20,
        dir: "col",
        children: [
          { kind: "leaf", id: 2 },
          { kind: "leaf", id: 3 },
        ],
      },
    ],
  };

  it("finds the neighbour in a direction", () => {
    expect(leafInDirection(tree, 1, "right")).toBe(2);
    expect(leafInDirection(tree, 3, "up")).toBe(2);
    expect(leafInDirection(tree, 3, "left")).toBe(1);
    expect(leafInDirection({ kind: "leaf", id: 1 }, 1, "left")).toBeNull();
  });

  it("finds leaves and splits", () => {
    expect(findLeafNode(tree, 3)).toEqual({ kind: "leaf", id: 3 });
    expect(findLeafNode(tree, 9)).toBeNull();
    expect(splitIds(tree)).toEqual([10, 20]);
  });

  it("moves the divider on the requested side, else the other one", () => {
    const right = splitResizeTarget(tree, 1, "right");
    expect(
      right && {
        split: right.split.id,
        divider: right.divider,
        sign: right.sign,
      },
    ).toEqual({
      split: 10,
      divider: 0,
      sign: 1,
    });
    // Pane 2 has no divider to its right: its left divider moves right.
    const shrink = splitResizeTarget(tree, 2, "right");
    expect(
      shrink && {
        split: shrink.split.id,
        divider: shrink.divider,
        sign: shrink.sign,
      },
    ).toEqual({
      split: 10,
      divider: 0,
      sign: 1,
    });
    // Vertical resize uses the nearest column split.
    const up = splitResizeTarget(tree, 3, "up");
    expect(
      up && { split: up.split.id, divider: up.divider, sign: up.sign },
    ).toEqual({
      split: 20,
      divider: 0,
      sign: -1,
    });
    expect(splitResizeTarget(tree, 1, "up")).toBeNull();
  });
});

// crynta/terax-ai#1035, #1149: a 2x2 grid was as far as a tab could go.
describe("pane limit", () => {
  it("splits a tab into eight panes and no further", () => {
    let tree: PaneNode = { kind: "leaf", id: 1 };
    let next = 2;
    while (canSplitPane(tree)) {
      const ids = leafIds(tree);
      const target = ids[ids.length - 1];
      tree = splitLeaf(tree, target, next++, next++, next % 2 ? "row" : "col");
    }
    expect(leafIds(tree)).toHaveLength(8);
    expect(MAX_PANES_PER_TAB).toBe(8);
  });

  it("leaves the WebGL fallback a renderer for every pane and one more", () => {
    expect(MAX_WEBGL_RENDERER_SLOTS).toBe(MAX_PANES_PER_TAB + 1);
  });
});
