import { describe, expect, it } from "vitest";
import { followWindowFrame, type WindowFrame } from "./windowFrame";

const frame = (fullscreen: boolean): WindowFrame => ({
  maximized: false,
  fullscreen,
});

function source() {
  const calls: string[] = [];
  const reads: Array<{
    resolve: (frame: WindowFrame) => void;
    reject: (error: Error) => void;
  }> = [];
  let changed: (() => void) | undefined;
  return {
    calls,
    reads,
    change: () => changed?.(),
    listen: async (handler: () => void) => {
      calls.push("listen");
      changed = handler;
      return () => calls.push("unlisten");
    },
    read: () => {
      calls.push("read");
      return new Promise<WindowFrame>((resolve, reject) =>
        reads.push({ resolve, reject }),
      );
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("followWindowFrame", () => {
  it("listens for changes before the first read", async () => {
    const s = source();
    const applied: WindowFrame[] = [];
    await followWindowFrame(s.listen, s.read, (f) => applied.push(f));
    expect(s.calls).toEqual(["listen", "read"]);
    s.reads[0].resolve(frame(true));
    await settle();
    expect(applied).toEqual([frame(true)]);
  });

  it("reads one at a time and lands the last state, never an older one", async () => {
    const s = source();
    const applied: WindowFrame[] = [];
    await followWindowFrame(s.listen, s.read, (f) => applied.push(f));
    // A drag reports many changes while the first read is out.
    for (let i = 0; i < 20; i++) s.change();
    expect(s.reads).toHaveLength(1);
    s.reads[0].resolve(frame(false));
    await settle();
    // One more read for everything that changed meanwhile.
    expect(s.reads).toHaveLength(2);
    s.reads[1].resolve(frame(true));
    await settle();
    expect(s.reads).toHaveLength(2);
    expect(applied).toEqual([frame(false), frame(true)]);
  });

  it("keeps the last state when a read fails, and reads again on the next change", async () => {
    const s = source();
    const applied: WindowFrame[] = [];
    await followWindowFrame(s.listen, s.read, (f) => applied.push(f));
    s.reads[0].reject(new Error("window gone"));
    await settle();
    expect(applied).toEqual([]);
    s.change();
    s.reads[1].resolve(frame(true));
    await settle();
    expect(applied).toEqual([frame(true)]);
  });

  it("applies nothing once stopped", async () => {
    const s = source();
    const applied: WindowFrame[] = [];
    const stop = await followWindowFrame(s.listen, s.read, (f) =>
      applied.push(f),
    );
    stop();
    s.reads[0].resolve(frame(true));
    await settle();
    expect(applied).toEqual([]);
    expect(s.calls).toEqual(["listen", "read", "unlisten"]);
  });
});
