import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  writeFile: vi.fn(),
  createDir: vi.fn(),
  canonicalize: vi.fn(),
}));

vi.mock("@/modules/ai/lib/native", () => ({ native }));

import { type QueuedEdit, usePlanStore } from "@/modules/ai/store/planStore";

function edit(partial: Partial<QueuedEdit> = {}): QueuedEdit {
  return {
    id: "q-1",
    kind: "edit",
    path: "/repo/a.ts",
    originalContent: "old",
    proposedContent: "new",
    isNewFile: false,
    ...partial,
  };
}

function dir(partial: Partial<QueuedEdit> = {}): QueuedEdit {
  return edit({
    kind: "create_directory",
    originalContent: "",
    proposedContent: "",
    description: "Create directory",
    ...partial,
  });
}

const queueIds = () => usePlanStore.getState().queue.map((q) => q.id);

describe("plan mode store", () => {
  beforeEach(() => {
    usePlanStore.setState({ active: false, queue: [] });
    native.writeFile.mockReset().mockResolvedValue(undefined);
    native.createDir.mockReset().mockResolvedValue(undefined);
    native.canonicalize
      .mockReset()
      .mockImplementation(async (path: string) => path);
  });

  it("keeps the queue when enabling and clears it when disabling", () => {
    usePlanStore.getState().enqueue(edit());
    usePlanStore.getState().enqueue(edit({ id: "q-2" }));

    usePlanStore.getState().enable();
    expect(usePlanStore.getState().active).toBe(true);
    expect(usePlanStore.getState().queue).toHaveLength(2);

    usePlanStore.getState().disable();
    expect(usePlanStore.getState().active).toBe(false);
    expect(usePlanStore.getState().queue).toEqual([]);
  });

  it("toggle clears queued edits only when switching off", () => {
    usePlanStore.getState().toggle();
    expect(usePlanStore.getState().active).toBe(true);

    usePlanStore.getState().enqueue(edit());
    usePlanStore.getState().toggle();

    expect(usePlanStore.getState().active).toBe(false);
    expect(usePlanStore.getState().queue).toEqual([]);
  });

  it("removeOne drops only the matching edit", () => {
    usePlanStore.getState().enqueue(edit({ id: "q-1" }));
    usePlanStore.getState().enqueue(edit({ id: "q-2" }));

    usePlanStore.getState().removeOne("q-1");

    expect(queueIds()).toEqual(["q-2"]);
  });

  it("applies file writes in queue order and reports success per item", async () => {
    usePlanStore.getState().enqueue(edit({ id: "q-1", path: "/repo/a.ts" }));
    usePlanStore.getState().enqueue(edit({ id: "q-2", path: "/repo/b.ts" }));

    const results = await usePlanStore.getState().applyAll();

    expect(native.writeFile.mock.calls).toEqual([
      ["/repo/a.ts", "new"],
      ["/repo/b.ts", "new"],
    ]);
    expect(results).toEqual([
      { id: "q-1", ok: true },
      { id: "q-2", ok: true },
    ]);
    expect(usePlanStore.getState().queue).toEqual([]);
  });

  it("routes create_directory edits to mkdir instead of write", async () => {
    usePlanStore.getState().enqueue(dir({ path: "/repo/new-dir" }));

    const results = await usePlanStore.getState().applyAll();

    expect(native.createDir).toHaveBeenCalledWith("/repo/new-dir");
    expect(native.writeFile).not.toHaveBeenCalled();
    expect(results).toEqual([{ id: "q-1", ok: true }]);
  });

  it("captures a failed edit in its result and still drains the rest", async () => {
    usePlanStore.getState().enqueue(edit({ id: "q-1", path: "/repo/blocked" }));
    usePlanStore.getState().enqueue(edit({ id: "q-2", path: "/repo/fine" }));
    native.writeFile.mockImplementation((path: string) =>
      path === "/repo/blocked"
        ? Promise.reject(new Error("denied"))
        : Promise.resolve(),
    );

    const results = await usePlanStore.getState().applyAll();

    expect(results[0]).toMatchObject({ id: "q-1", ok: false });
    expect(String(results[0].error)).toContain("denied");
    expect(results[1]).toEqual({ id: "q-2", ok: true });
    expect(usePlanStore.getState().queue).toEqual([]);
  });

  it("refuses denied paths at the mutation boundary without touching disk", async () => {
    usePlanStore.getState().enqueue(edit({ id: "q-1", path: "/repo/.env" }));
    usePlanStore
      .getState()
      .enqueue(dir({ id: "q-2", path: "/home/me/.ssh/keys" }));

    const results = await usePlanStore.getState().applyAll();

    expect(results.map((r) => r.ok)).toEqual([false, false]);
    expect(results[0].error).toMatch(/^Refused/);
    expect(native.writeFile).not.toHaveBeenCalled();
    expect(native.createDir).not.toHaveBeenCalled();
    expect(usePlanStore.getState().queue).toEqual([]);
  });

  it("refuses a path that became a link to a secret after it was queued", async () => {
    usePlanStore.getState().enqueue(edit({ path: "/repo/notes.txt" }));
    native.canonicalize.mockImplementation(async (path: string) =>
      path === "/repo/notes.txt" ? "/home/me/.ssh/config" : path,
    );

    const results = await usePlanStore.getState().applyAll();

    expect(results).toEqual([
      { id: "q-1", ok: false, error: expect.stringContaining(".ssh") },
    ]);
    expect(native.writeFile).not.toHaveBeenCalled();
  });

  it("writes to the canonical path", async () => {
    usePlanStore.getState().enqueue(edit({ path: "/repo/link.ts" }));
    native.canonicalize.mockImplementation(async (path: string) =>
      path === "/repo/link.ts" ? "/repo/src/real.ts" : path,
    );

    await usePlanStore.getState().applyAll();

    expect(native.writeFile).toHaveBeenCalledWith("/repo/src/real.ts", "new");
  });

  it("keeps edits enqueued while applyAll is pending and applies them later", async () => {
    let releaseWrite: (() => void) | undefined;
    native.writeFile.mockImplementation(
      (path: string) =>
        new Promise<void>((resolve) => {
          if (path === "/repo/first") releaseWrite = resolve;
          else resolve();
        }),
    );
    usePlanStore.getState().enqueue(edit({ id: "q-1", path: "/repo/first" }));

    const applying = usePlanStore.getState().applyAll();
    await vi.waitFor(() => expect(releaseWrite).toBeDefined());
    // Queued by the agent while the first write is still in flight.
    usePlanStore.getState().enqueue(edit({ id: "q-2", path: "/repo/second" }));
    releaseWrite?.();

    expect(await applying).toEqual([{ id: "q-1", ok: true }]);
    expect(queueIds()).toEqual(["q-2"]);

    expect(await usePlanStore.getState().applyAll()).toEqual([
      { id: "q-2", ok: true },
    ]);
    expect(usePlanStore.getState().queue).toEqual([]);
  });

  it("skips an edit rejected while earlier writes are running", async () => {
    let releaseWrite: (() => void) | undefined;
    native.writeFile.mockImplementation(
      (path: string) =>
        new Promise<void>((resolve) => {
          if (path === "/repo/first") releaseWrite = resolve;
          else resolve();
        }),
    );
    usePlanStore.getState().enqueue(edit({ id: "q-1", path: "/repo/first" }));
    usePlanStore.getState().enqueue(edit({ id: "q-2", path: "/repo/second" }));
    usePlanStore.getState().enqueue(edit({ id: "q-3", path: "/repo/third" }));

    const applying = usePlanStore.getState().applyAll();
    await vi.waitFor(() => expect(releaseWrite).toBeDefined());
    usePlanStore.getState().removeOne("q-2");
    releaseWrite?.();

    expect(await applying).toEqual([
      { id: "q-1", ok: true },
      { id: "q-3", ok: true },
    ]);
    expect(native.writeFile.mock.calls.map((c) => c[0])).toEqual([
      "/repo/first",
      "/repo/third",
    ]);
    expect(usePlanStore.getState().queue).toEqual([]);
  });
});
