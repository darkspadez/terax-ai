import { isMainWindow } from "@/lib/appWindow";
import { IS_MAC } from "@/lib/platform";
import {
  macFullDiskAccessSuggested,
  setMacFullDiskAccessSuggested,
} from "@/modules/settings/store";
import { useEffect } from "react";

let started = false;

/**
 * On macOS the main window may suggest Full Disk Access once per launch
 * (`firstRun.ts`); once the notice is answered, nothing of it loads again.
 */
export function useFullDiskAccessSuggestion(): void {
  useEffect(() => {
    if (!IS_MAC || started || !isMainWindow()) return;
    started = true;
    void (async () => {
      if (await macFullDiskAccessSuggested()) return;
      const { suggestFullDiskAccess } = await import("./firstRun");
      await suggestFullDiskAccess(setMacFullDiskAccessSuggested);
    })().catch((error) =>
      console.error("[mac-privacy] Full Disk Access suggestion failed:", error),
    );
  }, []);
}
