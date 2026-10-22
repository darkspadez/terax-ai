import type {
  GhosttyImagePlacement,
  GhosttyTerminalModelApi,
} from "@/modules/terminal/ghostty/GhosttyTerminalModel";
import { DEFAULT_IMAGE_BACKGROUND_Z_LIMIT } from "@/modules/terminal/ghostty/gpu/imageLayer";
import { WebGlCellRenderer } from "@/modules/terminal/ghostty/webgl/WebGlCellRenderer";
import {
  WebGlGlyphAtlas,
  type WebGlGlyphEntry,
} from "@/modules/terminal/ghostty/webgl/WebGlGlyphAtlas";
import { CellFlags } from "@terax/ghostty-core/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

const LIMIT = DEFAULT_IMAGE_BACKGROUND_Z_LIMIT;
const DRAWS = new Set(["drawArraysInstanced", "drawElementsInstanced"]);

function recordingGl() {
  const log: string[] = [];
  const methods = new Map<string, ReturnType<typeof vi.fn>>();
  let textures = 0;
  const constants = new Map<string, number>();
  const gl = new Proxy(
    {},
    {
      get: (_, key: string) => {
        if (/^[A-Z_0-9]+$/.test(key)) {
          if (!constants.has(key))
            constants.set(key, 1000 * (constants.size + 1));
          return constants.get(key);
        }
        let method = methods.get(key);
        if (!method) {
          method = vi.fn((...args: unknown[]) => {
            if (DRAWS.has(key)) log.push(key);
            if (key === "uniform1i") {
              const name = (args[0] as { name?: string }).name;
              if (name === "u_decorations_only")
                log.push(`decorationsOnly=${args[1]}`);
            }
            if (key === "getExtension") return null;
            if (key === "getUniformLocation") return { name: args[1] };
            if (key === "createTexture") return { texture: ++textures };
            return {};
          });
          methods.set(key, method);
        }
        return method;
      },
    },
  );
  return {
    gl,
    log,
    method: (name: string) => {
      // Touch the proxy so the spy exists even before the first call.
      (gl as Record<string, unknown>)[name];
      return methods.get(name) as ReturnType<typeof vi.fn>;
    },
  };
}

function image(
  overrides: Partial<GhosttyImagePlacement> = {},
): GhosttyImagePlacement {
  return {
    imageId: 1,
    channels: 4,
    imageWidth: 2,
    imageHeight: 2,
    pixels: new Uint8Array(16),
    generation: 1,
    col: 1,
    row: 1,
    z: 0,
    width: 8,
    height: 16,
    offsetX: 0,
    offsetY: 0,
    sourceX: 0,
    sourceY: 0,
    sourceWidth: 2,
    sourceHeight: 2,
    ...overrides,
  };
}

