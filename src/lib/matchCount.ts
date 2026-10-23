/** How many matches a find has, as the editor and terminal searches report it. */
export type MatchCount = {
  /** 1-based position of the selected match; 0 when none is selected. */
  readonly current: number;
  readonly total: number;
  /** Counting stopped at a cap: there are more than `total`. */
  readonly capped: boolean;
  /** Still counting: `total` may grow. */
  readonly pending: boolean;
};

export function sameMatchCount(
  a: MatchCount | null,
  b: MatchCount | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.current === b.current &&
    a.total === b.total &&
    a.capped === b.capped &&
    a.pending === b.pending
  );
}

/** "3 of 12", "12 matches" when none is selected, "No results"; "" without a count. */
export function formatMatchCount(count: MatchCount | null): string {
  if (!count) return "";
  const more = count.capped || count.pending ? "+" : "";
  if (count.total === 0) return count.pending ? "" : "No results";
  if (count.current > 0) return `${count.current} of ${count.total}${more}`;
  return `${count.total}${more} ${count.total === 1 && !more ? "match" : "matches"}`;
}
