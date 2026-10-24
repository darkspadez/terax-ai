import { type MatchCount, sameMatchCount } from "@/lib/matchCount";
import { getSearchQuery, SearchQuery } from "@codemirror/search";
import {
  CharCategory,
  type EditorState,
  Facet,
  findClusterBreak,
} from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

/** Matches counted before the count reads "10000+". */
const SEARCH_COUNT_CAP = 10_000;
/** Text scanned between deadline checks: about a millisecond of string search. */
const CHUNK_CHARS = 32 * 1024;
/** Scanning time per slice before the rest waits for the next task. */
const SLICE_MS = 6;
/** Edits re-count at once below this size, after a pause above it. */
const IMMEDIATE_RECOUNT_CHARS = 128 * 1024;
const RECOUNT_DELAY_MS = 200;
/**
 * A regular expression that can match across lines is found in one pass (its
 * matches have no length bound to chunk by), so it is counted only up to this.
 */
const MULTILINE_REGEX_COUNT_CHARS = 4 * 1024 * 1024;

/** CodeMirror's own test for a regular expression that can span lines. */
function regexSpansLines(source: string): boolean {
  return /\\[sWDnr]|\n|\r|\[\^/.test(source);
}

/** The text a string query looks for, with `\n`, `\r`, `\t` unescaped as CodeMirror does. */
function unquote(query: SearchQuery): string {
  if (query.literal) return query.search;
  return query.search.replace(/\\([nrt\\])/g, (_, ch: string) =>
    ch === "n" ? "\n" : ch === "r" ? "\r" : ch === "t" ? "\t" : "\\",
  );
}

/**
 * The longest stretch of document one match of a string query can cover. The
 * search compares normalized text (NFKD, lower case unless case sensitive),
 * and every document character normalizes to at least one character.
 */
function stringMatchBound(query: SearchQuery): number {
  const normalized = unquote(query).normalize("NFKD");
  return (query.caseSensitive ? normalized : normalized.toLowerCase()).length;
}

/** Characters read around a match to decide whether it is a whole word. */
const WORD_CONTEXT = 32;

/**
 * A whole-word string query that judges word boundaries from the document.
 * CodeMirror's own test reads the characters around a match from its search
 * buffer, which starts where the search range does, so a match at the start
 * of a chunk would always pass; the document has the real neighbours. The
 * rule is CodeMirror's: no word character continues the match on either side.
 */
function documentWordQuery(
  query: SearchQuery,
  state: EditorState,
): SearchQuery {
  if (query.regexp || !query.wholeWord) return query;
  const categorize = state.charCategorizer(state.selection.main.head);
  const isWord = (text: string) => categorize(text) === CharCategory.Word;
  const inner = query.test;
  return new SearchQuery({
    search: query.search,
    caseSensitive: query.caseSensitive,
    literal: query.literal,
    replace: query.replace,
    test: (match, at, from, to) => {
      if (inner && !inner(match, at, from, to)) return false;
      const start = Math.max(0, from - WORD_CONTEXT);
      const text = at.doc.sliceString(
        start,
        Math.min(at.doc.length, to + WORD_CONTEXT),
      );
      const before = (i: number) =>
        text.slice(findClusterBreak(text, i, false), i);
      const after = (i: number) => text.slice(i, findClusterBreak(text, i));
      const head = from - start;
      const tail = to - start;
      return (
        (!isWord(before(head)) || !isWord(after(head))) &&
        (!isWord(after(tail)) || !isWord(before(tail)))
      );
    },
  });
}

/**
 * Finds a query's matches in a document in chunks, so a long document is
 * counted over several tasks instead of blocking one. Chunking never changes
 * the result: a string query's chunk reads on by the longest match it can
 * have and keeps the matches that start inside it; a single-line regular
 * expression is cut between lines, which its matches never cross. Stops at
 * `cap` matches.
 */
export class MatchScan {
  readonly from: number[] = [];
  readonly to: number[] = [];
  capped = false;
  done = false;
  /** The query could not be counted here (a multi-line regex in a huge document). */
  readonly unsupported: boolean;
  private pos = 0;
  private readonly query: SearchQuery;
  private readonly overlap: number;
  private readonly wholeDocument: boolean;

  constructor(
    private readonly state: EditorState,
    query: SearchQuery,
    private readonly cap = SEARCH_COUNT_CAP,
    private readonly chunk = CHUNK_CHARS,
  ) {
    this.query = documentWordQuery(query, state);
    this.wholeDocument = query.regexp && regexSpansLines(query.search);
    this.overlap = query.regexp ? 0 : stringMatchBound(query);
    this.unsupported =
      this.wholeDocument && state.doc.length > MULTILINE_REGEX_COUNT_CHARS;
    if (this.unsupported) this.done = true;
  }

  /** Scans until finished or `expired()` ends the slice; true when finished. */
  step(expired: () => boolean): boolean {
    const doc = this.state.doc;
    while (!this.done) {
      const end = this.chunkEnd();
      const scanTo = Math.min(doc.length, end + this.overlap);
      const cursor = this.query.getCursor(this.state, this.pos, scanTo);
      let next = end;
      for (let match = cursor.next(); !match.done; match = cursor.next()) {
        const { from, to } = match.value;
        // A string match starting here or later belongs to the next chunk.
        if (!this.query.regexp && from >= end && end < doc.length) break;
        if (this.from.length >= this.cap) {
          this.capped = true;
          this.done = true;
          return true;
        }
        this.from.push(from);
        this.to.push(to);
        next = Math.max(next, to);
      }
      // A regex chunk ends at a line end; the next one starts on the next line.
      this.pos = this.query.regexp ? end + 1 : next;
      if (end >= doc.length || this.pos > doc.length) this.done = true;
      else if (expired()) return false;
    }
    return true;
  }

  private chunkEnd(): number {
    const doc = this.state.doc;
    if (this.wholeDocument) return doc.length;
    const target = Math.min(doc.length, this.pos + this.chunk);
    return this.query.regexp ? doc.lineAt(target).to : target;
  }
}

/** 1-based index of the match the selection is exactly on, else 0. */
export function selectedMatch(
  from: readonly number[],
  to: readonly number[],
  selectionFrom: number,
  selectionTo: number,
): number {
  let low = 0;
  let high = from.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (from[mid] < selectionFrom) low = mid + 1;
    else if (from[mid] > selectionFrom) high = mid - 1;
    else return to[mid] === selectionTo ? mid + 1 : 0;
  }
  return 0;
}

