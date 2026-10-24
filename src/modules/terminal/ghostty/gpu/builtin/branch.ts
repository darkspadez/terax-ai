/**
 * Branch drawing characters, U+F5D0..U+F60D: the lines, arcs and commit nodes
 * git graph tools draw with (kitty's set, also in Nerd Fonts 3.3+). Geometry
 * follows Ghostty's sprite font (`draw/branch.zig`, MIT). Lines and arcs are
 * the light box-drawing strokes, so a graph joins ─ │ ╭ and its own pieces
 * without a seam; nodes are circles centred where those strokes cross.
 */
import { drawArc } from "./boxDrawing";
import { circleRing, type SpriteMask } from "./SpriteMask";
import type { SpriteSpec } from "./spriteSpec";

export function isBranchDrawing(codepoint: number): boolean {
  return codepoint >= 0xf5d0 && codepoint <= 0xf60d;
}

const LINE_H = 1;
const LINE_V = 2;
const ARC_TL = 4;
const ARC_TR = 8;
const ARC_BL = 16;
const ARC_BR = 32;

/** Straight lines and arcs for U+F5D6..U+F5ED. */
const PIECES: readonly number[] = [
  ARC_BR,
  ARC_BL,
  ARC_TR,
  ARC_TL,
  LINE_V | ARC_TR,
  LINE_V | ARC_BR,
  ARC_TR | ARC_BR,
  LINE_V | ARC_TL,
  LINE_V | ARC_BL,
  ARC_TL | ARC_BL,
  LINE_H | ARC_BL,
  LINE_H | ARC_BR,
  ARC_BR | ARC_BL,
  LINE_H | ARC_TL,
  LINE_H | ARC_TR,
  ARC_TR | ARC_TL,
  LINE_V | ARC_TL | ARC_TR,
  LINE_V | ARC_BL | ARC_BR,
  LINE_H | ARC_BL | ARC_TL,
  LINE_H | ARC_TR | ARC_BR,
  LINE_V | ARC_TL | ARC_BR,
  LINE_V | ARC_TR | ARC_BL,
  LINE_H | ARC_TL | ARC_BR,
  LINE_H | ARC_TR | ARC_BL,
];

const UP = 1;
const RIGHT = 2;
const DOWN = 4;
const LEFT = 8;

/** Edges a node connects to, U+F5EE..U+F60D in filled / hollow pairs. */
const NODES: readonly number[] = [
  0,
  RIGHT,
  LEFT,
  LEFT | RIGHT,
  DOWN,
  UP,
  UP | DOWN,
  RIGHT | DOWN,
  LEFT | DOWN,
  UP | RIGHT,
  UP | LEFT,
  UP | DOWN | RIGHT,
  UP | DOWN | LEFT,
  DOWN | LEFT | RIGHT,
  UP | LEFT | RIGHT,
  UP | DOWN | LEFT | RIGHT,
];

type Edge = "top" | "right" | "bottom" | "left";

export function drawBranchDrawing(
  mask: SpriteMask,
  spec: SpriteSpec,
  codepoint: number,
): void {
  switch (codepoint) {
    case 0xf5d0:
      horizontalLine(mask, spec);
      return;
    case 0xf5d1:
      verticalLine(mask, spec);
      return;
    case 0xf5d2:
      fadingLine(mask, spec, "right");
      return;
    case 0xf5d3:
      fadingLine(mask, spec, "left");
      return;
    case 0xf5d4:
      fadingLine(mask, spec, "bottom");
      return;
    case 0xf5d5:
      fadingLine(mask, spec, "top");
      return;
  }
  if (codepoint <= 0xf5ed) {
    const pieces = PIECES[codepoint - 0xf5d6];
    // Arcs pin their open ends by clearing the edge row and column they end
    // in, so the straight lines (whole-pixel boxes) go on afterwards.
    if (pieces & ARC_TL) drawArc(mask, spec, "tl");
    if (pieces & ARC_TR) drawArc(mask, spec, "tr");
    if (pieces & ARC_BL) drawArc(mask, spec, "bl");
    if (pieces & ARC_BR) drawArc(mask, spec, "br");
    if (pieces & LINE_H) horizontalLine(mask, spec);
    if (pieces & LINE_V) verticalLine(mask, spec);
    return;
  }
  const index = codepoint - 0xf5ee;
  drawNode(mask, spec, NODES[index >> 1], (index & 1) === 0);
}

function horizontalLine(mask: SpriteMask, spec: SpriteSpec): void {
  const top = Math.max(0, spec.height - spec.thickness) >> 1;
  mask.box(0, top, spec.width, top + spec.thickness);
}

function verticalLine(mask: SpriteMask, spec: SpriteSpec): void {
  const left = Math.max(0, spec.width - spec.thickness) >> 1;
  mask.box(left, 0, left + spec.thickness, spec.height);
}

/**
 * A light line whose coverage falls off linearly from full at one edge to
 * nothing at `to`, one level per pixel row or column.
 */
function fadingLine(mask: SpriteMask, spec: SpriteSpec, to: Edge): void {
  const { width, height, thickness } = spec;
  const vertical = to === "top" || to === "bottom";
  const length = vertical ? height : width;
  const rising = to === "top" || to === "left";
  const step = (rising ? 255 : -255) / length;
  const top = Math.max(0, height - thickness) >> 1;
  const left = Math.max(0, width - thickness) >> 1;
  let level = rising ? 0 : 255;
  for (let along = 0; along < length; along += 1) {
    const value = Math.round(level);
    if (vertical) mask.box(left, along, left + thickness, along + 1, value);
    else mask.box(along, top, along + 1, top + thickness, value);
    level += step;
  }
}

/**
 * A commit node: a circle as large as the cell allows around the light-line
 * crossing, filled or hollow, with light lines out to the `edges` it joins.
 */
function drawNode(
  mask: SpriteMask,
  spec: SpriteSpec,
  edges: number,
  filled: boolean,
): void {
  const { width, height, thickness } = spec;
  const top = Math.max(0, height - thickness) >> 1;
  const left = Math.max(0, width - thickness) >> 1;
  // Centred on the light strokes, which sit on whole pixels and may be off
  // the true centre by half a pixel.
  const centerX = left + thickness / 2;
  const centerY = top + thickness / 2;
  const radius = Math.min(centerX, centerY, width - centerX, height - centerY);
  const half = thickness / 2;

  if (edges & UP) {
    mask.box(left, 0, left + thickness, Math.ceil(centerY - radius + half));
  }
  if (edges & RIGHT) {
    mask.box(Math.floor(centerX + radius - half), top, width, top + thickness);
  }
  if (edges & DOWN) {
    mask.box(
      left,
      Math.floor(centerY + radius - half),
      left + thickness,
      height,
    );
  }
  if (edges & LEFT) {
    mask.box(0, top, Math.ceil(centerX - radius + half), top + thickness);
  }

  const outer = circleRing(centerX, centerY, radius);
  const inner = radius - thickness;
  if (filled || inner <= 0) mask.fill(outer);
  else mask.fill(outer, [circleRing(centerX, centerY, inner)]);
}
