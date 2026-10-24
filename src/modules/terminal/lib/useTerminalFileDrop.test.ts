import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/platform", () => ({ IS_WINDOWS: false }));

import { createTerminalPathDropTarget } from "./useTerminalFileDrop";

describe("createTerminalPathDropTarget", () => {
  it("tracks the terminal leaf under the pointer", () => {
    const setTarget = vi.fn();
    const target = createTerminalPathDropTarget({
      leafIdAtPoint: (x, y) => (x === 20 && y === 30 ? 7 : null),
      paste: vi.fn(),
      setTarget,
    });

    expect(target.updateTarget(20, 30)).toBe(true);
    expect(setTarget).toHaveBeenLastCalledWith(7);
    expect(target.updateTarget(1, 2)).toBe(false);
    expect(setTarget).toHaveBeenLastCalledWith(null);
  });

  it("clears the target and pastes a shell-quoted path", () => {
    const paste = vi.fn(() => true);
    const setTarget = vi.fn();
    const target = createTerminalPathDropTarget({
      leafIdAtPoint: () => 11,
      paste,
      setTarget,
    });

    expect(target.dropPath(["/repo/My File.ts"], 40, 50)).toBe(true);
    expect(setTarget).toHaveBeenCalledWith(null);
    expect(paste).toHaveBeenCalledWith(11, "'/repo/My File.ts' ");
  });

  it("pastes multiple dropped paths quoted", () => {
    const paste = vi.fn(() => true);
    const setTarget = vi.fn();
    const target = createTerminalPathDropTarget({
      leafIdAtPoint: () => 11,
      paste,
      setTarget,
    });

    expect(
      target.dropPath(["/repo/a.ts", "/repo/b file.ts"], 40, 50),
    ).toBe(true);
    expect(paste).toHaveBeenCalledWith(
      11,
      "/repo/a.ts '/repo/b file.ts' ",
    );
  });

  it("clears stale state when a drop misses every terminal", () => {
    const paste = vi.fn(() => true);
    const setTarget = vi.fn();
    const target = createTerminalPathDropTarget({
      leafIdAtPoint: () => null,
      paste,
      setTarget,
    });

    expect(target.dropPath(["/repo/file.ts"], 1, 2)).toBe(false);
    expect(setTarget).toHaveBeenCalledWith(null);
    expect(paste).not.toHaveBeenCalled();
  });

  it("hands the drag to a program that registered for drops", () => {
    const paste = vi.fn(() => true);
    const setTarget = vi.fn();
    const calls: string[] = [];
    const registered = new Set([7]);
    const target = createTerminalPathDropTarget({
      leafIdAtPoint: (x) => (x < 100 ? 7 : 8),
      paste,
      setTarget,
      program: {
        offer: (leafId, x, y) => {
          calls.push(`offer ${leafId} ${x},${y}`);
          return registered.has(leafId);
        },
        drop: (leafId, _x, _y, paths) => {
          calls.push(`drop ${leafId} ${paths.join(",")}`);
          return registered.has(leafId);
        },
        leave: (leafId) => calls.push(`leave ${leafId}`),
      },
    });

    // The program decides, so no paste overlay.
    expect(target.updateTarget(10, 20)).toBe(true);
    expect(setTarget).toHaveBeenLastCalledWith(null);
    // Moving to a pane whose program takes no drops leaves the first.
    expect(target.updateTarget(150, 20)).toBe(true);
    expect(setTarget).toHaveBeenLastCalledWith(8);
    expect(target.updateTarget(10, 20)).toBe(true);
    expect(target.dropPath(["/a"], 10, 20)).toBe(true);
    // After the drop there is no drag left to leave.
    target.clearTarget();
    expect(paste).not.toHaveBeenCalled();
    expect(calls).toEqual([
      "offer 7 10,20",
      "leave 7",
      "offer 8 150,20",
      "offer 7 10,20",
      "drop 7 /a",
    ]);

    // A drop where the program takes none pastes, leaving the other pane.
    calls.length = 0;
    target.updateTarget(10, 20);
    expect(target.dropPath(["/b c"], 150, 20)).toBe(true);
    expect(paste).toHaveBeenCalledWith(8, "'/b c' ");
    expect(calls).toEqual(["offer 7 10,20", "leave 7", "drop 8 /b c"]);
  });

  it("leaves the program's drag when the drag ends elsewhere", () => {
    const leave = vi.fn();
    const target = createTerminalPathDropTarget({
      leafIdAtPoint: () => 7,
      paste: vi.fn(() => true),
      setTarget: vi.fn(),
      program: { offer: () => true, drop: () => true, leave },
    });
    target.updateTarget(1, 1);
    target.clearTarget();
    target.clearTarget();
    expect(leave).toHaveBeenCalledTimes(1);
    expect(leave).toHaveBeenCalledWith(7);
  });
});