/**
 * The match count of one editor pane, kept across the views the pane creates.
 * Counting runs only while something listens (the find panel, or the header
 * search while it has a query).
 */
export class SearchCountHub {
  private count: MatchCount | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly demandWatchers = new Set<() => void>();

  get(): MatchCount | null {
    return this.count;
  }

  get wanted(): boolean {
    return this.listeners.size > 0;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.demandChanged();
    return () => {
      if (this.listeners.delete(listener) && this.listeners.size === 0) {
        this.demandChanged();
      }
    };
  }

  publish(next: MatchCount | null): void {
    if (sameMatchCount(this.count, next)) return;
    this.count = next;
    for (const listener of [...this.listeners]) listener();
  }

  watchDemand(watcher: () => void): () => void {
    this.demandWatchers.add(watcher);
    return () => {
      this.demandWatchers.delete(watcher);
    };
  }

  private demandChanged(): void {
    for (const watcher of [...this.demandWatchers]) watcher();
  }
}

export const searchCountHub = Facet.define<
  SearchCountHub,
  SearchCountHub | null
>({ combine: (values) => values[0] ?? null });

/** Exported for tests; editors use `searchCounter`. */
export class SearchCounter {
  readonly hub: SearchCountHub;
  private scan: MatchScan | null = null;
  private scanState: EditorState | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly stopWatching: () => void;

  constructor(private readonly view: EditorView) {
    this.hub = view.state.facet(searchCountHub) ?? new SearchCountHub();
    this.stopWatching = this.hub.watchDemand(() => this.restart());
    this.restart();
  }

  update(update: ViewUpdate): void {
    if (!this.hub.wanted) return;
    const query = getSearchQuery(update.state);
    const scanned = this.scanState ? getSearchQuery(this.scanState) : null;
    if (!scanned || !query.eq(scanned)) this.restart();
    else if (update.docChanged) {
      if (update.state.doc.length <= IMMEDIATE_RECOUNT_CHARS) this.restart();
      else this.schedule(RECOUNT_DELAY_MS, () => this.restart());
    } else if (update.selectionSet) this.publish();
  }

  destroy(): void {
    this.cancel();
    this.stopWatching();
    this.hub.publish(null);
  }

  private restart(): void {
    this.cancel();
    const state = this.view.state;
    const query = getSearchQuery(state);
    if (!this.hub.wanted || !query.valid) {
      this.scan = null;
      this.scanState = null;
      this.hub.publish(null);
      return;
    }
    this.scanState = state;
    this.scan = new MatchScan(state, query);
    this.continueScan();
  }

  private continueScan(): void {
    const scan = this.scan;
    if (!scan) return;
    const deadline = performance.now() + SLICE_MS;
    const finished = scan.step(() => performance.now() >= deadline);
    this.publish();
    if (!finished) this.schedule(0, () => this.continueScan());
  }

  private publish(): void {
    const scan = this.scan;
    if (!scan || scan.unsupported) {
      this.hub.publish(null);
      return;
    }
    const { from, to } = this.view.state.selection.main;
    // The selection is compared only with the document the scan read.
    const current =
      this.scanState?.doc === this.view.state.doc
        ? selectedMatch(scan.from, scan.to, from, to)
        : 0;
    this.hub.publish({
      current,
      total: scan.from.length,
      capped: scan.capped,
      pending: !scan.done,
    });
  }

  private schedule(delay: number, run: () => void): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      run();
    }, delay);
  }

  private cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

export const searchCounter = ViewPlugin.fromClass(SearchCounter);
