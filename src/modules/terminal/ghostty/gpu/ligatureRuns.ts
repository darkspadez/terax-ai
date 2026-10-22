/**
 * Ligature runs: two or more adjacent narrow cells of one row that each hold
 * one ASCII punctuation or symbol code point and are drawn alike, cut into
 * chunks of at most `LIGATURE_MAX_CELLS`. Every cell of a run is drawn as its
 * part of the whole run (`ligatureSlicePlacement`), so a font's contextual
 * alternates and ligatures (`->`, `!=`, `===`) join across cells while each
 * cell keeps its own. Like Ghostty's renderer, runs break at the visible
 * cursor, so the text under it reads as typed. The core applies the same
 * rule when it interns WebGPU glyphs (`ligatureChunkLength` in `terax.zig`);
 * the WebGL renderer applies this one.
 */

import { CellFlags } from "@terax/ghostty-core/protocol";
import type { TerminalCellReader } from "../core/packedCells";

export const LIGATURE_MAX_CELLS = 16;

/** A cell that cannot join a run (`ligatureKey`). */
export const LIGATURE_NONE = -1;

/** `!"#$%&'()*+,-./`, `:;<=>?@`, `` [\]^_` `` and `{|}~`. */
export function isLigatureCodepoint(codepoint: number): boolean {
  return (
    (codepoint >= 0x21 && codepoint <= 0x2f) ||
    (codepoint >= 0x3a && codepoint <= 0x40) ||
    (codepoint >= 0x5b && codepoint <= 0x60) ||
    (codepoint >= 0x7b && codepoint <= 0x7e)
  );
}

/**
 * The key `findLigatureRuns` compares: `LIGATURE_NONE` unless the cell is
 * narrow, holds one ligature code point and no grapheme cluster, and is
 * visible. Visible cells join when `foreground` (24-bit RGB as displayed,
 * inverse applied) and `look` (any bits that are equal exactly when bold,
 * italic, faint and blink are) are equal.
 */
export function ligatureKey(
  codepoint: number,
  narrow: boolean,
  cluster: boolean,
  invisible: boolean,
  foreground: number,
  look: number,
): number {
  if (!narrow || cluster || invisible || !isLigatureCodepoint(codepoint)) {
    return LIGATURE_NONE;
  }
  return look * 0x100_0000 + (foreground & 0xff_ffff);
}

/**
 * Splits one row into runs from its cells' `ligatureKey`s. Writes
 * `runs[column]`: 0 outside a run, else the run's length and the cell's index
 * in it (`ligatureRunLength`, `ligatureRunIndex`). A run longer than
 * `LIGATURE_MAX_CELLS` continues as a new run; a last piece of one cell is
 * drawn on its own. A run ends before `breakAt` (the cursor's column, or -1),
 * whose cell is drawn on its own. Returns how many cells are in runs.
 */
export function findLigatureRuns(
  keys: ArrayLike<number>,
  cols: number,
  runs: Uint16Array,
  breakAt = -1,
): number {
  let total = 0;
  let column = 0;
  while (column < cols) {
    const key = keys[column];
    let end = column + 1;
    if (key !== LIGATURE_NONE && column !== breakAt) {
      let limit = Math.min(cols, column + LIGATURE_MAX_CELLS);
      if (breakAt > column) limit = Math.min(limit, breakAt);
      while (end < limit && keys[end] === key) end += 1;
    }
    const length = end - column;
    if (length < 2) {
      runs[column] = 0;
    } else {
      for (let index = 0; index < length; index += 1) {
        runs[column + index] = length * 16 + index;
      }
      total += length;
    }
    column = end;
  }
  return total;
}

/** Cell flags that change how a glyph looks. */
const LOOK_FLAGS =
  CellFlags.BOLD | CellFlags.ITALIC | CellFlags.FAINT | CellFlags.BLINK;

/**
 * `findLigatureRuns` for viewport row `row` of a cell reader (the input of the
 * WebGL renderer), broken at `breakAt`. `keys` and `runs` hold at least `cols`
 * entries. Only punctuation cells are read beyond their code point.
 */
export function findRowLigatureRuns(
  cells: TerminalCellReader,
  row: number,
  cols: number,
  keys: Float64Array,
  runs: Uint16Array,
  breakAt = -1,
): number {
  const base = row * cols;
  let candidates = 0;
  for (let column = 0; column < cols; column += 1) {
    const index = base + column;
    const codepoint = cells.codepoint(index);
    if (!isLigatureCodepoint(codepoint)) {
      keys[column] = LIGATURE_NONE;
      continue;
    }
    const flags = cells.flags(index);
    keys[column] = ligatureKey(
      codepoint,
      cells.width(index) === 1,
      cells.graphemeLength(index) > 0,
      (flags & CellFlags.INVISIBLE) !== 0,
      (flags & CellFlags.INVERSE) !== 0
        ? cells.backgroundPacked(index)
        : cells.foregroundPacked(index),
      flags & LOOK_FLAGS,
    );
    if (keys[column] !== LIGATURE_NONE) candidates += 1;
  }
  if (candidates < 2) {
    runs.fill(0, 0, cols);
    return 0;
  }
  return findLigatureRuns(keys, cols, runs, breakAt);
}

export function ligatureRunLength(run: number): number {
  return run >>> 4;
}

export function ligatureRunIndex(run: number): number {
  return run & 15;
}

/**
 * Text that `GlyphRasterizer` may draw as a run: 2 to `LIGATURE_MAX_CELLS`
 * ligature code points.
 */
export function isLigatureRun(text: string): boolean {
  if (text.length < 2 || text.length > LIGATURE_MAX_CELLS) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (!isLigatureCodepoint(text.charCodeAt(index))) return false;
  }
  return true;
}

/**
 * Whether runs are drawn. Letter spacing moves every cell off the font's
 * advance, which slices of one drawing cannot follow (CSS drops ligatures for
 * letter spacing too).
 */
export function ligaturesApply(
  enabled: boolean,
  letterSpacing: number,
): boolean {
  return enabled && letterSpacing === 0;
}
