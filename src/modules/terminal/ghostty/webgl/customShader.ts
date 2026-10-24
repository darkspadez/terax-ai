/**
 * Ghostty-compatible custom shaders (`custom-shader`): a Shadertoy-style
 * `mainImage(out vec4 fragColor, in vec2 fragCoord)` run over the finished
 * terminal frame, which it reads as `iChannel0`. Ghostty's uniforms are
 * declared with the same names and meanings (its `shadertoy_prefix.glsl`), so
 * shaders written for Ghostty (CRT, bloom, cursor trails) run unchanged. The
 * dialect is WebGL2's GLSL ES 3.00, which is what Shadertoy itself runs.
 *
 * Coordinates follow GL: `fragCoord` and the cursor rectangles have their
 * origin at the bottom left, in device pixels. `iCurrentCursor` is the
 * cursor's left edge, top edge, width and height, as in Ghostty's OpenGL
 * renderer.
 */

export const CURSOR_STYLE = {
  block: 0,
  blockHollow: 1,
  bar: 2,
  underline: 3,
  lock: 4,
} as const;

/** Longest shader source accepted (Ghostty's are a few KiB). */
export const MAX_CUSTOM_SHADER_BYTES = 256 * 1024;

const PREFIX = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform vec3 iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform float iFrameRate;
uniform int iFrame;
uniform float iChannelTime[4];
uniform vec3 iChannelResolution[4];
uniform vec4 iMouse;
uniform vec4 iDate;
uniform float iSampleRate;
uniform vec4 iCurrentCursor;
uniform vec4 iPreviousCursor;
uniform vec4 iCurrentCursorColor;
uniform vec4 iPreviousCursorColor;
uniform int iCurrentCursorStyle;
uniform int iPreviousCursorStyle;
uniform int iCursorVisible;
uniform float iTimeCursorChange;
uniform float iTimeFocus;
uniform int iFocus;
uniform vec3 iPalette[256];
uniform vec3 iBackgroundColor;
uniform vec3 iForegroundColor;
uniform vec3 iCursorColor;
uniform vec3 iCursorText;
uniform vec3 iSelectionForegroundColor;
uniform vec3 iSelectionBackgroundColor;
#define CURSORSTYLE_BLOCK 0
#define CURSORSTYLE_BLOCK_HOLLOW 1
#define CURSORSTYLE_BAR 2
#define CURSORSTYLE_UNDERLINE 3
#define CURSORSTYLE_LOCK 4
uniform sampler2D iChannel0;
out vec4 _fragColor;
#define texture2D texture
void mainImage(out vec4 fragColor, in vec2 fragCoord);
#line 1
`;

const SUFFIX = `
void main() { mainImage(_fragColor, gl_FragCoord.xy); }
`;

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/** A full-screen triangle; the fragment stage does all the work. */
export const CUSTOM_SHADER_VERTEX = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * The fragment shader for a user's source. A `#version` line of its own is
 * dropped (the prefix declares the dialect); `#line 1` keeps compiler line
 * numbers those of the user's file.
 */
export function customShaderFragment(source: string): string {
  const unmarked = source.startsWith(BYTE_ORDER_MARK)
    ? source.slice(1)
    : source;
  const body = unmarked.replace(/^\s*#version[^\n]*\n?/, "");
  return `${PREFIX}${body}${SUFFIX}`;
}

/**
 * A compiler log with the WebGL prefix ("ERROR: 0:12: ...") turned into
 * "line 12: ..." lines, empty lines dropped. Line numbers already count from
 * the user's first line (`#line 1`).
 */
export function customShaderErrors(log: string): string {
  return log
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "\u0000")
    .map((line) =>
      line.replace(/^(?:ERROR|WARNING):\s*\d+:(\d+):\s*/, "line $1: "),
    )
    .join("\n");
}

export type ShaderCursorState = {
  /** Left, top, width, height in GL device pixels (origin bottom left). */
  readonly rect: readonly [number, number, number, number];
  /** RGBA, 0 to 1. */
  readonly color: readonly [number, number, number, number];
  readonly style: number;
  readonly visible: boolean;
};

