import {
  BuiltinGlyphRenderer,
  builtinGlyphSpec,
  isBuiltinGlyph,
} from "./BuiltinGlyphs";
import {
  documentGlyphFontGate,
  type GlyphFontGate,
  hasPrivateUseCodepoint,
} from "./GlyphFontGate";
import { hasIntrinsicColor } from "./glyphColor";
import {
  type ConstraintMetrics,
  cellConstraintMetrics,
  constrainGlyph,
  type GlyphConstraint,
  glyphConstraint,
  isEmojiPresentation,
} from "./glyphConstraint";
import { isLigatureRun } from "./ligatureRuns";
import { fontCss, type TerminalFontMetrics } from "./terminalVisuals";

const RASTER_SIZE = 256;
/** Ligature runs whose measurements are kept (cells of a run come together). */
const MAX_CACHED_RUNS = 64;
const GLYPH_PADDING = 2;
const CLEAR_MARGIN = 8;
/** Ink smaller than this has no shape worth constraining (as Ghostty). */
const MIN_INK = 0.25;

export const GLYPH_STYLE_BOLD = 1;
export const GLYPH_STYLE_ITALIC = 2;
/**
 * The glyph may use two cells (Ghostty's constraint width 2): a wide
 * character, or a symbol with a blank cell after it. Without it the count
 * follows from the text: emoji take two cells, everything else one.
 */
export const GLYPH_STYLE_TWO_CELLS = 4;
/**
 * One cell of a ligature run (`ligatureRuns.ts`): the text is the whole run
 * and bits 4-7 hold the cell's index in it. The glyph is that cell's slice of
 * the run (`ligatureSlicePlacement`).
 */
export const GLYPH_STYLE_LIGATURE = 8;
export const GLYPH_STYLE_LIGATURE_INDEX_SHIFT = 4;
export const GLYPH_STYLE_LIGATURE_INDEX_MASK = 0xf0;
/** Style bits that change a glyph's bitmap beyond bold and italic. */
export const GLYPH_STYLE_LAYOUT_MASK =
  GLYPH_STYLE_TWO_CELLS |
  GLYPH_STYLE_LIGATURE |
  GLYPH_STYLE_LIGATURE_INDEX_MASK;

export type RasterizedGlyph = {
  readonly width: number;
  readonly height: number;
  /** Offset of the bitmap's top-left from the cell's top-left, device pixels. */
  readonly bearingX: number;
  readonly bearingY: number;
  readonly intrinsicColor: boolean;
  /**
   * The coverage is final: procedurally drawn cell shapes whose partial values
   * (shades, anti-aliased edges) are intended, so no text contrast adjustment
   * may reshape them.
   */
  readonly exact: boolean;
  /**
   * `width * height` coverage bytes, or `width * height * 4` RGBA bytes for an
   * intrinsic-colour glyph. Borrowed scratch memory: valid until the next call.
   */
  readonly pixels: Uint8Array;
};

/**
 * A glyph's ink around its pen origin, as `TextMetrics.actualBoundingBox*`
 * reports it (0 when unknown), in device pixels.
 */
export type InkBounds = {
  readonly left: number;
  readonly right: number;
  readonly ascent: number;
  readonly descent: number;
};

/** How a glyph is drawn into its bitmap and where the bitmap sits. */
export type GlyphPlacement = {
  /** Bitmap size, and its top-left relative to the cell's top-left. */
  readonly width: number;
  readonly height: number;
  readonly bearingX: number;
  readonly bearingY: number;
  /** Pen origin in the bitmap, and the scale the glyph is drawn at. */
  readonly originX: number;
  readonly originY: number;
  readonly scaleX: number;
  readonly scaleY: number;
};

type LigatureRun = {
  readonly ink: InkBounds;
  readonly pens: readonly number[];
};

type CellGeometry = Pick<
  TerminalFontMetrics,
  "deviceCellWidth" | "deviceCellHeight" | "deviceBaseline"
>;

