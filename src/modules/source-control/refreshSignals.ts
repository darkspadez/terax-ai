import type { Tab } from "@/modules/tabs";
import { findLeafCwd, hasLeaf } from "@/modules/terminal/lib/panes";

export type RefreshCoalescer = {
  signal: () => void;
  dispose: () => void;
};

/**
 * Turns bursts of change signals into refreshes: one refresh `quietMs` after
 * the last signal, at most `maxWaitMs` after the first, never two at once, and
 * one more after a refresh a signal arrived during, since that refresh may have
 * read the repository before the change.
 */
export function createRefreshCoalescer(options: {
  run: () => Promise<unknown>;
  quietMs: number;
  maxWaitMs: number;
}): RefreshCoalescer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstAt: number | null = null;
  let running = false;
  let pending = false;
  let disposed = false;

  const fire = () => {
    timer = null;
    firstAt = null;
    running = true;
    void options
      .run()
      .catch(() => {})
      .finally(() => {
        running = false;
        if (pending && !disposed) {
          pending = false;
          signal();
        }
      });
  };

  function signal() {
    if (disposed) return;
    if (running) {
      pending = true;
      return;
    }
    const now = Date.now();
    firstAt ??= now;
    if (timer !== null) clearTimeout(timer);
    const delay = Math.min(options.quietMs, firstAt + options.maxWaitMs - now);
    timer = setTimeout(fire, Math.max(0, delay));
  }

  return {
    signal,
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

/** Panes whose command finished between two terminal status snapshots. */
export function finishedCommandLeaves(
  previous: Readonly<Record<number, { running: boolean }>>,
  next: Readonly<Record<number, { running: boolean }>>,
): number[] {
  if (previous === next) return [];
  const finished: number[] = [];
  for (const [id, status] of Object.entries(previous)) {
    if (!status.running) continue;
    const now = next[Number(id)];
    if (now && !now.running) finished.push(Number(id));
  }
  return finished;
}

/** The directory a terminal pane is in, as its shell last reported it. */
export function terminalLeafCwd(
  tabs: readonly Tab[],
  leafId: number,
): string | null {
  for (const tab of tabs) {
    if (tab.kind !== "terminal" || !hasLeaf(tab.paneTree, leafId)) continue;
    return findLeafCwd(tab.paneTree, leafId) ?? tab.cwd ?? null;
  }
  return null;
}
