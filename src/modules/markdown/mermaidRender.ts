import type { MermaidConfig } from "@streamdown/mermaid";

/**
 * Configuration keys a diagram's own `%%{init: ...}%%` directive or front
 * matter can never change. Mermaid sanitizes directives against this list at
 * every depth; the first six are its defaults. Ours keep labels as SVG text
 * (no HTML), DOMPurify's settings as Mermaid ships them, and the stylesheet
 * free of injected CSS.
 */
export const MERMAID_SECURE_KEYS = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "suppressErrorRendering",
  "maxEdges",
  "htmlLabels",
  "dompurifyConfig",
  "themeCSS",
  "fontFamily",
  "altFontFamily",
];

/** The app's UI font (`--font-sans` in globals.css). */
const DIAGRAM_FONT = '"Inter Variable", sans-serif';

/**
 * Mermaid settings for untrusted diagrams (AI replies, files from disk):
 * strict security (no click callbacks, DOMPurify over the output), SVG text
 * labels instead of HTML, errors thrown instead of drawn into the page, and
 * Mermaid's light or dark theme to match the app.
 */
export function mermaidConfig(mode: "light" | "dark"): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    suppressErrorRendering: true,
    secure: MERMAID_SECURE_KEYS,
    theme: mode === "dark" ? "dark" : "default",
    fontFamily: DIAGRAM_FONT,
  };
}

/** Index just past the `>` closing the tag that opens at `start`. */
function tagEnd(markup: string, start: number): number {
  let quote = "";
  for (let i = start + 1; i < markup.length; i++) {
    const c = markup[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i + 1;
    }
  }
  return markup.length;
}

const LINK_TAG = /^<\/?a(?=[\s/>])/i;

/**
 * `svg` with every `<a>` unwrapped, its content kept. Mermaid turns `click`
 * statements and `href`s into links, and a link inside the app's own webview
 * would navigate it. The input is markup Mermaid serialized after DOMPurify:
 * attribute values quoted, `<` in text escaped, no comments.
 */
export function stripSvgLinks(svg: string): string {
  let out = "";
  let i = 0;
  while (i < svg.length) {
    const lt = svg.indexOf("<", i);
    if (lt === -1) {
      out += svg.slice(i);
      break;
    }
    out += svg.slice(i, lt);
    const end = tagEnd(svg, lt);
    const tag = svg.slice(lt, end);
    if (!LINK_TAG.test(tag)) out += tag;
    i = end;
  }
  return out;
}

/**
 * `task` wrapped to run one call at a time, in call order; a failed call
 * does not stop the ones after it.
 */
export function serialized<A extends unknown[], R>(
  task: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  let tail: Promise<unknown> = Promise.resolve();
  return (...args) => {
    const run = tail.then(() => task(...args));
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * Rendered diagrams by theme and source, so a diagram shown again (a chat
 * reopened, a file re-read after a save) is not laid out again. Least
 * recently used entries go first.
 */
export class DiagramCache {
  private readonly entries = new Map<string, string>();

  constructor(private readonly limit: number) {}

  static key(mode: "light" | "dark", source: string): string {
    return `${mode}\n${source}`;
  }

  get(key: string): string | undefined {
    const svg = this.entries.get(key);
    if (svg !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, svg);
    }
    return svg;
  }

  set(key: string, svg: string): void {
    this.entries.delete(key);
    this.entries.set(key, svg);
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.limit) break;
      this.entries.delete(oldest);
    }
  }
}
