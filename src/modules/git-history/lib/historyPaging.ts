export type HistoryPageRequest = { skip: number; anchorSha: string };

/**
 * The next page is `git log <newest loaded commit> --skip=<loaded count>`.
 * History reachable from a commit never changes, so this is an exact slice
 * even after HEAD moves, and unlike `<last>^` it keeps commits that only a
 * merge's second parent reaches.
 */
export function nextHistoryPage(
  loaded: readonly { sha: string }[],
): HistoryPageRequest | null {
  const anchor = loaded[0];
  if (!anchor) return null;
  return { skip: loaded.length, anchorSha: anchor.sha };
}
