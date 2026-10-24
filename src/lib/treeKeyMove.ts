/**
 * A row of a two-way tree list (the Source Control tree, search results).
 * `branch` is set on a row that holds others: its id and whether it is closed.
 */
export type TreeNavRow = {
  readonly key: string;
  readonly parentKey: string | null;
  readonly branch?: { readonly id: string; readonly collapsed: boolean };
};

export type TreeKeyMove =
  | { readonly toggle: string }
  | { readonly focus: string }
  | null;

/**
 * What Right ("in") or Left ("out") does on the focused row, as in the
 * explorer: Right opens a closed branch, then moves into it; Left closes an
 * open branch, then moves to the row above it. `next` is the row after it.
 */
export function treeKeyMove(
  focused: TreeNavRow,
  next: TreeNavRow | undefined,
  direction: "in" | "out",
): TreeKeyMove {
  const branch = focused.branch;
  if (direction === "in") {
    if (!branch) return null;
    if (branch.collapsed) return { toggle: branch.id };
    return next && next.parentKey === focused.key ? { focus: next.key } : null;
  }
  if (branch && !branch.collapsed) return { toggle: branch.id };
  return focused.parentKey ? { focus: focused.parentKey } : null;
}
