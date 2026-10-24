import type { GhosttyViewportLink } from "../GhosttyTerminalModel";

/**
 * The hovered link's cells, as an inclusive range of viewport cell indices (`row * cols +
 * column`). Both renderers underline it as an overlay, so hovering never rewrites cell data.
 */
export type LinkCellRange = { readonly start: number; readonly end: number };

/**
 * The cells to underline: the link's spans joined into one range when they follow each other in
 * reading order (a link wrapped over rows, as both kinds of link the model reports are), else
 * only the span under the pointer. Spans are clamped to the grid; null when nothing is left.
 */
export function linkCellRange(
  spans: GhosttyViewportLink["spans"],
  cols: number,
  rows: number,
  hoveredRow: number,
  hoveredColumn: number,
): LinkCellRange | null {
  const clamped = spans
    .filter((span) => span.row >= 0 && span.row < rows)
    .map((span) => ({
      row: span.row,
      start: Math.max(0, span.startColumn),
      end: Math.min(cols - 1, span.endColumn),
    }))
    .filter((span) => span.start <= span.end)
    .sort((left, right) => left.row - right.row);
  if (clamped.length === 0) return null;
  let joined = true;
  for (let index = 1; index < clamped.length && joined; index += 1) {
    const previous = clamped[index - 1];
    const span = clamped[index];
    joined =
      span.row === previous.row + 1 &&
      previous.end === cols - 1 &&
      span.start === 0;
  }
  if (joined) {
    const first = clamped[0];
    const last = clamped[clamped.length - 1];
    return {
      start: first.row * cols + first.start,
      end: last.row * cols + last.end,
    };
  }
  const hovered = clamped.find(
    (span) =>
      span.row === hoveredRow &&
      hoveredColumn >= span.start &&
      hoveredColumn <= span.end,
  );
  return hovered
    ? {
        start: hovered.row * cols + hovered.start,
        end: hovered.row * cols + hovered.end,
      }
    : null;
}

export function linkRangesEqual(
  left: LinkCellRange | null,
  right: LinkCellRange | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.start === right.start &&
      left.end === right.end)
  );
}
