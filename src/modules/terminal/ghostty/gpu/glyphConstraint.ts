/**
 * Glyph constraints, after Ghostty (`src/font/Glyph.zig` `Constraint`,
 * `renderer/cell.zig` `constraintWidth`, MIT): Nerd Font icons, symbols and
 * emoji are scaled and aligned to the cell, or to two cells when the glyph is
 * wide or a symbol has room after it, instead of being drawn at the size and
 * position their font gives them and spilling into the neighbours.
 *
 * Everything here is pure. Boxes use Ghostty's convention: `x` from the left
 * edge of the glyph's first cell, `y` up from the bottom edge of the cell to
 * the bottom of the glyph, in device pixels.
 */
import { nerdFontConstraint } from "./nerdFontConstraints";

export type ConstraintSize =
  /** Keep the size. */
  | "none"
  /** Scale down to fit, keeping the aspect ratio. */
  | "fit"
  /** Scale up or down to fit exactly, keeping the aspect ratio. */
  | "cover"
  /** Fit, but scale up to cover one cell when smaller (Nerd Fonts' "pa"). */
  | "fitCover1"
  /** Fill the bounds exactly, ignoring the aspect ratio. */
  | "stretch";

export type ConstraintAlign =
  | "none"
  | "start"
  | "end"
  | "center"
  /** Centred on the first cell even when two are available (Nerd Fonts). */
  | "center1";

/** Sizing and alignment rules shared by a family of glyphs. */
export type GlyphConstraintSpec = {
  readonly size?: ConstraintSize;
  /** The height that bounds scaling: the cell, or Nerd Fonts' icon height. */
  readonly height?: "cell" | "icon";
  /** Most cells the glyph may use, whatever is available. */
  readonly maxCells?: 1 | 2;
  readonly alignX?: ConstraintAlign;
  readonly alignY?: ConstraintAlign;
  /** Padding as a fraction of the face width (left, right) or height. */
  readonly padTop?: number;
  readonly padLeft?: number;
  readonly padRight?: number;
  readonly padBottom?: number;
  /** Largest width / height when stretching; 0 for no limit. */
  readonly maxAspect?: number;
};

export type GlyphConstraint = Required<GlyphConstraintSpec> & {
  /**
   * The glyph's size and offset as fractions of its scale group's bounding
   * box: icons in a group scale and align together, keeping their relative
   * sizes.
   */
  readonly relativeWidth: number;
  readonly relativeHeight: number;
  readonly relativeX: number;
  readonly relativeY: number;
};

export type GlyphBox = {
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
};

export type ConstraintMetrics = {
  /** Whole-pixel cell size. */
  readonly cellWidth: number;
  readonly cellHeight: number;
  /** The font's unrounded advance and line height. */
  readonly faceWidth: number;
  readonly faceHeight: number;
  /** Bottom of the face above the bottom of the cell. */
  readonly faceY: number;
  /** Icon heights for two cells and for one cell (Nerd Fonts' heuristic). */
  readonly iconHeight: number;
  readonly iconHeightSingle: number;
};

export function makeConstraint(spec: GlyphConstraintSpec): GlyphConstraint {
  return {
    size: "none",
    height: "cell",
    maxCells: 2,
    alignX: "none",
    alignY: "none",
    padTop: 0,
    padLeft: 0,
    padRight: 0,
    padBottom: 0,
    maxAspect: 0,
    relativeWidth: 1,
    relativeHeight: 1,
    relativeX: 0,
    relativeY: 0,
    ...spec,
  };
}

/** Symbols without a Nerd Font rule shrink, if needed, to fit their cells. */
export const SYMBOL_CONSTRAINT = makeConstraint({ size: "fit" });

/**
 * Colour emoji are as large as their cells allow, centred, with a little room
 * at the sides so neighbours do not touch.
 */
export const EMOJI_CONSTRAINT = makeConstraint({
  size: "cover",
  alignX: "center",
  alignY: "center",
  padLeft: 0.025,
  padRight: 0.025,
});

/**
 * Metrics for a cell that is the font's face, as Oarlock's cells are: the
 * cell is the line box the text is centred in. `capHeight` is the font's
 * capital height in device pixels.
 */
export function cellConstraintMetrics(
  cellWidth: number,
  cellHeight: number,
  capHeight: number,
): ConstraintMetrics {
  return {
    cellWidth,
    cellHeight,
    faceWidth: cellWidth,
    faceHeight: cellHeight,
    faceY: 0,
    iconHeight: cellHeight,
    iconHeightSingle: (2 * capHeight + cellHeight) / 3,
  };
}

/**
 * Where `glyph` goes under `constraint` when it may use `cells` cells
 * (Ghostty's `constraint_width`). A constraint that neither sizes nor aligns
 * returns the glyph unchanged.
 */
