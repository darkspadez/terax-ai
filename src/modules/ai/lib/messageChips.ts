import { MESSAGE_BLOCK_KINDS, type MessageBlockKind } from "./messageBlocks";

/**
 * A sent user message as the transcript shows it: its blocks (see
 * `messageBlocks.ts`) as chips, then the user's own text. Messages stored
 * before blocks were escaped read as they always did. Pure.
 */

export type ContextChip =
  | { kind: "selection"; source: "terminal" | "editor"; lines: number }
  | { kind: "file"; name: string; lines: number }
  | { kind: "snippet"; name: string }
  | { kind: "skill"; name: string }
  /** A resource or a prompt from an MCP server: the server's content. */
  | { kind: "mcp-resource" | "mcp-prompt"; server: string; name: string };

/** Chips show in this order of kind, as they always have. */
const CHIP_ORDER: readonly MessageBlockKind[] = [
  "mcp-prompt",
  "mcp-resource",
  "skill",
  "selection",
  "file",
  "snippet",
];

/**
 * An opening tag: its quoted attributes (a value may hold `>`), then up to
 * the first `>` whatever else it holds (a quote in a name stored unescaped).
 */
const OPEN_RE = new RegExp(
  `<(${MESSAGE_BLOCK_KINDS.join("|")})((?:\\s+[\\w-]+="[^"]*")*)[^>]*>`,
  "g",
);
const ATTRIBUTE_RE = /([\w-]+)="([^"]*)"/g;

const ATTRIBUTE_UNESCAPES: Record<string, string> = {
  amp: "&",
  quot: '"',
  lt: "<",
};

/** An attribute value as it was before `escapeAttribute`, which writes a
 *  control character or line separator as its decimal reference. */
export function unescapeAttribute(value: string): string {
  return value.replace(
    /&(amp|quot|lt|#\d{1,4});/g,
    (_, name: string) =>
      ATTRIBUTE_UNESCAPES[name] ?? String.fromCharCode(Number(name.slice(1))),
  );
}

function countLines(s: string): number {
  if (!s) return 0;
  const trimmed = s.replace(/\n+$/, "");
  if (!trimmed) return 0;
  return trimmed.split("\n").length;
}

/** The chip a block shows as, or null when it lacks what its kind names. */
function chipFor(
  kind: MessageBlockKind,
  attributes: string,
  body: string,
): ContextChip | null {
  const attrs = new Map<string, string>();
  for (const [, key, value] of attributes.matchAll(ATTRIBUTE_RE)) {
    if (!attrs.has(key)) attrs.set(key, unescapeAttribute(value));
  }
  const name = attrs.get("name");
  if (kind === "selection") {
    const source = attrs.get("source");
    return source === "terminal" || source === "editor"
      ? { kind, source, lines: countLines(body) }
      : null;
  }
  if (kind === "mcp-resource" || kind === "mcp-prompt") {
    const server = attrs.get("server");
    return server === undefined || name === undefined
      ? null
      : { kind, server, name };
  }
  if (!name) return null;
  return kind === "file"
    ? { kind, name, lines: countLines(body) }
    : { kind, name };
}

/**
 * The message's blocks as chips and the text around them. Read in one pass:
 * the leftmost block runs to its own closing tag, so whatever its text holds
 * (an opening tag, another kind's block) stays inside it.
 */
export function messageChips(text: string): {
  text: string;
  chips: ContextChip[];
} {
  const found: { chip: ContextChip; rank: number }[] = [];
  const unclosed = new Set<string>();
  let out = "";
  let from = 0;
  OPEN_RE.lastIndex = 0;
  for (let open = OPEN_RE.exec(text); open; open = OPEN_RE.exec(text)) {
    const kind = open[1] as MessageBlockKind;
    const close = `</${kind}>`;
    const bodyStart = open.index + open[0].length;
    const end = unclosed.has(kind) ? -1 : text.indexOf(close, bodyStart);
    if (end === -1) unclosed.add(kind);
    // One newline after the opening tag and one before the closing one frame the text.
    const chip =
      end === -1
        ? null
        : chipFor(
            kind,
            open[2],
            text.slice(bodyStart, end).replace(/^\n/, "").replace(/\n$/, ""),
          );
    if (!chip) {
      OPEN_RE.lastIndex = open.index + 1;
      continue;
    }
    found.push({ chip, rank: CHIP_ORDER.indexOf(kind) });
    out += text.slice(from, open.index);
    from = end + close.length;
    OPEN_RE.lastIndex = from;
  }
  out += text.slice(from);
  found.sort((a, b) => a.rank - b.rank);
  return { text: out.trim(), chips: found.map((f) => f.chip) };
}
