/**
 * Kitty graphics placement logic shared by the WebGPU and WebGL renderers: which layer a
 * placement draws in, where its quad goes, and which images keep a texture. Pure apart from the
 * texture backend the cache is given, so both renderers (and tests) drive the same rules.
 */
import type { GhosttyImagePlacement } from "../GhosttyTerminalModel";

/** Ghostty's layers: under cell backgrounds, between backgrounds and text, above text. */
export const IMAGE_LAYER_UNDER = 0;
export const IMAGE_LAYER_BELOW_TEXT = 1;
export const IMAGE_LAYER_ABOVE_TEXT = 2;
export type ImageLayer = 0 | 1 | 2;

/** Ghostty's `restty_kitty_background_z_limit` (i32 minimum / 2), for models that do not report it. */
export const DEFAULT_IMAGE_BACKGROUND_Z_LIMIT = -(2 ** 30);

/**
 * Floats per placement instance: destination x, y, width, height in grid device pixels (before
 * the gesture shift), then the source rectangle x, y, width, height in texels.
 */
export const IMAGE_INSTANCE_FLOATS = 8;
export const IMAGE_INSTANCE_BYTES = IMAGE_INSTANCE_FLOATS * 4;
/** Placements drawn per frame at most; a screen of Unicode placeholders stays far below. */
export const MAX_IMAGE_PLACEMENTS = 4096;

export type ImageTextureLimits = {
  /** RGBA bytes all textures of one surface may hold. */
  readonly budgetBytes: number;
  readonly maxTextures: number;
  /** Updates an image may go unplaced (scrolled away, cleared) before its texture is freed. */
  readonly graceUpdates: number;
};

export const DEFAULT_IMAGE_TEXTURE_LIMITS: ImageTextureLimits = {
  // Ghostty's storage limit per screen, so a screen of RGBA images always fits.
  budgetBytes: 64 * 1024 * 1024,
  maxTextures: 256,
  graceUpdates: 60,
};

export function imageLayerOf(z: number, backgroundLimit: number): ImageLayer {
  if (z < backgroundLimit) return IMAGE_LAYER_UNDER;
  return z < 0 ? IMAGE_LAYER_BELOW_TEXT : IMAGE_LAYER_ABOVE_TEXT;
}

/**
 * Writes a placement's instance at `offset`. The destination is its top-left cell plus the
 * offset inside that cell, at the size Ghostty computed; the source is clamped to the image so
 * filtering never reads outside it. False (nothing written) for an empty rectangle.
 */
export function writeImageInstance(
  target: Float32Array,
  offset: number,
  placement: GhosttyImagePlacement,
  cellWidth: number,
  cellHeight: number,
): boolean {
  const sourceX = clamp(placement.sourceX, 0, placement.imageWidth);
  const sourceY = clamp(placement.sourceY, 0, placement.imageHeight);
  const sourceWidth = Math.min(
    placement.sourceWidth,
    placement.imageWidth - sourceX,
  );
  const sourceHeight = Math.min(
    placement.sourceHeight,
    placement.imageHeight - sourceY,
  );
  if (
    !(sourceWidth > 0 && sourceHeight > 0) ||
    !(placement.width > 0 && placement.height > 0)
  )
    return false;
  target[offset] = placement.col * cellWidth + placement.offsetX;
  target[offset + 1] = placement.row * cellHeight + placement.offsetY;
  target[offset + 2] = placement.width;
  target[offset + 3] = placement.height;
  target[offset + 4] = sourceX;
  target[offset + 5] = sourceY;
  target[offset + 6] = sourceWidth;
  target[offset + 7] = sourceHeight;
  return true;
}

/** Consecutive instances of one image in one layer: one texture binding, one draw. */
export type ImageDrawRun = {
  readonly imageId: number;
  readonly first: number;
  readonly count: number;
};

export type ImageDrawList = {
  /** `count` instances of `IMAGE_INSTANCE_FLOATS`, in draw order. */
  readonly instances: Float32Array;
  readonly count: number;
  /** Runs per layer, indexed by `ImageLayer`. */
  readonly layers: readonly [
    readonly ImageDrawRun[],
    readonly ImageDrawRun[],
    readonly ImageDrawRun[],
  ];
};

