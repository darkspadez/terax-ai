import { type MatchCount, sameMatchCount } from "@/lib/matchCount";
import type {
  TerminalSearchController,
  TerminalSearchOptions,
} from "@/modules/terminal/search/TerminalSearchController";
import type {
  GhosttySearchStatus,
  GhosttyTerminalModelApi,
} from "../GhosttyTerminalModel";
import { MAX_REGEX_MATCHES, RegexTerminalSearch } from "./RegexTerminalSearch";

const SEARCH_STEP_BUDGET = 256;
/** Buffer lines a regex search scans per frame. */
const REGEX_STEP_LINES = 2_000;

type Direction = "next" | "previous";

export type GhosttySearchSnapshot = {
  readonly query: string;
  readonly regex?: boolean;
  readonly pendingDirection: Direction | null;
};

type Scheduler = {
  readonly request: (callback: () => void) => number;
  readonly cancel: (handle: number) => void;
};

export class GhosttySearchController implements TerminalSearchController {
  private query = "";
  private regex = false;
  private regexSearch: RegexTerminalSearch | null = null;
  private status: GhosttySearchStatus = emptyStatus();
  private viewportMask: Uint8Array = new Uint8Array(0);
  private scratchMask: Uint8Array = new Uint8Array(0);
  private maskCells = 0;
  private maskRevisionValue = 0;
  private pendingDirection: Direction | null = null;
  private scheduledStep: number | null = null;
  private disposed = false;
  private suspended = false;
  private count: MatchCount | null = null;
  private readonly countListeners = new Set<() => void>();

  constructor(
    private readonly model: GhosttyTerminalModelApi,
    private readonly onChange: () => void,
    private readonly scheduler: Scheduler = browserScheduler(),
  ) {}

  findNext(query: string, options?: TerminalSearchOptions): boolean {
    return this.find(query, "next", options?.regex === true);
  }

  findPrevious(query: string, options?: TerminalSearchOptions): boolean {
    return this.find(query, "previous", options?.regex === true);
  }

  snapshot(): GhosttySearchSnapshot {
    return {
      query: this.query,
      regex: this.regex,
      pendingDirection: this.pendingDirection,
    };
  }

  restore(snapshot: GhosttySearchSnapshot): void {
    if (this.disposed) return;
    this.cancelStep();
    this.query = snapshot.query;
    this.pendingDirection = snapshot.pendingDirection;
    this.setMode(snapshot.regex === true);
    if (this.regex && this.query) {
      this.status = this.regexEngine().setQuery(this.query);
    }
    this.refresh();
  }

  suspend(): void {
    this.suspended = true;
    this.cancelStep();
  }

  resume(): void {
    this.suspended = false;
    this.refresh();
  }

  clearDecorations(): void {
    if (this.disposed) return;
    this.cancelStep();
    this.query = "";
    this.pendingDirection = null;
    this.model.clearSearch();
    this.regexSearch?.clear();
    this.regex = false;
    this.status = emptyStatus();
    this.commitMask(new Uint8Array(0), 0);
    this.publishCount();
    this.onChange();
  }

  matchCount(): MatchCount | null {
    return this.count;
  }

  subscribeMatchCount(listener: () => void): () => void {
    this.countListeners.add(listener);
    return () => {
      this.countListeners.delete(listener);
    };
  }

  refreshOverlay(): void {
    if (this.disposed || this.suspended || this.query) return;
    if (this.model.blockSearchActive?.()) this.rebuildViewportMask();
    else if (this.viewportMask.length) this.commitMask(new Uint8Array(0), 0);
  }

  /** Increments only when the set of highlighted cells actually changes. */
  get maskRevision(): number {
    return this.maskRevisionValue;
  }

  /**
   * One byte per viewport cell (0 none, 1 match, 2 selected match), row-major,
   * or null when nothing is highlighted. Borrowed: valid until the next change.
   */
  viewportMaskBytes(): Uint8Array | null {
    return this.maskCells > 0 ? this.viewportMask : null;
  }

  refresh(): void {
    if (this.disposed) return;
    if (!this.query) {
      this.refreshOverlay();
      return;
    }
    this.step();
  }

  invalidate(): void {
    if (!this.disposed && !this.suspended && this.query) this.scheduleStep();
  }

  matchAt(row: number, column: number): 0 | 1 | 2 {
    if (
      row < 0 ||
      row >= this.model.rows ||
      column < 0 ||
      column >= this.model.cols
    ) {
      return 0;
    }
    return (this.viewportMask[row * this.model.cols + column] ?? 0) as
      | 0
      | 1
      | 2;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelStep();
    this.countListeners.clear();
    this.viewportMask = new Uint8Array(0);
    this.scratchMask = new Uint8Array(0);
    this.maskCells = 0;
    this.maskRevisionValue += 1;
  }

