import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect } from "react";

/** `skills::EDIT_EVENT`: Settings asked this window to open a skill's SKILL.md. */
const SKILL_EDIT_EVENT = "oarlock:skill-edit";

/** Opens the SKILL.md Settings hands over in an editor tab; the backend already let the
 *  file commands reach its folder. */
export function useSkillEditRequests(openFileTab: (path: string) => void) {
  useEffect(() => {
    let alive = true;
    let stop: (() => void) | undefined;
    void getCurrentWebviewWindow()
      .listen<string>(SKILL_EDIT_EVENT, (event) => {
        if (typeof event.payload === "string" && event.payload) {
          openFileTab(event.payload);
        }
      })
      .then((unlisten) => {
        if (alive) stop = unlisten;
        else unlisten();
      });
    return () => {
      alive = false;
      stop?.();
    };
  }, [openFileTab]);
}
