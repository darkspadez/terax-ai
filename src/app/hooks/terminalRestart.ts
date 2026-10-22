import type { Tab } from "@/modules/tabs";

/** The pane "Restart terminal" acts on: the active terminal tab's own pane. */
export function restartTarget(
  tabs: readonly Tab[],
  activeId: number,
): number | null {
  const tab = tabs.find((t) => t.id === activeId);
  return tab?.kind === "terminal" ? tab.activeLeafId : null;
}

/**
 * Restarting ends whatever runs in the pane, so a running program is
 * confirmed first, as when its tab closes. Opting out of that prompt skips the
 * check (one IPC) altogether.
 */
export async function planTerminalRestart(
  leafId: number,
  isBusy: (leafId: number) => Promise<boolean>,
  confirmRunningTerminal: boolean,
): Promise<"restart" | "confirm"> {
  if (!confirmRunningTerminal) return "restart";
  return (await isBusy(leafId)) ? "confirm" : "restart";
}
