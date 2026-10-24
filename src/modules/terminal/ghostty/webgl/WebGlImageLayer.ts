/**
 * Kitty images on the WebGL fallback, loaded the first time a pane shows one. Same rules as the
 * WebGPU layer (`gpu/imageLayer.ts`): one RGBA8 texture per image, one instanced quad per
 * placement, premultiplied bilinear filtering by hand from four `texelFetch`es clamped to the
 * source rectangle, premultiplied blending.
 */
import type { GhosttyImagePlacement } from "../GhosttyTerminalModel";
import {
  buildImageDrawList,
  DEFAULT_IMAGE_BACKGROUND_Z_LIMIT,
  EMPTY_IMAGE_DRAW_LIST,
  IMAGE_INSTANCE_BYTES,
  type ImageDrawList,
  type ImageLayer,
  ImageTextureCache,
} from "../gpu/imageLayer";

/**
 * The renderer's program and buffer helpers, handed in rather than imported: a static import
 * from this lazily loaded module would split the renderer out of the fallback chunk.
 */
export type WebGlHelpers = {
  createProgram(
    gl: WebGL2RenderingContext,
    vertexSource: string,
    fragmentSource: string,
  ): WebGLProgram;
  requiredUniform(
    gl: WebGL2RenderingContext,
    program: WebGLProgram,
    name: string,
  ): WebGLUniformLocation;
  requiredBuffer(gl: WebGL2RenderingContext): WebGLBuffer;
  requiredVertexArray(gl: WebGL2RenderingContext): WebGLVertexArrayObject;
};

/** Units 0 and 1 hold the glyph atlases. */
const IMAGE_TEXTURE_UNIT = 2;