/**
 * Ghostty's cursor uniforms: when the cursor's rectangle or colour changes,
 * the old one becomes `iPreviousCursor*` and `iTimeCursorChange` records the
 * shader time of the change (cursor-trail shaders animate from it). The style
 * moves to `iPreviousCursorStyle` on every update, as in Ghostty.
 */
export class ShaderCursorTracker {
  current: ShaderCursorState = {
    rect: [0, 0, 0, 0],
    color: [0, 0, 0, 0],
    style: CURSOR_STYLE.block,
    visible: false,
  };
  previous: ShaderCursorState = this.current;
  previousStyle: number = CURSOR_STYLE.block;
  changedAt = 0;

  update(next: ShaderCursorState, time: number): void {
    this.previousStyle = this.current.style;
    const moved =
      next.rect.some((value, index) => value !== this.current.rect[index]) ||
      next.color.some((value, index) => value !== this.current.color[index]);
    if (moved) {
      this.previous = this.current;
      this.changedAt = time;
    }
    this.current = next;
  }
}

/** Seconds since start, the delta since the last frame, and a frame counter. */
export class ShaderClock {
  private readonly start: number;
  private last: number;
  frame = 0;
  time = 0;
  delta = 0;

  constructor(now: number) {
    this.start = now;
    this.last = now;
  }

  tick(now: number): void {
    this.time = Math.max(0, (now - this.start) / 1000);
    this.delta = this.frame === 0 ? 0 : Math.max(0, (now - this.last) / 1000);
    this.last = now;
    this.frame += 1;
  }
}

/** Shadertoy's iDate: year, month (0-based), day, seconds since midnight. */
export function shaderDate(date: Date): [number, number, number, number] {
  const midnight = new Date(date);
  midnight.setHours(0, 0, 0, 0);
  return [
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    (date.getTime() - midnight.getTime()) / 1000,
  ];
}

type Rgb = readonly [number, number, number];

/** The colours a shader can read (Ghostty's iBackgroundColor and friends). */
export type ShaderTheme = {
  readonly background: Rgb;
  readonly foreground: Rgb;
  readonly cursor: Rgb;
  readonly selection: Rgb;
  readonly palette: readonly Rgb[];
};

/** Everything one custom shader frame reads besides the terminal image. */
export type CustomShaderFrame = {
  readonly clock: ShaderClock;
  readonly cursor: ShaderCursorTracker;
  readonly theme: ShaderTheme;
  readonly focused: boolean;
  /** Shader time at which the window last gained focus. */
  readonly focusTime: number;
  readonly date: readonly [number, number, number, number];
};

export type TerminalCursorShape = "block" | "bar" | "underline";

/**
 * The cursor's rectangle as a shader sees it: left, top, width, height in
 * device pixels with the origin at the bottom left (`gl_FragCoord`), shaped
 * like the cursor the renderer draws.
 */
export function shaderCursorRect(
  column: number,
  row: number,
  shape: TerminalCursorShape,
  cellWidth: number,
  cellHeight: number,
  canvasHeight: number,
): [number, number, number, number] {
  const left = column * cellWidth;
  const top = row * cellHeight;
  if (shape === "bar")
    return [
      left,
      canvasHeight - top,
      Math.max(1, cellWidth * 0.12),
      cellHeight,
    ];
  if (shape === "underline") {
    const height = Math.max(1, cellHeight * 0.12);
    return [
      left,
      canvasHeight - (top + cellHeight - height),
      cellWidth,
      height,
    ];
  }
  return [left, canvasHeight - top, cellWidth, cellHeight];
}