function setup(
  options: {
    underlinedCell?: number;
    minimumContrast?: number;
    /** Foreground by cell index; white elsewhere. */
    foregrounds?: ReadonlyMap<number, number>;
    /** Code points by cell index; every other cell is empty. */
    codepoints?: ReadonlyMap<number, number>;
    /** Cell flags by cell index; none elsewhere. */
    flags?: ReadonlyMap<number, number>;
    /** What the model reports for `ligatures()`; the method is absent when unset. */
    ligatures?: boolean;
    customShader?: string;
    /** `document.hasFocus()`; true when unset. */
    focused?: boolean;
  } = {},
) {
  const fake = recordingGl();
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  vi.stubGlobal("document", {
    hasFocus: () => options.focused ?? true,
    createElement: () =>
      Object.assign(new EventTarget(), {
        width: 1,
        height: 1,
        style: {},
        setAttribute() {},
        remove() {},
        getContext: (kind: string) => (kind === "webgl2" ? fake.gl : {}),
      }),
  });
  const renderer = new WebGlCellRenderer();
  const requestFrame = vi.fn();
  renderer.configure(
    {
      metrics: {
        scale: 1,
        deviceCellWidth: 8,
        deviceCellHeight: 16,
        deviceBaseline: 12,
        cellWidth: 8,
        cellHeight: 16,
        baseline: 12,
        font: {
          family: "monospace",
          size: 14,
          weight: "400",
          lineHeight: 1.2,
          letterSpacing: 0,
        },
      },
      theme: {
        background: [0, 0, 0],
        foreground: [255, 255, 255],
        cursor: [255, 255, 255],
        selection: { color: [50, 50, 50], alpha: 0.5 },
        palette: [],
        minimumContrast: options.minimumContrast,
        customShader: options.customShader,
      },
      scale: 1,
    },
    requestFrame,
    () => {},
  );
  renderer.resize(80, 24);
  const placements: { value: GhosttyImagePlacement[] } = { value: [] };
  const createModel = () =>
    ({
      cols: 80,
      rows: 24,
      cursor: () => ({
        x: 0,
        y: 0,
        visible: true,
        blinking: false,
        style: "block",
      }),
      viewportOriginLine: () => 0,
      renderCells: () => ({
        length: 80 * 24,
        width: () => 1,
        flags: (index: number) => options.flags?.get(index) ?? 0,
        codepoint: (index: number) => options.codepoints?.get(index) ?? 0,
        graphemeLength: () => 0,
        // An explicit background on the first column, so the cell pass draws rectangles.
        backgroundPacked: (index: number) => (index % 80 === 0 ? 0x334455 : 0),
        foregroundPacked: (index: number) =>
          options.foregrounds?.get(index) ?? 0xffffff,
        underlineColorPacked: () => 0,
        underlineStyle: (index: number) =>
          index === options.underlinedCell ? 1 : 0,
        overline: () => false,
      }),
      imagePlacements: vi.fn(() => placements.value),
      imageBackgroundZLimit: () => LIMIT,
      ...(options.ligatures === undefined
        ? {}
        : { ligatures: () => options.ligatures }),
    }) as unknown as GhosttyTerminalModelApi;
  const model = createModel();
  const frame = (
    damage: "full" | "none" = "full",
    target: GhosttyTerminalModelApi = model,
    link: { start: number; end: number } | null = null,
  ) => ({
    model: target,
    damage: { kind: damage },
    cursorVisible: true,
    textBlinkVisible: true,
    selection: null,
    searchMatchAt: () => 0 as const,
    link,
  });
  /** Places images and renders until the lazily loaded layer has drawn them. */
  const show = async (next: GhosttyImagePlacement[]) => {
    placements.value = next;
    renderer.render(frame());
    await vi.dynamicImportSettled();
    await Promise.resolve();
    fake.log.length = 0;
    return renderer.render(frame("none"));
  };
  return {
    ...fake,
    renderer,
    requestFrame,
    model,
    createModel,
    frame,
    show,
    placements,
  };
}

