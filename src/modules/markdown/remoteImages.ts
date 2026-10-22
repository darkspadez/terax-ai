import { invoke } from "@tauri-apps/api/core";

/** `[u8 type length][type][bytes]` from `markdown_remote_image`. */
export function decodeImagePayload(buffer: ArrayBuffer): Blob {
  const bytes = new Uint8Array(buffer);
  if (bytes.length === 0) throw new Error("empty image payload");
  const typeEnd = 1 + bytes[0];
  if (typeEnd > bytes.length) throw new Error("truncated image payload");
  const type = new TextDecoder().decode(bytes.subarray(1, typeEnd));
  return new Blob([bytes.subarray(typeEnd)], { type });
}

type Entry = { refs: number; url: Promise<string> };

/**
 * Object URLs for remote images, shared by every preview showing them.
 * Images on screen stay alive; up to `idleLimit` unused ones are kept for a
 * re-render (a refreshed preview remounts its images), older ones are
 * revoked. A failed load is forgotten so the next mount tries again.
 */
export class RemoteImageCache {
  private readonly entries = new Map<string, Entry>();
  // Unused URLs, oldest first.
  private readonly idle: string[] = [];

  constructor(
    private readonly load: (url: string) => Promise<Blob>,
    private readonly create: (blob: Blob) => string,
    private readonly revoke: (objectUrl: string) => void,
    private readonly idleLimit = 32,
  ) {}

  acquire(url: string): Promise<string> {
    let entry = this.entries.get(url);
    if (entry) {
      const i = this.idle.indexOf(url);
      if (i !== -1) this.idle.splice(i, 1);
    } else {
      const created: Entry = {
        refs: 0,
        url: this.load(url).then(this.create, (error) => {
          if (this.entries.get(url) === created) this.drop(url);
          throw error;
        }),
      };
      entry = created;
      this.entries.set(url, entry);
    }
    entry.refs += 1;
    return entry.url;
  }

  release(url: string): void {
    const entry = this.entries.get(url);
    if (!entry || entry.refs === 0) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    this.idle.push(url);
    while (this.idle.length > this.idleLimit) {
      const oldest = this.idle.shift();
      if (oldest === undefined) break;
      const evicted = this.entries.get(oldest);
      this.entries.delete(oldest);
      void evicted?.url.then(this.revoke, () => {});
    }
  }

  private drop(url: string): void {
    this.entries.delete(url);
    const i = this.idle.indexOf(url);
    if (i !== -1) this.idle.splice(i, 1);
  }
}

export const remoteImages = new RemoteImageCache(
  async (url) =>
    decodeImagePayload(
      await invoke<ArrayBuffer>("markdown_remote_image", { url }),
    ),
  (blob) => URL.createObjectURL(blob),
  (objectUrl) => URL.revokeObjectURL(objectUrl),
);