export class WebGlImageLayer {
  private readonly program: WebGLProgram;
  private readonly grid: WebGLUniformLocation;
  private readonly vao: WebGLVertexArrayObject;
  private readonly quad: WebGLBuffer;
  private readonly instances: WebGLBuffer;
  private readonly cache: ImageTextureCache<WebGLTexture>;
  private draws: ImageDrawList = EMPTY_IMAGE_DRAW_LIST;
  private scratch: Float32Array = new Float32Array(0);
  private instanceBytes = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    {
      createProgram,
      requiredBuffer,
      requiredUniform,
      requiredVertexArray,
    }: WebGlHelpers,
  ) {
    this.program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    this.grid = requiredUniform(gl, this.program, "u_grid");
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL method, not a React hook.
    gl.useProgram(this.program);
    gl.uniform1i(
      requiredUniform(gl, this.program, "u_image"),
      IMAGE_TEXTURE_UNIT,
    );
    this.quad = requiredBuffer(gl);
    this.instances = requiredBuffer(gl);
    this.vao = requiredVertexArray(gl);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    for (const location of [1, 2]) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribDivisor(location, 1);
    }
    gl.bindVertexArray(null);
    this.cache = new ImageTextureCache<WebGLTexture>({
      maxDimension: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096,
      create: (width, height) => {
        const texture = gl.createTexture();
        if (!texture) throw new Error("Failed to allocate a WebGL image");
        this.bind(texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
        gl.activeTexture(gl.TEXTURE0);
        return texture;
      },
      upload: (texture, rgba, width, height) => {
        this.bind(texture);
        // The glyph atlas leaves row length and skips at 0, but nothing else is assumed.
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          0,
          width,
          height,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          rgba,
        );
        gl.activeTexture(gl.TEXTURE0);
      },
      destroy: (texture) => gl.deleteTexture(texture),
    });
  }

  has(layer: ImageLayer): boolean {
    return this.draws.layers[layer].length > 0;
  }

  get textureBytes(): number {
    return this.cache.bytes;
  }

  get textureCount(): number {
    return this.cache.size;
  }

  get uploads(): number {
    return this.cache.uploads;
  }

  /** Uploads new generations and rebuilds the draws while the pixel views are valid. */
  update(
    placements: readonly GhosttyImagePlacement[],
    backgroundLimit: number | undefined,
    cellWidth: number,
    cellHeight: number,
  ): void {
    this.draws = EMPTY_IMAGE_DRAW_LIST;
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
    if (draws.count > 0) {
      const gl = this.gl;
      const data = draws.instances.subarray(
        0,
        (draws.count * IMAGE_INSTANCE_BYTES) / 4,
      );
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
      if (data.byteLength > this.instanceBytes) {
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
        this.instanceBytes = data.byteLength;
      } else {
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
      }
    }
    this.draws = draws;
  }

  /** Draws one layer over the grid of `gridWidth` x `gridHeight` device pixels. */
  draw(layer: ImageLayer, gridWidth: number, gridHeight: number): void {
    const runs = this.draws.layers[layer];
    if (runs.length === 0) return;
    const gl = this.gl;
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL method, not a React hook.
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(this.grid, gridWidth, gridHeight);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    for (const run of runs) {
      const texture = this.cache.texture(run.imageId);
      if (!texture) continue;
      this.bind(texture);
      const offset = run.first * IMAGE_INSTANCE_BYTES;
      gl.vertexAttribPointer(
        1,
        4,
        gl.FLOAT,
        false,
        IMAGE_INSTANCE_BYTES,
        offset,
      );
      gl.vertexAttribPointer(
        2,
        4,
        gl.FLOAT,
        false,
        IMAGE_INSTANCE_BYTES,
        offset + 16,
      );
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, run.count);
    }
    gl.activeTexture(gl.TEXTURE0);
  }

  /** Frees the textures (the renderer went back to the pool); the program stays. */
  clear(): void {
    this.draws = EMPTY_IMAGE_DRAW_LIST;
    this.cache.clear();
  }

  /** Frees everything; after a lost context the objects are already gone. */
  dispose(lost: boolean): void {
    this.draws = EMPTY_IMAGE_DRAW_LIST;
    if (lost) {
      this.cache.forget();
      return;
    }
    this.cache.clear();
    const gl = this.gl;
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.quad);
    gl.deleteBuffer(this.instances);
    gl.deleteProgram(this.program);
  }

  private bind(texture: WebGLTexture): void {
    this.gl.activeTexture(this.gl.TEXTURE0 + IMAGE_TEXTURE_UNIT);
    this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
  }
}

const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 a_unitquad;
layout(location = 1) in vec4 a_dest;
layout(location = 2) in vec4 a_source;
uniform vec2 u_grid;
out highp vec2 v_texel;
flat out highp vec4 v_source;
void main() {
  vec2 unit = (a_dest.xy + a_unitquad * a_dest.zw) / u_grid;
  gl_Position = vec4(unit.x * 2.0 - 1.0, 1.0 - unit.y * 2.0, 0.0, 1.0);
  v_texel = a_source.xy + a_unitquad * a_source.zw;
  v_source = a_source;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_image;
in vec2 v_texel;
flat in vec4 v_source;
out vec4 outColor;
vec4 premultiplied(ivec2 coord, ivec2 low, ivec2 high) {
  vec4 texel = texelFetch(u_image, clamp(coord, low, high), 0);
  return vec4(texel.rgb * texel.a, texel.a);
}
void main() {
  vec2 point = v_texel - 0.5;
  vec2 base = floor(point);
  vec2 weight = point - base;
  ivec2 corner = ivec2(base);
  ivec2 low = ivec2(v_source.xy);
  ivec2 high = low + ivec2(v_source.zw) - 1;
  vec4 top = mix(premultiplied(corner, low, high), premultiplied(corner + ivec2(1, 0), low, high), weight.x);
  vec4 bottom = mix(premultiplied(corner + ivec2(0, 1), low, high), premultiplied(corner + ivec2(1, 1), low, high), weight.x);
  outColor = mix(top, bottom, weight.y);
}`;
