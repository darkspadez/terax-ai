import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { createAllFoldersSync, syncAllFolders, useAllFolders } = await import(
  "./allFolders"
);

/** Lets every settled promise run its callbacks. */
const settle = () => new Promise((done) => setTimeout(done, 0));

function recorder(fail = () => false) {
  const calls: [string, boolean][] = [];
  const send = vi.fn(async (origin: string, all: boolean) => {
    calls.push([origin, all]);
    if (fail()) throw new Error("no backend");
  });
  return { calls, send };
}

describe("createAllFoldersSync", () => {
  it("tells the backend both settings first, then only what changed", () => {
    const { calls, send } = recorder();
    const update = createAllFoldersSync(send);
    update({ app: false, ai: false });
    expect(calls).toEqual([
      ["app", false],
      ["ai", false],
    ]);
    update({ app: false, ai: false });
    update({ app: true, ai: false });
    update({ app: true, ai: true });
    update({ app: false, ai: true });
    expect(calls.slice(2)).toEqual([
      ["app", true],
      ["ai", true],
      ["app", false],
    ]);
  });

  it("sends a setting again after it failed to arrive", async () => {
    let failing = true;
    const { calls, send } = recorder(() => failing);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const update = createAllFoldersSync(send);
    update({ app: true, ai: false });
    await settle();
    failing = false;
    update({ app: true, ai: false });
    expect(calls).toEqual([
      ["app", true],
      ["ai", false],
      ["app", true],
      ["ai", false],
    ]);
    warn.mockRestore();
  });
});

describe("syncAllFolders", () => {
  it("sends the stored settings at once and follows the store", () => {
    type State = {
      appAllFolders: boolean;
      aiAllFolders: boolean;
      other: number;
    };
    let state: State = { appAllFolders: true, aiAllFolders: false, other: 1 };
    const listeners = new Set<(s: State) => void>();
    const store = {
      getState: () => state,
      subscribe: (cb: (s: State) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    };
    const notify = () => {
      for (const listener of listeners) listener(state);
    };
    const { calls, send } = recorder();
    const stop = syncAllFolders(store, send);
    expect(calls).toEqual([
      ["app", true],
      ["ai", false],
    ]);

    state = { ...state, other: 2 };
    notify();
    state = { ...state, aiAllFolders: true };
    notify();
    expect(calls.slice(2)).toEqual([["ai", true]]);
    expect(useAllFolders.getState()).toEqual({ app: true, ai: true });

    stop();
    expect(listeners.size).toBe(0);
  });
});
