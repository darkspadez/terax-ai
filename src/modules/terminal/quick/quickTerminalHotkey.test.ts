import { describe, expect, it, vi } from "vitest";
import {
  applyQuickTerminalHotkey,
  quickTerminalAccelerator,
} from "./quickTerminalHotkey";

describe("quick terminal hotkey", () => {
  it("registers the chosen accelerator, or none when off", async () => {
    const register = vi.fn(async () => undefined);
    await applyQuickTerminalHotkey("Alt+Space", register);
    await applyQuickTerminalHotkey("off", register);
    expect(register.mock.calls).toEqual([["Alt+Space"], [null]]);
    expect(quickTerminalAccelerator("CommandOrControl+`")).toBe(
      "CommandOrControl+`",
    );
  });

  it("reports a hotkey the system refuses instead of throwing", async () => {
    const report = vi.fn();
    await applyQuickTerminalHotkey(
      "F12",
      async () => {
        throw new Error("already registered");
      },
      report,
    );
    expect(report).toHaveBeenCalledWith(new Error("already registered"));
  });
});
