import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  parseSidebarPosition,
  type SidebarPosition,
} from "@/modules/settings/store";
import { useEffect, useState } from "react";

const SIDEBAR_POSITION_STORAGE_KEY = "oarlock.sidebar.position";

/**
 * The side the window last laid the sidebar out on. Preferences load after the
 * first paint, so without this copy a right-docked sidebar would start on the
 * left and jump across at every launch.
 */
function readSidebarPositionShadow(): SidebarPosition {
  try {
    return parseSidebarPosition(
      window.localStorage.getItem(SIDEBAR_POSITION_STORAGE_KEY),
    );
  } catch {
    return "left";
  }
}

function writeSidebarPositionShadow(position: SidebarPosition): void {
  try {
    window.localStorage.setItem(SIDEBAR_POSITION_STORAGE_KEY, position);
  } catch {
    // storage may fail in private mode
  }
}

/** The stored preference once it has loaded, the window's last side until then. */
export function resolveSidebarPosition(
  hydrated: boolean,
  stored: unknown,
  shadow: SidebarPosition,
): SidebarPosition {
  return hydrated ? parseSidebarPosition(stored) : shadow;
}

/**
 * Panel id per side. A new id makes react-resizable-panels register the panel
 * again, which is when it sorts panels and separators into their visual order:
 * the side is swapped with CSS `order`, so no DOM moves and nothing remounts.
 */
export function sidebarPanelId(position: SidebarPosition): string {
  return `sidebar-${position}`;
}

export function useSidebarPosition(): SidebarPosition {
  const hydrated = usePreferencesStore((s) => s.hydrated);
  const stored = usePreferencesStore((s) => s.sidebarPosition);
  const [shadow] = useState(readSidebarPositionShadow);
  const position = resolveSidebarPosition(hydrated, stored, shadow);

  useEffect(() => {
    if (hydrated) writeSidebarPositionShadow(position);
  }, [hydrated, position]);

  return position;
}
