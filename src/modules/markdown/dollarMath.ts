// Single-dollar inline math follows Pandoc's rule, so prices stay text: the
// opening `$` is followed by a non-space, the closing `$` is preceded by one
// and not followed by a digit. remark-math pairs any two dollars ("$5 and
// $10" would become math), so a span it found that breaks the rule is parsed
// again as ordinary Markdown with its opening dollar escaped.

/** Minimal structural view of mdast nodes (no dependency on @types/mdast). */
type MdNode = {
  type: string;
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MdNode[];
};

type Parse = (markdown: string) => MdNode;

const SPACE = /\s/;
const DIGIT = /[0-9]/;

/**
 * Whether the inline math span `source.slice(start, end)`, delimiters
 * included, may stay math. `$$...$$` spans always may.
 */
export function isDollarMath(
  source: string,
  start: number,
  end: number,
): boolean {
  if (source[start] !== "$" || source[start + 1] === "$") return true;
  const first = source[start + 1] ?? "";
  const last = source[end - 2] ?? "";
  return (
    end - start > 2 &&
    !SPACE.test(first) &&
    !SPACE.test(last) &&
    !DIGIT.test(source[end] ?? "")
  );
}

/**
 * Replaces the inline math nodes of `tree` that break the rule with the
 * phrasing content `parse` makes of their source. `source` is the text the
 * tree was parsed from.
 */
export function guardDollarMath(
  tree: MdNode,
  source: string,
  parse: Parse,
): void {
  const children = tree.children;
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (node.type !== "inlineMath") {
      guardDollarMath(node, source, parse);
      continue;
    }
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    if (isDollarMath(source, start, end)) continue;
    const replacement = asText(source.slice(start, end), parse);
    children.splice(i, 1, ...replacement);
    i += replacement.length - 1;
  }
}

// Escaping the opening dollar leaves the span's closing dollar without a
// partner, so the reparse cannot pair the same two again; any math inside is
// checked against the span's own source.
function asText(span: string, parse: Parse): MdNode[] {
  const escaped = `\\${span}`;
  const root = parse(escaped);
  const only = root.children?.length === 1 ? root.children[0] : undefined;
  if (only?.type !== "paragraph" || !only.children) {
    return [{ type: "text", value: span }];
  }
  guardDollarMath(only, escaped, parse);
  return only.children;
}

type Transformer = (tree: MdNode, file: unknown) => void;

/** A unified plugin, structurally (no dependency on unified's types). */
export type Attacher = (
  this: unknown,
  options?: unknown,
) => Transformer | undefined;

/**
 * remark-math with the rule applied after parsing. The wrapper has its own
 * name: Streamdown keys its processor cache on plugin names.
 */
export function withDollarGuard(remarkMath: Attacher): Attacher {
  return function remarkMathDollarGuard(this: unknown, options?: unknown) {
    remarkMath.call(this, options);
    const processor = this as { parse: Parse };
    return (tree: MdNode, file: unknown) => {
      guardDollarMath(tree, String(file), (md) => processor.parse(md));
    };
  };
}
