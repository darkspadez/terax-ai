import { afterEach, describe, expect, it, vi } from "vitest";
import { GlyphFontGate } from "./GlyphFontGate";
import {
  GLYPH_STYLE_BOLD,
  GLYPH_STYLE_ITALIC,
  GLYPH_STYLE_TWO_CELLS,
  GlyphRasterizer,
  type InkBounds,
  placeGlyph,
  type RasterizedGlyph,
} from "./GlyphRasterizer";
import {
  cellConstraintMetrics,
  EMOJI_CONSTRAINT,
  SYMBOL_CONSTRAINT,
} from "./glyphConstraint";
import { nerdFontConstraint } from "./nerdFontConstraints";
import { deriveFontMetrics } from "./terminalVisuals";

/** 13 x 26 device pixel cells, baseline 19 pixels down. */
const METRICS = deriveFontMetrics(
  {
    family: '"JetBrains Mono", monospace',
    size: 14,
    lineHeight: 1.2,
    letterSpacing: 0,
    weight: "400",
  },
  1.5,
  { advance: 12.6, ascent: 16, descent: 5 },
);

const CAP_HEIGHT = 15;
const CONSTRAINT_METRICS = cellConstraintMetrics(
  METRICS.deviceCellWidth,
  METRICS.deviceCellHeight,
  CAP_HEIGHT,
);

const TEXT_INK: InkBounds = { left: 1, right: 9, ascent: 12, descent: 4 };

type StubOptions = {
  /** Texts the fake font draws in colour. */
  readonly color?: boolean | ((text: string) => boolean);
  /** Ink bounds per text; capital H measures the cap height. */
  readonly ink?: (text: string) => InkBounds | undefined;
};

function stub(options: StubOptions = {}) {
  const fonts: string[] = [];
  const clears: number[][] = [];
  const transforms: number[][] = [];
  const draws: Array<{
    text: string;
    x: number;
    y: number;
    transform: number[];
  }> = [];
  let font = "";
  let transform = [1, 0, 0, 1, 0, 0];
  let current = "";
  const texts: string[] = [];
  const colored = (text: string) =>
    typeof options.color === "function"
      ? options.color(text)
      : (options.color ?? false);
  const context = {
    textAlign: "",
    textBaseline: "",
    fillStyle: "",
    get font() {
      return font;
    },
    set font(value: string) {
      fonts.push(value);
      font = value;
    },
    clearRect: (...args: number[]) => clears.push(args),
    setTransform: (...args: number[]) => {
      transforms.push(args);
      transform = args;
    },
    fillText: (text: string, x: number, y: number) => {
      texts.push(text);
      draws.push({ text, x, y, transform });
      current = text;
    },
    measureText: (text: string) => {
      const ink =
        options.ink?.(text) ??
        (text === "H"
          ? { left: 0, right: 9, ascent: CAP_HEIGHT, descent: 0 }
          : TEXT_INK);
      return {
        actualBoundingBoxLeft: ink.left,
        actualBoundingBoxRight: ink.right,
        actualBoundingBoxAscent: ink.ascent,
        actualBoundingBoxDescent: ink.descent,
      };
    },
    getImageData: (_x: number, _y: number, width: number, height: number) => {
      const data = new Uint8ClampedArray(width * height * 4);
      const color = colored(current);
      for (let index = 0; index < data.length; index += 4) {
        data[index] = color ? 30 : 255;
        data[index + 1] = 255;
        data[index + 2] = 255;
        data[index + 3] = (index / 4) % 256;
      }
      return { data };
    },
  };
  let created = 0;
  vi.stubGlobal("document", {
    createElement: () => {
      created += 1;
      return { width: 0, height: 0, getContext: () => context };
    },
  });
  return {
    fonts,
    clears,
    created: () => created,
    texts,
    transforms,
    draws,
  };
}

function drawn(glyph: RasterizedGlyph | null): RasterizedGlyph {
  if (!glyph) throw new Error("glyph was deferred");
  return glyph;
}

