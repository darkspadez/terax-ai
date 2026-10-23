// The Mermaid renderer: loaded on demand by MermaidBlock, never with the
// Markdown preview or the chat themselves.
import { useTheme, variantMode } from "@/modules/theme";
import { createMermaidPlugin } from "@streamdown/mermaid";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  DiagramCache,
  mermaidConfig,
  serialized,
  stripSvgLinks,
} from "./mermaidRender";

type Mode = "light" | "dark";

const plugin = createMermaidPlugin({ config: mermaidConfig("light") });
const cache = new DiagramCache(32);
let renders = 0;

// Mermaid keeps one global configuration. Setting it and rendering happen
// together, one diagram at a time, so a theme switch in the middle of a run
// cannot draw (and cache) a diagram in the other theme. A diagram that left
// the screen (or the theme it waited for) before its turn is skipped.
const renderDiagram = serialized(
  async (source: string, mode: Mode, signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted();
    const mermaid = plugin.getMermaid(mermaidConfig(mode));
    renders += 1;
    const { svg } = await mermaid.render(`oarlock-mermaid-${renders}`, source);
    return stripSvgLinks(svg);
  },
);

/** True once `ref` comes near the viewport; stays true. */
function useNearViewport(ref: RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (near || !element) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near, ref]);
  return near;
}

type Drawn = { key: string; svg: string } | { key: string; error: unknown };

type Props = {
  code: string;
  /** Shown until the first drawing is ready. */
  pending: ReactNode;
  /** Shown when the diagram cannot be drawn. */
  failed: (error: unknown) => ReactNode;
};

/**
 * A diagram in the app's light or dark theme. It is laid out when it first
 * comes near the viewport (a long chat or document pays only for what is
 * read), and a theme change keeps the old drawing until the new one is ready.
 * What shows around it comes from MermaidBlock, so this chunk holds Mermaid
 * and nothing the block already loaded.
 */
export function MermaidDiagram({ code, pending, failed }: Props) {
  const { activeTheme, resolvedMode } = useTheme();
  const mode = variantMode(activeTheme, resolvedMode);
  const key = DiagramCache.key(mode, code);
  const [drawn, setDrawn] = useState<Drawn | null>(() => {
    const svg = cache.get(key);
    return svg === undefined ? null : { key, svg };
  });
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearViewport(ref);
  const current = drawn?.key === key;

  useEffect(() => {
    if (!near || current) return;
    const cached = cache.get(key);
    if (cached !== undefined) {
      setDrawn({ key, svg: cached });
      return;
    }
    const render = new AbortController();
    renderDiagram(code, mode, render.signal).then(
      (svg) => {
        cache.set(key, svg);
        if (!render.signal.aborted) setDrawn({ key, svg });
      },
      (error: unknown) => {
        if (!render.signal.aborted) setDrawn({ key, error });
      },
    );
    return () => render.abort();
  }, [near, current, key, code, mode]);

  // A stale drawing (the previous theme or source) stays up while the next
  // renders; a stale error does not.
  const shown = drawn && (current || "svg" in drawn) ? drawn : null;
  return (
    <div ref={ref}>
      {shown === null ? (
        pending
      ) : "svg" in shown ? (
        <div
          role="img"
          aria-label="Mermaid diagram"
          // Links are gone, so nodes Mermaid marks clickable are not.
          className="flex justify-center px-3 py-3 [&_.clickable]:cursor-default!"
          // Mermaid's own output: DOMPurify-sanitized in strict mode, labels
          // as SVG text, links removed (stripSvgLinks).
          // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized above
          dangerouslySetInnerHTML={{ __html: shown.svg }}
        />
      ) : (
        failed(shown.error)
      )}
    </div>
  );
}