function compileStage(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader | string {
  const shader = gl.createShader(type);
  if (!shader) return "could not create a shader";
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  const log = customShaderErrors(gl.getShaderInfoLog(shader) ?? "");
  gl.deleteShader(shader);
  return log || "the shader does not compile";
}

/** Compiles and links a user's shader, or returns the compiler's complaint. */
export function compileCustomShader(
  gl: WebGL2RenderingContext,
  source: string,
): { readonly program: WebGLProgram } | { readonly error: string } {
  if (source.length > MAX_CUSTOM_SHADER_BYTES)
    return { error: "the shader is larger than 256 KiB" };
  const vertex = compileStage(gl, gl.VERTEX_SHADER, CUSTOM_SHADER_VERTEX);
  if (typeof vertex === "string") return { error: vertex };
  const fragment = compileStage(
    gl,
    gl.FRAGMENT_SHADER,
    customShaderFragment(source),
  );
  if (typeof fragment === "string") {
    gl.deleteShader(vertex);
    return { error: fragment };
  }
  const program = gl.createProgram();
  if (!program) return { error: "could not create a program" };
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (gl.getProgramParameter(program, gl.LINK_STATUS)) return { program };
  const log = customShaderErrors(gl.getProgramInfoLog(program) ?? "");
  gl.deleteProgram(program);
  return { error: log || "the shader does not link" };
}

/**
 * Compiles `source` in a throwaway WebGL2 context: the error to show, or null
 * when it compiles (or when this webview has no WebGL2 to ask).
 */
export function validateCustomShader(source: string): string | null {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2");
  if (!gl) return null;
  try {
    const result = compileCustomShader(gl, source);
    if ("error" in result) return result.error;
    gl.deleteProgram(result.program);
    return null;
  } finally {
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/**
 * The custom shader pass of one WebGL renderer: the terminal frame is drawn
 * into a texture of the canvas's size (`begin`), then the shader draws the
 * canvas from it (`finish`).
 */
export class CustomShaderPass {
  private texture: WebGLTexture | null = null;
  private framebuffer: WebGLFramebuffer | null = null;
  private width = 0;
  private height = 0;
  private readonly locations = new Map<string, WebGLUniformLocation | null>();
  private readonly palette = new Float32Array(256 * 3);

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly program: WebGLProgram,
  ) {}

  /** Directs the following drawing into the pass's texture. */
  begin(width: number, height: number): void {
    const gl = this.gl;
    if (!this.framebuffer || width !== this.width || height !== this.height) {
      this.releaseTarget();
      this.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        this.texture,
        0,
      );
      this.width = width;
      this.height = height;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
  }

  /** Runs the shader over the texture into the canvas. */
  finish(frame: CustomShaderFrame): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.BLEND);
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL method, not a React hook.
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    this.setUniforms(frame);
    gl.bindVertexArray(null);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    this.releaseTarget();
    this.gl.deleteProgram(this.program);
  }

  private releaseTarget(): void {
    if (this.framebuffer) this.gl.deleteFramebuffer(this.framebuffer);
    if (this.texture) this.gl.deleteTexture(this.texture);
    this.framebuffer = null;
    this.texture = null;
  }

  private location(name: string): WebGLUniformLocation | null {
    let location = this.locations.get(name);
    if (location === undefined) {
      location = this.gl.getUniformLocation(this.program, name);
      this.locations.set(name, location);
    }
    return location;
  }

  private setUniforms(frame: CustomShaderFrame): void {
    const gl = this.gl;
    const { clock, cursor, theme } = frame;
    const f1 = (name: string, x: number) => {
      const at = this.location(name);
      if (at) gl.uniform1f(at, x);
    };
    const i1 = (name: string, x: number) => {
      const at = this.location(name);
      if (at) gl.uniform1i(at, x);
    };
    const f3 = (name: string, rgb: Rgb, scale = 255) => {
      const at = this.location(name);
      if (at) gl.uniform3f(at, rgb[0] / scale, rgb[1] / scale, rgb[2] / scale);
    };
    const f4 = (name: string, value: readonly number[]) => {
      const at = this.location(name);
      if (at) gl.uniform4f(at, value[0], value[1], value[2], value[3]);
    };
    const resolution = this.location("iResolution");
    if (resolution) gl.uniform3f(resolution, this.width, this.height, 1);
    const channelResolution = this.location("iChannelResolution[0]");
    if (channelResolution)
      gl.uniform3f(channelResolution, this.width, this.height, 1);
    i1("iChannel0", 0);
    f1("iTime", clock.time);
    f1("iTimeDelta", clock.delta);
    f1("iFrameRate", clock.delta > 0 ? 1 / clock.delta : 60);
    i1("iFrame", clock.frame);
    f4("iMouse", [0, 0, 0, 0]);
    f4("iDate", frame.date);
    f4("iCurrentCursor", cursor.current.rect);
    f4("iPreviousCursor", cursor.previous.rect);
    f4("iCurrentCursorColor", cursor.current.color);
    f4("iPreviousCursorColor", cursor.previous.color);
    i1("iCurrentCursorStyle", cursor.current.style);
    i1("iPreviousCursorStyle", cursor.previousStyle);
    i1("iCursorVisible", cursor.current.visible ? 1 : 0);
    f1("iTimeCursorChange", cursor.changedAt);
    i1("iFocus", frame.focused ? 1 : 0);
    f1("iTimeFocus", frame.focusTime);
    f3("iBackgroundColor", theme.background);
    f3("iForegroundColor", theme.foreground);
    f3("iCursorColor", theme.cursor);
    f3("iCursorText", theme.background);
    f3("iSelectionBackgroundColor", theme.selection);
    f3("iSelectionForegroundColor", theme.foreground);
    const palette = this.location("iPalette");
    if (palette) {
      const values = this.palette;
      values.fill(0);
      theme.palette.slice(0, 256).forEach((rgb, index) => {
        values[index * 3] = rgb[0] / 255;
        values[index * 3 + 1] = rgb[1] / 255;
        values[index * 3 + 2] = rgb[2] / 255;
      });
      gl.uniform3fv(palette, values);
    }
  }
}