/**
 * Where a glyph with `ink` is drawn. Without a constraint it keeps the font's
 * size and sits on the cell's baseline at the cell's left edge; with one it is
 * scaled and moved to the box `constrainGlyph` gives for `cells` cells.
 * `pixelAligned` snaps that box to whole pixels, as Ghostty does for bitmap
 * (colour emoji) glyphs, which blur when resampled off the pixel grid.
 */
export function placeGlyph(
  ink: InkBounds,
  cell: CellGeometry,
  constraint: GlyphConstraint | null,
  metrics: ConstraintMetrics | null,
  cells: number,
  pixelAligned: boolean,
): GlyphPlacement {
  const inkWidth = ink.left + ink.right;
  const inkHeight = ink.ascent + ink.descent;
  if (
    !constraint ||
    !metrics ||
    !(inkWidth >= MIN_INK && inkHeight >= MIN_INK)
  ) {
    return naturalPlacement(ink, cell);
  }
  const box = constrainGlyph(
    constraint,
    {
      width: inkWidth,
      height: inkHeight,
      x: -ink.left,
      y: cell.deviceCellHeight - cell.deviceBaseline - ink.descent,
    },
    metrics,
    cells,
  );
  // Cell coordinates, y down.
  let left = box.x;
  let right = box.x + box.width;
  let bottom = cell.deviceCellHeight - box.y;
  let top = bottom - box.height;
  if (pixelAligned) {
    left = Math.round(left);
    right = Math.max(left + 1, Math.round(right));
    top = Math.round(top);
    bottom = Math.max(top + 1, Math.round(bottom));
  }
  const scaleX = (right - left) / inkWidth;
  const scaleY = (bottom - top) / inkHeight;
  const bearingX = Math.floor(left) - GLYPH_PADDING;
  const bearingY = Math.floor(top) - GLYPH_PADDING;
  return {
    width: clampSize(Math.ceil(right) + GLYPH_PADDING - bearingX),
    height: clampSize(Math.ceil(bottom) + GLYPH_PADDING - bearingY),
    bearingX,
    bearingY,
    originX: left + ink.left * scaleX - bearingX,
    originY: top + ink.ascent * scaleY - bearingY,
    scaleX,
    scaleY,
  };
}

function naturalPlacement(ink: InkBounds, cell: CellGeometry): GlyphPlacement {
  const left = Math.max(0, Math.ceil(ink.left));
  const right = Math.ceil(ink.right || cell.deviceCellWidth);
  const ascent = Math.ceil(ink.ascent || cell.deviceBaseline);
  const descent = Math.ceil(
    ink.descent || cell.deviceCellHeight - cell.deviceBaseline,
  );
  return {
    width: clampSize(left + right + GLYPH_PADDING * 2),
    height: clampSize(ascent + descent + GLYPH_PADDING * 2),
    bearingX: -left - GLYPH_PADDING,
    bearingY: cell.deviceBaseline - ascent - GLYPH_PADDING,
    originX: GLYPH_PADDING + left,
    originY: GLYPH_PADDING + ascent,
    scaleX: 1,
    scaleY: 1,
  };
}

/**
 * Where cell `index` of a ligature run is drawn. The whole run is drawn with
 * that cell's character on the cell's pen origin, where it sits when drawn
 * alone, and the bitmap is exactly the cell: neighbouring slices meet without
 * overlapping, and every character stays on its own cell even when the cell
 * is wider than the font's advance (a cell is whole device pixels). `pens[i]`
 * is the pen offset of character `i` from the run's start and `ink` the whole
 * run's ink around that start. The first and last cells also keep the ink
 * that leaves the run (a slant, an overhang), as a glyph drawn alone does.
 */
