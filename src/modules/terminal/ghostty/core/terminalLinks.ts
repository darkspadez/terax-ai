export type TerminalTextLink = { start: number; end: number; uri: string };

/** Links found in one line of text are bounded. */
const MAX_LINKS = 256;

export function detectTerminalLinks(text: string): TerminalTextLink[] {
  const links: TerminalTextLink[] = [];
  const pattern =
    /(?:https?:\/\/|mailto:|file:\/\/)[^\s<>"'`\u0000-\u001f\u007f]+/giu;
  for (
    let match = pattern.exec(text);
    match && links.length < MAX_LINKS;
    match = pattern.exec(text)
  ) {
    let uri = match[0].replace(/[.,;:!?]+$/, "");
    const balance = [0, 0, 0];
    const opens = "([{",
      closes = ")]}";
    for (let index = 0; index < uri.length; index++) {
      const open = opens.indexOf(uri[index]);
      const close = closes.indexOf(uri[index]);
      if (open >= 0) balance[open]++;
      if (close >= 0) balance[close]--;
    }
    let end = uri.length;
    while (end > 0) {
      const close = closes.indexOf(uri[end - 1]);
      if (close < 0 || balance[close] >= 0) break;
      balance[close]++;
      end--;
    }
    uri = uri.slice(0, end);
    try {
      const parsed = new URL(uri);
      const local = parsed.protocol === "file:" && parsed.pathname.length > 1;
      if (parsed.protocol !== "mailto:" && !parsed.hostname && !local) continue;
      links.push({ start: match.index, end: match.index + uri.length, uri });
    } catch {
      /* Incomplete URLs stay ordinary terminal text. */
    }
  }
  return detectPathLinks(text, links);
}

/**
 * File paths, optionally with a position (`src/a.ts:12:5`, `a.ts(12,5)`, or a
 * Python traceback's `File "a.py", line 12`). The link URI is the matched text;
 * `parseTerminalPathLink` reads it back. Paths overlapping a URL are skipped.
 */
const PATH_PATTERN = new RegExp(
  [
    // Not inside a longer word, path or URL.
    String.raw`(?<![\w/\\.~@%+=:-])`,
    "(",
    // Windows drive paths.
    String.raw`[A-Za-z]:[\\/][^\s"'\x60<>|*?:]+`,
    // Absolute, home-relative and dot-relative paths.
    String.raw`|(?:~|\.{1,2})?/[^\s"'\x60<>|:]+`,
    // Relative paths with at least one separator.
    String.raw`|[\w.@+-]+(?:/[\w.@+-]+)+`,
    // A bare file name, only with a position after it.
    String.raw`|[\w.@+-]+\.[A-Za-z]\w{0,7}(?=:\d|\(\d)`,
    ")",
    // Position: :line[:column] or (line[,column]).
    String.raw`(?::\d+(?::\d+)?|\(\d+(?:,\s?\d+)?\))?`,
  ].join(""),
  "gu",
);

const PYTHON_TRACEBACK = /File "([^"\r\n]+)", line (\d+)/gu;

function detectPathLinks(
  text: string,
  links: TerminalTextLink[],
): TerminalTextLink[] {
  const urls = links.slice();
  const overlapsUrl = (start: number, end: number) =>
    urls.some((link) => start < link.end && end > link.start);
  const add = (start: number, end: number, uri: string) => {
    if (links.length >= MAX_LINKS || overlapsUrl(start, end)) return;
    if (links.some((link) => start < link.end && end > link.start)) return;
    links.push({ start, end, uri });
  };

  for (const match of text.matchAll(PYTHON_TRACEBACK)) {
    const start = (match.index ?? 0) + match[0].indexOf('"') + 1;
    add(start, start + match[1].length, `${match[1]}:${match[2]}`);
  }

  PATH_PATTERN.lastIndex = 0;
  for (
    let match = PATH_PATTERN.exec(text);
    match && links.length < MAX_LINKS;
    match = PATH_PATTERN.exec(text)
  ) {
    let candidate = match[0];
    // Prose punctuation after a path is not part of it, unless it closes a
    // (line,column) position.
    if (!/\(\d+(?:,\s?\d+)?\)$/u.test(candidate)) {
      candidate = candidate.replace(/[.,;:!?'")\]}>]+$/u, "");
    }
    const parsed = parseTerminalPathLink(candidate);
    if (!parsed || !plausiblePath(parsed.path, parsed.line !== null)) continue;
    add(match.index, match.index + candidate.length, candidate);
  }
  return links.sort((a, b) => a.start - b.start);
}

/** Rejects fractions, dates and lone separators that look like paths. */
function plausiblePath(path: string, positioned: boolean): boolean {
  if (!/[A-Za-z]/.test(path)) return false;
  if (/^[/\\.~]+$/.test(path)) return false;
  // A bare relative path such as "and/or" needs a dot, a position or depth.
  if (!/^(?:[A-Za-z]:|[~./\\])/.test(path)) {
    const segments = path.split("/").length;
    return positioned || segments > 2 || /\.[A-Za-z]\w{0,7}$/.test(path);
  }
  return true;
}

export type TerminalPathLink = {
  readonly path: string;
  /** 1-based line, when the link names one. */
  readonly line: number | null;
  /** 1-based column, when the link names one. */
  readonly column: number | null;
};

/** Splits a detected path link into its path and position. */
export function parseTerminalPathLink(text: string): TerminalPathLink | null {
  const match = /^(.+?)(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s?(\d+))?\))?$/u.exec(
    text,
  );
  if (!match?.[1]) return null;
  const line = match[2] ?? match[4];
  const column = match[3] ?? match[5];
  return {
    path: match[1],
    line: line ? Number(line) : null,
    column: column ? Number(column) : null,
  };
}
