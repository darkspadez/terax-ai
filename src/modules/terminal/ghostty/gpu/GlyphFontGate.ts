/** The part of `FontFaceSet` the gate uses. */
export type GlyphFontLoader = {
  check(font: string, text: string): boolean;
  load(font: string, text: string): Promise<unknown>;
};

/** Settled keys kept; past this the set restarts (loaded fonts check true). */
const MAX_SETTLED = 4_096;

/**
 * Private Use Area codepoints (Nerd Font icons): engines draw them only with a
 * font the stack names, never by system fallback, and the bundled symbol font
 * that supplies them loads on demand.
 */
export function isPrivateUseCodepoint(codepoint: number): boolean {
  return (
    (codepoint >= 0xe000 && codepoint <= 0xf8ff) ||
    (codepoint >= 0xf0000 && codepoint <= 0x10fffd)
  );
}

export function hasPrivateUseCodepoint(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const codepoint = text.codePointAt(index) ?? 0;
    if (codepoint > 0xffff) index += 1;
    if (isPrivateUseCodepoint(codepoint)) return true;
  }
  return false;
}

/**
 * Text that may need a font segment loaded on demand: anything beyond ASCII.
 * ASCII is in the segments loaded before a terminal starts
 * (`ensureMonoFontsLoaded`: JetBrains Mono's Latin, upright and italic).
 */
export function needsFontGate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7f) return true;
  }
  return false;
}

/**
 * Keeps glyph atlases from caching a glyph drawn before its font arrived. A
 * canvas draws a not-yet-loaded web font's characters with the next font (for
 * an icon, an empty box; for text, another typeface) and atlases keep what
 * they rasterize. Bundled fonts are split by Unicode range and load a segment
 * on first use (Terax Symbols' icon sets, JetBrains Mono's scripts and
 * symbols), so non-ASCII text is rasterized only once `document.fonts`
 * reports its fonts ready; text no bundled face covers checks ready at once.
 * Until then `ready()` starts one load and answers false; subscribers hear
 * when it settles and retry. A failed load counts as settled, so a glyph is
 * deferred at most once per font.
 */
export class GlyphFontGate {
  private readonly loading = new Set<string>();
  private settled = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private notifyQueued = false;

  constructor(private readonly fonts: GlyphFontLoader | null) {}

  /** True when `text` may be rasterized in `font` now. */
  ready(font: string, text: string): boolean {
    if (!this.fonts || !needsFontGate(text)) return true;
    const key = `${font}\u0000${text}`;
    if (this.settled.has(key)) return true;
    try {
      if (this.fonts.check(font, text)) return true;
    } catch {
      return true;
    }
    if (!this.loading.has(key)) {
      this.loading.add(key);
      const settle = () => {
        this.loading.delete(key);
        if (this.settled.size >= MAX_SETTLED) this.settled = new Set();
        this.settled.add(key);
        this.queueNotify();
      };
      this.fonts.load(font, text).then(settle, settle);
    }
    return false;
  }

  /** `listener` runs after loads settle (batched per microtask). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private queueNotify(): void {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      for (const listener of [...this.listeners]) listener();
    });
  }
}

let documentGate: GlyphFontGate | null = null;

/** The gate for this window's `document.fonts` (always ready without one). */
export function documentGlyphFontGate(): GlyphFontGate {
  documentGate ??= new GlyphFontGate(
    typeof document !== "undefined" && document.fonts ? document.fonts : null,
  );
  return documentGate;
}
