import { cn } from "@/lib/utils";
import {
  leafIds,
  selectTerminalTabStatus,
  type TerminalProgress,
  useTerminalStatusStore,
} from "@/modules/terminal";
import { useShallow } from "zustand/react/shallow";
import { labelFor } from "./lib/tabLabel";
import type { TerminalTab } from "./lib/useTabs";

/**
 * A terminal tab's label: the user's name for it, else the title the program
 * running in its active pane set, else the cwd. Progress (OSC 9;4) and a bell
 * rung while the tab was out of sight are shown beside it.
 */
export function TerminalTabLabel({ tab }: { tab: TerminalTab }) {
  const status = useTerminalStatusStore(
    useShallow((state) =>
      selectTerminalTabStatus(
        state.leaves,
        leafIds(tab.paneTree),
        tab.activeLeafId,
      ),
    ),
  );
  const label = tab.customTitle || status.title || labelFor(tab);
  return (
    <>
      <span className="truncate" title={status.title ?? undefined}>
        {label}
      </span>
      {status.progress && <TabProgress progress={status.progress} />}
      {status.bell && (
        <span
          role="img"
          aria-label="Bell"
          className="size-1.5 shrink-0 rounded-full bg-primary"
        />
      )}
    </>
  );
}

const RING_RADIUS = 5;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

function TabProgress({ progress }: { progress: TerminalProgress }) {
  const indeterminate =
    progress.state === "indeterminate" || progress.value === null;
  const fraction = indeterminate ? 0.25 : (progress.value ?? 0) / 100;
  const label =
    progress.state === "error"
      ? "Failed"
      : progress.state === "pause"
        ? "Paused"
        : indeterminate
          ? "In progress"
          : `${progress.value}%`;
  return (
    <svg
      role="img"
      aria-label={`Progress: ${label}`}
      viewBox="0 0 12 12"
      className={cn(
        "size-3 shrink-0 -rotate-90",
        indeterminate && progress.state !== "pause" && "animate-spin",
        progress.state === "error"
          ? "text-destructive"
          : progress.state === "pause"
            ? "text-muted-foreground"
            : "text-primary",
      )}
    >
      <circle
        cx="6"
        cy="6"
        r={RING_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.25}
        strokeWidth={1.5}
      />
      <circle
        cx="6"
        cy="6"
        r={RING_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeDasharray={`${RING_LENGTH * fraction} ${RING_LENGTH}`}
      />
    </svg>
  );
}
