import { CellFlags } from "@terax/ghostty-core/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GlyphFontGate } from "../gpu/GlyphFontGate";
import { hasIntrinsicColor, WebGlGlyphAtlas } from "./WebGlGlyphAtlas";

afterEach(() => vi.unstubAllGlobals());

describe("hasIntrinsicColor", () => {
  it("keeps monochrome antialiasing in the compact coverage atlas", () => {
    expect(
      hasIntrinsicColor(
        new Uint8ClampedArray([
          255, 255, 255, 255, 255, 255, 255, 128, 0, 0, 0, 0,
        ]),
      ),
    ).toBe(false);
  });

  it("routes color glyphs to the RGBA atlas", () => {
    expect(
      hasIntrinsicColor(
        new Uint8ClampedArray([255, 202, 40, 255, 255, 255, 255, 128]),
      ),
    ).toBe(true);
  });

  it("preserves intrinsically gray emoji pixels", () => {
    expect(hasIntrinsicColor(new Uint8ClampedArray([96, 96, 96, 255]))).toBe(
      true,
    );
  });

  it("ignores transparent RGB residue", () => {
    expect(hasIntrinsicColor(new Uint8ClampedArray([255, 0, 100, 0]))).toBe(
      false,
    );
  });
});

describe("WebGlGlyphAtlas uploads", () => {
  it("uploads dirty rows directly from the retained atlas without repacking", () => {
    const texSubImage2D = vi.fn();
    const pixelStorei = vi.fn();
    const gl = createWebGlHarness(texSubImage2D, pixelStorei);
    const atlas = new WebGlGlyphAtlas(gl, METRICS, 1);

    atlas.glyph(65, null, 0);
    atlas.glyph(66, null, 0);
    atlas.bindAndUpload();

    expect(texSubImage2D).toHaveBeenCalledOnce();
    expect(texSubImage2D.mock.calls[0][8]).toBeInstanceOf(Uint8Array);
    expect((texSubImage2D.mock.calls[0][8] as Uint8Array).byteLength).toBe(
      1_048_576,
    );
    expect(pixelStorei).toHaveBeenCalledWith(gl.UNPACK_ROW_LENGTH, 1_024);
    expect(pixelStorei).toHaveBeenCalledWith(gl.UNPACK_ROW_LENGTH, 0);
    expect(atlas.uploadCount).toBe(1);
    expect(atlas.uploadedBytes).toBeGreaterThan(0);
    atlas.dispose();
  });
});

describe("WebGlGlyphAtlas icon fonts", () => {
  it("skips an icon whose font is loading without caching it, then draws it unstyled", async () => {
    const fillText = vi.fn();
    const gl = createWebGlHarness(vi.fn(), vi.fn(), fillText);
    let loaded = false;
    let settle = () => {};
    const gate = new GlyphFontGate({
      check: () => loaded,
      load: () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    });
    const atlas = new WebGlGlyphAtlas(gl, METRICS, 1, gate);

    expect(atlas.glyph(0xf013, null, 0).width).toBe(0);
    expect(atlas.glyph(0xf0001, null, 0).width).toBe(0);
    expect(atlas.glyphCount).toBe(0);
    expect(fillText).not.toHaveBeenCalled();
    expect(atlas.takeDeferred()).toBe(true);
    expect(atlas.takeDeferred()).toBe(false);

    loaded = true;
    settle();
    await Promise.resolve();
    const icon = atlas.glyph(0xf013, null, CellFlags.BOLD);
    expect(icon.width).toBeGreaterThan(0);
    expect(atlas.glyph(0xf013, null, CellFlags.ITALIC)).toBe(icon);
    expect(atlas.takeDeferred()).toBe(false);
    atlas.dispose();
  });
});