export function constrainGlyph(
  constraint: GlyphConstraint,
  glyph: GlyphBox,
  metrics: ConstraintMetrics,
  cells: number,
): GlyphBox {
  if (
    constraint.size === "none" &&
    constraint.alignX === "none" &&
    constraint.alignY === "none"
  ) {
    return glyph;
  }
  if (constraint.size !== "stretch") {
    return constrainInner(constraint, glyph, metrics, cells);
  }
  // Stretched glyphs join across cells, so they scale to the grid rather than
  // the face, and need no negative padding against rounding gaps.
  return constrainInner(
    {
      ...constraint,
      padTop: Math.max(0, constraint.padTop),
      padLeft: Math.max(0, constraint.padLeft),
      padRight: Math.max(0, constraint.padRight),
      padBottom: Math.max(0, constraint.padBottom),
    },
    glyph,
    {
      ...metrics,
      faceWidth: metrics.cellWidth,
      faceHeight: metrics.cellHeight,
      faceY: 0,
    },
    cells,
  );
}

function constrainInner(
  constraint: GlyphConstraint,
  glyph: GlyphBox,
  metrics: ConstraintMetrics,
  cells: number,
): GlyphBox {
  // Extra wide faces never stretch a glyph across two cells (as the patcher).
  const span =
    constraint.size === "stretch" &&
    metrics.faceWidth > 0.9 * metrics.faceHeight
      ? 1
      : Math.min(constraint.maxCells, cells);

  // Scale and align the scale group's bounding box, then carry the result
  // back to the glyph.
  const groupWidth = glyph.width / constraint.relativeWidth;
  const groupHeight = glyph.height / constraint.relativeHeight;
  const groupX = glyph.x - groupWidth * constraint.relativeX;
  const groupY = glyph.y - groupHeight * constraint.relativeY;
  const [widthFactor, heightFactor] = scaleFactors(
    constraint,
    groupWidth,
    groupHeight,
    metrics,
    span,
  );
  const width = groupWidth * widthFactor;
  const height = groupHeight * heightFactor;
  // Scaling keeps the group's centre.
  const x = alignX(
    constraint,
    groupX + groupWidth / 2 - width / 2,
    width,
    metrics,
    span,
  );
  const y = alignY(
    constraint,
    groupY + groupHeight / 2 - height / 2,
    height,
    metrics,
  );
  return {
    width: widthFactor * glyph.width,
    height: heightFactor * glyph.height,
    x: x + width * constraint.relativeX,
    y: y + height * constraint.relativeY,
  };
}

function scaleFactors(
  constraint: GlyphConstraint,
  groupWidth: number,
  groupHeight: number,
  metrics: ConstraintMetrics,
  span: number,
): readonly [number, number] {
  if (constraint.size === "none") return [1, 1];
  const multiCell = span > 1;
  const targetWidth =
    (span - (constraint.padLeft + constraint.padRight)) * metrics.faceWidth;
  const boundHeight =
    constraint.height === "cell"
      ? metrics.faceHeight
      : multiCell
        ? metrics.iconHeight
        : metrics.iconHeightSingle;
  const targetHeight =
    (1 - (constraint.padBottom + constraint.padTop)) * boundHeight;
  let widthFactor = targetWidth / groupWidth;
  let heightFactor = targetHeight / groupHeight;
  switch (constraint.size) {
    case "fit":
      heightFactor = Math.min(1, widthFactor, heightFactor);
      widthFactor = heightFactor;
      break;
    case "cover":
      heightFactor = Math.min(widthFactor, heightFactor);
      widthFactor = heightFactor;
      break;
    case "fitCover1":
      heightFactor = Math.min(widthFactor, heightFactor);
      // An icon grows to cover one cell, never more because a second cell
      // is free: it keeps its one-cell size and only gains room.
      if (multiCell && heightFactor > 1) {
        const single = scaleFactors(
          constraint,
          groupWidth,
          groupHeight,
          metrics,
          1,
        );
        heightFactor = Math.max(1, single[1]);
      }
      widthFactor = heightFactor;
      break;
    case "stretch":
      break;
  }
  if (
    constraint.maxAspect > 0 &&
    groupWidth * widthFactor > groupHeight * heightFactor * constraint.maxAspect
  ) {
    widthFactor =
      (groupHeight * heightFactor * constraint.maxAspect) / groupWidth;
  }
  return [widthFactor, heightFactor];
}

function alignY(
  constraint: GlyphConstraint,
  y: number,
  height: number,
  metrics: ConstraintMetrics,
): number {
  if (constraint.size === "none" && constraint.alignY === "none") return y;
  const start = metrics.faceY + constraint.padBottom * metrics.faceHeight;
  const end =
    metrics.faceY +
    metrics.faceHeight -
    height -
    constraint.padTop * metrics.faceHeight;
  const center = (start + end) / 2;
  switch (constraint.alignY) {
    case "none":
      // Sized but not aligned: kept inside the padded cell, or centred when
      // it cannot fit.
      return end < start ? center : Math.max(start, Math.min(y, end));
    case "start":
      return start;
    case "end":
      return end;
    case "center":
    case "center1":
      return center;
  }
}

