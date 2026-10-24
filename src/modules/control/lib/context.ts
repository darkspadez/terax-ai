import { appWindowLabel } from "@/lib/appWindow";
import type { Tab } from "@/modules/tabs/lib/useTabs";
import { hasLeaf } from "@/modules/terminal/lib/panes";

export type ControlContext = {
  /** The app window answering (`appWindow.ts`). */
  window_id: string;
  space_id: string;
  tab_id: number | null;
  pane_id: number | null;
  source: "caller" | "active";
};

export function resolveControlContext(
  tabs: Tab[],
  activeTabId: number,
  activeSpaceId: string,
  callerPaneId?: number,
): ControlContext {
  if (callerPaneId != null) {
    const callerTab = tabs.find(
      (tab) => tab.kind === "terminal" && hasLeaf(tab.paneTree, callerPaneId),
    );
    if (callerTab?.kind === "terminal") {
      return {
        window_id: appWindowLabel(),
        space_id: callerTab.spaceId,
        tab_id: callerTab.id,
        pane_id: callerPaneId,
        source: "caller",
      };
    }
  }

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  return {
    window_id: appWindowLabel(),
    space_id: activeTab?.spaceId ?? activeSpaceId,
    tab_id: activeTab?.id ?? null,
    pane_id: activeTab?.kind === "terminal" ? activeTab.activeLeafId : null,
    source: "active",
  };
}