describe("WebGlGlyphAtlas procedural glyphs", () => {
  it("draws box characters at the cell size with no bearing and ignores styles", () => {
    const fillText = vi.fn();
    const gl = createWebGlHarness(vi.fn(), vi.fn(), fillText);
    const atlas = new WebGlGlyphAtlas(gl, METRICS, 1);
    const regular = atlas.glyph(0x253c, null, 0);
    const bold = atlas.glyph(0x253c, null, CellFlags.BOLD | CellFlags.ITALIC);
    expect(bold).toBe(regular);
    expect(regular.width).toBe(METRICS.deviceCellWidth);
    expect(regular.height).toBe(METRICS.deviceCellHeight);
    expect(regular.originOffsetX).toBe(0);
    expect(regular.originOffsetY).toBe(0);
    expect(regular.intrinsicColor).toBe(false);
    expect(regular.uvMaxX - regular.uvMinX).toBeCloseTo(8 / 1_024, 9);
    expect(regular.uvMaxY - regular.uvMinY).toBeCloseTo(16 / 1_024, 9);
    expect(fillText).not.toHaveBeenCalled();
    expect(atlas.glyphCount).toBe(1);
    // Text and combined sequences still come from the font.
    atlas.glyph(65, null, 0);
    atlas.glyph(0x253c, "\u253c\u0301", 0);
    expect(fillText).toHaveBeenCalledTimes(2);
    atlas.bindAndUpload();
    expect(atlas.uploadedBytes).toBeGreaterThan(0);
    atlas.dispose();
  });

  it("stores the shared mask in the coverage atlas at its allocated rectangle", () => {
    const texSubImage2D = vi.fn();
    const gl = createWebGlHarness(texSubImage2D, vi.fn());
    const atlas = new WebGlGlyphAtlas(gl, METRICS, 1);
    const glyph = atlas.glyph(0x2588, null, 0);
    atlas.bindAndUpload();
    const [, , x, y, width, height, , , pixels] = texSubImage2D.mock.calls[0];
    expect(x).toBe(glyph.uvMinX * 1_024);
    expect(y).toBe(glyph.uvMinY * 1_024);
    expect(width).toBeGreaterThanOrEqual(8);
    expect(height).toBeGreaterThanOrEqual(16);
    const atlasPixels = pixels as Uint8Array;
    // Every pixel of the full block is full coverage.
    for (let row = 0; row < 16; row += 1) {
      for (let column = 0; column < 8; column += 1) {
        expect(atlasPixels[(y + row) * 1_024 + x + column]).toBe(255);
      }
    }
    atlas.dispose();
  });
});

describe("WebGlGlyphAtlas constraints", () => {
  it("fits a symbol to the cells it may use and keys each layout", () => {
    const fillText = vi.fn();
    const setTransform = vi.fn();
    const gl = createWebGlHarness(vi.fn(), vi.fn(), fillText, setTransform);
    const atlas = new WebGlGlyphAtlas(gl, METRICS, 1);
    const inferred = atlas.glyph(0x2192, null, 0);
    const one = atlas.glyph(0x2192, null, 0, 1);
    const two = atlas.glyph(0x2192, null, 0, 2);
    expect(atlas.glyph(0x2192, null, 0, 2)).toBe(two);
    expect(atlas.glyph(0x2192, null, 0)).toBe(inferred);
    expect(atlas.glyphCount).toBe(3);
    expect(fillText).toHaveBeenCalledTimes(3);
    // Squeezed into one 8 pixel cell, or left at 16 pixels across two.
    expect(one.width).toBe(8 + 4);
    expect(inferred.width).toBe(one.width);
    expect(two.width).toBe(16 + 4);
    // Half size: the 16 x 12 ink becomes 8 x 6, centred where the font put
    // it (top at 5), drawn 2 pixels into a bitmap that starts at row 3.
    expect(setTransform).toHaveBeenCalledWith(0.5, 0, 0, 0.5, 2, 7);
    expect(setTransform).toHaveBeenLastCalledWith(1, 0, 0, 1, 0, 0);
    atlas.dispose();
  });

  it("draws branch drawing procedurally whatever the style or cells", () => {
    const fillText = vi.fn();
    const gl = createWebGlHarness(vi.fn(), vi.fn(), fillText);
    const atlas = new WebGlGlyphAtlas(gl, METRICS, 1);
    const node = atlas.glyph(0xf5ee, null, 0);
    expect(atlas.glyph(0xf5ee, null, CellFlags.BOLD, 2)).toBe(node);
    expect(node.width).toBe(METRICS.deviceCellWidth);
    expect(node.originOffsetX).toBe(0);
    expect(fillText).not.toHaveBeenCalled();
    atlas.dispose();
  });
});

