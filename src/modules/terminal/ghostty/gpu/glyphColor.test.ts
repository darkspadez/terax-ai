import { describe, expect, it } from "vitest";
import { hasIntrinsicColor, ignoresFill } from "./glyphColor";

const pixels = (...values: number[][]) => new Uint8ClampedArray(values.flat());

describe("ignoresFill", () => {
  it("tells subpixel-antialiased text, which follows the fill, from colour", () => {
    // Coloured fringes of white text drawn with LCD antialiasing.
    const white = pixels([255, 255, 255, 255], [70, 160, 255, 200]);
    expect(hasIntrinsicColor(white)).toBe(true);
    const black = pixels([0, 0, 0, 255], [0, 0, 0, 200]);
    expect(ignoresFill(white, black)).toBe(false);
  });

  it("finds colour glyphs, black pixels included", () => {
    const emoji = pixels([255, 202, 40, 255], [0, 0, 0, 255]);
    expect(ignoresFill(emoji, emoji.slice())).toBe(true);
    const blackHeart = pixels([0, 0, 0, 255], [12, 12, 12, 128]);
    expect(ignoresFill(blackHeart, blackHeart.slice())).toBe(true);
  });

  it("finds colour glyphs with layers in the foreground colour", () => {
    const white = pixels([255, 255, 255, 255], [220, 40, 40, 255]);
    const black = pixels([0, 0, 0, 255], [220, 40, 40, 255]);
    expect(ignoresFill(white, black)).toBe(true);
  });

  it("ignores pixels that are nearly transparent in either drawing", () => {
    const white = pixels([255, 0, 0, 12], [255, 255, 255, 255]);
    const black = pixels([255, 0, 0, 12], [0, 0, 0, 255]);
    expect(ignoresFill(white, black)).toBe(false);
  });
});
