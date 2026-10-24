/**
 * Kitty images on the WebGPU renderer, loaded the first time a pane shows one. Each image is one
 * rgba8unorm texture (straight alpha, as Kitty sends it); a placement is one instanced quad. The
 * fragment shader filters bilinearly by hand from four `textureLoad`s, premultiplying each texel
 * first, so transparent texels never bleed their colour into an edge, and clamps to the source
 * rectangle, so a cropped placement never shows its neighbours. Blending is premultiplied.
 */
import type { GhosttyImagePlacement } from "../GhosttyTerminalModel";
import {
  buildImageDrawList,
  DEFAULT_IMAGE_BACKGROUND_Z_LIMIT,
  EMPTY_IMAGE_DRAW_LIST,
  IMAGE_INSTANCE_BYTES,
  IMAGE_INSTANCE_FLOATS,
  IMAGE_LAYER_ABOVE_TEXT,
  IMAGE_LAYER_BELOW_TEXT,
  IMAGE_LAYER_UNDER,
  type ImageDrawList,
  type ImageDrawRun,
  ImageTextureCache,
} from "./imageLayer";

const MIN_INSTANCE_CAPACITY = 16;

/**
 * The eager shader sources this module builds on, handed in rather than imported: a static
 * import from this lazily loaded module would split `shaders.ts` into a chunk of its own.
 */
export type WebGpuImageShaderSources = {
  /** `shaders.ts` `SCREEN_STRUCT`: the uniform both the cell passes and the images read. */
  readonly screenStruct: string;
  /** `shaders.ts` `BACKGROUND_SHADER`, whose `shade` modes draw the cells over images. */
  readonly background: string;
};

const imageShader = (screenStruct: string) => /* wgsl */ `
${screenStruct}
@group(0) @binding(0) var<uniform> screen: Screen;
@group(1) @binding(0) var image: texture_2d<f32>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) texel: vec2f,
  @interpolate(flat) @location(1) source: vec4f,
}

@vertex
fn vertex_main(
  @builtin(vertex_index) vertex_index: u32,
  @location(0) dest: vec4f,
  @location(1) source: vec4f,
) -> VertexOutput {
  let corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  );
  let corner = corners[vertex_index];
  let pixel = dest.xy + corner * dest.zw - vec2f(0.0, f32(screen.shift_y)) - vec2f(screen.clip);
  var output: VertexOutput;
  output.position = vec4f(
    pixel.x / screen.viewport_size.x * 2.0 - 1.0,
    1.0 - pixel.y / screen.viewport_size.y * 2.0,
    0.0,
    1.0,
  );
  output.texel = source.xy + corner * source.zw;
  output.source = source;
  return output;
}

fn premultiplied(coord: vec2i, low: vec2i, high: vec2i) -> vec4f {
  let texel = textureLoad(image, clamp(coord, low, high), 0);
  return vec4f(texel.rgb * texel.a, texel.a);
}

@fragment
fn fragment_main(
  @location(0) texel: vec2f,
  @interpolate(flat) @location(1) source: vec4f,
) -> @location(0) vec4f {
  let point = texel - 0.5;
  let base = floor(point);
  let weight = point - base;
  let corner = vec2i(base);
  let low = vec2i(source.xy);
  let high = low + vec2i(source.zw) - 1;
  let top = mix(
    premultiplied(corner, low, high),
    premultiplied(corner + vec2i(1, 0), low, high),
    weight.x,
  );
  let bottom = mix(
    premultiplied(corner + vec2i(0, 1), low, high),
    premultiplied(corner + vec2i(1, 1), low, high),
    weight.x,
  );
  return mix(top, bottom, weight.y);
}
`;

const layeredCellsShader = (background: string) => /* wgsl */ `
${background}
@fragment
fn fragment_over_images(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let color = shade(position, 1u);
  if (color.a == 0.0) { discard; }
  return color;
}

@fragment
fn fragment_decorations(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let color = shade(position, 2u);
  if (color.a == 0.0) { discard; }
  return color;
}
`;

type ImagePipelines = {
  readonly image: GPURenderPipeline;
  /** The cell pass over images under the backgrounds: default backgrounds left out. */
  readonly cellsOverImages: GPURenderPipeline;
  /** Cursor and decorations only, over images between the backgrounds and the text. */
  readonly decorations: GPURenderPipeline;
  readonly screenLayout: GPUBindGroupLayout;
  readonly textureLayout: GPUBindGroupLayout;
};