describe("WebGlGlyphAtlas ligature runs", () => {
  it("keys each cell of a run by run, index and style, apart from plain glyphs", () => {
    const fillText = vi.fn();
    const gl = createWebGlHarness(vi.fn(), vi.fn(), fillText);
    const atlas = new WebGlGlyphAtlas(gl, METRICS, 1);
    const first = atlas.ligatureGlyph("->", 0, 0);
    const second = atlas.ligatureGlyph("->", 1, 0);
    const bold = atlas.ligatureGlyph("->", 0, CellFlags.BOLD);
    const other = atlas.ligatureGlyph("-=", 0, 0);
    const dash = atlas.glyph(0x2d, null, 0);
    expect(new Set([first, second, bold, other, dash]).size).toBe(5);
    expect(atlas.glyphCount).toBe(5);
    // Cached, and the whole run is what is drawn for each cell.
    expect(atlas.ligatureGlyph("->", 1, 0)).toBe(second);
    expect(atlas.ligatureGlyph("->", 0, CellFlags.BOLD)).toBe(bold);
    expect(fillText.mock.calls.map(([text]) => text)).toEqual([
      "->",
      "->",
      "->",
      "-=",
      "-",
    ]);
    // Colour, underline and the like never make another glyph.
    expect(atlas.ligatureGlyph("->", 0, CellFlags.FAINT)).toBe(first);
    // A middle cell is exactly one cell wide, with no bearing.
    const middle = atlas.ligatureGlyph("===", 1, 0);
    expect(middle.originOffsetX).toBe(0);
    expect(middle.width).toBe(METRICS.deviceCellWidth);
    atlas.dispose();
  });
});

function createWebGlHarness(
  texSubImage2D: ReturnType<typeof vi.fn>,
  pixelStorei: ReturnType<typeof vi.fn>,
  fillText: ReturnType<typeof vi.fn> = vi.fn(),
  setTransform: ReturnType<typeof vi.fn> = vi.fn(),
): WebGL2RenderingContext {
  const pixels = new Uint8ClampedArray(12 * 16 * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = 255;
    pixels[offset + 1] = 255;
    pixels[offset + 2] = 255;
    pixels[offset + 3] = 255;
  }
  vi.stubGlobal("document", {
    createElement: vi.fn(() => ({
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({
        clearRect: vi.fn(),
        setTransform,
        fillText,
        getImageData: vi.fn(() => ({ data: pixels })),
        // Arrows are drawn two cells wide, as a fallback font might.
        measureText: vi.fn((text: string) => ({
          width: text.length * 8,
          actualBoundingBoxLeft: 0,
          actualBoundingBoxRight: text === "→" ? 16 : 8,
          actualBoundingBoxAscent: 10,
          actualBoundingBoxDescent: 2,
        })),
        font: "",
        textAlign: "left",
        textBaseline: "alphabetic",
        fillStyle: "white",
      })),
    })),
  });
  return {
    TEXTURE_2D: 1,
    TEXTURE_MIN_FILTER: 2,
    TEXTURE_MAG_FILTER: 3,
    TEXTURE_WRAP_S: 4,
    TEXTURE_WRAP_T: 5,
    LINEAR: 6,
    CLAMP_TO_EDGE: 7,
    UNPACK_ALIGNMENT: 8,
    UNPACK_ROW_LENGTH: 9,
    UNPACK_SKIP_PIXELS: 10,
    UNPACK_SKIP_ROWS: 11,
    R8: 12,
    RED: 13,
    RGBA: 14,
    UNSIGNED_BYTE: 15,
    TEXTURE0: 16,
    TEXTURE1: 17,
    createTexture: vi.fn(() => ({})),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
    pixelStorei,
    texImage2D: vi.fn(),
    texSubImage2D,
    activeTexture: vi.fn(),
    deleteTexture: vi.fn(),
  } as unknown as WebGL2RenderingContext;
}

const METRICS = {
  font: {
    family: "monospace",
    size: 14,
    lineHeight: 1.2,
    letterSpacing: 0,
    weight: "400",
  },
  scale: 1,
  deviceCellWidth: 8,
  deviceCellHeight: 16,
  deviceBaseline: 12,
  cellWidth: 8,
  cellHeight: 16,
  baseline: 12,
} as const;