export function ligatureSlicePlacement(
  ink: InkBounds,
  pens: readonly number[],
  cell: CellGeometry,
  index: number,
): GlyphPlacement {
  const pen = pens[index];
  const last = pens.length - 1;
  const ascent = Math.ceil(ink.ascent || cell.deviceBaseline);
  const descent = Math.ceil(
    ink.descent || cell.deviceCellHeight - cell.deviceBaseline,
  );
  // Cell coordinates: x = 0 is the cell's left edge and this cell's pen.
  const left =
    index === 0 ? Math.min(0, Math.floor(-ink.left)) - GLYPH_PADDING : 0;
  const right =
    index === last
      ? Math.max(cell.deviceCellWidth, Math.ceil(ink.right - pen)) +
        GLYPH_PADDING
      : cell.deviceCellWidth;
  return {
    width: clampSize(right - left),
    height: clampSize(ascent + descent + GLYPH_PADDING * 2),
    bearingX: left,
    bearingY: cell.deviceBaseline - ascent - GLYPH_PADDING,
    originX: -pen - left,
    originY: GLYPH_PADDING + ascent,
    scaleX: 1,
    scaleY: 1,
  };
}

function clampSize(size: number): number {
  return Math.min(RASTER_SIZE, Math.max(1, size));
}

/**
 * Rasterizes single glyphs with the 2D canvas at `font.size * scale`. The
 * canvas is allocated lazily, sized once, and released on `dispose` so an idle
 * atlas holds no bitmap. Only the area the previous glyph touched is cleared,
 * and `context.font` is assigned only when the style changes.
 *
 * Box drawing, blocks, braille, powerline separators, branch drawing and legacy
 * computing shapes skip the font: they are drawn at exactly the cell size with
 * no bearing (see `BuiltinGlyphs.ts`), so neighbouring cells join without
 * gaps, and bold or italic never alters them.
 *
 * Icons, symbols and emoji are constrained as Ghostty constrains them
 * (`glyphConstraint.ts`): fitted and aligned to their cell, or two cells, so
 * a wide fallback glyph never spills into its neighbours.
 */
export class GlyphRasterizer {
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private readonly fonts: string[];
  private activeStyle = -1;
  private dirtyWidth = RASTER_SIZE;
  private dirtyHeight = RASTER_SIZE;
  private readonly coverage = new Uint8Array(RASTER_SIZE * RASTER_SIZE);
  private builtin: BuiltinGlyphRenderer | null = null;
  private constraintMetricsValue: ConstraintMetrics | null = null;
  /** Measured runs by font style and text: every cell of a run needs them. */
  private runs = new Map<string, LigatureRun>();

  constructor(
    private readonly metrics: TerminalFontMetrics,
    private readonly fontGate: GlyphFontGate = documentGlyphFontGate(),
  ) {
    const font = {
      ...metrics.font,
      size: metrics.font.size * metrics.scale,
    };
    this.fonts = [0, 1, 2, 3].map((style) =>
      fontCss(
        font,
        (style & GLYPH_STYLE_BOLD) !== 0,
        (style & GLYPH_STYLE_ITALIC) !== 0,
      ),
    );
  }

  get cpuBytes(): number {
    return (
      (this.canvas ? RASTER_SIZE * RASTER_SIZE * 5 : 0) +
      (this.builtin?.byteSize ?? 0)
    );
  }

  /**
   * Null while the font for an icon is still loading (`GlyphFontGate`): the
   * caller keeps nothing and retries once the gate reports the load settled.
   * `cells` is how many cells the glyph may use when the caller knows (see
   * `constraintCells`); otherwise `GLYPH_STYLE_TWO_CELLS` or the text decide.
   */
  rasterize(
    text: string,
    style: number,
    cells?: 1 | 2,
  ): RasterizedGlyph | null {
    if ((style & GLYPH_STYLE_LIGATURE) !== 0) {
      return this.rasterizeLigature(text, style);
    }
    const builtin = this.rasterizeBuiltin(text);
    if (builtin) return builtin;
    // Icons ignore bold and italic, like procedural glyphs: no synthesized
    // weight or slant on a symbol.
    const fontStyle = hasPrivateUseCodepoint(text)
      ? 0
      : style & (GLYPH_STYLE_BOLD | GLYPH_STYLE_ITALIC);
    if (!this.fontGate.ready(this.fonts[fontStyle], text)) return null;
    const context = this.ensureContext();

    const codepoint = text.codePointAt(0) ?? 0;
    const emoji = isEmojiPresentation(text);
    const span =
      cells ?? ((style & GLYPH_STYLE_TWO_CELLS) !== 0 || emoji ? 2 : 1);
    const constraint = glyphConstraint(codepoint, emoji);
    const constraintMetrics = constraint
      ? this.constraintMetrics(context)
      : null;
    this.selectFont(context, fontStyle);
    const measurement = context.measureText(text);
    const ink: InkBounds = {
      left: measurement.actualBoundingBoxLeft || 0,
      right: measurement.actualBoundingBoxRight || 0,
      ascent: measurement.actualBoundingBoxAscent || 0,
      descent: measurement.actualBoundingBoxDescent || 0,
    };
    let placement = placeGlyph(
      ink,
      this.metrics,
      constraint,
      constraintMetrics,
      span,
      emoji,
    );
    let rgba = this.draw(context, text, placement);
    const intrinsicColor = hasIntrinsicColor(rgba);
    if (intrinsicColor !== emoji) {
      // The font chose the other presentation (a colour glyph for text, or a
      // monochrome one for an emoji), which takes the other constraint.
      const actual = glyphConstraint(codepoint, intrinsicColor);
      placement = placeGlyph(
        ink,
        this.metrics,
        actual,
        actual ? this.constraintMetrics(context) : null,
        span,
        intrinsicColor,
      );
      rgba = this.draw(context, text, placement);
    }

    return this.glyph(rgba, placement, intrinsicColor);
  }

