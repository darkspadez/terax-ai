/**
 * Ghostty's `minimum-contrast`: text whose contrast ratio with its cell's
 * background (WCAG 2, 1 to 21) is below the minimum is drawn white or black,
 * whichever contrasts more. 1 turns it off. Colour glyphs (emoji) and
 * procedural shapes (box drawing, blocks, Powerline) keep their colours, as in
 * Ghostty. The WebGPU text shader applies the same rule (`contrasted_color` in
 * `shaders.ts`); the WebGL renderer calls this per glyph.
 */

function linear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a packed 0xRRGGBB colour. */
export function relativeLuminance(rgb: number): number {
  return (
    0.2126 * linear((rgb >> 16) & 0xff) +
    0.7152 * linear((rgb >> 8) & 0xff) +
    0.0722 * linear(rgb & 0xff)
  );
}

export function contrastRatio(a: number, b: number): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

const WHITE = 0xffffff;
const BLACK = 0x000000;

/** `foreground`, or white or black when it contrasts too little with `background`. */
export function contrastedColor(
  minimum: number,
  foreground: number,
  background: number,
): number {
  if (minimum <= 1 || contrastRatio(foreground, background) >= minimum)
    return foreground;
  return contrastRatio(BLACK, background) > contrastRatio(WHITE, background)
    ? BLACK
    : WHITE;
}
