import type { PtySession } from "./pty-bridge";

/**
 * Input, and separately terminal replies, queued behind a PTY that is not
 * reading; more is refused.
 */
const MAX_PENDING_BYTES = 256 * 1024;
/**
 * The largest terminal reply taken past that budget: a Kitty clipboard
 * answer carries up to 32 MiB as base64 (`terminalIntegration.ts`).
 */
const MAX_REPLY_BYTES = 64 * 1024 * 1024;
const MAX_WRITE_BATCH_BYTES = 64 * 1024;

/**
 * One session's input to its PTY, in order, one write in flight at a time,
 * small chunks batched.
 */
export class BoundedPtyWriter {
  private readonly queue: { bytes: Uint8Array; reply: boolean }[] = [];
  private pty: PtySession | null = null;
  private flushing = false;
  private disposed = false;
  private inputBytes = 0;
  private replyBytes = 0;

  constructor(private readonly onError: (error: unknown) => void) {}

  attach(pty: PtySession): void {
    if (this.disposed) return;
    this.pty = pty;
    void this.flush();
  }

  detach(): void {
    this.pty = null;
  }

  /** Bytes queued and not yet handed to the PTY. */
  get pendingBytes(): number {
    return this.inputBytes + this.replyBytes;
  }

  clear(): void {
    this.queue.length = 0;
    this.inputBytes = 0;
    this.replyBytes = 0;
  }

  /**
   * Queues `bytes`; false when refused. Terminal replies (`reply`) have a
   * budget of their own, so answers a program asked for never crowd out what
   * the user types; one may exceed it while no backlog beyond it is queued,
   * so a large answer goes through and a program that does not read its
   * input still cannot grow the queue without bound.
   */
  enqueue(bytes: Uint8Array, reply = false): boolean {
    if (this.disposed || bytes.byteLength === 0) return false;
    const queued = reply ? this.replyBytes : this.inputBytes;
    const fits =
      queued + bytes.byteLength <= MAX_PENDING_BYTES ||
      (reply &&
        queued <= MAX_PENDING_BYTES &&
        bytes.byteLength <= MAX_REPLY_BYTES);
    if (!fits) return false;
    this.queue.push({ bytes, reply });
    if (reply) this.replyBytes += bytes.byteLength;
    else this.inputBytes += bytes.byteLength;
    void this.flush();
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.pty = null;
    this.clear();
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.disposed || !this.pty) return;
    this.flushing = true;
    try {
      while (!this.disposed && this.pty && this.queue.length > 0) {
        const pty = this.pty;
        const batch = this.takeBatch();
        try {
          await pty.write(batch);
        } catch (error) {
          this.onError(error);
          return;
        }
      }
    } finally {
      this.flushing = false;
      if (!this.disposed && this.pty && this.queue.length > 0) {
        queueMicrotask(() => void this.flush());
      }
    }
  }

  private takeBatch(): Uint8Array {
    let length = 0;
    let count = 0;
    while (count < this.queue.length) {
      const nextLength = this.queue[count].bytes.byteLength;
      if (count > 0 && length + nextLength > MAX_WRITE_BATCH_BYTES) break;
      length += nextLength;
      count += 1;
      if (length >= MAX_WRITE_BATCH_BYTES) break;
    }

    const taken = this.queue.splice(0, count);
    for (const { bytes, reply } of taken) {
      if (reply) this.replyBytes -= bytes.byteLength;
      else this.inputBytes -= bytes.byteLength;
    }
    if (taken.length === 1) return taken[0].bytes;
    const batch = new Uint8Array(length);
    let offset = 0;
    for (const { bytes } of taken) {
      batch.set(bytes, offset);
      offset += bytes.byteLength;
    }
    return batch;
  }
}
