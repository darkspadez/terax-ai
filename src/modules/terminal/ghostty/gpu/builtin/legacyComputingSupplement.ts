/**
 * Symbols for Legacy Computing Supplement (U+1CC00..U+1CEBF) shapes beyond the
 * octants: separated block quadrants and sextants, sixteenth blocks, twelfth
 * and quarter circle pieces, half circles and ellipses, and box-drawing
 * corners. Geometry follows Ghostty's sprite font
 * (`draw/symbols_for_legacy_computing_supplement.zig`, MIT).
 */
import { fillFractions } from "./blockElements";
import { drawLines, LINE_LIGHT, LINE_NONE } from "./boxDrawing";
import { circle, LC, ML, MR, UC } from "./legacyComputing";
import { flattenCubic, type SpriteMask } from "./SpriteMask";
import type { SpriteSpec } from "./spriteSpec";

export function isLegacyComputingSupplement(codepoint: number): boolean {
  if (codepoint < 0x1cc1b || codepoint > 0x1ceaf) return false;
  return (
    codepoint <= 0x1cc1e ||
    (codepoint >= 0x1cc21 && codepoint <= 0x1cc3f) ||
    codepoint === 0x1ce00 ||
    codepoint === 0x1ce01 ||
    codepoint === 0x1ce0b ||
    codepoint === 0x1ce0c ||
    (codepoint >= 0x1ce16 && codepoint <= 0x1ce19) ||
    codepoint >= 0x1ce51
  );
}

type Corner = "tl" | "tr" | "bl" | "br";

/**
 * U+1CC30..U+1CC3F: a quarter of an ellipse `w x h` cells in radius, with this
 * cell at `(x, y)` cells from the ellipse's bounding box corner.
 */
const CIRCLE_PIECES: ReadonlyArray<
  readonly [x: number, y: number, w: number, h: number, corner: Corner]
> = [
  [0, 0, 2, 2, "tl"],
  [1, 0, 2, 2, "tl"],
  [2, 0, 2, 2, "tr"],
  [3, 0, 2, 2, "tr"],
  [0, 1, 2, 2, "tl"],
  [0, 0, 1, 1, "tl"],
  [1, 0, 1, 1, "tr"],
  [3, 1, 2, 2, "tr"],
  [0, 2, 2, 2, "bl"],
  [0, 1, 1, 1, "bl"],
  [1, 1, 1, 1, "br"],
  [3, 2, 2, 2, "br"],
  [0, 3, 2, 2, "bl"],
  [1, 3, 2, 2, "bl"],
  [2, 3, 2, 2, "br"],
  [3, 3, 2, 2, "br"],
];

/** U+1CE90..U+1CEAF in quarters of the cell: left, right, top, bottom. */
const SIXTEENTHS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 1, 0, 1],
  [1, 2, 0, 1],
  [2, 3, 0, 1],
  [3, 4, 0, 1],
  [0, 1, 1, 2],
  [1, 2, 1, 2],
  [2, 3, 1, 2],
  [3, 4, 1, 2],
  [0, 1, 2, 3],
  [1, 2, 2, 3],
  [2, 3, 2, 3],
  [3, 4, 2, 3],
  [0, 1, 3, 4],
  [1, 2, 3, 4],
  [2, 3, 3, 4],
  [3, 4, 3, 4],
  [2, 4, 3, 4],
  [1, 4, 3, 4],
  [0, 3, 3, 4],
  [0, 2, 3, 4],
  [0, 1, 2, 4],
  [0, 1, 1, 4],
  [0, 1, 0, 3],
  [0, 1, 0, 2],
  [0, 2, 0, 1],
  [0, 3, 0, 1],
  [1, 4, 0, 1],
  [2, 4, 0, 1],
  [3, 4, 0, 2],
  [3, 4, 0, 3],
  [3, 4, 1, 4],
  [3, 4, 2, 4],
];

