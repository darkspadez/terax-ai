// Eager (the composer reads every message): the rest of a prompt call loads on demand.
const INVOCATION_RE = /^\/([a-z0-9_.-]+:[a-z0-9_.-]+)(?:\s+([\s\S]*))?$/i;

/** `/server:prompt text`: the command (lowercase) and the text after it. */
export function parseMcpPromptInvocation(
  text: string,
): { command: string; text: string } | null {
  const match = INVOCATION_RE.exec(text.trim());
  return match
    ? { command: match[1].toLowerCase(), text: (match[2] ?? "").trim() }
    : null;
}
