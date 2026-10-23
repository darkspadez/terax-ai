import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { isImeKeyEvent } from "@/lib/ime";
import { treeKeyMove, type TreeNavRow } from "@/lib/treeKeyMove";
import { cn } from "@/lib/utils";
import {
  CONTENT_SEARCH_MIN_QUERY,
  useContentSearch,
} from "@/modules/command-palette/hooks/useContentSearch";
import { FileIcon } from "@/modules/explorer/FileIcon";
import {
  OpenPrivacySettingsButton,
  usePrivacyRefusal,
} from "@/modules/mac-privacy";
import {
  ArrowRight01Icon,
  Cancel01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type KeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type ContentSearchRow,
  contentSearchRows,
  groupContentHits,
  previewSegments,
} from "./contentSearchResults";

/** Results the sidebar asks for; the palette, which shows a few, asks for 80. */
const RESULT_LIMIT = 1000;
const ROW_HEIGHT = 24;
const NO_COLLAPSED: ReadonlySet<string> = new Set();

// The view unmounts when the sidebar shows another one; the query outlives it
// for this window, as the explorer's tree does.
let rememberedQuery = "";

type Props = {
  /** The workspace folder searched. */
  root: string | null;
  onOpenHit: (path: string, line: number) => void;
  /** Focus the field once shown (the user opened the view, not a restore). */
  autoFocus?: boolean;
};

function navRow(row: ContentSearchRow): TreeNavRow {
  return row.kind === "file"
    ? {
        key: row.key,
        parentKey: null,
        branch: { id: row.group.path, collapsed: row.collapsed },
      }
    : { key: row.key, parentKey: row.fileKey };
}

function basename(rel: string): string {
  const index = rel.lastIndexOf("/");
  return index === -1 ? rel : rel.slice(index + 1);
}

function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function dirname(rel: string): string {
  const index = rel.lastIndexOf("/");
  return index === -1 ? "" : rel.slice(0, index);
}

/**
 * Project-wide content search in the sidebar: the palette's content search
 * (literal, smart case, through `fs_grep_interactive` on its own channel) with
 * its results grouped by file, matches highlighted, and a click opening the
 * file at the line.
 */
