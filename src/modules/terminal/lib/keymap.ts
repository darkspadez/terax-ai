export type TerminalKeyEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "metaKey" | "key" | "code"
>;

export type PlatformOpts = { isMac: boolean };

/**
 * Keys that never compose text. WKWebView can stamp keyCode 229 (the IME's
 * "process" code) on Option+key events with no input method composing, and
 * an Option+Arrow or Option+Backspace taken for IME input was swallowed.
 */
const NON_COMPOSING_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/**
 * A keydown that belongs to an input method or dead key, which the terminal
 * leaves to the webview (its text arrives as input or composition events).
 * While a composition runs (`composing`, or `isComposing`) every key does;
 * otherwise keyCode 229 marks the keystroke that may start one, never a
 * navigation or deletion key.
 */
export function isInputMethodKeyDown(
  event: Pick<KeyboardEvent, "isComposing" | "keyCode" | "key">,
  composing: boolean,
): boolean {
  if (composing || event.isComposing) return true;
  if (event.key === "Dead" || event.key === "Process") return true;
  return event.keyCode === 229 && !NON_COMPOSING_KEYS.has(event.key);
}

export function terminalWordNavigationSequence(event: TerminalKeyEvent): string | null {
  if (!event.altKey || event.ctrlKey || event.metaKey) return null;
  if (event.key === "ArrowLeft" || event.code === "ArrowLeft") return "\x1bb";
  if (event.key === "ArrowRight" || event.code === "ArrowRight") return "\x1bf";
  return null;
}

/** Cmd+Left/Right → readline line-start (Ctrl+A) / line-end (Ctrl+E).
 * macOS-only — Cmd doesn't exist as a navigation modifier elsewhere. */
export function terminalLineNavigationSequence(
  event: TerminalKeyEvent,
  opts: PlatformOpts,
): string | null {
  if (!opts.isMac) return null;
  if (!event.metaKey || event.altKey || event.ctrlKey) return null;
  if (event.key === "ArrowLeft" || event.code === "ArrowLeft") return "\x01";
  if (event.key === "ArrowRight" || event.code === "ArrowRight") return "\x05";
  return null;
}

/** Modifier+Backspace deletion:
 *   macOS  Cmd+Backspace    → Ctrl+U (kill-to-line-start)
 *   macOS  Option+Backspace → Ctrl+W (kill-word-backward)
 *   Other  Ctrl+Backspace   → Ctrl+W (kill-word-backward)
 */
export function terminalDeleteSequence(
  event: TerminalKeyEvent,
  opts: PlatformOpts,
): string | null {
  if (event.key !== "Backspace" && event.code !== "Backspace") return null;
  if (opts.isMac) {
    if (event.metaKey && !event.altKey && !event.ctrlKey) return "\x15";
    if (event.altKey && !event.metaKey && !event.ctrlKey) return "\x17";
    return null;
  }
  if (event.ctrlKey && !event.altKey && !event.metaKey) return "\x17";
  return null;
}

export function terminalReadlineSequence(
  event: TerminalKeyEvent,
  opts: PlatformOpts & { isAlternateScreen: boolean },
): string | null {
  if (opts.isAlternateScreen) return null;
  return (
    terminalLineNavigationSequence(event, opts) ??
    terminalWordNavigationSequence(event) ??
    terminalDeleteSequence(event, opts)
  );
}

export type TerminalPlatform = "linux" | "macos" | "windows" | "other";

/**
 * A clipboard key in a terminal, before the program sees it:
 * - "copy": copy the selection; with nothing selected the key goes on to
 *   the program.
 * - "copyAndClear": the same, and the copied selection is cleared, so
 *   pressing the key again (Ctrl+C) interrupts.
 * - "paste": paste the clipboard.
 * - "pasteText": paste the clipboard's text; when it holds none the key goes
 *   to the program, which can read an image itself (Ctrl+V in agents).
 */
export type TerminalClipboardAction =
  | "copy"
  | "copyAndClear"
  | "paste"
  | "pasteText";

/**
 * Which clipboard action a key performs. macOS: Cmd+C and Cmd+V. Elsewhere:
 * Ctrl+Shift+C and Ctrl+Shift+V, plus Ctrl+Insert and Shift+Insert (Ghostty's
 * and Windows Terminal's defaults). Windows, unless `smartCopyPaste` is off,
 * also follows Windows Terminal: Ctrl+C copies a selection (and otherwise
 * interrupts) and Ctrl+V pastes. Linux keeps plain Ctrl+C and Ctrl+V for the
 * program (interrupt, readline's quoted insert).
 */
export function terminalClipboardAction(
  event: TerminalKeyEvent & Pick<KeyboardEvent, "shiftKey">,
  opts: { platform: TerminalPlatform; smartCopyPaste: boolean },
): TerminalClipboardAction | null {
  const letter = latinLetter(event);
  if (opts.platform === "macos") {
    if (!event.metaKey || event.ctrlKey || event.altKey) return null;
    return letter === "c" ? "copy" : letter === "v" ? "paste" : null;
  }
  if (event.metaKey || event.altKey) return null;
  if (event.key === "Insert") {
    if (event.ctrlKey !== event.shiftKey) return event.ctrlKey ? "copy" : "paste";
    return null;
  }
  if (!event.ctrlKey) return null;
  if (event.shiftKey) {
    return letter === "c" ? "copy" : letter === "v" ? "paste" : null;
  }
  if (opts.platform !== "windows" || !opts.smartCopyPaste) return null;
  return letter === "c" ? "copyAndClear" : letter === "v" ? "pasteText" : null;
}

/**
 * The Latin letter a key types; on layouts typing another script (Cyrillic,
 * Greek), the letter at its position, so Ctrl+C still copies there.
 */
function latinLetter(event: Pick<KeyboardEvent, "key" | "code">): string | null {
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase();
  return /^Key[A-Z]$/.test(event.code) ? event.code.charAt(3).toLowerCase() : null;
}
