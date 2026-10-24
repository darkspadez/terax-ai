/**
 * Adapted from xterm.js's TextureAtlas.
 * Copyright (c) 2017-2019 The xterm.js authors. MIT licensed.
 */

import { CellFlags } from "@oarlock/ghostty-core/protocol";
import { isBuiltinGlyph } from "../gpu/BuiltinGlyphs";
import {
  documentGlyphFontGate,
  type GlyphFontGate,
  hasPrivateUseCodepoint,
  isPrivateUseCodepoint,
} from "../gpu/GlyphFontGate";
import {
  GLYPH_STYLE_BOLD,
  GLYPH_STYLE_ITALIC,
  GLYPH_STYLE_LIGATURE,
  GLYPH_STYLE_LIGATURE_INDEX_SHIFT,
  GlyphRasterizer,
  type RasterizedGlyph,
} from "../gpu/GlyphRasterizer";
import { SkylineAtlasAllocator } from "../gpu/SkylineAtlasAllocator";
import type { TerminalFontMetrics } from "../gpu/terminalVisuals";

const ATLAS_SIZE = 1_024;
const COLOR_ATLAS_SIZE = 512;
/** Glyph variant bit of a ligature slice; the cell's index follows it. */
const LIGATURE_VARIANT = 1 << 4;

export type WebGlGlyphEntry = {
  readonly originOffsetX: number;
  readonly originOffsetY: number;
  readonly width: number;
  readonly height: number;
  readonly uvMinX: number;
  readonly uvMinY: number;
  readonly uvMaxX: number;
  readonly uvMaxY: number;
  readonly intrinsicColor: boolean;
};

type DirtyRectangle = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

const NULL_GLYPH: WebGlGlyphEntry = {
  originOffsetX: 0,
  originOffsetY: 0,
  width: 0,
  height: 0,
  uvMinX: 0,
  uvMinY: 0,
  uvMaxX: 0,
  uvMaxY: 0,
  intrinsicColor: false,
};

/**
 * A compact coverage atlas with a lazy color-glyph companion. Normal text uses
 * one byte of coverage and receives its color in the fragment shader, keeping
 * one cache entry across all ANSI and true-color variants. Native emoji use a
 * bounded RGBA atlas that is allocated only when an intrinsic-color glyph is
 * encountered. Glyphs come from the WebGPU path's `GlyphRasterizer`, so both
 * renderers draw the same pixels: procedural box drawing, blocks and braille
 * fill exactly their cell and ignore bold and italic, and icons, symbols and
 * emoji are fitted to their cells.
 */