/** A font set whose fonts load only when `settle` is called. */
function loadingFonts() {
  let loaded = false;
  const pending: Array<() => void> = [];
  const loader = {
    check: vi.fn(() => loaded),
    load: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          pending.push(resolve);
        }),
    ),
  };
  return {
    loader,
    async settle() {
      loaded = true;
      for (const resolve of pending.splice(0)) resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("GlyphRasterizer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("measures and positions glyphs in device pixels at the cell baseline", () => {
    stub();
    const glyph = drawn(new GlyphRasterizer(METRICS).rasterize("a", 0));
    expect(glyph.width).toBe(1 + 9 + 4);
    expect(glyph.height).toBe(12 + 4 + 4);
    expect(glyph.bearingX).toBe(-1 - 2);
    expect(glyph.bearingY).toBe(METRICS.deviceBaseline - 12 - 2);
    expect(glyph.intrinsicColor).toBe(false);
    expect(glyph.pixels).toHaveLength(glyph.width * glyph.height);
    expect(glyph.pixels[5]).toBe(5);
  });

  it("returns RGBA for intrinsic-colour glyphs", () => {
    stub({ color: true });
    const glyph = drawn(new GlyphRasterizer(METRICS).rasterize("x", 0));
    expect(glyph.intrinsicColor).toBe(true);
    expect(glyph.pixels).toHaveLength(glyph.width * glyph.height * 4);
  });

  it("assigns context.font only when the style changes, at size times ratio", () => {
    const s = stub();
    const rasterizer = new GlyphRasterizer(METRICS);
    rasterizer.rasterize("a", 0);
    rasterizer.rasterize("b", 0);
    rasterizer.rasterize("c", 0);
    expect(s.fonts).toHaveLength(1);
    expect(s.fonts[0]).toContain("21px");
    rasterizer.rasterize("d", GLYPH_STYLE_BOLD);
    rasterizer.rasterize("e", GLYPH_STYLE_BOLD | GLYPH_STYLE_ITALIC);
    rasterizer.rasterize("f", 0);
    expect(s.fonts).toHaveLength(4);
    expect(s.fonts[1]).toMatch(/^700 /);
    expect(s.fonts[2]).toMatch(/^italic 700 /);
  });

  it("clears only the area the previous glyph touched", () => {
    const s = stub();
    const rasterizer = new GlyphRasterizer(METRICS);
    rasterizer.rasterize("a", 0);
    rasterizer.rasterize("b", 0);
    expect(s.clears[0]).toEqual([0, 0, 256, 256]);
    expect(s.clears[1][2]).toBeLessThan(40);
    expect(s.clears[1][3]).toBeLessThan(40);
  });

  it("draws box and block glyphs at exactly the cell size without the canvas", () => {
    const s = stub();
    const rasterizer = new GlyphRasterizer(METRICS);
    const regular = drawn(rasterizer.rasterize("┼", 0));
    expect(regular.width).toBe(METRICS.deviceCellWidth);
    expect(regular.height).toBe(METRICS.deviceCellHeight);
    expect(regular.bearingX).toBe(0);
    expect(regular.bearingY).toBe(0);
    expect(regular.intrinsicColor).toBe(false);
    expect(regular.exact).toBe(true);
    expect(regular.pixels).toHaveLength(
      METRICS.deviceCellWidth * METRICS.deviceCellHeight,
    );
    // The light line weight is whole pixels: 14px * 1.5 = 21 device pixels.
    const middle =
      regular.pixels[Math.floor(METRICS.deviceCellHeight / 2) * regular.width];
    expect(middle).toBe(255);
    const regularPixels = regular.pixels.slice();
    const styled = drawn(
      rasterizer.rasterize("┼", GLYPH_STYLE_BOLD | GLYPH_STYLE_ITALIC),
    );
    expect(styled.pixels).toEqual(regularPixels);
    expect(
      drawn(rasterizer.rasterize("█", 0)).pixels.every(
        (value) => value === 255,
      ),
    ).toBe(true);
    expect(s.created()).toBe(0);
    expect(s.texts).toEqual([]);
    expect(s.fonts).toEqual([]);
    expect(rasterizer.cpuBytes).toBeGreaterThan(0);
    rasterizer.dispose();
    expect(rasterizer.cpuBytes).toBe(0);
  });

  it("leaves text and sequences that merely start with a box character to the font", () => {
    const s = stub();
    const rasterizer = new GlyphRasterizer(METRICS);
    const sequence = drawn(rasterizer.rasterize("┼\u0301", 0));
    expect(sequence.exact).toBe(false);
    expect(drawn(rasterizer.rasterize("a", 0)).exact).toBe(false);
    expect(drawn(rasterizer.rasterize("■", 0)).exact).toBe(false);
    expect(s.texts).toEqual(["┼\u0301", "a", "■"]);
  });

  it("allocates its canvas lazily and releases it on dispose", () => {
    const s = stub();
    const rasterizer = new GlyphRasterizer(METRICS);
    expect(s.created()).toBe(0);
    expect(rasterizer.cpuBytes).toBe(0);
    rasterizer.rasterize("a", 0);
    expect(s.created()).toBe(1);
    expect(rasterizer.cpuBytes).toBeGreaterThan(0);
    rasterizer.dispose();
    expect(rasterizer.cpuBytes).toBe(0);
    rasterizer.rasterize("a", 0);
    expect(s.created()).toBe(2);
  });

  // A canvas draws a loading web font's characters with the next font (an
  // empty box for an icon); the atlas would keep that box for good.
  it("defers an icon until its font has loaded, then draws it unstyled", async () => {
    const s = stub();
    const fonts = loadingFonts();
    const gate = new GlyphFontGate(fonts.loader);
    const rasterizer = new GlyphRasterizer(METRICS, gate);

    expect(rasterizer.rasterize("\uf013", GLYPH_STYLE_BOLD)).toBeNull();
    expect(rasterizer.rasterize("\u{f0001}", 0)).toBeNull();
    expect(s.texts).toEqual([]);
    expect(fonts.loader.load).toHaveBeenCalledTimes(2);
    // Still loading: no second load for the same glyph.
    expect(rasterizer.rasterize("\uf013", GLYPH_STYLE_BOLD)).toBeNull();
    expect(fonts.loader.load).toHaveBeenCalledTimes(2);

    const settled = vi.fn();
    gate.subscribe(settled);
    await fonts.settle();
    expect(settled).toHaveBeenCalledTimes(1);

    drawn(rasterizer.rasterize("\uf013", GLYPH_STYLE_BOLD));
    expect(s.texts).toEqual(["\uf013"]);
    // Icons take no synthesized weight or slant.
    expect(s.fonts[s.fonts.length - 1]).not.toMatch(/^(italic )?700 /);
  });

  it("never gates ordinary text on font loading", () => {
    stub();
    const fonts = loadingFonts();
    const rasterizer = new GlyphRasterizer(
      METRICS,
      new GlyphFontGate(fonts.loader),
    );
    drawn(rasterizer.rasterize("a", GLYPH_STYLE_BOLD));
    drawn(rasterizer.rasterize("\u2500", 0));
    expect(fonts.loader.check).not.toHaveBeenCalled();
  });
});

