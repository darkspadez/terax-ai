/**
 * The message a built-in command sends (`composer.tsx`): its marker, any
 * blocks, then the command's directive, which quotes the user's own words in
 * a `<request>` when the command takes any. The transcript shows the marker
 * as the command (`AiChat.tsx`); a conversation's title names the command by
 * those words or by its label (`deriveTitle`). Pure, and free of the
 * commands' icons and stores, so the conversation list can read it in every
 * window.
 */

/** Each built-in command's label (`SLASH_COMMANDS`). */
export const COMMAND_LABELS = {
  init: "Initialize workspace",
  plan: "Plan mode",
  "claude-code": "Delegate to Claude Code",
} as const;

const LABELS: ReadonlyMap<string, string> = new Map(
  Object.entries(COMMAND_LABELS),
);

export const TERAX_CMD_RE =
  /^<terax-command\s+name="([a-z0-9-]+)"(?:\s+state="([a-z]+)")?\s*\/>(?:\n+|$)/;

const REQUEST_OPEN = "<request>\n";
const REQUEST_CLOSE = "\n</request>";

/** The user's own words as a command's directive quotes them. */
export function quoteRequest(request: string): string {
  return `${REQUEST_OPEN}${request}${REQUEST_CLOSE}`;
}

/**
 * What a sent command is called in its conversation's title: the user's own
 * words its directive quotes (`/claude-code fix the build`), else the
 * command's label, else its invocation. `directive` is the message after the
 * marker, without its blocks; the rest of it is Terax's text, never a title.
 */
export function commandTitle(name: string, directive: string): string {
  const open = directive.indexOf(REQUEST_OPEN);
  const start = open + REQUEST_OPEN.length;
  const end = directive.lastIndexOf(REQUEST_CLOSE);
  const own = open !== -1 && end >= start ? directive.slice(start, end) : "";
  return own.trim() || (LABELS.get(name) ?? `/${name}`);
}
