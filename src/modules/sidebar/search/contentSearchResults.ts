import type { ContentHit } from "@/modules/command-palette/hooks/useContentSearch";

export type ContentFileGroup = {
  readonly path: string;
  readonly rel: string;
  readonly hits: readonly ContentHit[];
};

export type ContentSearchRow =
  | {
      readonly kind: "file";
      readonly key: string;
      readonly group: ContentFileGroup;
      readonly collapsed: boolean;
    }
  | {
      readonly kind: "hit";
      readonly key: string;
      readonly hit: ContentHit;
      /** The key of the file row above it. */
      readonly fileKey: string;
    };

export type PreviewSegment = { readonly text: string; readonly match: boolean };

const NAME_ORDER = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

function compareRel(a: string, b: string): number {
  return NAME_ORDER.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Hits grouped by file, files in the explorer's order of their relative
 * paths and each file's lines in order. The backend walks folders in
 * parallel, so the hits of different files arrive interleaved.
 */
export function groupContentHits(
  hits: readonly ContentHit[],
): ContentFileGroup[] {
  const byPath = new Map<string, ContentHit[]>();
  for (const hit of hits) {
    const list = byPath.get(hit.path);
    if (list) list.push(hit);
    else byPath.set(hit.path, [hit]);
  }
  return [...byPath.entries()]
    .map(([path, list]) => ({
      path,
      rel: list[0].rel,
      hits: [...list].sort((a, b) => a.line - b.line),
    }))
    .sort((a, b) => compareRel(a.rel, b.rel));
}

/** Rows to show: a row per file, then its hits unless the file is collapsed. */
export function contentSearchRows(
  groups: readonly ContentFileGroup[],
  collapsed: ReadonlySet<string>,
): ContentSearchRow[] {
  const rows: ContentSearchRow[] = [];
  for (const group of groups) {
    const fileKey = `file:${group.path}`;
    const isCollapsed = collapsed.has(group.path);
    rows.push({
      kind: "file",
      key: fileKey,
      group,
      collapsed: isCollapsed,
    });
    if (isCollapsed) continue;
    for (const hit of group.hits) {
      rows.push({
        kind: "hit",
        key: `hit:${group.path}:${hit.line}`,
        hit,
        fileKey,
      });
    }
  }
  return rows;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Where `query` occurs in `text`, matched as the backend matches it: as a
 * literal, ignoring case unless the query has an upper-case letter.
 */
export function matchRanges(text: string, query: string): [number, number][] {
  if (!query) return [];
  const flags = /\p{Uppercase}/u.test(query) ? "gu" : "giu";
  const pattern = new RegExp(escapeRegExp(query), flags);
  const ranges: [number, number][] = [];
  for (const match of text.matchAll(pattern)) {
    if (match[0].length === 0) continue;
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

/** Characters kept before the first match when a line is cut to show it. */
const PREVIEW_LEAD = 32;

/**
 * A line as the result list shows it: leading indentation dropped, cut to
 * `maxChars` around the first match (an ellipsis marks a cut), and split into
 * matched and unmatched runs for highlighting.
 */
export function previewSegments(
  text: string,
  query: string,
  maxChars = 240,
): PreviewSegment[] {
  const indent = text.length - text.trimStart().length;
  const ranges = matchRanges(text, query);
  const firstMatch = ranges[0]?.[0] ?? indent;
  const start = Math.max(indent, firstMatch - PREVIEW_LEAD);
  const end = Math.min(text.length, start + maxChars);
  const segments: PreviewSegment[] = [];
  const push = (from: number, to: number, match: boolean) => {
    if (to > from) segments.push({ text: text.slice(from, to), match });
  };
  let at = start;
  for (const [from, to] of ranges) {
    if (to <= start) continue;
    if (from >= end) break;
    push(at, Math.max(at, from), false);
    push(Math.max(at, from), Math.min(to, end), true);
    at = Math.min(to, end);
  }
  push(at, end, false);
  if (start > indent && segments.length > 0) {
    segments.unshift({ text: "…", match: false });
  }
  if (end < text.length) segments.push({ text: "…", match: false });
  return segments;
}
