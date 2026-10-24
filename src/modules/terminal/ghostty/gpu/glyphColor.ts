/**
 * Whether a glyph drawn in white has pixels that are not white: a colour glyph
 * (emoji, COLR), or a monochrome one drawn with subpixel (LCD) antialiasing,
 * whose edges are coloured too. `ignoresFill` tells the two apart.
 */
export function hasIntrinsicColor(rgba: Uint8ClampedArray): boolean {
  for (let offset = 0; offset < rgba.length; offset += 4) {
    if (rgba[offset + 3] < 16) continue;
    const red = rgba[offset];
    const green = rgba[offset + 1];
    const blue = rgba[offset + 2];
    if (
      Math.abs(red - green) > 8 ||
      Math.abs(red - blue) > 8 ||
      Math.abs(green - blue) > 8 ||
      Math.abs(255 - red) > 8
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a glyph drawn once in white and once in black kept the colour of
 * any inked pixel. A colour glyph keeps its own colours whatever the fill; a
 * monochrome glyph follows the fill in every pixel, fringes included.
 */
export function ignoresFill(
  white: Uint8ClampedArray,
  black: Uint8ClampedArray,
): boolean {
  const length = Math.min(white.length, black.length);
  for (let offset = 0; offset < length; offset += 4) {
    if (white[offset + 3] < 16 || black[offset + 3] < 16) continue;
    if (
      Math.abs(white[offset] - black[offset]) <= 8 &&
      Math.abs(white[offset + 1] - black[offset + 1]) <= 8 &&
      Math.abs(white[offset + 2] - black[offset + 2]) <= 8
    ) {
      return true;
    }
  }
  return false;
}
