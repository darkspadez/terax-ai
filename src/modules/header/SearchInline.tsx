import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMatchCount, type MatchCount } from "@/lib/matchCount";
import { KEY_SEP } from "@/lib/platform";
import { cn } from "@/lib/utils";
import type { EditorPaneHandle } from "@/modules/editor";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { getBindingTokens, SHORTCUTS } from "@/modules/shortcuts/shortcuts";
import type { TerminalSearchController } from "@/modules/terminal/search/TerminalSearchController";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

const TERM_DECORATIONS = {
  matchBackground: "#515c6a",
  activeMatchBackground: "#d18616",
  matchOverviewRuler: "#d18616",
  activeMatchColorOverviewRuler: "#d18616",
};

export type SearchTarget =
  | { kind: "terminal"; addon: TerminalSearchController; focus: () => void }
  | { kind: "editor"; handle: EditorPaneHandle; focus: () => void }
  | {
      kind: "git-history";
      handle: { setQuery: (q: string) => void; clearQuery: () => void };
      focus: () => void;
    }
  | null;

export type SearchInlineHandle = { focus: () => void };

type Props = {
  target: SearchTarget;
  /** When true, collapse to an icon-only button until the user opens it. */
  compact?: boolean;
};

type CountSource = {
  get: () => MatchCount | null;
  subscribe: (listener: () => void) => () => void;
};

const FIELD_WIDTH = 192;
/** Wide enough for "999 of 1000", the arrows and the clear button. */
const NAVIGATING_FIELD_WIDTH = 288;
/** In a narrow header the tabs keep more of the room. */
const COMPACT_NAVIGATING_FIELD_WIDTH = 240;

const noCount = () => null;
const noSubscription = () => () => {};

/**
 * The match count of a terminal or editor search. Read only while the field
 * has a query: an editor counts only while someone listens.
 */
function useMatchCount(target: SearchTarget, active: boolean) {
  const source = useMemo<CountSource | null>(() => {
    if (!active || !target) return null;
    if (target.kind === "terminal") {
      const addon = target.addon;
      return {
        get: () => addon.matchCount(),
        subscribe: (listener) => addon.subscribeMatchCount(listener),
      };
    }
    if (target.kind === "editor") {
      const handle = target.handle;
      return {
        get: () => handle.searchCount(),
        subscribe: (listener) => handle.subscribeSearchCount(listener),
      };
    }
    return null;
  }, [active, target]);
  return useSyncExternalStore(
    source?.subscribe ?? noSubscription,
    source?.get ?? noCount,
    noCount,
  );
}