  /**
   * Cell `index` of a ligature run: the run drawn once per cell, shifted so
   * the cell's character sits on its pen origin, and cut to the cell
   * (`ligatureSlicePlacement`). Drawing per cell keeps every character on the
   * pixel phase it has when drawn alone; the run's measurements are cached.
   * Text that is not a run, or letter spacing (cells off the font's advance),
   * draws the cell's own character.
   */
  private rasterizeLigature(
    text: string,
    style: number,
  ): RasterizedGlyph | null {
    const index =
      (style & GLYPH_STYLE_LIGATURE_INDEX_MASK) >>>
      GLYPH_STYLE_LIGATURE_INDEX_SHIFT;
    const fontStyle = style & (GLYPH_STYLE_BOLD | GLYPH_STYLE_ITALIC);
    if (
      !isLigatureRun(text) ||
      index >= text.length ||
      this.metrics.font.letterSpacing !== 0
    ) {
      return this.rasterize(text.charAt(index) || text, fontStyle, 1);
    }
    if (!this.fontGate.ready(this.fonts[fontStyle], text)) return null;
    const context = this.ensureContext();
    this.selectFont(context, fontStyle);
    const run = this.measureRun(context, text, fontStyle);
    const placement = ligatureSlicePlacement(
      run.ink,
      run.pens,
      this.metrics,
      index,
    );
    const rgba = this.draw(
      context,
      text,
      placement,
      placement.originX + run.ink.right,
    );
    return this.glyph(rgba, placement, hasIntrinsicColor(rgba));
  }

  private measureRun(
    context: CanvasRenderingContext2D,
    text: string,
    fontStyle: number,
  ): LigatureRun {
    const key = `${fontStyle}\u0000${text}`;
    const cached = this.runs.get(key);
    if (cached) return cached;
    const measurement = context.measureText(text);
    const pens = [0];
    for (let index = 1; index < text.length; index += 1) {
      pens.push(context.measureText(text.slice(0, index)).width || 0);
    }
    const run: LigatureRun = {
      ink: {
        left: measurement.actualBoundingBoxLeft || 0,
        right: measurement.actualBoundingBoxRight || 0,
        ascent: measurement.actualBoundingBoxAscent || 0,
        descent: measurement.actualBoundingBoxDescent || 0,
      },
      pens,
    };
    if (this.runs.size >= MAX_CACHED_RUNS) this.runs.clear();
    this.runs.set(key, run);
    return run;
  }

  private glyph(
    rgba: Uint8ClampedArray,
    placement: GlyphPlacement,
    intrinsicColor: boolean,
  ): RasterizedGlyph {
    const { width, height } = placement;
    let pixels: Uint8Array;
    if (intrinsicColor) {
      pixels = new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    } else {
      const count = width * height;
      pixels = this.coverage.subarray(0, count);
      for (let index = 0, source = 3; index < count; index += 1, source += 4) {
        pixels[index] = rgba[source];
      }
    }
    return {
      width,
      height,
      bearingX: placement.bearingX,
      bearingY: placement.bearingY,
      intrinsicColor,
      exact: false,
      pixels,
    };
  }

