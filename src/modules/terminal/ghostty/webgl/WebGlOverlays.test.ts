import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GhosttyImagePlacement,
  GhosttyTerminalModelApi,
} from "@/modules/terminal/ghostty/GhosttyTerminalModel";
import { DEFAULT_IMAGE_BACKGROUND_Z_LIMIT } from "@/modules/terminal/ghostty/gpu/imageLayer";
import { WebGlCellRenderer } from "@/modules/terminal/ghostty/webgl/WebGlCellRenderer";

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

function setup(options: { underlinedCell?: number } = {}) {
  const fake = recordingGl();
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  vi.stubGlobal("document", {
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
        flags: () => 0,
        codepoint: () => 0,
        // An explicit background on the first column, so the cell pass draws rectangles.
        backgroundPacked: (index: number) => (index % 80 === 0 ? 0x334455 : 0),
        foregroundPacked: () => 0xffffff,
        underlineColorPacked: () => 0,
        underlineStyle: (index: number) =>
          index === options.underlinedCell ? 1 : 0,
        overline: () => false,
      }),
      imagePlacements: vi.fn(() => placements.value),
      imageBackgroundZLimit: () => LIMIT,
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