export class WebGlGlyphAtlas {
  private readonly coverageAllocator = new SkylineAtlasAllocator(
    ATLAS_SIZE,
    ATLAS_SIZE,
  );
  private readonly colorAllocator = new SkylineAtlasAllocator(
    COLOR_ATLAS_SIZE,
    COLOR_ATLAS_SIZE,
  );
  private readonly simpleGlyphs = new Map<number, WebGlGlyphEntry>();
  private readonly complexGlyphs = new Map<
    number,
    Map<string, WebGlGlyphEntry>
  >();
  private coverage = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE);
  private colorPixels: Uint8Array | null = null;
  private readonly rasterizer: GlyphRasterizer;
  private readonly coverageTexture: WebGLTexture;
  private readonly colorTexture: WebGLTexture;
  private coverageDirty: DirtyRectangle | null = null;
  private colorDirty: DirtyRectangle | null = null;
  private uploadCountValue = 0;
  private uploadedBytesValue = 0;
  private generationValue = 1;
  private deferredValue = false;
  private disposed = false;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    metrics: TerminalFontMetrics,
    scale: number,
    fontGate: GlyphFontGate = documentGlyphFontGate(),
  ) {
    this.rasterizer = new GlyphRasterizer(
      metrics.scale === scale ? metrics : { ...metrics, scale },
      fontGate,
    );

    const coverageTexture = gl.createTexture();
    const colorTexture = gl.createTexture();
    if (!coverageTexture || !colorTexture) {
      if (coverageTexture) gl.deleteTexture(coverageTexture);
      if (colorTexture) gl.deleteTexture(colorTexture);
      throw new Error("Failed to allocate the WebGL glyph atlas");
    }
    this.coverageTexture = coverageTexture;
    this.colorTexture = colorTexture;
    gl.bindTexture(gl.TEXTURE_2D, coverageTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      ATLAS_SIZE,
      ATLAS_SIZE,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.bindTexture(gl.TEXTURE_2D, colorTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(4),
    );
  }

  get byteSize(): number {
    if (this.disposed) return 0;
    return (
      ATLAS_SIZE * ATLAS_SIZE +
      (this.colorPixels ? COLOR_ATLAS_SIZE * COLOR_ATLAS_SIZE * 4 : 4)
    );
  }

  get cpuByteSize(): number {
    return (
      this.rasterizer.cpuBytes +
      this.coverage.byteLength +
      (this.colorPixels?.byteLength ?? 0)
    );
  }

  get generation(): number {
    return this.generationValue;
  }

  get glyphCount(): number {
    let complexCount = 0;
    for (const glyphs of this.complexGlyphs.values()) {
      complexCount += glyphs.size;
    }
    return this.simpleGlyphs.size + complexCount;
  }

  get uploadCount(): number {
    return this.uploadCountValue;
  }

  get uploadedBytes(): number {
    return this.uploadedBytesValue;
  }

  /**
   * The atlas entry for a cell's glyph. `cells` is how many cells the glyph
   * may use (`constraintCells`: two for a wide character or a symbol with a
   * blank cell after it); left out, it follows from the text.
   */
  glyph(
    codepoint: number,
    grapheme: string | null,
    flags: number,
    cells?: 1 | 2,
  ): WebGlGlyphEntry {
    this.assertLive();
    if (codepoint === 0 || codepoint === 32) return NULL_GLYPH;
    // Procedural glyphs and icons ignore bold and italic (no synthesized
    // weight or slant on a symbol), and procedural glyphs fill one cell.
    const builtin = grapheme === null && isBuiltinGlyph(codepoint);
    const styleless =
      builtin ||
      (grapheme === null
        ? isPrivateUseCodepoint(codepoint)
        : hasPrivateUseCodepoint(grapheme));
    const style = styleless ? 0 : fontStyle(flags);
    // Bits 0-1 style, 2-3 the cell count: inferred (0), one or two. Ligature
    // slices add `LIGATURE_VARIANT` and their index (`ligatureGlyph`).
    const variant = builtin ? 0 : style | ((cells ?? 0) << 2);
    if (grapheme === null) {
      const key = codepoint * 16 + variant;
      const cached = this.simpleGlyphs.get(key);
      if (cached) return cached;
      const entry = this.rasterize(
        String.fromCodePoint(codepoint),
        style,
        cells,
      );
      if (entry) this.simpleGlyphs.set(key, entry);
      return entry ?? NULL_GLYPH;
    }

    return this.complexGlyph(variant, grapheme, style, cells);
  }

  /**
   * The slice of ligature run `text` (`ligatureRuns.ts`) that falls in the
   * run's cell `index`, for a cell with `flags`.
   */
  ligatureGlyph(text: string, index: number, flags: number): WebGlGlyphEntry {
    this.assertLive();
    const style = fontStyle(flags);
    return this.complexGlyph(
      style | LIGATURE_VARIANT | (index << 5),
      text,
      style |
        GLYPH_STYLE_LIGATURE |
        (index << GLYPH_STYLE_LIGATURE_INDEX_SHIFT),
      1,
    );
  }

  private complexGlyph(
    variant: number,
    text: string,
    style: number,
    cells: 1 | 2 | undefined,
  ): WebGlGlyphEntry {
    const cached = this.complexGlyphs.get(variant)?.get(text);
    if (cached) return cached;
    const entry = this.rasterize(text, style, cells);
    if (!entry) return NULL_GLYPH;
    let glyphs = this.complexGlyphs.get(variant);
    if (!glyphs) {
      glyphs = new Map();
      this.complexGlyphs.set(variant, glyphs);
    }
    glyphs.set(text, entry);
    return entry;
  }

  bindAndUpload(): void {
    this.assertLive();
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.coverageTexture);
    const coverageDirty = this.coverageDirty;
    if (coverageDirty) {
      const width = coverageDirty.right - coverageDirty.left;
      const height = coverageDirty.bottom - coverageDirty.top;
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, ATLAS_SIZE);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, coverageDirty.left);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, coverageDirty.top);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        coverageDirty.left,
        coverageDirty.top,
        width,
        height,
        gl.RED,
        gl.UNSIGNED_BYTE,
        this.coverage,
      );
      this.uploadCountValue += 1;
      this.uploadedBytesValue += width * height;
      this.coverageDirty = null;
    }

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.colorTexture);
    const colorDirty = this.colorDirty;
    const colorPixels = this.colorPixels;
    if (!colorDirty || !colorPixels) {
      this.resetUnpackState();
      return;
    }
    const width = colorDirty.right - colorDirty.left;
    const height = colorDirty.bottom - colorDirty.top;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, COLOR_ATLAS_SIZE);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, colorDirty.left);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, colorDirty.top);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      colorDirty.left,
      colorDirty.top,
      width,
      height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      colorPixels,
    );
    this.uploadCountValue += 1;
    this.uploadedBytesValue += width * height * 4;
    this.colorDirty = null;
    this.resetUnpackState();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.gl.deleteTexture(this.coverageTexture);
    this.gl.deleteTexture(this.colorTexture);
    this.simpleGlyphs.clear();
    this.complexGlyphs.clear();
    this.coverage = new Uint8Array(0);
    this.colorPixels = null;
    this.rasterizer.dispose();
    this.coverageDirty = null;
    this.colorDirty = null;
  }

  /**
   * Whether any glyph was skipped since the last call because its font was
   * still loading (`GlyphFontGate`). Nothing was cached for it: the owner
   * redraws in full once the gate reports the load settled.
   */
  takeDeferred(): boolean {
    const deferred = this.deferredValue;
    this.deferredValue = false;
    return deferred;
  }

  /**
   * Rasterizes and stores a glyph, or returns null (caching nothing) while its
   * font loads.
   */
  private rasterize(
    text: string,
    style: number,
    cells: 1 | 2 | undefined,
  ): WebGlGlyphEntry | null {
    const glyph = this.rasterizer.rasterize(text, style, cells);
    if (!glyph) {
      this.deferredValue = true;
      return null;
    }
    const color = glyph.intrinsicColor;
    if (color) this.ensureColorAtlas();
    const allocator = color ? this.colorAllocator : this.coverageAllocator;
    let region = allocator.allocate(glyph.width, glyph.height);
    if (!region) {
      this.reset();
      if (color) this.ensureColorAtlas();
      region = allocator.allocate(glyph.width, glyph.height);
    }
    if (!region) {
      const size = color ? COLOR_ATLAS_SIZE : ATLAS_SIZE;
      throw new Error(`Glyph exceeds the ${size}px atlas budget`);
    }
    if (color) this.storeColor(glyph, region.x, region.y);
    else this.storeCoverage(glyph, region.x, region.y);

    const atlasSize = color ? COLOR_ATLAS_SIZE : ATLAS_SIZE;
    return {
      originOffsetX: glyph.bearingX,
      originOffsetY: glyph.bearingY,
      width: glyph.width,
      height: glyph.height,
      uvMinX: region.x / atlasSize,
      uvMinY: region.y / atlasSize,
      uvMaxX: (region.x + glyph.width) / atlasSize,
      uvMaxY: (region.y + glyph.height) / atlasSize,
      intrinsicColor: color,
    };
  }

  private storeCoverage(glyph: RasterizedGlyph, x: number, y: number): void {
    const { width, height, pixels } = glyph;
    for (let row = 0; row < height; row += 1) {
      this.coverage.set(
        pixels.subarray(row * width, (row + 1) * width),
        (y + row) * ATLAS_SIZE + x,
      );
    }
    this.coverageDirty = mergeDirty(this.coverageDirty, x, y, width, height);
  }

  private storeColor(glyph: RasterizedGlyph, x: number, y: number): void {
    const { width, height, pixels } = glyph;
    const colorPixels = this.colorPixels as Uint8Array;
    for (let row = 0; row < height; row += 1) {
      colorPixels.set(
        pixels.subarray(row * width * 4, (row + 1) * width * 4),
        ((y + row) * COLOR_ATLAS_SIZE + x) * 4,
      );
    }
    this.colorDirty = mergeDirty(this.colorDirty, x, y, width, height);
  }

  private ensureColorAtlas(): void {
    if (this.colorPixels) return;
    this.colorPixels = new Uint8Array(COLOR_ATLAS_SIZE * COLOR_ATLAS_SIZE * 4);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.colorTexture);
    this.gl.texImage2D(
      this.gl.TEXTURE_2D,
      0,
      this.gl.RGBA,
      COLOR_ATLAS_SIZE,
      COLOR_ATLAS_SIZE,
      0,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      null,
    );
  }

  private reset(): void {
    this.coverageAllocator.reset();
    this.colorAllocator.reset();
    this.simpleGlyphs.clear();
    this.complexGlyphs.clear();
    this.coverage.fill(0);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.coverageTexture);
    this.gl.texImage2D(
      this.gl.TEXTURE_2D,
      0,
      this.gl.R8,
      ATLAS_SIZE,
      ATLAS_SIZE,
      0,
      this.gl.RED,
      this.gl.UNSIGNED_BYTE,
      null,
    );
    if (this.colorPixels) {
      this.colorPixels.fill(0);
      this.gl.bindTexture(this.gl.TEXTURE_2D, this.colorTexture);
      this.gl.texImage2D(
        this.gl.TEXTURE_2D,
        0,
        this.gl.RGBA,
        COLOR_ATLAS_SIZE,
        COLOR_ATLAS_SIZE,
        0,
        this.gl.RGBA,
        this.gl.UNSIGNED_BYTE,
        null,
      );
    }
    this.coverageDirty = null;
    this.colorDirty = null;
    this.generationValue += 1;
  }

  private assertLive(): void {
    if (this.disposed) throw new Error("WebGL glyph atlas is disposed");
  }

  private resetUnpackState(): void {
    this.gl.pixelStorei(this.gl.UNPACK_ROW_LENGTH, 0);
    this.gl.pixelStorei(this.gl.UNPACK_SKIP_PIXELS, 0);
    this.gl.pixelStorei(this.gl.UNPACK_SKIP_ROWS, 0);
  }
}

export { hasIntrinsicColor } from "../gpu/glyphColor";

function fontStyle(flags: number): number {
  return (
    ((flags & CellFlags.BOLD) !== 0 ? GLYPH_STYLE_BOLD : 0) |
    ((flags & CellFlags.ITALIC) !== 0 ? GLYPH_STYLE_ITALIC : 0)
  );
}

function mergeDirty(
  current: DirtyRectangle | null,
  x: number,
  y: number,
  width: number,
  height: number,
): DirtyRectangle {
  if (!current) {
    return { left: x, top: y, right: x + width, bottom: y + height };
  }
  current.left = Math.min(current.left, x);
  current.top = Math.min(current.top, y);
  current.right = Math.max(current.right, x + width);
  current.bottom = Math.max(current.bottom, y + height);
  return current;
}
