/**
 * Scrollback saved across restarts: the text format, its limits and the
 * sequence written back into a restored pane. Pure; the registry in
 * `terminalScrollbackRestore.ts` does the I/O.
 */

/** Lines of history kept per pane, newest last. */
export const SCROLLBACK_MAX_LINES = 5_000;
/** UTF-8 bytes of styled history kept per pane (the native side refuses 8 MiB). */
const SCROLLBACK_MAX_BYTES = 4 * 1024 * 1024;

export type ScrollbackLimits = {
  readonly maxLines: number;
  readonly maxBytes: number;
};

export const SCROLLBACK_LIMITS: ScrollbackLimits = {
  maxLines: SCROLLBACK_MAX_LINES,
  maxBytes: SCROLLBACK_MAX_BYTES,
};

/**
 * Rows formatted per native call. The core builds each result in the pane's
 * own WebAssembly memory, which never shrinks, so one call over the whole
 * history would leave the pane holding about twice its styled size for good.
 */
const EXPORT_CHUNK_ROWS = 256;
/** Rows searched for a clean split before a chunk gives older history up. */
const MIN_SPLIT_SEARCH_ROWS = 64;

type TextFormat = "vt" | "plain";

/** What an export needs from a terminal model. */
export type ScrollbackSource = {
  readonly rows: number;
  scrollPosition(): { readonly history: number };
  modes(): { readonly alternateScreen: boolean };
  formatTextRange?(
    startLine: number,
    endLine: number,
    format: TextFormat,
  ): string;
};

const KEY = /^[A-Za-z0-9_-]{1,128}$/;
const FILE_HEADER = /^oarlock-scrollback 1 (\d{1,16})$/;
const MAX_DATE_MS = 8_640_000_000_000_000;
const LINE_BREAK = "\r\n";

export function isScrollbackKey(value: unknown): value is string {
  return typeof value === "string" && KEY.test(value);
}

