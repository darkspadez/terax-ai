import type { Tab } from "@/modules/tabs";
import { describe, expect, it, vi } from "vitest";
import { planTerminalRestart, restartTarget } from "./terminalRestart";

// crynta/terax-ai#368: Restart terminal in the command palette.
describe("restarting a terminal", () => {
  it("asks first while a program runs in the pane", async () => {
    const isBusy = vi.fn(async () => true);
    expect(await planTerminalRestart(7, isBusy, true)).toBe("confirm");
    expect(isBusy).toHaveBeenCalledWith(7);
  });

  it("restarts at once at the prompt", async () => {
    expect(await planTerminalRestart(7, async () => false, true)).toBe(
      "restart",
    );
  });

  it("never asks, nor checks, once the prompt is turned off", async () => {
    const isBusy = vi.fn(async () => true);
    expect(await planTerminalRestart(7, isBusy, false)).toBe("restart");
    expect(isBusy).not.toHaveBeenCalled();
  });

  it("acts on the active terminal tab's pane only", () => {
    const tabs = [
      { id: 1, kind: "terminal", activeLeafId: 12 },
      { id: 2, kind: "editor" },
    ] as unknown as Tab[];
    expect(restartTarget(tabs, 1)).toBe(12);
    expect(restartTarget(tabs, 2)).toBeNull();
    expect(restartTarget(tabs, 3)).toBeNull();
  });
});
