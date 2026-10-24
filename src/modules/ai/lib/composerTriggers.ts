/**
 * What the composer's pickers open on: `#snippet`, `/command` (built-in
 * commands, skills and MCP prompts, whose `server:prompt` names may hold
 * `:`, `_` and `.`) and `@file` (files and MCP resources), each typed at a
 * word start. Pure.
 */

export type SnippetTrigger = {
  start: number;
  end: number;
  query: string;
  char: "#" | "/";
};

export type FileTrigger = {
  start: number;
  end: number;
  query: string;
};

const SLASH_QUERY_RE = /^[a-z0-9_.:-]*$/i;
const SNIPPET_QUERY_RE = /^[a-z0-9-]*$/i;

export function detectSnippetTrigger(
  value: string,
  caret: number,
): SnippetTrigger | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === "#" || ch === "/") {
      const prev = i === 0 ? " " : value[i - 1];
      if (!/\s/.test(prev)) return null;
      const slice = value.slice(i + 1, caret);
      const re = ch === "/" ? SLASH_QUERY_RE : SNIPPET_QUERY_RE;
      if (!re.test(slice)) return null;
      return { start: i, end: caret, query: slice.toLowerCase(), char: ch };
    }
    if (!/[a-z0-9_.:-]/i.test(ch)) return null;
  }
  return null;
}

export function detectFileTrigger(
  value: string,
  caret: number,
): FileTrigger | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === "@") {
      const prev = i === 0 ? " " : value[i - 1];
      if (!/\s/.test(prev)) return null;
      const slice = value.slice(i + 1, caret);
      return { start: i, end: caret, query: slice };
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}
