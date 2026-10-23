/**
 * The blocks a user message carries ahead of the user's own words: attached
 * files, selections, snippets, an invoked skill, an MCP resource or prompt.
 * Each is the opening tag, a newline, its text, a newline and the closing
 * tag. Attribute values are escaped as XML escapes them (newlines too, so an
 * opening tag stays one line), and in a block's text the closing tag of
 * every kind is escaped (`<\/file>`): no content ends its block early,
 * closes another or reads to the model as the user's own words.
 * `messageChips.ts` reads them back for the transcript. Pure.
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

const ATTRIBUTE_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  '"': "&quot;",
  "<": "&lt;",
  "\n": "&#10;",
  "\r": "&#13;",
};

/** A value as an attribute holds it: `unescapeAttribute` gives it back. */
export function escapeAttribute(value: string): string {
  return value.replace(/[&"<\n\r]/g, (c) => ATTRIBUTE_ESCAPES[c]);
}

/** A closing tag of any block, whatever its case or spacing. */
const BLOCK_END_RE = new RegExp(`<\\/(?=\\s*(?:${KINDS})\\s*>)`, "gi");

/** Text for inside a block: every block's closing tag escaped. */
export function escapeBlockText(text: string): string {
  return text.replace(BLOCK_END_RE, "<\\/");
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
