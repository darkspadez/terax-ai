/**
 * The blocks a user message carries ahead of the user's own words: attached
 * files, selections, snippets, an invoked skill, an MCP resource or prompt.
 * Each is the opening tag, a newline, its text, a newline and the closing
 * tag. Attribute values are escaped as XML escapes them (control characters
 * and line separators as character references, so an opening tag stays one
 * line), and in a block's text the closing tag of every kind is escaped
 * (`<\/file>`): no content ends its block early, closes another or reads to
 * the model as the user's own words. A name or path in a block's text stays
 * on its line (`jsonText`, `pathText`). `messageChips.ts` reads them back for
 * the transcript. Pure.
 *
 * Oarlock adds two blocks for the model only, never stored: the run's `<env>`
 * before the last user message (`transport.ts`) and each MCP server's
 * `<mcp-instructions>` in the system prompt (`agent.ts`). Their closing tags
 * are escaped too.
 */

/** Every kind of block, by its tag. */
export const MESSAGE_BLOCK_KINDS = [
  "file",
  "selection",
  "snippet",
  "skill",
  "mcp-resource",
  "mcp-prompt",
] as const;

export type MessageBlockKind = (typeof MESSAGE_BLOCK_KINDS)[number];

const KINDS = MESSAGE_BLOCK_KINDS.join("|");

/** The blocks Oarlock adds for the model only (see above). */
const MODEL_BLOCK_KINDS = ["env", "mcp-instructions"];

const ATTRIBUTE_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  '"': "&quot;",
  "<": "&lt;",
};

/** Control characters (C0, DEL, C1) and Unicode's line separators. */
const LINE_UNSAFE = "\\p{Cc}\\u2028\\u2029";

const ATTRIBUTE_UNSAFE_RE = new RegExp(`[&"<${LINE_UNSAFE}]`, "gu");

/** A value as an attribute holds it: `unescapeAttribute` gives it back. */
export function escapeAttribute(value: string): string {
  return value.replace(
    ATTRIBUTE_UNSAFE_RE,
    (c) => ATTRIBUTE_ESCAPES[c] ?? `&#${c.charCodeAt(0)};`,
  );
}

/** A closing tag of any block, whatever its case or spacing. */
const BLOCK_END_RE = new RegExp(
  `<\\/(?=\\s*(?:${[KINDS, ...MODEL_BLOCK_KINDS].join("|")})\\s*>)`,
  "gi",
);

/** Text for inside a block: every block's closing tag escaped. */
export function escapeBlockText(text: string): string {
  return text.replace(BLOCK_END_RE, "<\\/");
}

/** What `JSON.stringify` leaves raw that could still break a line. */
const JSON_UNSAFE_RE = new RegExp(`[${LINE_UNSAFE}]`, "gu");

/**
 * `value` as a JSON string, for a name or path in a block's text: one line
 * whatever it holds (every control character and line separator escaped),
 * and a closing tag in it escaped as `<\/`, which is JSON's own escape of
 * `/`, so it still reads back as written.
 */
export function jsonText(value: string): string {
  const json = JSON.stringify(value).replace(
    JSON_UNSAFE_RE,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return escapeBlockText(json);
}

/** A path that cannot be shown as it is: see `pathText`. */
const PATH_UNSAFE_RE = new RegExp(`[${LINE_UNSAFE}]|^["\\s]|\\s$`, "u");

/**
 * A path in a block's text: as it is (a Windows path keeps its single
 * backslashes), or as a JSON string (`jsonText`) when it holds a control
 * character, a line separator or a closing tag, begins with a quote, or
 * begins or ends with a space. So no path starts a line of its block or
 * ends the block.
 */
export function pathText(path: string): string {
  return PATH_UNSAFE_RE.test(path) || escapeBlockText(path) !== path
    ? jsonText(path)
    : path;
}

/** A text file the user attached. */
export function fileBlock(
  name: string,
  mediaType: string,
  text: string,
): string {
  return `<file name="${escapeAttribute(name)}" mediaType="${escapeAttribute(mediaType)}">\n${escapeBlockText(text)}\n</file>`;
}

/** Text the user selected in a terminal or the editor. */
export function selectionBlock(
  source: "terminal" | "editor",
  text: string,
): string {
  return `<selection source="${source}">\n${escapeBlockText(text)}\n</selection>`;
}

/** A prompt snippet the user picked or named with `#handle`. */
export function snippetBlock(handle: string, content: string): string {
  return `<snippet name="${escapeAttribute(handle)}">\n${escapeBlockText(content)}\n</snippet>`;
}

/**
 * Every block and the space after it, leftmost first and each up to its own
 * closing tag, for the text without them (a conversation's title).
 */
export const MESSAGE_BLOCKS_RE = new RegExp(
  `<(${KINDS})\\b[\\s\\S]*?<\\/\\1>\\s*`,
  "g",
);
