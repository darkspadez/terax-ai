import { useEffect, useSyncExternalStore } from "react";
import type { PluginConfig } from "streamdown";

// A fenced block whose language is `math` renders as display math too.
const MATH_FENCE = /(?:`{3,}|~{3,})[ \t]*math\b/;

/**
 * Whether `text` may hold math: two dollars or a math fence. Cheap and never
 * wrong in the negative, so text without math never loads KaTeX.
 */
export function mayContainMath(text: string): boolean {
  const first = text.indexOf("$");
  if (first !== -1 && text.indexOf("$", first + 1) !== -1) return true;
  return MATH_FENCE.test(text);
}

let loaded: PluginConfig | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Loads the math renderer once; a failed load is tried again next time. */
export function loadMathPlugins(): Promise<void> {
  if (loaded) return Promise.resolve();
  loading ??= import("./mathPlugin").then(
    (m) => {
      loaded = { math: m.mathPlugin };
      for (const notify of listeners) notify();
    },
    (error) => {
      loading = null;
      console.warn("[markdown] math renderer not loaded", error);
    },
  );
  return loading;
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

const snapshot = () => loaded;

/**
 * Streamdown plugins for `text`: the math renderer once it is loaded, and
 * only for text that may hold math, so other messages and files keep their
 * processor. Until it loads, formulas show as their source.
 */
export function useMathPlugins(text: string): PluginConfig | undefined {
  const wanted = mayContainMath(text);
  const plugins = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (wanted) void loadMathPlugins();
  }, [wanted]);
  return wanted && plugins ? plugins : undefined;
}
