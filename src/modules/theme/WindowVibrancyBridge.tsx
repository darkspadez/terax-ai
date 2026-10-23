import { usePreferencesStore } from "@/modules/settings/preferences";
import { useEffect } from "react";
import { useTheme } from "./ThemeProvider";
import { applyVibrancy } from "./vibrancy";

/**
 * The window's backdrop: vibrancy and translucent terminals. App windows only:
 * `window_set_backdrop` targets its caller.
 */
export function WindowVibrancyBridge() {
  const enabled = usePreferencesStore((s) => s.windowVibrancy);
  const terminalOpacity = usePreferencesStore((s) => s.terminalOpacity);
  const hydrated = usePreferencesStore((s) => s.hydrated);
  const { resolvedMode, activeTheme } = useTheme();

  // The theme object, not only its id: an edit can change its terminal
  // background's alpha.
  useEffect(() => {
    if (!hydrated) return;
    void applyVibrancy(
      enabled,
      resolvedMode === "dark",
      activeTheme.id,
      terminalOpacity,
    );
  }, [enabled, hydrated, resolvedMode, activeTheme, terminalOpacity]);

  return null;
}