export function ContentSearchView({ root, onOpenHit, autoFocus }: Props) {
  const [query, setQueryState] = useState(rememberedQuery);
  const setQuery = useCallback((next: string) => {
    rememberedQuery = next;
    setQueryState(next);
  }, []);
  const searchable = query.trim().length > 0;
  const search = useContentSearch(root, query, searchable, {
    channel: "sidebar",
    maxResults: RESULT_LIMIT,
    keepPrevious: true,
  });
  const refusal = usePrivacyRefusal(root, search.error);
  const groups = useMemo(
    () => groupContentHits(search.results),
    [search.results],
  );

  const [collapsedState, setCollapsedState] = useState<{
    term: string;
    paths: ReadonlySet<string>;
  }>({ term: "", paths: NO_COLLAPSED });
  // Files start open again for each new set of results.
  const collapsed =
    collapsedState.term === search.resultsTerm
      ? collapsedState.paths
      : NO_COLLAPSED;
  const toggleFile = useCallback(
    (path: string) => {
      const term = search.resultsTerm;
      setCollapsedState((current) => {
        const next = new Set(current.term === term ? current.paths : []);
        if (!next.delete(path)) next.add(path);
        return { term, paths: next };
      });
    },
    [search.resultsTerm],
  );

  const rows = useMemo(
    () => contentSearchRows(groups, collapsed),
    [groups, collapsed],
  );
  const indexByKey = useMemo(() => {
    const map = new Map<string, number>();
    for (const [index, row] of rows.entries()) map.set(row.key, index);
    return map;
  }, [rows]);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const focusedIndex =
    focusedKey === null ? -1 : (indexByKey.get(focusedKey) ?? -1);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 16,
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const focusRow = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return;
      setFocusedKey(row.key);
      virtualizer.scrollToIndex(index, { align: "auto" });
    },
    [rows, virtualizer],
  );

  const activate = useCallback(
    (row: ContentSearchRow) => {
      if (row.kind === "file") toggleFile(row.group.path);
      else onOpenHit(row.hit.path, row.hit.line);
    },
    [onOpenHit, toggleFile],
  );

  // Rows never take focus: the list keeps it, so keys always reach one handler.
  const pressRow = useCallback((key: string) => {
    setFocusedKey(key);
    listRef.current?.focus();
  }, []);

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeKeyEvent(event.nativeEvent)) return;
    if (event.key === "Escape" && query) {
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
    } else if (
      (event.key === "ArrowDown" || event.key === "Enter") &&
      rows.length > 0
    ) {
      event.preventDefault();
      listRef.current?.focus();
      focusRow(Math.max(0, focusedIndex));
    }
  };

  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const row = rows[focusedIndex];
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusRow(Math.min(rows.length - 1, focusedIndex + 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        if (focusedIndex <= 0) inputRef.current?.focus();
        else focusRow(focusedIndex - 1);
        break;
      case "ArrowRight":
      case "ArrowLeft": {
        if (!row) break;
        const next = rows[focusedIndex + 1];
        const move = treeKeyMove(
          navRow(row),
          next && navRow(next),
          event.key === "ArrowRight" ? "in" : "out",
        );
        if (!move) break;
        event.preventDefault();
        if ("toggle" in move) toggleFile(move.toggle);
        else focusRow(indexByKey.get(move.focus) ?? -1);
        break;
      }
      case "Enter":
      case " ":
        if (!row) break;
        event.preventDefault();
        activate(row);
        break;
    }
  };

  const trimmed = query.trim();
  const fileCount = groups.length;
  const hitCount = search.results.length;
  const stale =
    search.loading &&
    (search.resultsTerm !== query || search.resultsRoot !== root);

  let status: string | null = null;
  if (!root) status = "Open a folder to search its files.";
  else if (!trimmed) status = "Search the contents of files in this folder.";
  else if (query.length < CONTENT_SEARCH_MIN_QUERY)
    status = `Type at least ${CONTENT_SEARCH_MIN_QUERY} characters.`;
  else if (search.error) status = refusal?.message ?? "Search failed.";
  else if (hitCount === 0)
    status = search.loading ? "Searching…" : "No results.";

  return (
    <aside className="flex h-full min-w-0 flex-col [contain:layout_style]">
      <div className="shrink-0 space-y-2 border-b border-border/50 px-2.5 pb-2.5 pt-3">
        <div className="flex h-4 items-center justify-between px-0.5">
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/85">
            Search
          </span>
          {search.loading ? <Spinner className="size-3" /> : null}
        </div>
        <div className="relative">
          <HugeiconsIcon
            icon={Search01Icon}
            size={13}
            strokeWidth={2}
            className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder={root ? `Search in ${folderName(root)}` : "Search"}
            aria-label="Search in files"
            title={root ?? undefined}
            spellCheck={false}
            disabled={!root}
            className="h-7 pr-7 pl-6.5 text-xs"
          />
          {query ? (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Clear search"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
            </button>
          ) : null}
        </div>
        {hitCount > 0 && !search.error ? (
          <div className="px-0.5 text-[10.5px] tabular-nums text-muted-foreground">
            {search.truncated
              ? `First ${hitCount} results in ${fileCount} ${fileCount === 1 ? "file" : "files"}`
              : `${hitCount} ${hitCount === 1 ? "result" : "results"} in ${fileCount} ${fileCount === 1 ? "file" : "files"}`}
          </div>
        ) : null}
      </div>

      {status ? (
        <div className="flex flex-col items-start gap-2 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
          <span>{status}</span>
          {search.error ? (
            <div className="flex items-center gap-2">
              {refusal ? <OpenPrivacySettingsButton refusal={refusal} /> : null}
              <Button size="xs" variant="outline" onClick={search.retry}>
                Retry
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <div
          ref={listRef}
          role="tree"
          tabIndex={0}
          aria-label="Search results"
          aria-busy={search.loading}
          aria-activedescendant={
            focusedIndex >= 0 ? `content-search-row-${focusedIndex}` : undefined
          }
          onKeyDown={handleListKeyDown}
          onFocus={() => {
            const first = rows[0]?.key ?? null;
            setFocusedKey((current) =>
              current !== null && indexByKey.has(current) ? current : first,
            );
          }}
          className={cn(
            "relative min-h-0 flex-1 outline-none transition-opacity",
            stale && "opacity-60",
          )}
        >
          <div
            ref={scrollRef}
            className="h-full overflow-y-auto overflow-x-hidden py-1 [scrollbar-gutter:stable]"
          >
            <div
              style={{
                height: virtualizer.getTotalSize(),
                position: "relative",
                width: "100%",
              }}
            >
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index];
                if (!row) return null;
                return (
                  <div
                    key={item.key}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: item.size,
                      transform: `translateY(${item.start}px)`,
                    }}
                  >
                    <ResultRow
                      id={`content-search-row-${item.index}`}
                      row={row}
                      term={search.resultsTerm}
                      focused={item.index === focusedIndex}
                      onPress={pressRow}
                      onActivate={activate}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

function PreviewText({ text, match }: { text: string; match: boolean }) {
  if (!match) return text;
  return (
    <mark className="rounded-sm bg-primary/25 text-foreground">{text}</mark>
  );
}

const ResultRow = memo(function ResultRow({
  id,
  row,
  term,
  focused,
  onPress,
  onActivate,
}: {
  id: string;
  row: ContentSearchRow;
  term: string;
  focused: boolean;
  onPress: (key: string) => void;
  onActivate: (row: ContentSearchRow) => void;
}) {
  const press = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    onPress(row.key);
  };
  const rowClass = cn(
    "flex h-6 w-full min-w-0 cursor-pointer items-center gap-1.5 pr-2 text-left text-xs",
    focused ? "bg-accent text-foreground" : "hover:bg-accent/50",
  );
  if (row.kind === "file") {
    const { group } = row;
    const dir = dirname(group.rel);
    return (
      <div
        id={id}
        role="treeitem"
        tabIndex={-1}
        aria-level={1}
        aria-expanded={!row.collapsed}
        aria-selected={focused}
        onMouseDown={press}
      >
        <button
          type="button"
          tabIndex={-1}
          title={group.path}
          onClick={() => onActivate(row)}
          className={cn(rowClass, "pl-1.5")}
        >
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            size={12}
            strokeWidth={2.25}
            className={cn(
              "shrink-0 text-muted-foreground transition-transform",
              !row.collapsed && "rotate-90",
            )}
          />
          <FileIcon name={basename(group.rel)} className="size-4 shrink-0" />
          <span className="shrink-0 truncate font-medium text-foreground/90">
            {basename(group.rel)}
          </span>
          {dir ? (
            <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground/75">
              {dir}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full border border-border/60 px-1 text-[9.5px] font-semibold tabular-nums text-muted-foreground">
            {group.hits.length}
          </span>
        </button>
      </div>
    );
  }
  const { hit } = row;
  return (
    <div
      id={id}
      role="treeitem"
      tabIndex={-1}
      aria-level={2}
      aria-selected={focused}
      onMouseDown={press}
    >
      <button
        type="button"
        tabIndex={-1}
        title={`${hit.rel}:${hit.line}`}
        onClick={() => onActivate(row)}
        className={cn(rowClass, "pl-7")}
      >
        <span className="w-7 shrink-0 text-right font-mono text-[10.5px] tabular-nums text-muted-foreground/70">
          {hit.line}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground/85">
          {previewSegments(hit.text, term).map((segment, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: one line's runs, in order
            <PreviewText key={index} {...segment} />
          ))}
        </span>
      </button>
    </div>
  );
});
