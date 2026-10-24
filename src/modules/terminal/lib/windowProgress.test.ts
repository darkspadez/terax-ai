import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type TerminalProgress,
  useTerminalStatusStore,
} from "./terminalStatus";
import {
  NO_WINDOW_PROGRESS,
  startWindowProgress,
  windowProgressOf,
} from "./windowProgress";

const leaf = (progress: TerminalProgress | null) => ({
  title: null,
  progress,
  bell: false,
  running: false,
});

afterEach(() => {
  for (const id of Object.keys(useTerminalStatusStore.getState().leaves))
    useTerminalStatusStore.getState().clear(Number(id));
});

describe("windowProgressOf", () => {
  it("shows nothing without reports", () => {
    expect(windowProgressOf({})).toEqual(NO_WINDOW_PROGRESS);
    expect(windowProgressOf({ 1: leaf(null) })).toEqual(NO_WINDOW_PROGRESS);
  });

  it("shows the least advanced of several running panes", () => {
    expect(
      windowProgressOf({
        1: leaf({ state: "set", value: 80 }),
        2: leaf({ state: "set", value: 35 }),
      }),
    ).toEqual({ status: "normal", value: 35 });
  });

  it("lets the most urgent state win over progress elsewhere", () => {
    const running = leaf({ state: "set", value: 10 });
    expect(
      windowProgressOf({
        1: running,
        2: leaf({ state: "indeterminate", value: null }),
      }),
    ).toEqual({ status: "indeterminate", value: null });
    expect(
      windowProgressOf({ 1: running, 2: leaf({ state: "pause", value: 60 }) }),
    ).toEqual({ status: "paused", value: 60 });
    expect(
      windowProgressOf({
        1: leaf({ state: "pause", value: 60 }),
        2: leaf({ state: "error", value: null }),
      }),
    ).toEqual({ status: "error", value: 100 });
  });

  it("clamps and rounds values into a percentage", () => {
    expect(
      windowProgressOf({ 1: leaf({ state: "set", value: 140.4 }) }),
    ).toEqual({ status: "normal", value: 100 });
    expect(
      windowProgressOf({ 1: leaf({ state: "set", value: null }) }),
    ).toEqual({
      status: "normal",
      value: 0,
    });
  });
});

describe("startWindowProgress", () => {
  it("writes on change only and clears the bar when stopped", () => {
    const sink = vi.fn();
    const stop = startWindowProgress(sink);
    expect(sink).not.toHaveBeenCalled();
    const status = useTerminalStatusStore.getState();
    status.update(1, { progress: { state: "set", value: 20 } });
    status.update(1, { title: "build" }); // same progress
    status.update(2, { progress: { state: "set", value: 50 } }); // min stays 20
    expect(sink.mock.calls).toEqual([[{ status: "normal", value: 20 }]]);
    status.update(1, { progress: null });
    expect(sink).toHaveBeenLastCalledWith({ status: "normal", value: 50 });
    stop();
    expect(sink).toHaveBeenLastCalledWith(NO_WINDOW_PROGRESS);
    status.update(2, { progress: { state: "error", value: null } });
    expect(sink).toHaveBeenCalledTimes(3);
  });
});