describe("placeGlyph", () => {
  it("keeps unconstrained text at its font size on the cell's baseline", () => {
    expect(placeGlyph(TEXT_INK, METRICS, null, null, 1, false)).toEqual({
      width: 1 + 9 + 4,
      height: 12 + 4 + 4,
      bearingX: -1 - 2,
      bearingY: METRICS.deviceBaseline - 12 - 2,
      originX: 2 + 1,
      originY: 2 + 12,
      scaleX: 1,
      scaleY: 1,
    });
  });

  it("shrinks a symbol twice the cell's width into one cell, or keeps it for two", () => {
    const ink = { left: 0, right: 26, ascent: 13, descent: 0 };
    // Half size, flush left, centred on where the font put it vertically.
    expect(
      placeGlyph(ink, METRICS, SYMBOL_CONSTRAINT, CONSTRAINT_METRICS, 1, false),
    ).toEqual({
      width: 17,
      height: 11,
      bearingX: -2,
      bearingY: 7,
      originX: 2,
      originY: 8.75,
      scaleX: 0.5,
      scaleY: 0.5,
    });
    expect(
      placeGlyph(ink, METRICS, SYMBOL_CONSTRAINT, CONSTRAINT_METRICS, 2, false),
    ).toEqual({
      width: 30,
      height: 17,
      bearingX: -2,
      bearingY: 4,
      originX: 2,
      originY: 15,
      scaleX: 1,
      scaleY: 1,
    });
  });

  it("fits a colour emoji to two whole cells, centred on whole pixels", () => {
    const ink = { left: 0, right: 24, ascent: 20, descent: 4 };
    const placement = placeGlyph(
      ink,
      METRICS,
      EMOJI_CONSTRAINT,
      CONSTRAINT_METRICS,
      2,
      true,
    );
    // Covers 26 x 26 (two 13 pixel cells less 2.5% each side, rounded).
    expect(placement.scaleX).toBeCloseTo(26 / 24, 9);
    expect(placement.scaleY).toBeCloseTo(26 / 24, 9);
    const left =
      placement.bearingX + placement.originX - ink.left * placement.scaleX;
    const top =
      placement.bearingY + placement.originY - ink.ascent * placement.scaleY;
    expect(left).toBeCloseTo(0, 9);
    expect(top).toBeCloseTo(0, 9);
    expect(placement.bearingX + placement.width).toBe(26 + 2);
    // Unaligned, the same emoji keeps its fractional, centred box.
    const smooth = placeGlyph(
      ink,
      METRICS,
      EMOJI_CONSTRAINT,
      CONSTRAINT_METRICS,
      2,
      false,
    );
    expect(smooth.scaleX).toBeCloseTo(25.35 / 24, 9);
    expect(smooth.bearingX + smooth.originX).toBeCloseTo(0.325, 9);
  });

  it("leaves ink too small to shape where the font put it", () => {
    const space = { left: 0, right: 0, ascent: 0, descent: 0 };
    expect(
      placeGlyph(
        space,
        METRICS,
        SYMBOL_CONSTRAINT,
        CONSTRAINT_METRICS,
        1,
        false,
      ),
    ).toEqual(placeGlyph(space, METRICS, null, null, 1, false));
  });
});