  /** A procedurally drawn cell-sized glyph, or null when `text` is not one. */
  private rasterizeBuiltin(text: string): RasterizedGlyph | null {
    const codepoint = text.codePointAt(0) ?? 0;
    if (!isBuiltinGlyph(codepoint)) return null;
    if (text.length !== (codepoint > 0xffff ? 2 : 1)) return null;
    this.builtin ??= new BuiltinGlyphRenderer(builtinGlyphSpec(this.metrics));
    const pixels = this.builtin.render(codepoint);
    if (!pixels) return null;
    return {
      width: this.builtin.spec.width,
      height: this.builtin.spec.height,
      bearingX: 0,
      bearingY: 0,
      intrinsicColor: false,
      exact: true,
      pixels,
    };
  }

  /**
   * Clears what the last glyph touched, draws `text` and reads it back.
   * `inkRight` is where the drawn ink ends when it goes past the bitmap (the
   * rest of a ligature run), so the next glyph clears it.
   */
  private draw(
    context: CanvasRenderingContext2D,
    text: string,
    placement: GlyphPlacement,
    inkRight = 0,
  ): Uint8ClampedArray {
    context.clearRect(0, 0, this.dirtyWidth, this.dirtyHeight);
    const { originX, originY, scaleX, scaleY, width, height } = placement;
    if (scaleX === 1 && scaleY === 1) {
      context.fillText(text, originX, originY);
    } else {
      context.setTransform(scaleX, 0, 0, scaleY, originX, originY);
      context.fillText(text, 0, 0);
      context.setTransform(1, 0, 0, 1, 0, 0);
    }
    this.dirtyWidth = Math.min(
      RASTER_SIZE,
      Math.max(width, Math.ceil(inkRight)) + CLEAR_MARGIN,
    );
    this.dirtyHeight = Math.min(RASTER_SIZE, height + CLEAR_MARGIN);
    return context.getImageData(0, 0, width, height).data;
  }

  /**
   * The cell as the font's face, with the capital height the icon height
   * derives from. Measured once, with the regular font.
   */
  private constraintMetrics(
    context: CanvasRenderingContext2D,
  ): ConstraintMetrics {
    if (this.constraintMetricsValue) return this.constraintMetricsValue;
    const previous = this.activeStyle;
    this.selectFont(context, 0);
    const { deviceCellWidth, deviceCellHeight, deviceBaseline } = this.metrics;
    const capHeight =
      context.measureText("H").actualBoundingBoxAscent || 0.75 * deviceBaseline;
    if (previous >= 0) this.selectFont(context, previous);
    this.constraintMetricsValue = cellConstraintMetrics(
      deviceCellWidth,
      deviceCellHeight,
      capHeight,
    );
    return this.constraintMetricsValue;
  }

  private selectFont(context: CanvasRenderingContext2D, style: number): void {
    if (style === this.activeStyle) return;
    context.font = this.fonts[style];
    this.activeStyle = style;
  }

  dispose(): void {
    if (this.canvas) {
      this.canvas.width = 1;
      this.canvas.height = 1;
    }
    this.canvas = null;
    this.context = null;
    this.builtin = null;
    this.runs = new Map();
    this.activeStyle = -1;
  }

  private ensureContext(): CanvasRenderingContext2D {
    if (this.context) return this.context;
    const canvas = document.createElement("canvas");
    canvas.width = RASTER_SIZE;
    canvas.height = RASTER_SIZE;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Glyph rasterization is unavailable");
    context.textAlign = "left";
    context.textBaseline = "alphabetic";
    context.fillStyle = "white";
    this.canvas = canvas;
    this.context = context;
    this.activeStyle = -1;
    this.dirtyWidth = RASTER_SIZE;
    this.dirtyHeight = RASTER_SIZE;
    return context;
  }
}