function alignX(
  constraint: GlyphConstraint,
  x: number,
  width: number,
  metrics: ConstraintMetrics,
  span: number,
): number {
  if (constraint.size === "none" && constraint.alignX === "none") return x;
  const faceSpan = metrics.faceWidth + (span - 1) * metrics.cellWidth;
  const start = constraint.padLeft * metrics.faceWidth;
  const end = faceSpan - width - constraint.padRight * metrics.faceWidth;
  // A glyph never protrudes to the left: the left bound wins.
  switch (constraint.alignX) {
    case "none":
      return Math.max(start, Math.min(x, end));
    case "start":
      return start;
    case "end":
      return Math.max(start, end);
    case "center":
      return Math.max(start, (start + end) / 2);
    case "center1": {
      const firstEnd =
        metrics.faceWidth - width - constraint.padRight * metrics.faceWidth;
      return Math.max(start, (start + firstEnd) / 2);
    }
  }
}

/**
 * Ghostty's "symbol-like" code points: Private Use Area icons and the Arrows,
 * Enclosed Alphanumerics, Miscellaneous Symbols, Dingbats, Enclosed
 * Alphanumeric Supplement, Miscellaneous Symbols and Pictographs, Emoticons
 * and Transport and Map Symbols blocks.
 */
export function isSymbol(codepoint: number): boolean {
  if (codepoint < 0x2190) return false;
  if (codepoint < 0xe000) {
    return (
      codepoint <= 0x21ff ||
      (codepoint >= 0x2460 && codepoint <= 0x24ff) ||
      (codepoint >= 0x2600 && codepoint <= 0x27bf)
    );
  }
  if (codepoint <= 0xf8ff) return true;
  return (
    (codepoint >= 0x1f100 && codepoint <= 0x1f1ff) ||
    (codepoint >= 0x1f300 && codepoint <= 0x1f64f) ||
    (codepoint >= 0x1f680 && codepoint <= 0x1f6ff) ||
    (codepoint >= 0xf0000 && codepoint <= 0xffffd) ||
    (codepoint >= 0x100000 && codepoint <= 0x10fffd)
  );
}

/**
 * Terminal graphics drawn edge to edge (box drawing, blocks, legacy computing,
 * powerline): a symbol after one still gets room to grow.
 */
function isGraphicsElement(codepoint: number): boolean {
  return (
    (codepoint >= 0x2500 && codepoint <= 0x259f) ||
    (codepoint >= 0x1fb00 && codepoint <= 0x1fbff) ||
    (codepoint >= 0x1cc00 && codepoint <= 0x1cebf) ||
    (codepoint >= 0xe0b0 && codepoint <= 0xe0d7)
  );
}

/**
 * How many cells a glyph may use (Ghostty's `constraintWidth`): two for a
 * wide character; two for a symbol followed by a blank cell, a space or an en
 * space, unless it ends the row or follows another symbol (so runs of icons
 * stay aligned); one otherwise. `previous` and `next` are the neighbouring
 * cells' first code points (0 for an empty cell); `next` is null at the end
 * of the row.
 */
export function constraintCells(
  codepoint: number,
  gridWidth: number,
  previous: number,
  next: number | null,
): 1 | 2 {
  if (gridWidth > 1) return 2;
  if (!isSymbol(codepoint) || next === null) return 1;
  if (isSymbol(previous) && !isGraphicsElement(previous)) return 1;
  return next === 0 || next === 0x20 || next === 0x2002 ? 2 : 1;
}

const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}/u;
const EMOJI = /^\p{Emoji}/u;

/**
 * Whether `text` asks for emoji presentation: its first code point defaults
 * to it, or a variation selector 16 requests it (and no selector 15 asks for
 * text). Such a cluster is two cells wide in Ghostty's width model.
 */
export function isEmojiPresentation(text: string): boolean {
  const first = text.codePointAt(0) ?? 0;
  // The first code point with emoji presentation is U+231A.
  if (text.length === 1 && first < 0x231a) return false;
  if (text.includes("\ufe0e")) return false;
  if (EMOJI_PRESENTATION.test(text)) return true;
  return text.includes("\ufe0f") && EMOJI.test(text);
}

/**
 * The constraint for a glyph whose first code point is `codepoint`: emoji
 * fill their cells, Nerd Font icons follow the patcher's rules, other symbols
 * shrink to fit, and text is drawn as the font made it (null).
 */
export function glyphConstraint(
  codepoint: number,
  emoji: boolean,
): GlyphConstraint | null {
  if (emoji) return EMOJI_CONSTRAINT;
  if (codepoint < 0x2190) return null;
  return (
    nerdFontConstraint(codepoint) ??
    (isSymbol(codepoint) ? SYMBOL_CONSTRAINT : null)
  );
}
