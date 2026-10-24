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

/** Ctrl with these physical keys types control characters too (ESC, GS, FS, US). */
const CONTROL_PUNCTUATION_CODES = new Set([
  "BracketLeft",
  "BracketRight",
  "Backslash",
  "Slash",
]);

/**
 * Windows and Linux: a focused terminal keeps Ctrl+<letter> and Ctrl+[ ] \ /
 * with no other modifier, the control characters shells and full-screen
 * programs read (EOF, reverse search, kill word, Escape, OpenCode's palette),
 * as in Ghostty and Windows Terminal. App shortcuts on those chords, the
 * second binding of every Ctrl+Shift shortcut (`defaultShortcuts`), run only
 * when focus is elsewhere; Ctrl+Shift chords, and Ctrl with Tab, digits,
 * arrows, `,`, `=` and `-`, stay the app's. macOS app shortcuts use Cmd,
 * which programs do not get.
 */
export function shouldDeferShortcutToTerminal(
  e: Pick<
    KeyboardEvent,
    "ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "key" | "code"
  >,
  opts: { readonly isMac: boolean; readonly inTerminal: boolean },
): boolean {
  if (opts.isMac || !opts.inTerminal) return false;
  if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return false;
  return (
    /^[a-z]$/i.test(e.key) ||
    /^Key[A-Z]$/.test(e.code) ||
    CONTROL_PUNCTUATION_CODES.has(e.code)
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

/**
 * Marks a text box that handles modifier chords itself (`mod+<key>`; several
 * keys separated by spaces).
 */
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
  return (
    !!claimed && claimed.split(" ").some((key) => isModChord(e, key, isMac))
  );
}
