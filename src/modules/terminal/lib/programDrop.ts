import { IS_WINDOWS } from "@/lib/platform";
import type { GhosttyDragPosition } from "@/modules/terminal/ghostty/GhosttyTerminalModel";

/**
 * Dropping files on a program that registered for drops (Kitty OSC 72):
 * the representations offered, the data they carry and where the drag is.
 */

/** What dropped files are offered as, most specific first. */
export const DROPPED_PATH_MIMES: readonly string[] = [
  "text/uri-list",
  "text/plain",
];

const encoder = new TextEncoder();

/** A `file:` URI (RFC 8089) for an absolute path. */
export function fileUri(path: string, windows = IS_WINDOWS): string {
  const slashed = windows ? path.replace(/\\/g, "/") : path;
  const encoded = slashed
    .split("/")
    .map((segment) =>
      // A drive letter stays as written: file:///C:/dir.
      windows && /^[A-Za-z]:$/.test(segment)
        ? segment
        : encodeURIComponent(segment),
    )
    .join("/");
  // A UNC path names its host: \\server\share is file://server/share.
  if (encoded.startsWith("//")) return `file:${encoded}`;
  return `file://${encoded.startsWith("/") ? "" : "/"}${encoded}`;
}

/** The data of a file drop, in `DROPPED_PATH_MIMES` order. */
export function droppedPathItems(
  paths: readonly string[],
  windows = IS_WINDOWS,
): { mime: string; data: Uint8Array }[] {
  const uris = paths.map((path) => `${fileUri(path, windows)}\r\n`).join("");
  return [
    { mime: "text/uri-list", data: encoder.encode(uris) },
    { mime: "text/plain", data: encoder.encode(paths.join("\n")) },
  ];
}

/**
 * Where a drag at `x`, `y` CSS pixels from the grid's top-left is: its cell,
 * and its position in the terminal pixels mouse reports count in (`pixels`
 * per cell; the CSS cell size when the terminal has none). Files are only
 * ever copied: moving them would delete the originals. Null before the grid
 * has a cell size.
 */
export function terminalDragPosition(
  x: number,
  y: number,
  cell: { readonly width: number; readonly height: number },
  pixels: { readonly width: number; readonly height: number } | null,
): GhosttyDragPosition | null {
  if (!(cell.width > 0 && cell.height > 0)) return null;
  const scale = pixels ?? cell;
  return {
    cellX: Math.max(0, Math.floor(x / cell.width)),
    cellY: Math.max(0, Math.floor(y / cell.height)),
    pixelX: Math.round((x / cell.width) * scale.width),
    pixelY: Math.round((y / cell.height) * scale.height),
    copy: true,
    move: false,
  };
}
