import { isPrimaryClick } from "@/lib/nativeContextMenu";
import { IS_MAC } from "@/lib/platform";
import { isTerminalSurfaceTarget } from "@/modules/terminal/lib/terminalSurfaceTarget";
import { useCallback, useEffect, useState } from "react";

/**
 * A mouseup that can end a selection to ask about: the primary button, in a
 * terminal or an editor. A right click only opens the context menu.
 */
export function endsContentSelection(
  event: Pick<MouseEvent, "button" | "ctrlKey" | "target">,
  isMac: boolean = IS_MAC,
): boolean {
  // A right click (or a Control-click on macOS) on a selection opens the
  // text menu, not Ask AI too.
  if (!isPrimaryClick(event, isMac)) return false;
  const el = event.target as HTMLElement | null;
  return isTerminalSurfaceTarget(event.target) || !!el?.closest?.(".cm-editor");
}

type Params = {
  captureActiveSelection: () => string | null;
  askFromSelection: () => void;
  /** Settings' "Ask Oarlock on selected text"; off, no popup and no listeners. */
  enabled: boolean;
};

/**
 * Tracks text selections inside the terminal / editor and surfaces the
 * "Ask AI" popup at the pointer. Dismisses on any click outside the AI surface.
 */
export function useSelectionAskAi({
  captureActiveSelection,
  askFromSelection,
  enabled,
}: Params) {
  const [askPopup, setAskPopup] = useState<{ x: number; y: number } | null>(
    null,
  );
  // Turned off while it shows: it goes, and does not come back when the
  // setting is turned on again.
  if (!enabled && askPopup !== null) setAskPopup(null);

  useEffect(() => {
    if (!enabled) return;
    const isInsideAi = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el) return false;
      return !!(
        el.closest("[data-selection-ask-ai]") ||
        el.closest("[data-ai-input-bar]") ||
        el.closest("[data-ai-mini-window]")
      );
    };

    const onDown = (e: MouseEvent) => {
      if (isInsideAi(e.target)) return;
      setAskPopup(null);
    };
    const onUp = (e: MouseEvent) => {
      if (isInsideAi(e.target) || !endsContentSelection(e)) return;
      // Defer one tick so the terminal and CodeMirror finalize the selection.
      setTimeout(() => {
        const text = captureActiveSelection();
        if (text && text.trim().length > 0) {
          setAskPopup({ x: e.clientX, y: e.clientY });
        } else {
          setAskPopup(null);
        }
      }, 0);
    };

    document.addEventListener("mousedown", onDown);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("mouseup", onUp);
    };
  }, [captureActiveSelection, enabled]);

  const onAskFromSelection = useCallback(() => {
    askFromSelection();
    setAskPopup(null);
  }, [askFromSelection]);

  return { askPopup, setAskPopup, onAskFromSelection };
}
