import type { GroupImperativeHandle } from "react-resizable-panels";
import {
  firstLeafSlotId,
  type PaneDirection,
  type PaneId,
  type PaneNode,
  splitIds,
  splitResizeTarget,
} from "./panes";

/** Resize step for one keyboard resize, in percent of the split. */
export const PANE_RESIZE_STEP = 5;
/** Matches the panels' `minSize`. */
const MIN_PANE_PERCENT = 10;

const groups = new Map<PaneId, GroupImperativeHandle>();

/** PaneTreeView registers each split's panel group under the split id. */
export function registerPaneGroup(
  splitId: PaneId,
  handle: GroupImperativeHandle | null,
): void {
  if (handle) groups.set(splitId, handle);
  else groups.delete(splitId);
}

/** The panel id PaneTreeView gives a split child. */
export function paneSlotPanelId(child: PaneNode): string {
  return `pane-slot-${firstLeafSlotId(child)}`;
}

/**
 * Moves one divider by `step` percent, keeping every pane at least the
 * minimum size. Pure: returns the new layout (or null when nothing moves).
 */
export function movedDivider(
  layout: Readonly<Record<string, number>>,
  panelIds: readonly string[],
  divider: number,
  delta: number,
): Record<string, number> | null {
  const before = panelIds[divider];
  const after = panelIds[divider + 1];
  const beforeSize = layout[before];
  const afterSize = layout[after];
  if (beforeSize === undefined || afterSize === undefined) return null;
  const clamped = Math.max(
    MIN_PANE_PERCENT - beforeSize,
    Math.min(afterSize - MIN_PANE_PERCENT, delta),
  );
  if (Math.abs(clamped) < 0.01) return null;
  return {
    ...layout,
    [before]: beforeSize + clamped,
    [after]: afterSize - clamped,
  };
}

/** Keyboard resize of the active pane; false when it has no divider that way. */
export function resizeActivePane(
  tree: PaneNode,
  activeId: PaneId,
  direction: PaneDirection,
  step = PANE_RESIZE_STEP,
): boolean {
  const target = splitResizeTarget(tree, activeId, direction);
  if (!target) return false;
  const group = groups.get(target.split.id);
  if (!group) return false;
  const next = movedDivider(
    group.getLayout(),
    target.split.children.map(paneSlotPanelId),
    target.divider,
    target.sign * step,
  );
  if (!next) return false;
  group.setLayout(next);
  return true;
}

/** Gives every pane of every split an equal share. */
export function equalizePanes(tree: PaneNode): void {
  const visit = (node: PaneNode) => {
    if (node.kind === "leaf") return;
    const group = groups.get(node.id);
    if (group) {
      const share = 100 / node.children.length;
      group.setLayout(
        Object.fromEntries(
          node.children.map((child) => [paneSlotPanelId(child), share]),
        ),
      );
    }
    node.children.forEach(visit);
  };
  if (splitIds(tree).length > 0) visit(tree);
}
