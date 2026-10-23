import { describe, expect, it } from "vitest";
import { applyStatusEvent, statusView, type WindowStatus } from "./status";

function report(
  window: string,
  state: WindowStatus["state"],
  extra: Partial<WindowStatus> = {},
): WindowStatus {
  return {
    window,
    serverId: "s",
    state,
    error: null,
    serverInfo: null,
    toolCount: null,
    retryAtMs: null,
    ...extra,
  };
}

describe("statusView", () => {
  it("is off when disabled, whatever windows report", () => {
    expect(statusView(false, [report("main", "running")])).toEqual({
      state: "disabled",
    });
  });

  it("is idle until a window needs it", () => {
    expect(statusView(true, [])).toEqual({ state: "idle" });
  });

  it("shows running when any window runs it, noting a crash elsewhere", () => {
    expect(
      statusView(true, [
        report("main", "running", { serverInfo: "srv 1.0", toolCount: 3 }),
        report("w-1", "crashed", { error: "boom" }),
        report("w-2", "running"),
      ]),
    ).toEqual({
      state: "running",
      windows: 2,
      serverInfo: "srv 1.0",
      toolCount: 3,
      crashedElsewhere: "boom",
    });
  });

  it("prefers starting over crashed, and shows the soonest retry", () => {
    expect(
      statusView(true, [report("main", "starting"), report("w", "crashed")]),
    ).toEqual({ state: "starting", windows: 1 });
    expect(
      statusView(true, [
        report("main", "crashed", { error: "gave up", retryAtMs: null }),
        report("w", "crashed", { error: "retrying", retryAtMs: 50 }),
      ]),
    ).toEqual({ state: "crashed", error: "retrying", retryAtMs: 50 });
  });
});

describe("applyStatusEvent", () => {
  it("replaces a window's report and drops it when the window stops", () => {
    const one = applyStatusEvent([], {
      window: "main",
      serverId: "s",
      report: { ...report("main", "starting") },
    });
    expect(one).toHaveLength(1);
    const two = applyStatusEvent(one, {
      window: "main",
      serverId: "s",
      report: { ...report("main", "running") },
    });
    expect(two.map((r) => r.state)).toEqual(["running"]);
    expect(
      applyStatusEvent(two, { window: "main", serverId: "s", report: null }),
    ).toEqual([]);
  });
});
