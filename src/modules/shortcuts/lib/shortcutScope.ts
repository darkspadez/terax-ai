import type { ShortcutId } from "@/modules/shortcuts/shortcuts";

function isPaneSwapShortcut(id: ShortcutId): boolean {
  return (
    id === "pane.swapLeft" ||
    id === "pane.swapRight" ||
    id === "pane.swapUp" ||
    id === "pane.swapDown"
  );
}

export function shouldDisablePaneSwapShortcut(
  id: ShortcutId,
  terminalPaneCount: number | null,
): boolean {
  return (
    isPaneSwapShortcut(id) &&
    (terminalPaneCount === null || terminalPaneCount < 2)
  );
}

type ModChord = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

/** Exactly the platform modifier (⌘ on macOS, Ctrl elsewhere) plus `key`. */
export function isModChord(e: ModChord, key: string, isMac: boolean): boolean {
  const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === key;
}

/** Marks a text box that handles one modifier chord itself (`mod+<key>`). */
export const CLAIMS_MOD_KEY_ATTR = "data-claims-mod-key";

/**
 * Whether the focused element handles this chord itself, so a global shortcut
 * on the same chord must let it through: the commit message box generates a
 * message on ⌘G / Ctrl+G, which elsewhere toggles Source Control. `claimed` is
 * the `CLAIMS_MOD_KEY_ATTR` of the focused element or an ancestor.
 */
export function focusClaimsChord(
  e: ModChord,
  claimed: string | null | undefined,
  isMac: boolean,
): boolean {
  return !!claimed && isModChord(e, claimed, isMac);
}