  private find(query: string, direction: Direction, regex: boolean): boolean {
    if (this.disposed || this.suspended || query.length === 0) return false;
    if (query !== this.query || regex !== this.regex) {
      this.cancelStep();
      this.query = query;
      this.setMode(regex);
      this.status = regex
        ? this.regexEngine().setQuery(query)
        : this.model.setSearchQuery(query);
    }
    this.pendingDirection = direction;
    this.step();
    return this.status.totalMatches > 0;
  }

  private step(): void {
    if (this.disposed || this.suspended || !this.query) return;
    this.status = this.regex
      ? this.regexEngine().step(REGEX_STEP_LINES)
      : this.model.stepSearch(SEARCH_STEP_BUDGET);
    if (
      this.status.complete &&
      this.status.totalMatches > 0 &&
      this.pendingDirection
    ) {
      const direction = this.pendingDirection;
      this.pendingDirection = null;
      this.status = this.regex
        ? this.regexEngine().select(direction)
        : this.model.selectSearchMatch(direction);
    }
    this.rebuildViewportMask();
    this.publishCount();
    this.onChange();
    if (!this.status.complete) this.scheduleStep();
    else this.cancelStep();
  }

  /** Steps run often while output streams: listeners hear only real changes. */
  private publishCount(): void {
    const next = this.query ? searchMatchCount(this.status, this.regex) : null;
    if (sameMatchCount(this.count, next)) return;
    this.count = next;
    for (const listener of [...this.countListeners]) listener();
  }

  private rebuildViewportMask(): void {
    const length = this.model.cols * this.model.rows;
    if (this.scratchMask.length !== length) {
      this.scratchMask = new Uint8Array(length);
    } else {
      this.scratchMask.fill(0);
    }
    let cells = 0;
    const matches = this.regex
      ? this.regexEngine().viewportMatches()
      : this.model.searchViewportMatches();
    for (const match of matches) {
      if (match.row < 0 || match.row >= this.model.rows) continue;
      const start = Math.max(0, Math.min(this.model.cols, match.startColumn));
      const end = Math.max(start, Math.min(this.model.cols, match.endColumn));
      this.scratchMask.fill(
        match.selected ? 2 : 1,
        match.row * this.model.cols + start,
        match.row * this.model.cols + end,
      );
      cells += end - start;
    }
    this.commitMask(this.scratchMask, cells);
  }

  /** Installs `next` when it differs; returns true if `next` was adopted. */
  private commitMask(next: Uint8Array, cells: number): boolean {
    const current = this.viewportMask;
    let same = next.length === current.length;
    for (let index = 0; same && index < next.length; index += 1) {
      same = next[index] === current[index];
    }
    if (same) return false;
    if (next === this.scratchMask) this.scratchMask = current;
    this.viewportMask = next;
    this.maskCells = cells;
    this.maskRevisionValue += 1;
    return true;
  }

  /** Switches between the core's literal search and the regex engine. */
  private setMode(regex: boolean): void {
    if (regex === this.regex) return;
    if (regex) this.model.clearSearch();
    else this.regexSearch?.clear();
    this.regex = regex;
  }

  private regexEngine(): RegexTerminalSearch {
    this.regexSearch ??= new RegexTerminalSearch(this.model);
    return this.regexSearch;
  }

  private scheduleStep(): void {
    if (this.scheduledStep !== null) return;
    this.scheduledStep = this.scheduler.request(() => {
      this.scheduledStep = null;
      this.step();
    });
  }

  private cancelStep(): void {
    if (this.scheduledStep !== null) {
      this.scheduler.cancel(this.scheduledStep);
    }
    this.scheduledStep = null;
  }
}

/**
 * The count a search status stands for. The selected index counts in the
 * engine's own order, as Ghostty's search shows it; the regex engine stops
 * counting at its cap.
 */
export function searchMatchCount(
  status: GhosttySearchStatus,
  regex: boolean,
): MatchCount {
  return {
    current: status.selectedIndex >= 0 ? status.selectedIndex + 1 : 0,
    total: status.totalMatches,
    capped: regex && status.totalMatches >= MAX_REGEX_MATCHES,
    pending: !status.complete,
  };
}

function emptyStatus(): GhosttySearchStatus {
  return {
    active: false,
    pending: false,
    complete: true,
    generation: 0,
    totalMatches: 0,
    selectedIndex: -1,
  };
}

function browserScheduler(): Scheduler {
  return {
    request: (callback) => requestAnimationFrame(callback),
    cancel: (handle) => cancelAnimationFrame(handle),
  };
}