export function drawLegacyComputingSupplement(
  mask: SpriteMask,
  spec: SpriteSpec,
  codepoint: number,
): void {
  const { width: w, height: h, thickness: t } = spec;
  if (codepoint >= 0x1ce90) {
    const [x0, x1, y0, y1] = SIXTEENTHS[codepoint - 0x1ce90];
    fillFractions(mask, spec, x0 / 4, x1 / 4, y0 / 4, y1 / 4);
    return;
  }
  if (codepoint >= 0x1ce51) {
    separatedSextants(mask, spec, codepoint - 0x1ce50);
    return;
  }
  if (codepoint >= 0x1cc30 && codepoint <= 0x1cc3f) {
    const [x, y, cellsX, cellsY, corner] = CIRCLE_PIECES[codepoint - 0x1cc30];
    circlePiece(mask, spec, x, y, cellsX, cellsY, corner);
    return;
  }
  if (codepoint >= 0x1cc21 && codepoint <= 0x1cc2f) {
    separatedQuadrants(mask, spec, codepoint - 0x1cc20);
    return;
  }
  switch (codepoint) {
    case 0x1cc1b:
      drawLines(mask, spec, LINE_NONE, LINE_LIGHT, LINE_NONE, LINE_LIGHT);
      mask.box(w - t, 0, w, h >> 1);
      return;
    case 0x1cc1c:
      drawLines(mask, spec, LINE_NONE, LINE_LIGHT, LINE_NONE, LINE_LIGHT);
      mask.box(w - t, h >> 1, w, h);
      return;
    case 0x1cc1d:
      mask.box(0, 0, w, t);
      mask.box(0, 0, t, h >> 1);
      return;
    case 0x1cc1e:
      mask.box(0, h - t, w, h);
      mask.box(0, h >> 1, t, h);
      return;
    case 0x1ce00:
      circle(mask, spec, ML, false);
      circle(mask, spec, MR, false);
      return;
    case 0x1ce01:
      circle(mask, spec, UC, false);
      circle(mask, spec, LC, false);
      return;
    case 0x1ce0b:
      circlePiece(mask, spec, 0, 0, 1, 0.5, "tl");
      circlePiece(mask, spec, 0, 0, 1, 0.5, "bl");
      return;
    case 0x1ce0c:
      circlePiece(mask, spec, 1, 0, 1, 0.5, "tr");
      circlePiece(mask, spec, 1, 0, 1, 0.5, "br");
      return;
    case 0x1ce16:
    case 0x1ce17:
    case 0x1ce18:
    case 0x1ce19: {
      drawLines(mask, spec, LINE_LIGHT, LINE_NONE, LINE_LIGHT, LINE_NONE);
      const right = codepoint <= 0x1ce17;
      const bottom = codepoint === 0x1ce17 || codepoint === 0x1ce19;
      mask.box(
        right ? w >> 1 : 0,
        bottom ? h - t : 0,
        right ? w : w >> 1,
        bottom ? h : t,
      );
      return;
    }
  }
}

/**
 * The gap around separated blocks: a twelfth of the width (at least a pixel)
 * at the cell edges, twice that between blocks plus any odd pixel.
 */
function separation(width: number): number {
  return Math.max(1, Math.floor(width / 12));
}

/** U+1CC21..U+1CC2F: bit 1 top-left, 2 top-right, 4 bottom-left, 8 bottom-right. */
function separatedQuadrants(
  mask: SpriteMask,
  spec: SpriteSpec,
  quadrants: number,
): void {
  const { width, height } = spec;
  const gap = separation(width);
  const middleX = gap * 2 + (width % 2);
  const middleY = gap * 2 + (height % 2);
  const w = (width - gap * 2 - middleX) / 2;
  const h = (height - gap * 2 - middleY) / 2;
  const right = gap + w + middleX;
  const bottom = gap + h + middleY;
  if (quadrants & 1) mask.box(gap, gap, gap + w, gap + h);
  if (quadrants & 2) mask.box(right, gap, right + w, gap + h);
  if (quadrants & 4) mask.box(gap, bottom, gap + w, bottom + h);
  if (quadrants & 8) mask.box(right, bottom, right + w, bottom + h);
}

/**
 * U+1CE51..U+1CE8F: bits 1, 2 top row, 4, 8 middle, 16, 32 bottom (left then
 * right). Rows are equal but for the middle one, which takes the leftover.
 */
