import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { useCallback } from "react";
import { type AsyncQueryState, useAsyncQuery } from "./useAsyncQuery";

export const CONTENT_SEARCH_MIN_QUERY = 2;
const PALETTE_LIMIT = 80;
const DEBOUNCE_MS = 140;

export type ContentHit = {
  path: string;
  rel: string;
  line: number;
  text: string;
};

type GrepResponse = {
  hits: ContentHit[];
  truncated: boolean;
  files_scanned: number;
};

/**
 * Who searches: each caller's new query cancels only its own previous walk
 * in the backend, so the palette and the sidebar never cut each other short.
 */
export type ContentSearchChannel = "palette" | "sidebar";

type ContentSearchResults = {
  hits: ContentHit[];
  /** The backend stopped at the result limit. */
  truncated: boolean;
  /** The query and folder these results are for. */
  term: string;
  root: string | null;
};

const NO_RESULTS: ContentSearchResults = {
  hits: [],
  truncated: false,
  term: "",
  root: null,
};

export type ContentSearchState = Omit<
  AsyncQueryState<ContentSearchResults>,
  "results"
> & {
  results: ContentHit[];
  truncated: boolean;
  /** The query `results` belong to, which lags `term` while a search runs. */
  resultsTerm: string;
  /** The folder `results` belong to, which lags `root` likewise. */
  resultsRoot: string | null;
};

export function useContentSearch(
  root: string | null,
  term: string,
  enabled: boolean,
  options: {
    channel?: ContentSearchChannel;
    maxResults?: number;
    /** Keep the last results on screen while the next query runs. */
    keepPrevious?: boolean;
  } = {},
): ContentSearchState {
  const {
    channel = "palette",
    maxResults = PALETTE_LIMIT,
    keepPrevious = false,
  } = options;
  const run = useCallback(
    async (q: string): Promise<ContentSearchResults> => {
      if (!root) return NO_RESULTS;
      const res = await invoke<GrepResponse>("fs_grep_interactive", {
        pattern: q,
        root,
        maxResults,
        workspace: currentWorkspaceEnv(),
        channel,
      });
      return { hits: res.hits, truncated: res.truncated, term: q, root };
    },
    [root, maxResults, channel],
  );

  const { results, ...state } = useAsyncQuery({
    enabled: enabled && !!root,
    term,
    minLength: CONTENT_SEARCH_MIN_QUERY,
    debounceMs: DEBOUNCE_MS,
    run,
    empty: NO_RESULTS,
    keepPrevious,
  });
  return {
    ...state,
    results: results.hits,
    truncated: results.truncated,
    resultsTerm: results.term,
    resultsRoot: results.root,
  };
}
