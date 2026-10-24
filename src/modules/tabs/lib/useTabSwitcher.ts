import { useCallback, useEffect, useRef, useState } from "react";

export type TabSwitcherState = { order: number[]; index: number };

/**
 * The tab a tap of the switcher's keys lands on (one step, then the release
 * commits): the next or previous tab in MRU order, never the current one.
 */
export function switcherTapTarget(
  order: readonly number[],
  delta: 1 | -1,
): number | null {
  if (order.length < 2) return null;
  return order[(delta + order.length) % order.length] ?? null;
}

type Options = {
  /** Candidate tab ids in MRU order, current tab first. */
  getOrder: () => number[];
  /** Called on commit with the chosen tab id (never the already-active one). */
  onCommit: (id: number) => void;
};

export function useTabSwitcher({ getOrder, onCommit }: Options) {
  const [state, setState] = useState<TabSwitcherState | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const cb = useRef({ getOrder, onCommit });
  cb.current = { getOrder, onCommit };

  const step = useCallback((delta: 1 | -1) => {
    setState((prev) => {
      if (prev) {
        const len = prev.order.length;
        return { ...prev, index: (prev.index + delta + len) % len };
      }
      const order = cb.current.getOrder();
      if (order.length < 2) return null;
      return { order, index: (delta + order.length) % order.length };
    });
  }, []);

  const commit = useCallback(() => {
    const s = stateRef.current;
    if (!s) return;
    setState(null);
    const id = s.order[s.index];
    if (id !== undefined && id !== s.order[0]) cb.current.onCommit(id);
  }, []);

  const cancel = useCallback(() => setState(null), []);

  /**
   * Steps and commits at once, as a tap of the keys does, for a caller with no
   * key release to wait for (the macOS menu bar).
   */
  const jump = useCallback(
    (delta: 1 | -1) => {
      if (stateRef.current) {
        step(delta);
        return;
      }
      const id = switcherTapTarget(cb.current.getOrder(), delta);
      if (id !== null) cb.current.onCommit(id);
    },
    [step],
  );

  useEffect(() => {
    const onKeyUp = (e: KeyboardEvent) => {
      if (!stateRef.current) return;
      if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) commit();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (stateRef.current && e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        cancel();
      }
    };
    window.addEventListener("keyup", onKeyUp, { capture: true });
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keyup", onKeyUp, { capture: true });
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("blur", cancel);
    };
  }, [commit, cancel]);

  return { state, step, jump };
}
