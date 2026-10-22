// Renames reported by the explorer, keyed by the (from, to) pair of an open
// editor tab. A document session consumes one when its path changes, so a
// moved file keeps its buffer instead of reloading from disk and dropping
// unsaved edits.
//
// Only tabs with a mounted pane (not `cold`) note a retarget, one note per
// tab, and every path change of a mounted pane consumes the matching note
// whether or not it keeps the buffer. The same file can be open in several
// tabs, hence the count.
const pending = new Map<string, number>();

const key = (from: string, to: string) => `${from}\0${to}`;

export function noteRetarget(from: string, to: string): void {
  if (from === to) return;
  const k = key(from, to);
  pending.set(k, (pending.get(k) ?? 0) + 1);
}

/** True once per noted rename; false for any other path change. */
export function consumeRetarget(from: string, to: string): boolean {
  const k = key(from, to);
  const n = pending.get(k);
  if (n === undefined) return false;
  if (n <= 1) pending.delete(k);
  else pending.set(k, n - 1);
  return true;
}