function randomSuffix(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function createScrollbackKey(
  now = Date.now(),
  random: () => string = randomSuffix,
): string {
  return `sb-${Math.max(0, Math.trunc(now)).toString(36)}-${random()}`;
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < text.length &&
      (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

/** The newest whole lines that fit the limits; older lines go first. */
export function trimScrollback(vt: string, limits: ScrollbackLimits): string {
  let lines = vt.split(LINE_BREAK);
  if (lines.length > limits.maxLines) {
    lines = lines.slice(lines.length - Math.max(0, limits.maxLines));
  }
  let bytes = 0;
  for (const line of lines) bytes += utf8Length(line);
  bytes += Math.max(0, lines.length - 1) * LINE_BREAK.length;
  let first = 0;
  while (first < lines.length && bytes > limits.maxBytes) {
    bytes -= utf8Length(lines[first]);
    bytes -= first < lines.length - 1 ? LINE_BREAK.length : 0;
    first++;
  }
  return lines.slice(first).join(LINE_BREAK);
}

const SGR = /\x1b\[[0-9;:]*m/g;

/** Whether anything but styles and whitespace is left. */
export function hasVisibleText(vt: string): boolean {
  return vt.replace(SGR, "").trim().length > 0;
}

type ReadRange = (start: number, end: number, format: TextFormat) => string;

/**
 * The newest row in `(floor, from]` where a non-blank logical line starts
 * right after another non-blank one. Ranges split there join back exactly: no
 * soft wrap is cut and no blank line is trimmed off a range's end.
 */
function cleanSplit(
  read: ReadRange,
  from: number,
  floor: number,
): number | null {
  for (let row = from; row > floor; row--) {
    const pair = read(row - 1, row, "plain").split("\n");
    if (pair.length === 2 && pair[0].trim() && pair[1].trim()) return row;
  }
  return null;
}

/**
 * The pane's history as styled text, or null when it cannot be read now (a
 * full-screen program has the alternate screen, whose contents are not
 * history), so whatever is stored stays. Empty when there is nothing to keep.
 * Reads newest first in chunks and stops once the limits are met; a logical
 * line too long to split cleanly ends the export, giving older history up.
 */
export function exportScrollback(
  model: ScrollbackSource,
  limits: ScrollbackLimits = SCROLLBACK_LIMITS,
  chunkRows = EXPORT_CHUNK_ROWS,
): string | null {
  const format = model.formatTextRange;
  if (!format || model.modes().alternateScreen) return null;
  const read: ReadRange = (start, end, as) =>
    format.call(model, start, end, as);
  const total = model.scrollPosition().history + model.rows;
  const lowest = Math.max(0, total - limits.maxLines);
  const rows = Math.max(1, Math.trunc(chunkRows));
  const chunks: string[] = [];
  let lines = 0;
  let length = 0;
  let end = total - 1;
  while (
    end >= lowest &&
    lines < limits.maxLines &&
    length <= limits.maxBytes
  ) {
    let start = Math.max(lowest, end - rows + 1);
    let partial = start > 0;
    if (start > lowest) {
      const floor = Math.max(
        lowest,
        start - Math.max(rows, MIN_SPLIT_SEARCH_ROWS),
      );
      const split = cleanSplit(read, start, floor);
      if (split !== null) {
        start = split;
        partial = false;
      } else if (floor === lowest) {
        start = lowest;
        partial = lowest > 0;
      }
    }
    let chunk = read(start, end, "vt");
    if (partial) {
      const cut = chunk.indexOf(LINE_BREAK);
      chunk = cut < 0 ? "" : chunk.slice(cut + LINE_BREAK.length);
    }
    if (chunk) {
      chunks.push(chunk);
      lines += chunk.split(LINE_BREAK).length;
      // UTF-16 length never exceeds the UTF-8 size: a safe point to stop.
      length += chunk.length;
    }
    if (partial) break;
    end = start - 1;
  }
  // Each range ends in the cursor's pen; reset it before the next one starts.
  const vt = chunks.reverse().join(`\x1b[0m${LINE_BREAK}`);
  const trimmed = trimScrollback(vt, limits);
  return hasVisibleText(trimmed) ? trimmed : "";
}

export function encodeScrollbackFile(vt: string, savedAt: number): string {
  return `oarlock-scrollback 1 ${Math.max(0, Math.trunc(savedAt))}\n${vt}`;
}

export function decodeScrollbackFile(
  text: string,
): { readonly savedAt: number; readonly vt: string } | null {
  const newline = text.indexOf("\n");
  if (newline < 0) return null;
  const match = FILE_HEADER.exec(text.slice(0, newline));
  if (!match) return null;
  const savedAt = Number(match[1]);
  if (!Number.isSafeInteger(savedAt) || savedAt > MAX_DATE_MS) return null;
  return { savedAt, vt: text.slice(newline + 1) };
}

// SGR (kept); any other control sequence; OSC, DCS, SOS, PM and APC strings up
// to their terminator or the end; other escapes; C0 and C1 controls but CR/LF.
const CONTROL =
  /\x1b\[[0-9;:]*m|\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]?|\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)|\x1b[\x20-\x2f]*[\x30-\x7e]?|[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
const SGR_ONLY = /^\x1b\[[0-9;:]*m$/;
const NEWLINE = /\r\n|\r|\n/g;

/**
 * Only text, line breaks and SGR styles survive. The file is read back from
 * disk into a live terminal, so nothing in it may move the cursor, set modes,
 * write the clipboard, change the cwd or title, or make the terminal answer
 * (an answer would reach the new shell as input).
 */
export function sanitizeScrollback(text: string): string {
  return text
    .replace(CONTROL, (match) => (SGR_ONLY.test(match) ? match : ""))
    .replace(NEWLINE, (match) => (match === "\r" ? "" : LINE_BREAK));
}

/**
 * What a restored pane is fed ahead of its new shell's output: the saved
 * history, styles reset, and a dim marker line, leaving the cursor at the
 * start of a clean line for the prompt. Null when there is nothing to show.
 */
export function restoreSequence(
  file: string,
  formatDate: (savedAt: number) => string,
  limits: ScrollbackLimits = SCROLLBACK_LIMITS,
): string | null {
  const decoded = decodeScrollbackFile(file);
  if (!decoded) return null;
  const history = trimScrollback(sanitizeScrollback(decoded.vt), limits);
  if (!hasVisibleText(history)) return null;
  const marker = `─── Restored ${formatDate(decoded.savedAt)} ───`;
  return `${history}\x1b[0m${LINE_BREAK}\x1b[2m${marker}\x1b[0m${LINE_BREAK}`;
}
