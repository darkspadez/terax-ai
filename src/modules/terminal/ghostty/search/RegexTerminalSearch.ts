import type {
  GhosttySearchStatus,
  GhosttySearchViewportSpan,
  GhosttyTerminalModelApi,
} from "../GhosttyTerminalModel";

/** Matches kept; a pattern matching more stops counting there. */
export const MAX_REGEX_MATCHES = 10_000;

type Match = {
  /** Buffer line (0 is the oldest line of history). */
  readonly line: number;
  readonly startColumn: number;
  /** Exclusive. */
  readonly endColumn: number;
};

/**
 * Compiles a terminal search pattern: a JavaScript regular expression,
 * case-insensitive unless it contains an upper-case letter (smart case, as in
 * editors). Returns null for an invalid pattern or one that can match empty
 * text (which would highlight every cell).
 */
export function compileTerminalPattern(pattern: string): RegExp | null {
  if (!pattern) return null;
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, /\p{Lu}/u.test(pattern) ? "gu" : "giu");
  } catch {
    return null;
  }
  return regex.test("") ? null : regex;
}

/**
 * The matches of `regex` in one line of cells. Cells hold a grapheme each
 * (" " when blank) and "" for the second half of a wide character, so string
 * offsets map back to columns through the cell starts.
 */
export function matchLine(
  cells: readonly string[],
  line: number,
  regex: RegExp,
  limit: number,
): Match[] {
  let text = "";
  const columnAt: number[] = [];
  for (let column = 0; column < cells.length; column++) {
    const cell = cells[column] ?? "";
    for (let unit = 0; unit < cell.length; unit++) columnAt.push(column);
    text += cell;
  }
  columnAt.push(cells.length);
  const matches: Match[] = [];
  regex.lastIndex = 0;
  for (
    let found = regex.exec(text);
    found && matches.length < limit;
    found = regex.exec(text)
  ) {
    if (found[0].length === 0) {
      regex.lastIndex += 1;
      continue;
    }
    const startColumn = columnAt[found.index];
    const last = columnAt[found.index + found[0].length - 1];
    // A match ending on a wide character covers its second cell too.
    const endColumn = cells[last + 1] === "" ? last + 2 : last + 1;
    matches.push({ line, startColumn, endColumn });
  }
  return matches;
}

/**
 * Regular-expression search over the whole buffer, in budgeted steps like
 * the core's literal search: `step()` scans some lines, `select()` moves to
 * the next or previous match and scrolls it into view, `viewportMatches()`
 * gives the highlights. Lines are searched one at a time (a match does not
 * span a wrap). Any content change restarts the scan.
 */
export class RegexTerminalSearch {
  private regex: RegExp | null = null;
  private matches: Match[] = [];
  private nextLine = 0;
  private totalLines = 0;
  private revision = -1;
  private selected = -1;
  private generation = 0;

  constructor(private readonly model: GhosttyTerminalModelApi) {}

  setQuery(pattern: string): GhosttySearchStatus {
    this.regex = compileTerminalPattern(pattern);
    this.restart();
    return this.status();
  }

  clear(): void {
    this.regex = null;
    this.restart();
  }

  /** Scans up to `budget` lines; restarts first if the buffer changed. */
  step(budget: number): GhosttySearchStatus {
    if (!this.regex) return this.status();
    if (this.model.revision() !== this.revision) this.restart();
    const end = Math.min(this.totalLines, this.nextLine + Math.max(1, budget));
    if (this.nextLine < end && this.matches.length < MAX_REGEX_MATCHES) {
      const lines = this.readLines(this.nextLine, end - 1);
      for (let index = 0; index < lines.length; index++) {
        const remaining = MAX_REGEX_MATCHES - this.matches.length;
        if (remaining <= 0) break;
        this.matches.push(
          ...matchLine(
            lines[index],
            this.nextLine + index,
            this.regex,
            remaining,
          ),
        );
      }
    }
    this.nextLine =
      this.matches.length >= MAX_REGEX_MATCHES ? this.totalLines : end;
    return this.status();
  }

  select(direction: "next" | "previous"): GhosttySearchStatus {
    if (this.matches.length === 0) return this.status();
    if (this.selected < 0) {
      // Start from the viewport: the first match at or below its top for
      // "next", the last one above its bottom for "previous".
      const top = this.model.viewportOriginLine();
      const bottom = top + this.model.rows - 1;
      if (direction === "next") {
        const index = this.matches.findIndex((match) => match.line >= top);
        this.selected = index < 0 ? 0 : index;
      } else {
        let index = -1;
        for (let i = this.matches.length - 1; i >= 0; i--) {
          if (this.matches[i].line <= bottom) {
            index = i;
            break;
          }
        }
        this.selected = index < 0 ? this.matches.length - 1 : index;
      }
    } else {
      const count = this.matches.length;
      this.selected =
        (this.selected + (direction === "next" ? 1 : -1) + count) % count;
    }
    this.reveal(this.matches[this.selected]);
    this.generation += 1;
    return this.status();
  }

  viewportMatches(): readonly GhosttySearchViewportSpan[] {
    const top = this.model.viewportOriginLine();
    const bottom = top + this.model.rows - 1;
    const spans: GhosttySearchViewportSpan[] = [];
    for (let index = 0; index < this.matches.length; index++) {
      const match = this.matches[index];
      if (match.line < top || match.line > bottom) continue;
      spans.push({
        row: match.line - top,
        startColumn: match.startColumn,
        endColumn: match.endColumn,
        selected: index === this.selected,
      });
    }
    return spans;
  }

  status(): GhosttySearchStatus {
    const active = this.regex !== null;
    return {
      active,
      pending: active && this.nextLine < this.totalLines,
      complete: !active || this.nextLine >= this.totalLines,
      generation: this.generation,
      totalMatches: this.matches.length,
      selectedIndex: this.selected,
    };
  }

  private restart(): void {
    this.matches = [];
    this.nextLine = 0;
    this.selected = -1;
    this.revision = this.model.revision();
    const { history } = this.model.scrollPosition();
    this.totalLines = this.regex ? history + this.model.rows : 0;
    this.generation += 1;
  }

  private readLines(
    first: number,
    last: number,
  ): readonly (readonly string[])[] {
    if (this.model.readCellLines) return this.model.readCellLines(first, last);
    const lines: (readonly string[])[] = [];
    for (let line = first; line <= last; line++) {
      lines.push(this.model.readCellLine?.(line) ?? []);
    }
    return lines;
  }

  /** Scrolls so the match is visible, keeping the viewport when it already is. */
  private reveal(match: Match): void {
    const top = this.model.viewportOriginLine();
    if (match.line >= top && match.line < top + this.model.rows) return;
    const { history } = this.model.scrollPosition();
    // Offsets count lines scrolled up from the bottom of history.
    const wantTop = Math.max(0, match.line - Math.floor(this.model.rows / 2));
    this.model.scrollTo(Math.max(0, history - wantTop));
  }
}
