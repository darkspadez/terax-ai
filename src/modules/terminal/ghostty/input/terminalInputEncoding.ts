export function normalizeTerminalPaste(text: string): string {
  return text.replace(/\r\n|\r|\n/g, "\r");
}

export function encodeTerminalPaste(
  text: string,
  bracketedPaste: boolean,
): string {
  const normalized = normalizeTerminalPaste(text);
  if (!bracketedPaste) return normalized;
  return `\x1b[200~${normalized.split("\x1b").join("␛")}\x1b[201~`;
}

export function encodeTerminalSubmission(
  text: string,
  bracketedPaste: boolean,
): string {
  const normalized = normalizeTerminalPaste(text);
  const payload =
    normalized.includes("\r") || normalized.includes("\x1b")
      ? encodeTerminalPaste(normalized, bracketedPaste)
      : normalized;
  return `${payload}\r`;
}

/**
 * A paste that would run commands: line breaks the shell receives as Enter.
 * Inside bracketed paste the program gets the text as one paste, and
 * `encodeTerminalPaste` neutralizes ESC so the bracket cannot be closed early
 * (Ghostty's `clipboard-paste-protection` with `clipboard-paste-bracketed-safe`).
 */
export function isUnsafePaste(text: string, bracketedPaste: boolean): boolean {
  return !bracketedPaste && /[\r\n]/.test(text);
}

/** Kitty keyboard progressive enhancement flags. */
const KITTY_KEYBOARD_ALL_FLAGS = 0b11111;
const KITTY_REPORT_EVENTS = 0b10;
const KITTY_REPORT_ALTERNATES = 0b100;

/**
 * The Kitty keyboard flags a program may turn on. Windows' inbox ConPTY
 * (conhost older than Windows Terminal 1.19's) reads input through a VT
 * parser that drops any CSI holding a `:` sub-parameter, unseen. Report-events
 * (2) puts one in every release and repeat and in every arrow, Home, End and
 * F1-F4 press (`CSI 1;1:1A`), report-alternates (4) in every shifted key
 * (`CSI 97:65;2u`), so a program asking for them (pi asks for 7) lost its
 * arrows. Windows withholds both, and a query reports what is in force.
 * Associated text (16) puts `:` only between code points of multi-code-point
 * text, which a key rarely types.
 */
export function supportedKittyKeyboardFlags(
  platform: "linux" | "macos" | "windows" | "other",
): number {
  return platform === "windows"
    ? KITTY_KEYBOARD_ALL_FLAGS & ~(KITTY_REPORT_EVENTS | KITTY_REPORT_ALTERNATES)
    : KITTY_KEYBOARD_ALL_FLAGS;
}
