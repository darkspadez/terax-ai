/**
 * Procedural ("builtin") glyphs: box drawing, block elements, braille,
 * powerline separators, git branch drawing and Symbols for Legacy Computing
 * are drawn from the cell geometry instead of the font, as Ghostty, kitty,
 * Alacritty and Windows Terminal do; the set is Ghostty's sprite font. Fonts
 * draw these characters with side bearings and rounded metrics, so borders
 * show gaps between rows and columns; a procedural glyph fills exactly its
 * cell and joins its neighbours at every size and ratio.
 *
 * This module is pure: it turns a code point and a whole-pixel cell size into
 * a coverage mask. The WebGPU and WebGL atlases upload that mask like any other
 * glyph, so both renderers draw the same pixels. Bold and italic never change a
 * builtin glyph.
 */

import {
  drawBlockElement,
  drawBraille,
  drawOctant,
  drawSextant,
  isBlockElement,
  isBraille,
  isOctant,
  isSextant,
} from "./builtin/blockElements";
import { drawBoxDrawing, isBoxDrawing } from "./builtin/boxDrawing";
import { drawBranchDrawing, isBranchDrawing } from "./builtin/branch";
import {
  drawGeometricShape,
  drawLegacyComputing,
  isGeometricShape,
  isLegacyComputing,
} from "./builtin/legacyComputing";
import {
  drawLegacyComputingSupplement,
  isLegacyComputingSupplement,
} from "./builtin/legacyComputingSupplement";
import { drawPowerline, isPowerline } from "./builtin/powerline";
import { SpriteMask } from "./builtin/SpriteMask";
import { builtinLineThickness, type SpriteSpec } from "./builtin/spriteSpec";
import type { TerminalFontMetrics } from "./terminalVisuals";

export { builtinLineThickness };

/** The cell a font's builtin glyphs fill, in the metrics' device pixels. */
export function builtinGlyphSpec(metrics: TerminalFontMetrics): SpriteSpec {
  return {
    width: metrics.deviceCellWidth,
    height: metrics.deviceCellHeight,
    thickness: builtinLineThickness(metrics.font.size * metrics.scale),
  };
}

/** Whether `codepoint` is drawn procedurally rather than from the font. */
export function isBuiltinGlyph(codepoint: number): boolean {
  if (codepoint < 0x2500) return false;
  return (
    isBoxDrawing(codepoint) ||
    isBlockElement(codepoint) ||
    isBraille(codepoint) ||
    isPowerline(codepoint) ||
    isBranchDrawing(codepoint) ||
    isGeometricShape(codepoint) ||
    isSextant(codepoint) ||
    isLegacyComputing(codepoint) ||
    isOctant(codepoint) ||
    isLegacyComputingSupplement(codepoint)
  );
}

/**
 * Draws builtin glyphs for one cell size. The returned mask is the renderer's
 * own scratch buffer (`width * height` coverage bytes, row-major, top row
 * first), valid until the next call.
 */
export class BuiltinGlyphRenderer {
  private readonly mask: SpriteMask;

  constructor(readonly spec: SpriteSpec) {
    this.mask = new SpriteMask(spec.width, spec.height);
  }

  /** Scratch memory held by this renderer. */
  get byteSize(): number {
    return this.mask.byteSize;
  }

  render(codepoint: number): Uint8Array | null {
    if (!isBuiltinGlyph(codepoint)) return null;
    const { mask, spec } = this;
    mask.clear();
    if (isBoxDrawing(codepoint)) drawBoxDrawing(mask, spec, codepoint);
    else if (isBlockElement(codepoint)) drawBlockElement(mask, spec, codepoint);
    else if (isBraille(codepoint)) drawBraille(mask, spec, codepoint);
    else if (isPowerline(codepoint)) drawPowerline(mask, spec, codepoint);
    else if (isBranchDrawing(codepoint)) {
      drawBranchDrawing(mask, spec, codepoint);
    } else if (isGeometricShape(codepoint)) {
      drawGeometricShape(mask, spec, codepoint);
    } else if (isSextant(codepoint)) drawSextant(mask, spec, codepoint);
    else if (isOctant(codepoint)) drawOctant(mask, spec, codepoint);
    else if (isLegacyComputing(codepoint)) {
      drawLegacyComputing(mask, spec, codepoint);
    } else drawLegacyComputingSupplement(mask, spec, codepoint);
    return mask.data;
  }
}
