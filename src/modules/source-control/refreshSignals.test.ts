import type { Tab } from "@/modules/tabs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRefreshCoalescer,
  finishedCommandLeaves,
  terminalLeafCwd,
} from "./refreshSignals";

describe("createRefreshCoalescer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const finishes: Array<() => void> = [];
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishes.push(resolve);
        }),
    );
    const coalescer = createRefreshCoalescer({
      run,
      quietMs: 300,
      maxWaitMs: 1000,
    });
    return { run, coalescer, finishes };
  }

  it("turns a burst into one refresh after a quiet gap", () => {
    const { run, coalescer } = setup();
    coalescer.signal();
    vi.advanceTimersByTime(200);
    coalescer.signal();
    vi.advanceTimersByTime(299);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("refreshes at most maxWaitMs after the first signal of a steady stream", () => {
    const { run, coalescer } = setup();
    for (let t = 0; t < 1000; t += 100) {
      coalescer.signal();
      vi.advanceTimersByTime(100);
    }
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs once more after a refresh that a signal arrived during", async () => {
    const { run, coalescer, finishes } = setup();
    coalescer.signal();
    vi.advanceTimersByTime(300);
    expect(run).toHaveBeenCalledTimes(1);

    coalescer.signal();
    coalescer.signal();
    vi.advanceTimersByTime(1000);
    expect(run).toHaveBeenCalledTimes(1);

    finishes[0]();
    await vi.advanceTimersByTimeAsync(300);
    expect(run).toHaveBeenCalledTimes(2);
    finishes[1]();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("survives a failed refresh", async () => {
    const run = vi.fn(() => Promise.reject(new Error("git failed")));
    const coalescer = createRefreshCoalescer({
      run,
      quietMs: 300,
      maxWaitMs: 1000,
    });
    coalescer.signal();
    await vi.advanceTimersByTimeAsync(300);
    coalescer.signal();
    await vi.advanceTimersByTimeAsync(300);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does nothing once disposed", async () => {
    const { run, coalescer } = setup();
    coalescer.signal();
    coalescer.dispose();
    vi.advanceTimersByTime(1000);
    expect(run).not.toHaveBeenCalled();

    const second = setup();
    second.coalescer.signal();
    vi.advanceTimersByTime(300);
    second.coalescer.signal();
    second.coalescer.dispose();
    second.finishes[0]();
    await vi.advanceTimersByTimeAsync(1000);
    expect(second.run).toHaveBeenCalledTimes(1);
  });
});

describe("finishedCommandLeaves", () => {
  it("lists the panes whose command stopped running", () => {
    const previous = {
      1: { running: true },
      2: { running: true },
      3: { running: false },
      4: { running: true },
    };
    const next = {
      1: { running: false },
      2: { running: true },
      3: { running: false },
    };
    expect(finishedCommandLeaves(previous, next)).toEqual([1]);
  });

  it("ignores a command that starts", () => {
    expect(
      finishedCommandLeaves(
        { 1: { running: false } },
        { 1: { running: true } },
      ),
    ).toEqual([]);
  });
});

describe("terminalLeafCwd", () => {
  const tabs = [
    { id: 1, kind: "editor", path: "/repo/a.ts" },
    {
      id: 2,
      kind: "terminal",
      cwd: "/home/u",
      activeLeafId: 10,
      paneTree: {
        kind: "split",
        id: 9,
        dir: "row",
        children: [
          { kind: "leaf", id: 10, cwd: "/repo/src" },
          { kind: "leaf", id: 11 },
        ],
      },
    },
  ] as unknown as Tab[];

  it("reads the pane's own directory", () => {
    expect(terminalLeafCwd(tabs, 10)).toBe("/repo/src");
  });

  it("falls back to the tab's directory before the shell reports one", () => {
    expect(terminalLeafCwd(tabs, 11)).toBe("/home/u");
  });

  it("knows nothing of a pane that is gone", () => {
    expect(terminalLeafCwd(tabs, 12)).toBeNull();
  });
});
