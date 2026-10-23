import { useCallback, useEffect, useRef, useState } from "react";

type Params<R> = {
  enabled: boolean;
  term: string;
  minLength: number;
  debounceMs: number;
  run: (term: string) => Promise<R>;
  /** The result while disabled, searching or after a failure; keep it stable. */
  empty: R;
  /** Keep showing the last results while the next query runs. */
  keepPrevious?: boolean;
};

export type AsyncQueryState<R> = {
  results: R;
  loading: boolean;
  error: string | null;
  retry: () => void;
};

export function useAsyncQuery<R>({
  enabled,
  term,
  minLength,
  debounceMs,
  run,
  empty,
  keepPrevious = false,
}: Params<R>): AsyncQueryState<R> {
  const [results, setResults] = useState<R>(empty);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const emptyRef = useRef(empty);
  emptyRef.current = empty;

  const execute = useCallback(
    (q: string, runner: (term: string) => Promise<R>) => {
      const requestId = ++requestIdRef.current;
      setLoading(true);
      setError(null);
      runner(q)
        .then((hits) => {
          if (requestId !== requestIdRef.current) return;
          setResults(hits);
        })
        .catch((e) => {
          if (requestId !== requestIdRef.current) return;
          setResults(emptyRef.current);
          setError(String(e));
        })
        .finally(() => {
          if (requestId === requestIdRef.current) setLoading(false);
        });
    },
    [],
  );

  useEffect(() => {
    requestIdRef.current += 1;
    if (!enabled || term.length < minLength) {
      setResults(emptyRef.current);
      setLoading(false);
      setError(null);
      return;
    }
    if (!keepPrevious) setResults(emptyRef.current);
    setLoading(true);
    setError(null);
    // A new `run` (another folder to search) runs the query again.
    const handle = window.setTimeout(() => execute(term, run), debounceMs);
    return () => window.clearTimeout(handle);
  }, [enabled, term, minLength, debounceMs, execute, keepPrevious, run]);

  const retry = useCallback(() => {
    if (enabled && term.length >= minLength) execute(term, run);
  }, [enabled, term, minLength, execute, run]);

  return { results, loading, error, retry };
}
