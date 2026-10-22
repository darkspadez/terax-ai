import { describe, expect, it, vi } from "vitest";
import type { GhosttyImagePlacement } from "@/modules/terminal/ghostty/GhosttyTerminalModel";
import {
  buildImageDrawList,
  DEFAULT_IMAGE_BACKGROUND_Z_LIMIT,
  IMAGE_INSTANCE_FLOATS,
  IMAGE_LAYER_ABOVE_TEXT,
  IMAGE_LAYER_BELOW_TEXT,
  IMAGE_LAYER_UNDER,
  type ImageTextureBackend,
  ImageTextureCache,
  imageLayerOf,
  imageRgba,
  MAX_IMAGE_PLACEMENTS,
  writeImageInstance,
} from "@/modules/terminal/ghostty/gpu/imageLayer";

const LIMIT = DEFAULT_IMAGE_BACKGROUND_Z_LIMIT;

function placement(
  overrides: Partial<GhosttyImagePlacement> = {},
): GhosttyImagePlacement {
  const imageWidth = overrides.imageWidth ?? 4;
  const imageHeight = overrides.imageHeight ?? 2;
  const channels = overrides.channels ?? 4;
  return {
    imageId: 1,
    channels,
    imageWidth,
    imageHeight,
    pixels: new Uint8Array(imageWidth * imageHeight * channels),
    generation: 1,
    col: 0,
    row: 0,
    z: 0,
    width: imageWidth,
    height: imageHeight,
    offsetX: 0,
    offsetY: 0,
    sourceX: 0,
    sourceY: 0,
    sourceWidth: imageWidth,
    sourceHeight: imageHeight,
    ...overrides,
  };
}

describe("image layers", () => {
  it("follows Ghostty's z layering", () => {
    expect(imageLayerOf(LIMIT - 1, LIMIT)).toBe(IMAGE_LAYER_UNDER);
    expect(imageLayerOf(-(2 ** 31), LIMIT)).toBe(IMAGE_LAYER_UNDER);
    expect(imageLayerOf(LIMIT, LIMIT)).toBe(IMAGE_LAYER_BELOW_TEXT);
    expect(imageLayerOf(-1, LIMIT)).toBe(IMAGE_LAYER_BELOW_TEXT);
    expect(imageLayerOf(0, LIMIT)).toBe(IMAGE_LAYER_ABOVE_TEXT);
    expect(imageLayerOf(5, LIMIT)).toBe(IMAGE_LAYER_ABOVE_TEXT);
    expect(LIMIT).toBe(-1_073_741_824);
  });
});

describe("placement geometry", () => {
  const instance = (value: GhosttyImagePlacement, cell = [10, 20]) => {
    const target = new Float32Array(IMAGE_INSTANCE_FLOATS);
    const written = writeImageInstance(target, 0, value, cell[0], cell[1]);
    return written ? [...target] : null;
  };

  it("places the quad at its cell plus the offset inside it, at Ghostty's size", () => {
    expect(
      instance(
        placement({
          col: 3,
          row: 2,
          offsetX: 4,
          offsetY: 7,
          width: 50,
          height: 30,
          imageWidth: 100,
          imageHeight: 60,
          sourceWidth: 100,
          sourceHeight: 60,
        }),
      ),
    ).toEqual([34, 47, 50, 30, 0, 0, 100, 60]);
  });

  it("keeps cells above or left of the viewport negative, for the scissor to clip", () => {
    expect(instance(placement({ col: -2, row: -3 }))?.slice(0, 2)).toEqual([
      -20, -60,
    ]);
  });

  it("clamps the source rectangle to the image", () => {
    expect(
      instance(
        placement({
          imageWidth: 8,
          imageHeight: 8,
          sourceX: 6,
          sourceY: 2,
          sourceWidth: 10,
          sourceHeight: 3,
        }),
      )?.slice(4),
    ).toEqual([6, 2, 2, 3]);
  });

  it("writes nothing for an empty source or destination", () => {
    expect(instance(placement({ sourceX: 4, imageWidth: 4 }))).toBeNull();
    expect(instance(placement({ sourceHeight: 0 }))).toBeNull();
    expect(instance(placement({ width: 0 }))).toBeNull();
    expect(instance(placement({ height: -1 }))).toBeNull();
  });
});