describe("GlyphRasterizer constraints", () => {
  afterEach(() => vi.unstubAllGlobals());

  const COG = "\uf013";
  const wideInk = (text: string) =>
    text === COG || text === "→" || text === "😀"
      ? { left: 0, right: 24, ascent: 20, descent: 4 }
      : undefined;

  it("draws a Nerd Font icon scaled into its cell, then resets the transform", () => {
    const s = stub({ ink: wideInk });
    const glyph = drawn(new GlyphRasterizer(METRICS).rasterize(COG, 0));
    const constraint = nerdFontConstraint(0xf013);
    const placement = placeGlyph(
      { left: 0, right: 24, ascent: 20, descent: 4 },
      METRICS,
      constraint,
      CONSTRAINT_METRICS,
      1,
      false,
    );
    expect(placement.scaleX).toBeLessThan(1);
    expect(glyph).toMatchObject({
      width: placement.width,
      height: placement.height,
      bearingX: placement.bearingX,
      bearingY: placement.bearingY,
      intrinsicColor: false,
      exact: false,
    });
    expect(s.draws).toEqual([
      {
        text: COG,
        x: 0,
        y: 0,
        transform: [
          placement.scaleX,
          0,
          0,
          placement.scaleY,
          placement.originX,
          placement.originY,
        ],
      },
    ]);
    expect(s.transforms[s.transforms.length - 1]).toEqual([1, 0, 0, 1, 0, 0]);
    // The scaled ink fits the cell: no spill into the neighbours.
    const inkLeft = glyph.bearingX + placement.originX;
    expect(inkLeft).toBeGreaterThanOrEqual(0);
    expect(inkLeft + 24 * placement.scaleX).toBeLessThanOrEqual(
      METRICS.deviceCellWidth + 1e-9,
    );
  });

  it("fits a colour emoji to two cells", () => {
    const s = stub({ ink: wideInk, color: (text) => text === "😀" });
    const glyph = drawn(new GlyphRasterizer(METRICS).rasterize("😀", 0));
    expect(glyph.intrinsicColor).toBe(true);
    expect(glyph.pixels).toHaveLength(glyph.width * glyph.height * 4);
    const placement = placeGlyph(
      { left: 0, right: 24, ascent: 20, descent: 4 },
      METRICS,
      EMOJI_CONSTRAINT,
      CONSTRAINT_METRICS,
      2,
      true,
    );
    expect(glyph.bearingX).toBe(placement.bearingX);
    expect(glyph.width).toBe(placement.width);
    // Predicted from the text: drawn once.
    expect(s.texts).toEqual(["😀"]);
  });

  it("gives a symbol two cells when the cell count says so", () => {
    const s = stub({ ink: wideInk });
    const rasterizer = new GlyphRasterizer(METRICS);
    const one = drawn(rasterizer.rasterize("→", 0));
    expect(one.width).toBe(17);
    const two = drawn(rasterizer.rasterize("→", GLYPH_STYLE_TWO_CELLS));
    expect(two.width).toBe(24 + 4);
    const explicit = drawn(rasterizer.rasterize("→", 0, 2));
    expect(explicit.width).toBe(two.width);
    // An explicit count wins over the style bit.
    expect(
      drawn(rasterizer.rasterize("→", GLYPH_STYLE_TWO_CELLS, 1)).width,
    ).toBe(one.width);
    // Only the one-cell layouts needed scaling.
    expect(s.draws.map((draw) => draw.transform[0] !== 1)).toEqual([
      true,
      false,
      false,
      true,
    ]);
  });

  it("redraws text the font drew in colour as an emoji in its cell", () => {
    const s = stub({ color: (text) => text === "x" });
    const glyph = drawn(new GlyphRasterizer(METRICS).rasterize("x", 0));
    expect(s.texts).toEqual(["x", "x"]);
    expect(glyph.intrinsicColor).toBe(true);
    const placement = placeGlyph(
      TEXT_INK,
      METRICS,
      EMOJI_CONSTRAINT,
      CONSTRAINT_METRICS,
      1,
      true,
    );
    expect(glyph).toMatchObject({
      width: placement.width,
      height: placement.height,
      bearingX: placement.bearingX,
      bearingY: placement.bearingY,
    });
  });

  it("measures the cap height once, with the regular font, and keeps the style", () => {
    const s = stub({ ink: wideInk });
    const rasterizer = new GlyphRasterizer(METRICS);
    rasterizer.rasterize("→", GLYPH_STYLE_BOLD);
    rasterizer.rasterize("⇒", GLYPH_STYLE_BOLD);
    // Regular for H, bold for the arrows; no switching back and forth.
    expect(s.fonts).toHaveLength(2);
    expect(s.fonts[1]).toMatch(/^700 /);
    expect(s.texts).toEqual(["→", "⇒"]);
  });

  it("never transforms plain text", () => {
    const s = stub();
    const rasterizer = new GlyphRasterizer(METRICS);
    rasterizer.rasterize("a", 0);
    rasterizer.rasterize("水", GLYPH_STYLE_ITALIC);
    expect(s.transforms).toEqual([]);
  });
});
