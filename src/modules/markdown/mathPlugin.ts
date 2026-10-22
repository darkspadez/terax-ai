// The math renderer: loaded on demand by `math.ts`, never with the Markdown
// preview or the chat themselves. KaTeX's stylesheet and fonts ship with the
// app (`virtual:katex.css`, see vite.config.ts).
import "virtual:katex.css";
import "./math.css";
import { createMathPlugin } from "@streamdown/math";
import type { MathPlugin } from "streamdown";
import { type Attacher, withDollarGuard } from "./dollarMath";

const base = createMathPlugin({
  singleDollarTextMath: true,
  errorColor: "var(--destructive)",
});
const [remarkMath, remarkOptions] = base.remarkPlugin as [Attacher, object];
const [rehypeKatex, katexOptions] = base.rehypePlugin as [Attacher, object];

/**
 * KaTeX settings. `trust` stays off, so `\href`, `\url`, `\includegraphics`
 * and the `\html*` extensions render as errors instead of links or markup.
 * Bad input renders inline in the error colour with the parse error as its
 * title; it never throws.
 */
export const KATEX_OPTIONS = {
  ...katexOptions,
  trust: false,
  // Non-LaTeX input (Unicode in math mode and the like) renders without a
  // console warning per formula.
  strict: "ignore",
  // Caps \rule, \kern and friends at 50em, so a formula cannot stretch the
  // page or the chat; macro expansion keeps KaTeX's own limit.
  maxSize: 50,
  maxExpand: 1000,
} as const;

export const mathPlugin: MathPlugin = {
  ...base,
  remarkPlugin: [withDollarGuard(remarkMath), remarkOptions],
  rehypePlugin: [rehypeKatex, KATEX_OPTIONS],
};
