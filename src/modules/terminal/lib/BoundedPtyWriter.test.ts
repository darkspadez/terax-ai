import { describe, expect, it, vi } from "vitest";
import { BoundedPtyWriter } from "./BoundedPtyWriter";
import type { PtySession } from "./pty-bridge";

const KiB = 1024;

/** A PTY whose writes complete when the test says. */
function stalledPty() {
  const writes: Uint8Array[] = [];
  let release: (() => void) | undefined;
  const pty: PtySession = {
    id: 1,
    write: vi.fn(async (data: string | Uint8Array) => {
      writes.push(data as Uint8Array);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }),
    resize: async () => undefined,
    close: async () => undefined,
  };
  return { pty, writes, release: () => release?.() };
}

describe("BoundedPtyWriter", () => {
  it("refuses input past its budget while the PTY is not reading", () => {
    const writer = new BoundedPtyWriter(() => undefined);
    expect(writer.enqueue(new Uint8Array(200 * KiB))).toBe(true);
    expect(writer.enqueue(new Uint8Array(100 * KiB))).toBe(false);
    expect(writer.enqueue(new Uint8Array(56 * KiB))).toBe(true);
    expect(writer.pendingBytes).toBe(256 * KiB);
  });

  it("takes a large reply the program asked for once, then refuses more replies", () => {
    const writer = new BoundedPtyWriter(() => undefined);
    writer.enqueue(new Uint8Array(250 * KiB));
    // A clipboard answer far past the budget goes through.
    expect(writer.enqueue(new Uint8Array(40 * KiB * KiB), true)).toBe(true);
    // With that backlog no more replies are taken; typing still is.
    expect(writer.enqueue(new Uint8Array(1), true)).toBe(false);
    expect(writer.enqueue(new Uint8Array(6 * KiB))).toBe(true);
    expect(writer.enqueue(new Uint8Array(1))).toBe(false);
    expect(writer.pendingBytes).toBe(256 * KiB + 40 * KiB * KiB);
    // Larger than any answer the core makes: refused.
    expect(
      new BoundedPtyWriter(() => undefined).enqueue(
        new Uint8Array(65 * KiB * KiB),
        true,
      ),
    ).toBe(false);
  });

  it("writes in order, one write in flight, a large reply unbatched", async () => {
    const { pty, writes, release } = stalledPty();
    const writer = new BoundedPtyWriter(() => undefined);
    writer.enqueue(Uint8Array.of(1));
    writer.attach(pty);
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    writer.enqueue(Uint8Array.of(2));
    const answer = new Uint8Array(1024 * KiB).fill(7);
    writer.enqueue(answer, true);
    writer.enqueue(Uint8Array.of(3));
    expect(writes).toHaveLength(1);

    release();
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect([...writes[1]]).toEqual([2]);
    release();
    await vi.waitFor(() => expect(writes).toHaveLength(3));
    expect(writes[2]).toBe(answer);
    release();
    await vi.waitFor(() => expect(writes).toHaveLength(4));
    expect([...writes[3]]).toEqual([3]);
    expect(writer.pendingBytes).toBe(0);
    release();
    // Budgets are freed as writes are taken.
    expect(writer.enqueue(new Uint8Array(40 * KiB * KiB), true)).toBe(true);
  });
});
