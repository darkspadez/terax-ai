/** Clipboard writes one at a time, a burst coalesced to its latest value. */
export class LatestClipboardWrite<T = string> {
  private pending: { readonly value: T } | null = null;
  private running = false;

  constructor(private readonly write: (value: T) => Promise<void>) {}

  enqueue(value: T): void {
    this.pending = { value };
    if (this.running) return;
    this.running = true;
    queueMicrotask(() => void this.drain());
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending !== null) {
        const { value } = this.pending;
        this.pending = null;
        try {
          await this.write(value);
        } catch {
          /* Later writes can still succeed. */
        }
      }
    } finally {
      this.running = false;
    }
  }
}