describe("WebGL glyph cells", () => {
  it("asks the atlas for Ghostty's cell count, from the neighbouring cells", () => {
    const empty: WebGlGlyphEntry = {
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
    const glyph = vi
      .spyOn(WebGlGlyphAtlas.prototype, "glyph")
      .mockReturnValue(empty);
    const icon = 0xe718;
    const h = setup({
      codepoints: new Map([
        [0, icon], // then an empty cell: may use two
        [80, icon], // then text: one
        [81, 0x78],
        [160, icon], // a run of icons: one each
        [161, icon],
        [240 + 79, icon], // the last column: one
      ]),
    });
    try {
      h.renderer.render(h.frame());
      expect(glyph.mock.calls.map((args) => [args[0], args[3]])).toEqual([
        [icon, 2],
        [icon, 1],
        [0x78, 1],
        [icon, 1],
        [icon, 1],
        [icon, 1],
      ]);
      expect(glyph.mock.calls[0][1]).toBeNull(); // no grapheme cluster
    } finally {
      glyph.mockRestore();
      h.renderer.dispose();
    }
  });
});

describe("WebGL ligature runs", () => {
  const empty: WebGlGlyphEntry = {
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
  /** Row 0: "a->b ===" then a red "-" before a white ">", then a bold "!" before "=". */
  const text = new Map(
    [..."a->b ===  -> !="].map((character, column) => [
      column,
      character === " " ? 0 : (character.codePointAt(0) ?? 0),
    ]),
  );

  function render(ligatures: boolean | undefined) {
    const glyph = vi
      .spyOn(WebGlGlyphAtlas.prototype, "glyph")
      .mockReturnValue(empty);
    const ligature = vi
      .spyOn(WebGlGlyphAtlas.prototype, "ligatureGlyph")
      .mockReturnValue(empty);
    const h = setup({
      codepoints: text,
      foregrounds: new Map([[10, 0xff0000]]),
      flags: new Map([[13, CellFlags.BOLD]]),
      ligatures,
    });
    try {
      h.renderer.render(h.frame());
      return {
        plain: glyph.mock.calls.map(([codepoint]) =>
          String.fromCodePoint(codepoint),
        ),
        slices: ligature.mock.calls.map(([run, index, flags]) => [
          run,
          index,
          flags,
        ]),
      };
    } finally {
      glyph.mockRestore();
      ligature.mockRestore();
      h.renderer.dispose();
    }
  }

  it("asks the atlas for each run cell's slice when the model draws ligatures", () => {
    expect(render(true)).toEqual({
      plain: ["a", "b", "-", ">", "!", "="],
      slices: [
        ["->", 0, 0],
        ["->", 1, 0],
        ["===", 0, 0],
        ["===", 1, 0],
        ["===", 2, 0],
      ],
    });
  });

  it("draws every cell on its own when the model's switch is off or absent", () => {
    for (const ligatures of [false, undefined]) {
      const { plain, slices } = render(ligatures);
      expect(slices).toEqual([]);
      expect(plain.join("")).toBe("a->b===->!=");
    }
  });
});

describe("WebGL minimum contrast", () => {
  const glyphEntry = (intrinsicColor: boolean): WebGlGlyphEntry => ({
    originOffsetX: 0,
    originOffsetY: 0,
    width: 8,
    height: 16,
    uvMinX: 0,
    uvMinY: 0,
    uvMaxX: 0.01,
    uvMaxY: 0.01,
    intrinsicColor,
  });

  /** Renders cells 1 (text), 2 (a colour glyph) and 3 (box drawing) in dark grey. */
  function colours(minimumContrast: number) {
    const glyph = vi
      .spyOn(WebGlGlyphAtlas.prototype, "glyph")
      .mockImplementation((codepoint) => glyphEntry(codepoint === 0x1f600));
    const dark = 0x202020;
    const h = setup({
      minimumContrast,
      codepoints: new Map([
        [1, 0x41],
        [2, 0x1f600],
        [3, 0x2500],
      ]),
      foregrounds: new Map([
        [1, dark],
        [2, dark],
        [3, dark],
      ]),
    });
    try {
      h.renderer.render(h.frame());
      const attributes = (
        h.renderer as unknown as { glyphAttributes: Float32Array }
      ).glyphAttributes;
      // 15 floats per glyph; the colour is RGBA at 8..11.
      const rgb = (cell: number) =>
        [8, 9, 10].map((offset) =>
          Math.round(attributes[cell * 15 + offset] * 255),
        );
      return [rgb(1), rgb(2), rgb(3)];
    } finally {
      glyph.mockRestore();
      h.renderer.dispose();
    }
  }

  it("draws unreadable text white or black, but not colour glyphs or shapes", () => {
    const dark = [0x20, 0x20, 0x20];
    // Cells 1-3 sit on black (only column 0 has a background of its own).
    expect(colours(1)).toEqual([dark, dark, dark]);
    expect(colours(4.5)).toEqual([[255, 255, 255], dark, dark]);
  });
});

describe("WebGL custom shader", () => {
  const SHADER = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  fragColor = texture(iChannel0, fragCoord / iResolution.xy);
}`;

  /** Renders until the lazily loaded shader module has compiled the pass. */
  async function shaded(focused: boolean) {
    const h = setup({ customShader: SHADER, focused });
    h.renderer.render(h.frame());
    await vi.dynamicImportSettled();
    expect(h.requestFrame).toHaveBeenCalled(); // the module arrived
    h.requestFrame.mockClear();
    h.method("bindFramebuffer").mockClear();
    h.method("drawArrays").mockClear();
    return h;
  }

  it("draws the frame into a texture, then the shader over the canvas", async () => {
    const h = await shaded(true);
    try {
      expect(h.renderer.render(h.frame("none"))).toBe(true);
      const targets = h
        .method("bindFramebuffer")
        .mock.calls.map((call) => call[1]);
      // Into the pass's framebuffer first, back to the canvas last.
      expect(targets[0]).not.toBeNull();
      expect(targets[targets.length - 1]).toBeNull();
      expect(h.method("drawArrays")).toHaveBeenCalledWith(
        expect.anything(),
        0,
        3,
      );
      const sources = h.method("shaderSource").mock.calls;
      expect(sources[sources.length - 1]?.[1]).toContain(
        "fragColor = texture(iChannel0, fragCoord / iResolution.xy);",
      );
    } finally {
      h.renderer.dispose();
    }
  });

  it("animates while the window has focus and rests without it", async () => {
    const focused = await shaded(true);
    try {
      // Nothing changed, yet it draws and asks for the next frame.
      expect(focused.renderer.render(focused.frame("none"))).toBe(true);
      expect(focused.requestFrame).toHaveBeenCalledOnce();
    } finally {
      focused.renderer.dispose();
    }
    const resting = await shaded(false);
    try {
      expect(resting.renderer.render(resting.frame("none"))).toBe(false);
      expect(resting.requestFrame).not.toHaveBeenCalled();
    } finally {
      resting.renderer.dispose();
    }
  });

  it("draws without the shader when it does not compile", async () => {
    const h = setup({ customShader: SHADER });
    try {
      h.method("getProgramParameter").mockReturnValue(false);
      h.method("getProgramInfoLog").mockReturnValue(
        "ERROR: Linking fragment stage: no mainImage",
      );
      h.renderer.render(h.frame());
      await vi.dynamicImportSettled();
      h.method("bindFramebuffer").mockClear();
      expect(h.renderer.render(h.frame())).toBe(true);
      expect(h.method("bindFramebuffer")).not.toHaveBeenCalledWith(
        expect.anything(),
        null,
      );
    } finally {
      h.renderer.dispose();
    }
  });
});

describe("WebGL Kitty images", () => {
  it("creates no image texture and draws no image pass without images", () => {
    const h = setup();
    try {
      expect(h.renderer.render(h.frame())).toBe(true);
      // The glyph atlas has textures of its own; images allocate storage only through the layer.
      expect(h.method("texStorage2D")).not.toHaveBeenCalled();
      expect(h.renderer.imagesShown).toBe(false);
      expect(h.log).toEqual([
        "decorationsOnly=0",
        "drawElementsInstanced",
        "decorationsOnly=0",
        "drawElementsInstanced",
        "drawElementsInstanced",
      ]);
    } finally {
      h.renderer.dispose();
    }
  });

  it("draws Ghostty's layers in order around the cell and text passes", async () => {
    const h = setup();
    try {
      expect(
        await h.show([
          image({ imageId: 1, z: LIMIT - 1 }),
          image({ imageId: 2, z: -1 }),
          image({ imageId: 3, z: 0 }),
        ]),
      ).toBe(true);
      expect(h.renderer.imagesShown).toBe(true);
      expect(h.log).toEqual([
        // Under the backgrounds: only explicit backgrounds are rectangles.
        "drawArraysInstanced",
        "decorationsOnly=0",
        "drawElementsInstanced",
        "decorationsOnly=0",
        "drawElementsInstanced",
        // Between backgrounds and text, then decorations and the cursor again over it.
        "drawArraysInstanced",
        "decorationsOnly=1",
        "drawElementsInstanced",
        "decorationsOnly=0",
        "drawElementsInstanced",
        // Text, then the images above it.
        "drawElementsInstanced",
        "drawArraysInstanced",
      ]);
      // Premultiplied blending for images, straight alpha again for the glyphs.
      const gl = h.gl as WebGL2RenderingContext;
      const premultiplied = [gl.ONE, gl.ONE_MINUS_SRC_ALPHA];
      expect(h.method("blendFunc").mock.calls.slice(-4)).toEqual([
        premultiplied,
        premultiplied,
        [gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA],
        premultiplied,
      ]);
    } finally {
      h.renderer.dispose();
    }
  });

  it("uploads an image once per generation into one texture and frees it when released", async () => {
    const h = setup();
    try {
      await h.show([image({ imageId: 4 }), image({ imageId: 4, row: 3 })]);
      const storage = h.method("texStorage2D");
      const upload = h.method("texSubImage2D");
      expect(storage).toHaveBeenCalledOnce();
      expect(upload).toHaveBeenCalledOnce();
      for (let frame = 0; frame < 10; frame++) h.renderer.render(h.frame());
      expect(upload).toHaveBeenCalledOnce();
      h.placements.value = [image({ imageId: 4, generation: 2 })];
      h.renderer.render(h.frame());
      expect(upload).toHaveBeenCalledTimes(2);
      expect(storage).toHaveBeenCalledOnce();
      expect(h.renderer.diagnostics().imageBytes).toBe(16);
      // Back in the pool: the texture goes with the lease.
      h.renderer.detach();
      expect(h.method("deleteTexture")).toHaveBeenCalledOnce();
      expect(h.renderer.diagnostics().imageBytes).toBe(0);
      expect(h.renderer.imagesShown).toBe(false);
    } finally {
      h.renderer.dispose();
    }
  });

  it("never draws one model's textures for another model sharing the pooled renderer", async () => {
    const h = setup();
    try {
      await h.show([image({ imageId: 1, generation: 1 })]);
      const upload = h.method("texSubImage2D");
      expect(upload).toHaveBeenCalledOnce();
      // Same id and generation, other terminal: other pixels.
      h.renderer.render(h.frame("full", h.createModel()));
      expect(h.method("deleteTexture")).toHaveBeenCalledOnce();
      expect(upload).toHaveBeenCalledTimes(2);
    } finally {
      h.renderer.dispose();
    }
  });

  it("drops textures of a lost context without deleting them and uploads again after restore", async () => {
    const h = setup();
    try {
      await h.show([image()]);
      h.renderer.canvas.dispatchEvent(new Event("webglcontextlost"));
      expect(h.method("deleteTexture")).not.toHaveBeenCalled();
      h.renderer.canvas.dispatchEvent(new Event("webglcontextrestored"));
      h.renderer.render(h.frame("none"));
      expect(h.method("texSubImage2D")).toHaveBeenCalledTimes(2);
    } finally {
      h.renderer.dispose();
    }
  });
});

describe("WebGL hovered link underline", () => {
  const drawCounts = (h: ReturnType<typeof setup>) =>
    h
      .method("drawElementsInstanced")
      .mock.calls.map((call) => call[4] as number);

  it("draws one underline per linked cell as an overlay, only when the link changes", () => {
    // Cell 1 has an underline of its own and keeps it.
    const h = setup({ underlinedCell: 1 });
    try {
      h.renderer.render(h.frame());
      expect(h.renderer.render(h.frame("none"))).toBe(false);
      const draws = h.method("drawElementsInstanced");
      draws.mockClear();
      expect(
        h.renderer.render(h.frame("none", h.model, { start: 0, end: 2 })),
      ).toBe(true);
      // Backgrounds, the link underline (cells 0 and 2), the cursor, the glyphs.
      const counts = drawCounts(h);
      expect(counts).toHaveLength(4);
      expect(counts[1]).toBe(2);
      draws.mockClear();
      expect(
        h.renderer.render(h.frame("none", h.model, { start: 0, end: 2 })),
      ).toBe(false);
      expect(h.renderer.render(h.frame("none"))).toBe(true);
      expect(drawCounts(h)).toHaveLength(3);
    } finally {
      h.renderer.dispose();
    }
  });

  it("clamps a range past the grid and draws it again after a context restore", () => {
    const h = setup();
    try {
      h.renderer.render(h.frame());
      const link = { start: 80 * 24 - 2, end: 80 * 24 + 50 };
      h.renderer.render(h.frame("none", h.model, link));
      const counts = drawCounts(h);
      expect(counts[counts.length - 3]).toBe(2);
      h.renderer.canvas.dispatchEvent(new Event("webglcontextlost"));
      h.renderer.canvas.dispatchEvent(new Event("webglcontextrestored"));
      h.method("drawElementsInstanced").mockClear();
      expect(h.renderer.render(h.frame("none", h.model, link))).toBe(true);
      expect(drawCounts(h)[1]).toBe(2);
    } finally {
      h.renderer.dispose();
    }
  });
});
