import type { MatchCount } from "@/lib/matchCount";

export type TerminalSearchOptions = {
  readonly incremental?: boolean;
  /** Treat the query as a regular expression (smart case). */
  readonly regex?: boolean;
  readonly decorations?: {
    readonly matchBackground?: string;
    readonly activeMatchBackground?: string;
    readonly matchOverviewRuler?: string;
    readonly activeMatchColorOverviewRuler?: string;
  };
};

export interface TerminalSearchController {
  findNext(query: string, options?: TerminalSearchOptions): boolean;
  findPrevious(query: string, options?: TerminalSearchOptions): boolean;
  clearDecorations(): void;
  /** Matches of the current query and the selected one; null without a query. */
  matchCount(): MatchCount | null;
  /** Calls `listener` whenever `matchCount()` changes. */
  subscribeMatchCount(listener: () => void): () => void;
}
