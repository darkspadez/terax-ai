import type { NewTabPosition } from "@/modules/settings/store";
import type { Tab } from "./useTabs";

/** Puts a new tab into the list; the strip shows a space's tabs in list order. */
export type TabInserter = (tabs: readonly Tab[], tab: Tab) => Tab[];

export const appendTab: TabInserter = (tabs, tab) => [...tabs, tab];

/**
 * Where a tab the user opens goes. With "afterCurrent" it follows the active
 * tab when it joins that tab's space; a tab opened in another space or in the
 * background goes to the end, so a burst of them keeps its order.
 */
export function newTabInserter(
  position: NewTabPosition,
  activeId: number,
  activates = true,
): TabInserter {
  if (position !== "afterCurrent" || !activates) return appendTab;
  return (tabs, tab) => {
    const index = tabs.findIndex((t) => t.id === activeId);
    if (index < 0 || tabs[index].spaceId !== tab.spaceId) {
      return [...tabs, tab];
    }
    return [...tabs.slice(0, index + 1), tab, ...tabs.slice(index + 1)];
  };
}