export const EMPTY_IMAGE_DRAW_LIST: ImageDrawList = {
  instances: new Float32Array(0),
  count: 0,
  layers: [[], [], []],
};

/**
 * Turns placements (sorted by z, as the model reports them) into instances and per-layer draw
 * runs. Placements whose image has no texture are left out; order within a layer is kept, so
 * overlapping images stack as Ghostty stacks them.
 */
export function buildImageDrawList(
  placements: readonly GhosttyImagePlacement[],
  resident: (imageId: number) => boolean,
  backgroundLimit: number,
  cellWidth: number,
  cellHeight: number,
  scratch?: Float32Array,
): ImageDrawList {
  const limit = Math.min(placements.length, MAX_IMAGE_PLACEMENTS);
  const floats = limit * IMAGE_INSTANCE_FLOATS;
  const instances =
    scratch && scratch.length >= floats ? scratch : new Float32Array(floats);
  const layers: [ImageDrawRun[], ImageDrawRun[], ImageDrawRun[]] = [[], [], []];
  let count = 0;
  for (let index = 0; index < limit; index += 1) {
    const placement = placements[index];
    if (!resident(placement.imageId)) continue;
    if (
      !writeImageInstance(
        instances,
        count * IMAGE_INSTANCE_FLOATS,
        placement,
        cellWidth,
        cellHeight,
      )
    )
      continue;
    const runs = layers[imageLayerOf(placement.z, backgroundLimit)];
    const last = runs[runs.length - 1];
    if (
      last &&
      last.imageId === placement.imageId &&
      last.first + last.count === count
    ) {
      runs[runs.length - 1] = { ...last, count: last.count + 1 };
    } else {
      runs.push({ imageId: placement.imageId, first: count, count: 1 });
    }
    count += 1;
  }
  return { instances, count, layers };
}

/**
 * The pixels as tightly packed RGBA8: a view of the same memory for 4 channels, an expanded copy
 * for gray, gray + alpha and RGB. Null when `pixels` is shorter than the image.
 */
export function imageRgba(
  pixels: Uint8Array,
  channels: number,
  width: number,
  height: number,
): Uint8Array | null {
  const count = width * height;
  if (pixels.length < count * channels) return null;
  if (channels === 4) return pixels.subarray(0, count * 4);
  const rgba = new Uint8Array(count * 4);
  for (let pixel = 0, source = 0; pixel < count; pixel += 1) {
    const target = pixel * 4;
    if (channels === 3) {
      rgba[target] = pixels[source];
      rgba[target + 1] = pixels[source + 1];
      rgba[target + 2] = pixels[source + 2];
      rgba[target + 3] = 255;
      source += 3;
    } else {
      const gray = pixels[source];
      rgba[target] = gray;
      rgba[target + 1] = gray;
      rgba[target + 2] = gray;
      rgba[target + 3] = channels === 2 ? pixels[source + 1] : 255;
      source += channels;
    }
  }
  return rgba;
}

/** What the cache needs from a renderer: RGBA8 textures it can fill and free. */
export type ImageTextureBackend<Texture> = {
  readonly maxDimension: number;
  create(width: number, height: number): Texture;
  /** `rgba` may be a view into WebAssembly memory: copy it before returning. */
  upload(
    texture: Texture,
    rgba: Uint8Array,
    width: number,
    height: number,
  ): void;
  destroy(texture: Texture): void;
};

type CacheEntry<Texture> = {
  readonly texture: Texture;
  readonly width: number;
  readonly height: number;
  generation: number;
  lastUsed: number;
};

/**
 * One texture per Kitty image id, re-uploaded only when the image's generation changes (new
 * pixels or animation frame). Images no longer placed keep their texture for a grace period of
 * updates, then are freed; a new texture that would exceed the byte or count limit first evicts
 * the least recently placed unplaced images, and is skipped if that is not enough. Placed images
 * are never evicted for another one.
 */
