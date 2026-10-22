import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  canonicalize: vi.fn(async (p: string) => p),
  writeFile: vi.fn(async (_path: string, _content: string) => {}),
  createDir: vi.fn(async (_path: string) => {}),
}));
vi.mock("../lib/native", () => ({ native }));

import { type QueuedEdit, usePlanStore } from "./planStore";

const edit = (id: string, path: string): QueuedEdit => ({
  id,
  kind: "write_file",
  path,
  originalContent: "",
  proposedContent: "new",
  isNewFile: true,
});

describe("plan Apply failures", () => {
  beforeEach(() => {
    usePlanStore.setState({ queue: [] });
    native.writeFile.mockReset().mockResolvedValue(undefined);
  });

  it("keeps edits that were not written, with the reason, and drops the rest", async () => {
    native.writeFile.mockImplementation(async (path: string) => {
      if (path === "/repo/locked.ts") throw "permission denied";
    });
    const { enqueue, applyAll } = usePlanStore.getState();
    enqueue(edit("q-1", "/repo/ok.ts"));
    enqueue(edit("q-2", "/repo/locked.ts"));
    enqueue(edit("q-3", "/repo/.env"));

    const results = await applyAll();

    expect(results.map((r) => r.ok)).toEqual([true, false, false]);
    expect(usePlanStore.getState().queue).toEqual([
      { ...edit("q-2", "/repo/locked.ts"), error: "permission denied" },
      {
        ...edit("q-3", "/repo/.env"),
        error: expect.stringMatching(/^Refused/),
      },
    ]);
  });

  it("clears a failed edit once a later Apply writes it", async () => {
    native.writeFile.mockRejectedValueOnce("disk full");
    const { enqueue, applyAll } = usePlanStore.getState();
    enqueue(edit("q-1", "/repo/a.ts"));

    await applyAll();
    expect(usePlanStore.getState().queue[0].error).toBe("disk full");

    await applyAll();
    expect(usePlanStore.getState().queue).toEqual([]);
  });
});