export const SearchInline = forwardRef<SearchInlineHandle, Props>(
  function SearchInline({ target, compact }, ref) {
    const [q, setQ] = useState("");
    // Terminal searches can use a regular expression (smart case).
    const [regex, setRegex] = useState(false);
    const terminalTarget = target?.kind === "terminal";
    // In compact mode the field is hidden behind an icon until activated.
    // In normal mode the field is always present.
    const [openInCompact, setOpenInCompact] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const pendingFocusRef = useRef(false);
    const setInputRef = useCallback((el: HTMLInputElement | null) => {
      inputRef.current = el;
      if (!el || !pendingFocusRef.current) return;
      pendingFocusRef.current = false;
      el.focus();
    }, []);

    const userShortcuts = usePreferencesStore((s) => s.shortcuts);

    const shortcutText = useMemo(() => {
      const s = SHORTCUTS.find((s) => s.id === "search.focus");
      if (!s) return "";
      const bindings = userShortcuts["search.focus"] || s.defaultBindings;
      if (!bindings || bindings.length === 0) return "";
      const tokens = getBindingTokens(bindings[0]);
      return tokens.join(KEY_SEP);
    }, [userShortcuts]);

    const baseLabel = target?.kind === "git-history" ? "Git search" : "Search";

    const placeholder = useMemo(() => {
      return shortcutText ? `${baseLabel} (${shortcutText})` : baseLabel;
    }, [baseLabel, shortcutText]);

    const tooltipTitle = useMemo(() => {
      return shortcutText ? `${baseLabel} (${shortcutText})` : baseLabel;
    }, [baseLabel, shortcutText]);

    const expanded = !compact || openInCompact;
    // Terminal and editor searches step through matches; Git search filters.
    const navigable = target?.kind === "terminal" || target?.kind === "editor";
    const navigating = navigable && q.length > 0;
    const count = useMatchCount(target, navigating);
    const countText = navigating ? formatMatchCount(count) : "";
    const noMatches =
      count !== null && count.total === 0 && !count.pending && !count.capped;

    // The buttons at the field's end vary in width (the count, the regex
    // toggle): the text stops where they start.
    const trailingRef = useRef<HTMLDivElement>(null);
    const [trailingWidth, setTrailingWidth] = useState(0);
    useLayoutEffect(() => {
      const width = trailingRef.current?.offsetWidth ?? 0;
      setTrailingWidth((current) => (current === width ? current : width));
    });

    const focus = useCallback(() => {
      pendingFocusRef.current = true;
      if (compact) setOpenInCompact(true);
      else inputRef.current?.focus();
      if (inputRef.current) pendingFocusRef.current = false;
    }, [compact]);

    useImperativeHandle(ref, () => ({ focus }), [focus]);

    const clearTarget = useCallback(() => {
      if (!target) return;
      if (target.kind === "terminal") target.addon.clearDecorations();
      else target.handle.clearQuery();
    }, [target]);

    const restoreTargetFocus = useCallback(() => {
      if (!target) return;
      target.focus();
    }, [target]);

    // Target switched (terminal ↔ editor) or removed → drop highlights.
    useEffect(() => clearTarget, [clearTarget]);

    const applyIncremental = (next: string, useRegex = regex) => {
      if (!target) return;
      if (target.kind === "terminal") {
        if (next) {
          target.addon.findNext(next, {
            incremental: true,
            regex: useRegex,
            decorations: TERM_DECORATIONS,
          });
        } else {
          target.addon.clearDecorations();
        }
      } else {
        target.handle.setQuery(next);
      }
    };

    const findDirection = (forward: boolean) => {
      if (!target || !q) return;
      if (target.kind === "terminal") {
        const opts = { regex, decorations: TERM_DECORATIONS };
        if (forward) target.addon.findNext(q, opts);
        else target.addon.findPrevious(q, opts);
      } else if (target.kind === "editor") {
        if (forward) target.handle.findNext();
        else target.handle.findPrevious();
      }
      // git-history: the list filters live; Enter has no next/prev semantics.
    };

    return (
      <div
        className="relative h-7 shrink-0 transition-[width] duration-200 ease-out"
        style={{
          width: !expanded
            ? 28
            : !navigating
              ? FIELD_WIDTH
              : compact
                ? COMPACT_NAVIGATING_FIELD_WIDTH
                : NAVIGATING_FIELD_WIDTH,
        }}
      >
        {expanded ? (
          <div className="absolute inset-0 animate-in fade-in-0 duration-150">
            <HugeiconsIcon
              icon={Search01Icon}
              size={13}
              strokeWidth={1.75}
              className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              ref={setInputRef}
              value={q}
              placeholder={placeholder}
              className="h-7 w-full bg-muted/80 pl-7 text-[13px]! placeholder:text-muted-foreground/70 focus-visible:ring-0"
              style={{ paddingRight: trailingWidth + 8 }}
              onChange={(e) => {
                const next = e.target.value;
                setQ(next);
                applyIncremental(next);
              }}
              onBlur={() => {
                if (compact && !q) setOpenInCompact(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  findDirection(!e.shiftKey);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  clearTarget();
                  setQ("");
                  if (compact) {
                    setOpenInCompact(false);
                  }
                  restoreTargetFocus();
                }
              }}
            />
            <div
              ref={trailingRef}
              className="absolute inset-y-0 right-1.5 flex items-center gap-0.5"
            >
              {countText ? (
                <span className="mr-0.5 whitespace-nowrap text-[10.5px] tabular-nums text-muted-foreground">
                  {countText}
                </span>
              ) : null}
              {terminalTarget && (
                <button
                  type="button"
                  aria-pressed={regex}
                  title="Regular expression"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    const next = !regex;
                    setRegex(next);
                    applyIncremental(q, next);
                  }}
                  className={cn(
                    "rounded px-0.5 font-mono text-[10px] leading-4",
                    regex
                      ? "bg-primary/20 text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  .*
                </button>
              )}
              {navigating && (
                <>
                  <SearchStepButton
                    label="Previous match (Shift+Enter)"
                    icon={ArrowUp01Icon}
                    disabled={noMatches}
                    onStep={() => findDirection(false)}
                  />
                  <SearchStepButton
                    label="Next match (Enter)"
                    icon={ArrowDown01Icon}
                    disabled={noMatches}
                    onStep={() => findDirection(true)}
                  />
                </>
              )}
              {q && (
                <button
                  type="button"
                  onClick={() => {
                    setQ("");
                    clearTarget();
                    inputRef.current?.focus();
                  }}
                  className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label="Clear search"
                >
                  <HugeiconsIcon
                    icon={Cancel01Icon}
                    size={11}
                    strokeWidth={2}
                  />
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-end animate-in fade-in-0 duration-150">
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={focus}
              title={tooltipTitle}
            >
              <HugeiconsIcon icon={Search01Icon} size={15} strokeWidth={1.75} />
            </Button>
          </div>
        )}
      </div>
    );
  },
);

function SearchStepButton({
  label,
  icon,
  disabled,
  onStep,
}: {
  label: string;
  icon: typeof ArrowUp01Icon;
  disabled: boolean;
  onStep: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      // Keeps the caret in the field, so Enter goes on stepping.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onStep}
      className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      <HugeiconsIcon icon={icon} size={12} strokeWidth={2} />
    </button>
  );
}