describe("draw list", () => {
  const all = () => true;

  it("splits placements into Ghostty's three layers in z order", () => {
    const list = buildImageDrawList(
      [
        placement({ imageId: 1, z: LIMIT - 5 }),
        placement({ imageId: 2, z: -1 }),
        placement({ imageId: 3, z: 0 }),
        placement({ imageId: 4, z: 7 }),
      ],
      all,
      LIMIT,
      10,
      20,
    );
    expect(list.count).toBe(4);
    expect(list.layers).toEqual([
      [{ imageId: 1, first: 0, count: 1 }],
      [{ imageId: 2, first: 1, count: 1 }],
      [
        { imageId: 3, first: 2, count: 1 },
        { imageId: 4, first: 3, count: 1 },
      ],
    ]);
  });

  it("batches consecutive placements of one image into one draw, keeping stacking order", () => {
    const list = buildImageDrawList(
      [
        placement({ imageId: 7, row: 0 }),
        placement({ imageId: 7, row: 1 }),
        placement({ imageId: 8, row: 1 }),
        placement({ imageId: 7, row: 2 }),
      ],
      all,
      LIMIT,
      10,
      20,
    );
    expect(list.layers[IMAGE_LAYER_ABOVE_TEXT]).toEqual([
      { imageId: 7, first: 0, count: 2 },
      { imageId: 8, first: 2, count: 1 },
      { imageId: 7, first: 3, count: 1 },
    ]);
    expect(list.instances[IMAGE_INSTANCE_FLOATS + 1]).toBe(20);
  });

  it("leaves out images without a texture and empty rectangles", () => {
    const list = buildImageDrawList(
      [
        placement({ imageId: 1 }),
        placement({ imageId: 2 }),
        placement({ imageId: 1, width: 0 }),
        placement({ imageId: 1, row: 4 }),
      ],
      (id) => id === 1,
      LIMIT,
      10,
      20,
    );
    expect(list.count).toBe(2);
    expect(list.layers[IMAGE_LAYER_ABOVE_TEXT]).toEqual([
      { imageId: 1, first: 0, count: 2 },
    ]);
    expect(list.instances[IMAGE_INSTANCE_FLOATS + 1]).toBe(80);
  });

  it("reuses a large enough scratch buffer and caps the placements drawn", () => {
    const scratch = new Float32Array(64 * IMAGE_INSTANCE_FLOATS);
    expect(
      buildImageDrawList([placement()], all, LIMIT, 1, 1, scratch).instances,
    ).toBe(scratch);
    const many = Array.from({ length: MAX_IMAGE_PLACEMENTS + 10 }, (_, row) =>
      placement({ row }),
    );
    expect(buildImageDrawList(many, all, LIMIT, 1, 1).count).toBe(
      MAX_IMAGE_PLACEMENTS,
    );
  });
});

