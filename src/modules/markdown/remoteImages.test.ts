import { describe, expect, it, vi } from "vitest";
import { decodeImagePayload, RemoteImageCache } from "./remoteImages";

describe("decodeImagePayload", () => {
  it("reads the type ahead of the bytes", async () => {
    const type = new TextEncoder().encode("image/svg+xml");
    const bytes = new Uint8Array([type.length, ...type, 60, 115]);
    const blob = decodeImagePayload(bytes.buffer);
    expect(blob.type).toBe("image/svg+xml");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new Uint8Array([60, 115]),
    );
  });

  it("rejects truncated payloads", () => {
    expect(() => decodeImagePayload(new ArrayBuffer(0))).toThrow();
    expect(() => decodeImagePayload(new Uint8Array([9, 1]).buffer)).toThrow();
  });
});

function setup(idleLimit = 2) {
  const load = vi.fn(async (url: string) => {
    if (url.includes("fail")) throw new Error("404");
    return new Blob([url]);
  });
  let n = 0;
  const create = vi.fn(() => `blob:${++n}`);
  const revoke = vi.fn();
  return {
    load,
    revoke,
    cache: new RemoteImageCache(load, create, revoke, idleLimit),
  };
}

describe("RemoteImageCache", () => {
  it("shares one download between previews showing the same image", async () => {
    const { cache, load } = setup();
    const [a, b] = await Promise.all([
      cache.acquire("https://x/a.png"),
      cache.acquire("https://x/a.png"),
    ]);
    expect(a).toBe(b);
    expect(load).toHaveBeenCalledOnce();
  });

  it("keeps a few unused images for a re-render and revokes older ones", async () => {
    const { cache, load, revoke } = setup(1);
    const a = await cache.acquire("https://x/a.png");
    cache.release("https://x/a.png");
    expect(await cache.acquire("https://x/a.png")).toBe(a);
    cache.release("https://x/a.png");
    await cache.acquire("https://x/b.png");
    cache.release("https://x/b.png");
    await Promise.resolve();
    expect(revoke).toHaveBeenCalledWith(a);
    await cache.acquire("https://x/a.png");
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("never revokes an image still on screen", async () => {
    const { cache, revoke } = setup(0);
    await cache.acquire("https://x/a.png");
    await cache.acquire("https://x/a.png");
    cache.release("https://x/a.png");
    expect(revoke).not.toHaveBeenCalled();
  });

  it("retries an image that failed to load", async () => {
    const { cache, load } = setup();
    await expect(cache.acquire("https://x/fail.png")).rejects.toThrow("404");
    cache.release("https://x/fail.png");
    await expect(cache.acquire("https://x/fail.png")).rejects.toThrow("404");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