export class ImageTextureCache<Texture> {
  private readonly entries = new Map<number, CacheEntry<Texture>>();
  private bytesValue = 0;
  private updates = 0;
  uploads = 0;
  uploadedBytes = 0;
  evictions = 0;

  constructor(
    private readonly backend: ImageTextureBackend<Texture>,
    private readonly limits: ImageTextureLimits = DEFAULT_IMAGE_TEXTURE_LIMITS,
  ) {}

  get bytes(): number {
    return this.bytesValue;
  }

  get size(): number {
    return this.entries.size;
  }

  texture(imageId: number): Texture | undefined {
    return this.entries.get(imageId)?.texture;
  }

  /**
   * Makes the placed images resident, uploading new generations, while the placements' pixel
   * views are still valid. Returns the ids that have a current texture.
   */
  sync(placements: readonly GhosttyImagePlacement[]): ReadonlySet<number> {
    const update = ++this.updates;
    const placed = new Set<number>();
    for (const placement of placements) placed.add(placement.imageId);
    for (const id of placed) {
      const entry = this.entries.get(id);
      if (entry) entry.lastUsed = update;
    }
    for (const [id, entry] of this.entries) {
      if (!placed.has(id) && update - entry.lastUsed > this.limits.graceUpdates)
        this.evict(id, entry);
    }
    const resident = new Set<number>();
    const skipped = new Set<number>();
    for (const placement of placements) {
      const id = placement.imageId;
      if (resident.has(id) || skipped.has(id)) continue;
      if (this.ensure(placement, placed, update)) resident.add(id);
      else skipped.add(id);
    }
    return resident;
  }

  /** Frees every texture. */
  clear(): void {
    for (const [id, entry] of this.entries) this.evict(id, entry);
  }

  /** Drops every texture without freeing it (its context is gone). */
  forget(): void {
    this.entries.clear();
    this.bytesValue = 0;
  }

  private ensure(
    placement: GhosttyImagePlacement,
    placed: ReadonlySet<number>,
    update: number,
  ): boolean {
    const id = placement.imageId;
    let entry = this.entries.get(id);
    if (entry && entry.generation === placement.generation) return true;
    const width = placement.imageWidth;
    const height = placement.imageHeight;
    const valid =
      Number.isInteger(width) &&
      Number.isInteger(height) &&
      width > 0 &&
      height > 0 &&
      width <= this.backend.maxDimension &&
      height <= this.backend.maxDimension;
    const rgba = valid
      ? imageRgba(placement.pixels, placement.channels, width, height)
      : null;
    if (entry && (!rgba || entry.width !== width || entry.height !== height)) {
      // Stale pixels must not stay drawable under the new generation.
      this.evict(id, entry);
      entry = undefined;
    }
    if (!rgba) return false;
    if (!entry) {
      const bytes = width * height * 4;
      if (!this.makeRoom(bytes, placed)) return false;
      entry = {
        texture: this.backend.create(width, height),
        width,
        height,
        generation: Number.NaN,
        lastUsed: update,
      };
      this.entries.set(id, entry);
      this.bytesValue += bytes;
    }
    this.backend.upload(entry.texture, rgba, width, height);
    entry.generation = placement.generation;
    entry.lastUsed = update;
    this.uploads += 1;
    this.uploadedBytes += rgba.byteLength;
    return true;
  }

  private makeRoom(bytes: number, placed: ReadonlySet<number>): boolean {
    if (bytes > this.limits.budgetBytes) return false;
    while (
      this.bytesValue + bytes > this.limits.budgetBytes ||
      this.entries.size >= this.limits.maxTextures
    ) {
      let victim: number | null = null;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [id, entry] of this.entries) {
        if (placed.has(id) || entry.lastUsed >= oldest) continue;
        victim = id;
        oldest = entry.lastUsed;
      }
      const entry = victim === null ? undefined : this.entries.get(victim);
      if (victim === null || !entry) return false;
      this.evict(victim, entry);
    }
    return true;
  }

  private evict(id: number, entry: CacheEntry<Texture>): void {
    this.entries.delete(id);
    this.bytesValue -= entry.width * entry.height * 4;
    this.evictions += 1;
    this.backend.destroy(entry.texture);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