describe("pixel formats", () => {
  it("uploads RGBA from the borrowed memory without a copy", () => {
    const memory = new Uint8Array(64);
    const view = new Uint8Array(memory.buffer, 8, 2 * 2 * 4);
    const rgba = imageRgba(view, 4, 2, 2);
    expect(rgba?.buffer).toBe(memory.buffer);
    expect(rgba?.byteOffset).toBe(8);
    expect(rgba?.length).toBe(16);
  });

  it("expands gray, gray with alpha and RGB to RGBA", () => {
    expect([...(imageRgba(Uint8Array.of(10, 200), 1, 2, 1) ?? [])]).toEqual([
      10, 10, 10, 255, 200, 200, 200, 255,
    ]);
    expect([
      ...(imageRgba(Uint8Array.of(10, 50, 200, 0), 2, 2, 1) ?? []),
    ]).toEqual([10, 10, 10, 50, 200, 200, 200, 0]);
    expect([
      ...(imageRgba(Uint8Array.of(1, 2, 3, 4, 5, 6), 3, 1, 2) ?? []),
    ]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
  });

  it("rejects pixels shorter than the image", () => {
    expect(imageRgba(new Uint8Array(11), 3, 2, 2)).toBeNull();
    expect(imageRgba(new Uint8Array(15), 4, 2, 2)).toBeNull();
  });
});

describe("texture cache", () => {
  type FakeTexture = { id: number; width: number; height: number };
  function backend(maxDimension = 8192) {
    let next = 0;
    const value = {
      maxDimension,
      create: vi.fn(
        (width: number, height: number): FakeTexture => ({
          id: ++next,
          width,
          height,
        }),
      ),
      upload: vi.fn(
        (
          _texture: FakeTexture,
          _rgba: Uint8Array,
          _width: number,
          _height: number,
        ) => {},
      ),
      destroy: vi.fn((_texture: FakeTexture) => {}),
    } satisfies ImageTextureBackend<FakeTexture>;
    return value;
  }

  it("uploads an image once per generation and again into the same texture when it changes", () => {
    const gpu = backend();
    const cache = new ImageTextureCache(gpu);
    const first = placement({ imageId: 3, generation: 10 });
    expect([...cache.sync([first, { ...first, row: 4 }])]).toEqual([3]);
    expect(gpu.create).toHaveBeenCalledOnce();
    expect(gpu.upload).toHaveBeenCalledOnce();
    // Same generation in later frames: nothing is uploaded.
    for (let frame = 0; frame < 10; frame++) cache.sync([first]);
    expect(gpu.upload).toHaveBeenCalledOnce();
    // A new animation frame of the same size reuses the texture.
    cache.sync([{ ...first, generation: 11 }]);
    expect(gpu.create).toHaveBeenCalledOnce();
    expect(gpu.upload).toHaveBeenCalledTimes(2);
    expect(gpu.upload.mock.calls[1][0]).toBe(cache.texture(3));
    expect(gpu.destroy).not.toHaveBeenCalled();
    expect(cache.uploads).toBe(2);
    expect(cache.bytes).toBe(4 * 2 * 4);
  });

  it("replaces the texture when a new generation changes the size", () => {
    const gpu = backend();
    const cache = new ImageTextureCache(gpu);
    cache.sync([placement({ imageId: 3, generation: 1 })]);
    const old = cache.texture(3);
    cache.sync([
      placement({ imageId: 3, generation: 2, imageWidth: 8, imageHeight: 8 }),
    ]);
    expect(gpu.destroy).toHaveBeenCalledExactlyOnceWith(old);
    expect(cache.texture(3)).toMatchObject({ width: 8, height: 8 });
    expect(cache.bytes).toBe(8 * 8 * 4);
  });

  it("drops a stale texture when the new generation cannot be uploaded", () => {
    const gpu = backend();
    const cache = new ImageTextureCache(gpu);
    cache.sync([placement({ imageId: 3, generation: 1 })]);
    const resident = cache.sync([
      placement({ imageId: 3, generation: 2, pixels: new Uint8Array(3) }),
    ]);
    expect(resident.has(3)).toBe(false);
    expect(cache.texture(3)).toBeUndefined();
    expect(gpu.destroy).toHaveBeenCalledOnce();
  });

  it("frees an image's texture once it has been unplaced for the grace period", () => {
    const gpu = backend();
    const cache = new ImageTextureCache(gpu, {
      budgetBytes: 1 << 20,
      maxTextures: 16,
      graceUpdates: 3,
    });
    cache.sync([placement({ imageId: 1 }), placement({ imageId: 2 })]);
    // Image 1 scrolls away; image 2 stays.
    for (let update = 0; update < 3; update++)
      cache.sync([placement({ imageId: 2 })]);
    expect(gpu.destroy).not.toHaveBeenCalled();
    // Back within the grace period: no upload.
    cache.sync([placement({ imageId: 1 }), placement({ imageId: 2 })]);
    expect(gpu.upload).toHaveBeenCalledTimes(2);
    for (let update = 0; update < 4; update++) cache.sync([]);
    expect(gpu.destroy).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });

  it("evicts the least recently placed unplaced images to stay under the byte budget", () => {
    const gpu = backend();
    const bytes = 4 * 2 * 4;
    const cache = new ImageTextureCache(gpu, {
      budgetBytes: bytes * 2,
      maxTextures: 16,
      graceUpdates: 100,
    });
    cache.sync([placement({ imageId: 1 })]);
    cache.sync([placement({ imageId: 2 })]);
    cache.sync([placement({ imageId: 3 })]);
    expect(cache.texture(1)).toBeUndefined();
    expect(cache.texture(2)).toBeDefined();
    expect(cache.texture(3)).toBeDefined();
    expect(cache.bytes).toBe(bytes * 2);
  });

  it("never evicts a placed image for another and skips what does not fit", () => {
    const gpu = backend();
    const bytes = 4 * 2 * 4;
    const cache = new ImageTextureCache(gpu, {
      budgetBytes: bytes * 2,
      maxTextures: 16,
      graceUpdates: 100,
    });
    const resident = cache.sync([
      placement({ imageId: 1, z: -5 }),
      placement({ imageId: 2 }),
      placement({ imageId: 3 }),
    ]);
    expect([...resident]).toEqual([1, 2]);
    expect(gpu.destroy).not.toHaveBeenCalled();
    // An image larger than the whole budget is never uploaded.
    expect(
      cache
        .sync([placement({ imageId: 9, imageWidth: 64, imageHeight: 64 })])
        .has(9),
    ).toBe(false);
  });

  it("bounds the number of textures", () => {
    const gpu = backend();
    const cache = new ImageTextureCache(gpu, {
      budgetBytes: 1 << 30,
      maxTextures: 2,
      graceUpdates: 100,
    });
    for (let id = 1; id <= 5; id++) cache.sync([placement({ imageId: id })]);
    expect(cache.size).toBe(2);
    expect(gpu.destroy).toHaveBeenCalledTimes(3);
  });

  it("skips images beyond the device's texture size", () => {
    const gpu = backend(4);
    const cache = new ImageTextureCache(gpu);
    expect(
      cache.sync([placement({ imageWidth: 5, imageHeight: 1 })]).size,
    ).toBe(0);
    expect(gpu.create).not.toHaveBeenCalled();
  });

  it("frees everything on clear and forgets textures of a lost context without freeing them", () => {
    const gpu = backend();
    const cache = new ImageTextureCache(gpu);
    cache.sync([placement({ imageId: 1 }), placement({ imageId: 2 })]);
    cache.clear();
    expect(gpu.destroy).toHaveBeenCalledTimes(2);
    expect(cache.bytes).toBe(0);
    cache.sync([placement({ imageId: 1 })]);
    cache.forget();
    expect(gpu.destroy).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });
});
