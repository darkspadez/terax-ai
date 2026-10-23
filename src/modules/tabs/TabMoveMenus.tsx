import {
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  type SplitPosition,
  type TerminalLeafStatus,
  useTerminalStatusStore,
} from "@/modules/terminal";
import {
  LayoutTwoColumnIcon,
  SquareArrowUpRightIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { labelFor, paneLabels } from "./lib/tabLabel";
import { moveToSplitTargets, type Tab, type TerminalTab } from "./lib/useTabs";

const ITEM = "gap-2 rounded-xl px-2.5 py-1.5 text-[13px]";

const POSITIONS: { position: SplitPosition; label: string }[] = [
  { position: "left", label: "Left" },
  { position: "right", label: "Right" },
  { position: "top", label: "Top" },
  { position: "bottom", label: "Bottom" },
];

/** The title a pane's running program set, as its tab label shows it. */
function runningTitle(
  leaves: Readonly<Record<number, TerminalLeafStatus>>,
  leafId: number,
): string | null {
  const leaf = leaves[leafId];
  return leaf?.running && leaf.title ? leaf.title : null;
}

/** "Move to split": a single-pane terminal tab joins another tab's split. */
export function MoveToSplitMenu({
  tabs,
  sourceId,
  onMove,
}: {
  tabs: Tab[];
  sourceId: number;
  onMove: (
    sourceId: number,
    destinationId: number,
    position: SplitPosition,
  ) => void;
}) {
  const paneLimit = usePreferencesStore((s) => s.terminalPaneLimit);
  const targets = moveToSplitTargets(tabs, sourceId, paneLimit);
  if (targets.length === 0) return null;
  const leaves = useTerminalStatusStore.getState().leaves;
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger className={ITEM}>
        <HugeiconsIcon
          icon={LayoutTwoColumnIcon}
          size={13}
          strokeWidth={1.75}
        />
        <span className="flex-1">Move to split</span>
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="max-w-64 p-1">
        {targets.map((target) => (
          <ContextMenuSub key={target.id}>
            <ContextMenuSubTrigger className={ITEM}>
              <span className="flex-1 truncate">
                {target.customTitle ||
                  runningTitle(leaves, target.activeLeafId) ||
                  labelFor(target)}
              </span>
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="p-1">
              {POSITIONS.map(({ position, label }) => (
                <ContextMenuItem
                  key={position}
                  className={ITEM}
                  onSelect={() => onMove(sourceId, target.id, position)}
                >
                  {label}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        ))}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

/** "Move pane to new tab": one pane of a split tab becomes its own tab. */
export function MovePaneToNewTabMenu({
  tab,
  onMove,
}: {
  tab: TerminalTab;
  onMove: (tabId: number, leafId: number) => void;
}) {
  if (tab.paneTree.kind === "leaf") return null;
  const leaves = useTerminalStatusStore.getState().leaves;
  const panes = paneLabels(tab, (leafId) => runningTitle(leaves, leafId));
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger className={ITEM}>
        <HugeiconsIcon
          icon={SquareArrowUpRightIcon}
          size={13}
          strokeWidth={1.75}
        />
        <span className="flex-1">Move pane to new tab</span>
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="max-w-64 p-1">
        {panes.map((pane) => (
          <ContextMenuItem
            key={pane.leafId}
            className={ITEM}
            onSelect={() => onMove(tab.id, pane.leafId)}
          >
            <span className="flex-1 truncate">{pane.name}</span>
            {pane.active && (
              <span className="text-[11px] text-muted-foreground">active</span>
            )}
          </ContextMenuItem>
        ))}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
