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