/** What a pane needs to draw images on one device; the runtime keeps one per device. */
export type WebGpuImageSupport = {
  createLayer(uniform: GPUBuffer): WebGpuImageLayer;
};

export async function createWebGpuImageSupport(
  device: GPUDevice,
  format: GPUTextureFormat,
  cellLayout: GPUBindGroupLayout,
  shaders: WebGpuImageShaderSources,
): Promise<WebGpuImageSupport> {
  const screenLayout = device.createBindGroupLayout({
    label: "Oarlock terminal image screen",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
    ],
  });
  const textureLayout = device.createBindGroupLayout({
    label: "Oarlock terminal image texture",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "unfilterable-float" },
      },
    ],
  });
  const imageModule = device.createShaderModule({
    label: "Oarlock terminal image shader",
    code: imageShader(shaders.screenStruct),
  });
  const cellsModule = device.createShaderModule({
    label: "Oarlock terminal layered cell shader",
    code: layeredCellsShader(shaders.background),
  });
  const cellsLayout = device.createPipelineLayout({
    bindGroupLayouts: [cellLayout],
  });
  const cellsPipeline = (entryPoint: string, label: string) =>
    device.createRenderPipelineAsync({
      label,
      layout: cellsLayout,
      vertex: { module: cellsModule, entryPoint: "vertex_main" },
      fragment: { module: cellsModule, entryPoint, targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
  const premultiplied: GPUBlendComponent = {
    srcFactor: "one",
    dstFactor: "one-minus-src-alpha",
  };
  const [image, cellsOverImages, decorations] = await Promise.all([
    device.createRenderPipelineAsync({
      label: "Oarlock terminal image pipeline",
      layout: device.createPipelineLayout({
        bindGroupLayouts: [screenLayout, textureLayout],
      }),
      vertex: {
        module: imageModule,
        entryPoint: "vertex_main",
        buffers: [
          {
            arrayStride: IMAGE_INSTANCE_BYTES,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x4" },
              { shaderLocation: 1, offset: 16, format: "float32x4" },
            ],
          },
        ],
      },
      fragment: {
        module: imageModule,
        entryPoint: "fragment_main",
        targets: [
          { format, blend: { color: premultiplied, alpha: premultiplied } },
        ],
      },
      primitive: { topology: "triangle-list" },
    }),
    cellsPipeline(
      "fragment_over_images",
      "Oarlock terminal cells over images pipeline",
    ),
    cellsPipeline(
      "fragment_decorations",
      "Oarlock terminal decorations over images pipeline",
    ),
  ]);
  const pipelines: ImagePipelines = {
    image,
    cellsOverImages,
    decorations,
    screenLayout,
    textureLayout,
  };
  return {
    createLayer: (uniform) => new WebGpuImageLayer(device, pipelines, uniform),
  };
}

type ImageTexture = {
  readonly texture: GPUTexture;
  readonly bindGroup: GPUBindGroup;
};

export type WebGpuImageLayerStats = {
  readonly textures: number;
  readonly textureBytes: number;
  readonly bufferBytes: number;
  readonly placements: number;
  readonly uploads: number;
  readonly uploadedBytes: number;
};

/** One pane's image textures, instances and draws. */
export class WebGpuImageLayer {
  private readonly cache: ImageTextureCache<ImageTexture>;
  private readonly screenGroup: GPUBindGroup;
  private draws: ImageDrawList = EMPTY_IMAGE_DRAW_LIST;
  private scratch: Float32Array = new Float32Array(0);
  private instanceBuffer: GPUBuffer | null = null;
  private released = false;

  constructor(
    private readonly device: GPUDevice,
    private readonly pipelines: ImagePipelines,
    uniform: GPUBuffer,
  ) {
    this.screenGroup = device.createBindGroup({
      label: "Oarlock terminal image screen",
      layout: pipelines.screenLayout,
      entries: [{ binding: 0, resource: { buffer: uniform } }],
    });
    this.cache = new ImageTextureCache({
      maxDimension: device.limits?.maxTextureDimension2D ?? 8192,
      create: (width, height) => {
        const texture = device.createTexture({
          label: "Oarlock terminal image",
          size: [width, height],
          format: "rgba8unorm",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        return {
          texture,
          bindGroup: device.createBindGroup({
            label: "Oarlock terminal image texture",
            layout: pipelines.textureLayout,
            entries: [{ binding: 0, resource: texture.createView() }],
          }),
        };
      },
      upload: ({ texture }, rgba, width, height) =>
        device.queue.writeTexture(
          { texture },
          rgba,
          { bytesPerRow: width * 4, rowsPerImage: height },
          { width, height },
        ),
      destroy: ({ texture }) => texture.destroy(),
    });
  }

  /** Something is placed: the pane draws the layered passes. */
  get hasDraws(): boolean {
    return this.draws.count > 0;
  }

  /**
   * Uploads new image generations and rebuilds the draw list from the frame's placements, while
   * their pixel views are valid. True when the pane must redraw for it.
   */
  update(
    placements: readonly GhosttyImagePlacement[],
    backgroundLimit: number | undefined,
    cellWidth: number,
    cellHeight: number,
  ): boolean {
    if (this.released) return false;
    const previous = this.draws;
    // Nothing may name a texture the cache is about to free, even if the update fails midway.
    this.draws = EMPTY_IMAGE_DRAW_LIST;
    const uploadsBefore = this.cache.uploads;
    const resident = this.cache.sync(placements);
    const draws = buildImageDrawList(
      placements,
      (id) => resident.has(id),
      backgroundLimit ?? DEFAULT_IMAGE_BACKGROUND_Z_LIMIT,
      cellWidth,
      cellHeight,
      this.scratch,
    );
    this.scratch = draws.instances;
    if (draws.count > 0) this.uploadInstances(draws);
    this.draws = draws;
    // Placement changes come with full damage anyway; this matters for the first update.
    return (
      this.cache.uploads !== uploadsBefore ||
      previous.count > 0 ||
      draws.count > 0
    );
  }

  /**
   * Images under the cell backgrounds and between backgrounds and text, each followed by the
   * cell pass that goes over it. Leaves `cells` bound at group 0 for the glyph pass.
   */
  encodeBelowText(pass: GPURenderPassEncoder, cells: GPUBindGroup): void {
    const layers = this.draws.layers;
    if (layers[IMAGE_LAYER_UNDER].length > 0) {
      this.encodeRuns(pass, layers[IMAGE_LAYER_UNDER]);
      pass.setBindGroup(0, cells);
      pass.setPipeline(this.pipelines.cellsOverImages);
      pass.draw(3);
    }
    if (layers[IMAGE_LAYER_BELOW_TEXT].length > 0) {
      this.encodeRuns(pass, layers[IMAGE_LAYER_BELOW_TEXT]);
      pass.setBindGroup(0, cells);
      pass.setPipeline(this.pipelines.decorations);
      pass.draw(3);
    }
  }

  encodeAboveText(pass: GPURenderPassEncoder): void {
    this.encodeRuns(pass, this.draws.layers[IMAGE_LAYER_ABOVE_TEXT]);
  }

  stats(): WebGpuImageLayerStats {
    return {
      textures: this.cache.size,
      textureBytes: this.cache.bytes,
      bufferBytes: this.instanceBuffer?.size ?? 0,
      placements: this.draws.count,
      uploads: this.cache.uploads,
      uploadedBytes: this.cache.uploadedBytes,
    };
  }

  /** Frees every texture and buffer; the layer draws nothing afterwards. */
  release(): void {
    if (this.released) return;
    this.released = true;
    this.draws = EMPTY_IMAGE_DRAW_LIST;
    this.cache.clear();
    this.instanceBuffer?.destroy();
    this.instanceBuffer = null;
    this.scratch = new Float32Array(0);
  }

  private encodeRuns(
    pass: GPURenderPassEncoder,
    runs: readonly ImageDrawRun[],
  ): void {
    if (runs.length === 0 || !this.instanceBuffer) return;
    pass.setPipeline(this.pipelines.image);
    pass.setBindGroup(0, this.screenGroup);
    pass.setVertexBuffer(0, this.instanceBuffer);
    for (const run of runs) {
      const texture = this.cache.texture(run.imageId);
      if (!texture) continue;
      pass.setBindGroup(1, texture.bindGroup);
      pass.draw(6, run.count, 0, run.first);
    }
  }

  private uploadInstances(draws: ImageDrawList): void {
    const bytes = draws.count * IMAGE_INSTANCE_BYTES;
    if (!this.instanceBuffer || this.instanceBuffer.size < bytes) {
      this.instanceBuffer?.destroy();
      let capacity = MIN_INSTANCE_CAPACITY;
      while (capacity < draws.count) capacity *= 2;
      this.instanceBuffer = this.device.createBuffer({
        label: "Oarlock terminal image placements",
        size: capacity * IMAGE_INSTANCE_BYTES,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    this.device.queue.writeBuffer(
      this.instanceBuffer,
      0,
      draws.instances,
      0,
      draws.count * IMAGE_INSTANCE_FLOATS,
    );
  }
}