/** What the runner reads of the terminal theme (`TerminalGpuTheme`). */
export type ShaderThemeSource = {
  readonly background: Rgb;
  readonly foreground: Rgb;
  readonly cursor: Rgb;
  readonly selection: { readonly color: Rgb };
  readonly palette: readonly Rgb[];
};

/** The cursor as the renderer knows it (`TerminalCursor`). */
export type ShaderCursorSource = {
  readonly x: number;
  readonly y: number;
  readonly style: string;
  readonly visible: boolean;
};

/**
 * One renderer's custom shader: the compiled pass with its clock, focus and
 * cursor state. Lives in this lazily loaded module so the WebGL renderer only
 * carries three calls for it.
 */
export class CustomShaderRunner {
  focused = false;
  private focusTime = 0;
  private readonly clock = new ShaderClock(performance.now());
  private readonly cursor = new ShaderCursorTracker();

  private constructor(private readonly pass: CustomShaderPass) {}

  /** The runner, or the compiler's complaint. */
  static create(
    gl: WebGL2RenderingContext,
    source: string,
  ): CustomShaderRunner | string {
    const compiled = compileCustomShader(gl, source);
    if ("error" in compiled) return compiled.error;
    return new CustomShaderRunner(new CustomShaderPass(gl, compiled.program));
  }

  /** Advances the clock and records focus and the cursor for this frame. */
  update(
    cursor: ShaderCursorSource,
    cursorShown: boolean,
    cellWidth: number,
    cellHeight: number,
    canvasHeight: number,
    cursorColor: Rgb,
  ): void {
    this.clock.tick(performance.now());
    const focused = typeof document !== "undefined" && document.hasFocus();
    if (focused && !this.focused) this.focusTime = this.clock.time;
    this.focused = focused;
    const shape: TerminalCursorShape =
      cursor.style === "bar" || cursor.style === "underline"
        ? cursor.style
        : "block";
    this.cursor.update(
      {
        rect: shaderCursorRect(
          cursor.x,
          cursor.y,
          shape,
          cellWidth,
          cellHeight,
          canvasHeight,
        ),
        color: [
          cursorColor[0] / 255,
          cursorColor[1] / 255,
          cursorColor[2] / 255,
          1,
        ],
        style:
          shape === "bar"
            ? CURSOR_STYLE.bar
            : shape === "underline"
              ? CURSOR_STYLE.underline
              : CURSOR_STYLE.block,
        visible: cursorShown && cursor.visible,
      },
      this.clock.time,
    );
  }

  begin(width: number, height: number): void {
    this.pass.begin(width, height);
  }

  finish(theme: ShaderThemeSource): void {
    this.pass.finish({
      clock: this.clock,
      cursor: this.cursor,
      theme: {
        background: theme.background,
        foreground: theme.foreground,
        cursor: theme.cursor,
        selection: theme.selection.color,
        palette: theme.palette,
      },
      focused: this.focused,
      focusTime: this.focusTime,
      date: shaderDate(new Date()),
    });
  }

  dispose(): void {
    this.pass.dispose();
  }
}
