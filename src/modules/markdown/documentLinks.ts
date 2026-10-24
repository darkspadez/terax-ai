import type { HNode } from "./hast";
import { isDocumentRelative } from "./localImages";

/**
 * Anchors as GitHub shows them, settled before harden, which turns every
 * anchor it cannot vet into a "[blocked]" note:
 *
 * - A link to a file next to the document ("LICENSE", "docs/setup.md")
 *   stays a link: harden cannot parse a bare relative URL, but passes it
 *   written "./LICENSE". The preview never navigates to it (PreviewLink).
 * - An anchor without a link (`<a name="install">`, or one whose
 *   `javascript:` URL the sanitizer took away) becomes a span with its
 *   content, keeping its name as the id that `#install` scrolls to.
 */
export function rehypeDocumentLinks() {
  const visit = (node: HNode) => {
    if (node.type === "element" && node.tagName === "a") settle(node);
    for (const child of node.children ?? []) visit(child);
  };
  return (tree: HNode) => visit(tree);
}

function settle(anchor: HNode): void {
  const { href, id, name } = anchor.properties ?? {};
  if (typeof href !== "string") {
    // Both arrive with the sanitizer's user-content- prefix.
    const target = id ?? name;
    anchor.tagName = "span";
    anchor.properties = target === undefined ? {} : { id: target };
  } else if (isDocumentRelative(href) && !/^\.\.?\//.test(href)) {
    anchor.properties = { ...anchor.properties, href: `./${href}` };
  }
}
