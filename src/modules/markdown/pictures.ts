import type { ThemeMode } from "@/modules/theme/types";
import type { HNode } from "./hast";
import { isDocumentRelative } from "./localImages";

const COLOR_SCHEME = /prefers-color-scheme\s*:\s*(dark|light)/i;

/**
 * `<picture>` as GitHub shows a README's logo: its `<img>` takes the image
 * of the first `<source>` that applies (a `prefers-color-scheme` query is
 * matched against the variant the app paints, not the system's; a source
 * without `media` always applies, one with any other query never does), and
 * every `<source>` goes. A srcset therefore never reaches the webview: the
 * chosen URL is vetted like an image's own src (https, http, or a path
 * relative to the document) and loads through the same image steps, which
 * run after this one.
 */
export function rehypePictures(scheme: ThemeMode) {
  const visit = (node: HNode) => {
    if (node.type === "element" && node.tagName === "picture") {
      pick(node, scheme);
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  return (tree: HNode) => visit(tree);
}

function pick(picture: HNode, scheme: ThemeMode): void {
  const children = picture.children ?? [];
  const isSource = (node: HNode) =>
    node.type === "element" && node.tagName === "source";
  const chosen = children
    .filter(isSource)
    .find((source) => applies(source.properties?.media, scheme));
  const src = chosen && firstCandidate(chosen.properties?.srcSet);
  const img = children.find(
    (node) => node.type === "element" && node.tagName === "img",
  );
  if (img && src) img.properties = { ...img.properties, src };
  picture.children = children.filter((node) => !isSource(node));
}

function applies(media: unknown, scheme: ThemeMode): boolean {
  if (typeof media !== "string" || media.trim() === "") return true;
  return COLOR_SCHEME.exec(media)?.[1]?.toLowerCase() === scheme;
}

// The URL of a srcset's first candidate ("a.png 1x, b.png 2x"; hast may
// hold the list split on its commas), when it may load as an image.
function firstCandidate(srcSet: unknown): string | null {
  const list = Array.isArray(srcSet) ? srcSet.join(",") : srcSet;
  if (typeof list !== "string") return null;
  const url = list.trim().split(/\s+/, 1)[0]?.replace(/,$/, "") ?? "";
  return /^https?:\/\//i.test(url) || isDocumentRelative(url) ? url : null;
}