function separatedSextants(
  mask: SpriteMask,
  spec: SpriteSpec,
  sextants: number,
): void {
  const { width, height } = spec;
  const gap = separation(width);
  const middleX = gap * 2 + (width % 2);
  const middleY = gap * 2 + Math.floor((height % 3) / 2);
  const w = (width - gap * 2 - middleX) / 2;
  const h = Math.floor((height - gap * 2 - middleY * 2) / 3);
  const middleHeight = height - gap * 2 - middleY * 2 - h * 2;
  const right = gap + w + middleX;
  const middle = gap + h + middleY;
  const bottom = middle + middleHeight + middleY;
  if (sextants & 1) mask.box(gap, gap, gap + w, gap + h);
  if (sextants & 2) mask.box(right, gap, right + w, gap + h);
  if (sextants & 4) mask.box(gap, middle, gap + w, middle + middleHeight);
  if (sextants & 8) mask.box(right, middle, right + w, middle + middleHeight);
  if (sextants & 16) mask.box(gap, bottom, gap + w, bottom + h);
  if (sextants & 32) mask.box(right, bottom, right + w, bottom + h);
}

/** Control-point coefficient that approximates a quarter circle. */
const ARC = ((Math.SQRT2 - 1) * 4) / 3;

/**
 * How far each end of a curve continues along its tangent. Butt caps then sit
 * square to the curve, past the cell edge or the neighbouring piece, instead
 * of square to the first flattened chord, so pieces meet without a seam.
 */
const TANGENT_RUN = 0.5;

/**
 * A light stroke along one quarter of an ellipse with radii `cellsX` and
 * `cellsY` cells, seen through this cell at `(x, y)` cells from the corner of
 * the ellipse's bounding box. The stroke lies inside the ellipse so pieces in
 * neighbouring cells meet edge to edge.
 */
function circlePiece(
  mask: SpriteMask,
  spec: SpriteSpec,
  x: number,
  y: number,
  cellsX: number,
  cellsY: number,
  corner: Corner,
): void {
  const { width, height, thickness } = spec;
  const rx = width * cellsX;
  const ry = height * cellsY;
  const half = thickness / 2;
  const curve = quarterEllipse(corner, {
    left: half - width * x,
    top: half - height * y,
    right: rx * 2 - half - width * x,
    bottom: ry * 2 - half - height * y,
    middleX: rx - width * x,
    middleY: ry - height * y,
    controlX: ARC * rx,
    controlY: ARC * ry,
  });
  const [x0, y0, x1, y1, x2, y2, x3, y3] = curve;
  const startLength = Math.hypot(x1 - x0, y1 - y0);
  const endLength = Math.hypot(x3 - x2, y3 - y2);
  const points = [
    x0 - ((x1 - x0) / startLength) * TANGENT_RUN,
    y0 - ((y1 - y0) / startLength) * TANGENT_RUN,
    x0,
    y0,
  ];
  const segments = Math.max(8, Math.min(64, Math.ceil(Math.max(rx, ry) * 2)));
  flattenCubic(points, x0, y0, x1, y1, x2, y2, x3, y3, segments);
  points.push(
    x3 + ((x3 - x2) / endLength) * TANGENT_RUN,
    y3 + ((y3 - y2) / endLength) * TANGENT_RUN,
  );
  mask.stroke(points, thickness);
}

type EllipseBox = {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly middleX: number;
  readonly middleY: number;
  readonly controlX: number;
  readonly controlY: number;
};

/** Start, two control points and end of one quarter of the ellipse. */
function quarterEllipse(corner: Corner, box: EllipseBox): readonly number[] {
  const { left: l, top: t, right: r, bottom: b } = box;
  const { middleX: mx, middleY: my, controlX: cx, controlY: cy } = box;
  switch (corner) {
    case "tl":
      return [mx, t, mx - cx, t, l, my - cy, l, my];
    case "tr":
      return [mx, t, mx + cx, t, r, my - cy, r, my];
    case "bl":
      return [l, my, l, my + cy, mx - cx, b, mx, b];
    case "br":
      return [r, my, r, my + cy, mx + cx, b, mx, b];
  }
}
