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
 * as in Ghostty and Windows Terminal. App shortcuts on those chords run only
 * when focus is elsewhere; the app's Ctrl+Shift chords, and Ctrl with Tab,
 * digits, arrows, `,`, `=` and `-`, stay the app's. macOS app shortcuts use
 * Cmd, which programs do not get. Ask-about-selection only fires while
 * terminal text is selected, so it keeps its key.
 */
export function shouldDeferShortcutToTerminal(
  id: ShortcutId,
  e: Pick<
    KeyboardEvent,
    "ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "key" | "code"
  >,
  opts: { readonly isMac: boolean; readonly inTerminal: boolean },
): boolean {
  if (opts.isMac || !opts.inTerminal || id === "ai.askSelection") return false;
  if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return false;
  return (
    /^[a-z]$/i.test(e.key) ||
    /^Key[A-Z]$/.test(e.code) ||
    CONTROL_PUNCTUATION_CODES.has(e.code)
  );
}
