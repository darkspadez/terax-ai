import type {
  PackedTerminalViewport,
  TerminalCursor,
  TerminalDamage,
  TerminalModelDiagnostics,
  TerminalModes,
  TerminalRowRange,
} from "@/modules/terminal/backend/contracts";
import {
  detectTerminalLinks,
  type TerminalTextLink,
} from "@/modules/terminal/ghostty/core/terminalLinks";
import type {
  TeraxGhostty,
  TeraxGhosttyGpuRenderState,
  TeraxGhosttyRenderBase,
  TeraxGhosttyRenderState,
  TeraxGhosttyTerminal,
} from "@terax/ghostty-core/adapted";
import type {
  GhosttyTerminalConfig,
  GhosttyTerminalEvent,
  KeyEvent,
} from "@terax/ghostty-core/protocol";
import { CellFlags } from "@terax/ghostty-core/protocol";
import { PromptPresentationGate } from "./core/PromptPresentationGate";
import {
  CELL_STRIDE,
  type Rgb,
  type TerminalCellReader,
} from "./core/packedCells";
import { ResizePromptHold } from "./core/ResizePromptHold";
import { SynchronizedOutputPresentationGate } from "./core/SynchronizedOutputPresentationGate";
import {
  MIN_SCROLLBACK_BYTES,
  normalizeScrollbackLines,
  requestedScrollbackBytes,
} from "./core/scrollbackBudget";
import { clearTerminalBufferSequence } from "./core/terminalActions";
import type {
  GhosttyGpuFrame,
  GhosttyGpuFrameOptions,
  GhosttyGpuGlyph,
  GhosttyImagePlacement,
  GhosttyMouseEvent,
  GhosttyRenderFormat,
  GhosttySearchStatus,
  GhosttySearchViewportSpan,
  GhosttyTerminalModelApi,
  GhosttyTerminalModelOptions,
  GhosttyTextFormat,
  GhosttyViewportLink,
  TerminalBufferPoint,
  TerminalBufferSelection,
} from "./GhosttyTerminalModel";

const MAX_DIMENSION = 4_096;
const MAX_CELLS = 1_048_576;
const NO_DAMAGE: TerminalDamage = { kind: "none" };
const FULL_DAMAGE: TerminalDamage = { kind: "full" };
const NO_GLYPHS: readonly GhosttyGpuGlyph[] = Object.freeze([]);
const NO_RANGES: readonly TerminalRowRange[] = Object.freeze([]);
const NO_PLACEMENTS: readonly GhosttyImagePlacement[] = Object.freeze([]);
/** A link is followed across at most this many rows from the hovered cell. */
const MAX_LINK_ROWS = 8;

/** Inclusive viewport cell range [start, end] as per-row spans. */
function viewportSpans(
  start: number,
  end: number,
  cols: number,
): GhosttyViewportLink["spans"] {
  const spans: { row: number; startColumn: number; endColumn: number }[] = [];
  for (
    let row = Math.floor(start / cols);
    row <= Math.floor(end / cols);
    row++
  ) {
    spans.push({
      row,
      startColumn: row === Math.floor(start / cols) ? start % cols : 0,
      endColumn: row === Math.floor(end / cols) ? end % cols : cols - 1,
    });
  }
  return spans;
}

type BufferLine = {
  readonly cells: string[];
  readonly wrapped: boolean;
};

type ScrollPosition = {
  readonly offset: number;
  readonly history: number;
};

const DEFAULT_MODES: TerminalModes = Object.freeze({
  alternateScreen: false,
  bracketedPaste: false,
  focusReporting: false,
  mouseTracking: false,
  synchronizedOutput: false,
});

type AdaptedGhosttyTerminalModelOptions = GhosttyTerminalModelOptions & {
  /** Initial scrollback byte limit when the global budget grants less than requested. */
  readonly scrollbackByteLimit?: number;
};

/**
 * Terax-owned model adapter for the current Ghostty terminal and render-state
 * implementation. The terminal model is independent from GPU surfaces so it
 * survives RendererPool lease release and keeps parsing hidden-tab output.
 *
 * Each model owns a private WebAssembly instance. `dispose()` drops it, so the
 * linear memory (scrollback included) is returned to the operating system once
 * the caller also drops its reference to the model.
 */
export class AdaptedGhosttyTerminalModel implements GhosttyTerminalModelApi {
  readonly backend: GhosttyTerminalModelOptions["backend"];
  /** Scrollback bytes the configuration asks for, before the global budget. */
  readonly requestedScrollbackBytes: number;

  private readonly terminal: TeraxGhosttyTerminal;
  private plainLinks: {
    revision: number;
    origin: number;
    cols: number;
    startRow: number;
    endRow: number;
    offsets: number[];
    links: TerminalTextLink[];
  } | null = null;
  private blockMatch: { line: number; col: number; len: number } | null = null;
  private readonly directCellReader = new GhosttyRenderCellView();
  private readonly damageListeners = new Set<() => void>();
  private replySink: ((bytes: Uint8Array) => void) | null;
  private eventSink: ((event: GhosttyTerminalEvent) => void) | null;
  private onDispose: (() => void) | null;
  private pendingDamage: TerminalDamage = FULL_DAMAGE;
  private renderState: TeraxGhosttyRenderState | null = null;
  private gpuState: TeraxGhosttyGpuRenderState | null = null;
  private renderFormatValue: GhosttyRenderFormat = "soa";
  /** Record changes (GPU format) accumulated across updates since the last frame. */
  private pendingCellDamage: TerminalDamage = FULL_DAMAGE;
  private renderStateCurrent = false;
  private packedViewport = new Uint8Array(0);
  private packedRenderVersion = -1;
  private renderVersion = 0;
  private contentRevision = 0;
  private writeCount = 0;
  private renderStateUpdateCount = 0;
  private presentationResourcesReleased = false;
  /** The last render update moved, changed or removed image placements. */
  private imagesChanged = false;
  /** The core's cell size: set with the pixel size, kept across resizes. */
  private cellPixels = { width: 1, height: 1 };
  private damageNotificationPending = false;
  private damageNeedsResolution = false;
  private modeBitsValue = 0;
  private modesValue = DEFAULT_MODES;
  private scrollPositionValue: ScrollPosition = { offset: 0, history: 0 };
  private scrollPositionCurrent = false;
  private readonly promptPresentation: PromptPresentationGate;
  private readonly resizePromptHold: ResizePromptHold;
  private readonly synchronizedOutputPresentation: SynchronizedOutputPresentationGate;
  private colsValue: number;
  private rowsValue: number;
  private scrollbackLines: number;
  private scrollbackBytesLimit: number;
  private ligaturesValue = true;
  private disposed = false;

  constructor(
    ghostty: TeraxGhostty,
    options: AdaptedGhosttyTerminalModelOptions,
  ) {
    validateDimensions(options.cols, options.rows);
    this.backend = options.backend;
    this.colsValue = options.cols;
    this.rowsValue = options.rows;
    this.replySink = options.onReply ?? null;
    this.eventSink = options.onEvent ?? null;
    this.onDispose = options.onDispose ?? null;

    this.scrollbackLines = normalizeScrollbackLines(
      options.config?.scrollbackLimit,
    );
    this.requestedScrollbackBytes = requestedScrollbackBytes(
      this.scrollbackLines,
      options.cols,
    );
    this.scrollbackBytesLimit = clampInteger(
      options.scrollbackByteLimit ?? this.requestedScrollbackBytes,
      MIN_SCROLLBACK_BYTES,
      this.requestedScrollbackBytes,
    );
    this.terminal = ghostty.createTerminal(options.cols, options.rows, {
      maxScrollbackLines: this.scrollbackLines,
      maxScrollbackBytes: this.scrollbackBytesLimit,
    });
    this.promptPresentation = new PromptPresentationGate(() =>
      this.requestPresentation(),
    );
    this.resizePromptHold = new ResizePromptHold(() =>
      this.requestPresentation(),
    );
    this.synchronizedOutputPresentation =
      new SynchronizedOutputPresentationGate(() => this.notifyDamage());
    try {
      this.applyConfig(options.config);
    } catch (error) {
      this.terminal.dispose();
      throw error;
    }
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  /** The scrollback byte limit currently in force (at most the requested one). */
  get scrollbackByteLimit(): number {
    return this.scrollbackBytesLimit;
  }

  /** Page bytes currently held by the primary screen (history plus active area). */
  scrollbackPageBytes(): number {
    this.assertLive();
    return this.terminal.scrollbackPageBytes();
  }

  /**
   * Applies the share of the global scrollback budget granted to this model.
   * Raising only permits growth; a limit below the bytes already held prunes
   * the oldest history immediately. The grant never exceeds what the
   * configuration requested.
   */
  setScrollbackByteLimit(bytes: number): void {
    this.assertLive();
    const next = clampInteger(
      bytes,
      MIN_SCROLLBACK_BYTES,
      this.requestedScrollbackBytes,
    );
    if (next === this.scrollbackBytesLimit) return;
    const held = this.terminal.scrollbackPageBytes();
    this.terminal.setScrollbackLimits(next, this.scrollbackLines);
    this.scrollbackBytesLimit = next;
    if (this.terminal.scrollbackPageBytes() >= held) return;
    this.blockMatch = null;
    this.contentRevision += 1;
    this.scrollPositionCurrent = false;
    this.invalidateRenderState();
    this.pendingDamage = FULL_DAMAGE;
    this.notifyDamage();
  }

  get cols(): number {
    this.assertLive();
    return this.colsValue;
  }

  get rows(): number {
    this.assertLive();
    return this.rowsValue;
  }

  presentationSuppressed(): boolean {
    this.assertLive();
    return (
      this.promptPresentation.suppressed ||
      this.resizePromptHold.suppressed ||
      this.synchronizedOutputPresentation.suppressed
    );
  }

  promptErased(): boolean {
    return this.resizePromptHold.promptErased;
  }

  deferPresentation(): boolean {
    this.assertLive();
    if (!this.presentationSuppressed()) return false;
    this.damageNotificationPending = false;
    return true;
  }

  releasePresentationResources(): void {
    this.assertLive();
    if (this.presentationResourcesReleased) return;
    this.plainLinks = null;
    this.renderState = null;
    this.gpuState = null;
    this.directCellReader.clear();
    this.renderStateCurrent = false;
    this.packedViewport = new Uint8Array(0);
    this.packedRenderVersion = -1;
    this.terminal.releaseRenderState();
    this.presentationResourcesReleased = true;
    this.pendingDamage = FULL_DAMAGE;
    this.pendingCellDamage = FULL_DAMAGE;
    this.damageNeedsResolution = false;
  }

  compactPresentationResources(): void {
    this.assertLive();
    this.directCellReader.clear();
    this.terminal.compactRenderState();
    this.renderState = null;
    this.gpuState = null;
    this.renderStateCurrent = false;
    this.packedViewport = new Uint8Array(0);
    this.packedRenderVersion = -1;
    this.pendingDamage = FULL_DAMAGE;
    this.pendingCellDamage = FULL_DAMAGE;
    this.damageNeedsResolution = false;
  }

  setColors(
    foreground: number,
    background: number,
    cursor: number,
    palette: readonly number[],
  ): boolean {
    this.assertLive();
    this.terminal.setDefaultColors(foreground, background, cursor);
    this.terminal.setPalette(encodePalette(palette));
    this.invalidateRenderState();
    this.pendingDamage = FULL_DAMAGE;
    this.notifyDamage();
    return true;
  }

  write(bytes: Uint8Array): void {
    this.assertLive();
    if (bytes.byteLength === 0) return;

    this.blockMatch = null;
    this.terminal.write(bytes);
    this.writeCount += 1;
    this.contentRevision += 1;
    this.scrollPositionCurrent = false;
    this.invalidateRenderState();
    this.damageNeedsResolution = true;
    this.refreshModes();
    this.drainReplies();
    this.drainEvents();
    this.synchronizedOutputPresentation.observe(
      this.modesValue.synchronizedOutput,
    );
    this.requestPresentation();
  }

  resize(cols: number, rows: number): void {
    this.assertLive();
    validateDimensions(cols, rows);
    if (cols === this.colsValue && rows === this.rowsValue) return;

    this.terminal.resize(cols, rows);
    this.blockMatch = null;
    this.colsValue = cols;
    this.rowsValue = rows;
    this.contentRevision += 1;
    this.scrollPositionCurrent = false;
    this.invalidateRenderState();
    this.pendingDamage = FULL_DAMAGE;
    // Ghostty just cleared a redrawable prompt; keep the previous frame until the shell
    // prints it again (or the deadline), instead of presenting it blank.
    this.resizePromptHold.resized(this.modesValue.alternateScreen);
    // Mode 2048 in-band size report.
    this.drainReplies();
    this.notifyDamage();
  }

  setPixelSize(widthPx: number, heightPx: number): void {
    this.assertLive();
    if (widthPx <= 0 || heightPx <= 0) return;
    this.terminal.setPixelSize(widthPx, heightPx);
    const cellPixels = {
      width: Math.max(1, Math.floor(widthPx / this.colsValue)),
      height: Math.max(1, Math.floor(heightPx / this.rowsValue)),
    };
    if (
      cellPixels.width !== this.cellPixels.width ||
      cellPixels.height !== this.cellPixels.height
    ) {
      // Image placements are sized in pixels when the core renders, so a new
      // cell size (a display-scale or font change that keeps the grid) must
      // reach the next frame even without new output.
      this.invalidateRenderState();
      this.damageNeedsResolution = true;
    }
    this.cellPixels = cellPixels;
    // A new cell size is reported to programs using mode 2048.
    this.drainReplies();
  }

  cellPixelSize(): { readonly width: number; readonly height: number } {
    return this.cellPixels;
  }

  imagePlacements(): readonly GhosttyImagePlacement[] {
    this.assertLive();
    return this.renderStateCurrent
      ? this.terminal.kittyPlacements()
      : NO_PLACEMENTS;
  }

  imageBackgroundZLimit(): number {
    this.assertLive();
    return this.terminal.kittyBackgroundZLimit;
  }

  advanceImageAnimations(nowMs: number): number | null {
    this.assertLive();
    const delay = this.terminal.kittyAnimationTick(nowMs);
    // A new frame bumps the image generation; the next update reports it.
    this.invalidateRenderState();
    this.damageNeedsResolution = true;
    return delay;
  }

  encodeMouse(event: GhosttyMouseEvent): Uint8Array {
    this.assertLive();
    return this.terminal.encodeMouse(event);
  }

  resetMouseMotion(): void {
    this.assertLive();
    this.terminal.resetMouseMotion();
  }

  setColorScheme(scheme: "dark" | "light"): void {
    this.assertLive();
    this.terminal.setColorScheme(scheme);
    this.drainReplies();
  }

  setVisible(visible: boolean): void {
    this.assertLive();
    this.terminal.setVisible(visible);
    this.drainReplies();
  }

  setTerminalVersion(version: string): void {
    this.assertLive();
    this.terminal.setXtversion(version);
  }

  setImageStorageLimit(bytes: number): void {
    this.assertLive();
    this.terminal.setImageStorageLimit(bytes);
    this.invalidateRenderState();
    this.damageNeedsResolution = true;
    this.requestPresentation();
  }

  setLigatures(enabled: boolean): void {
    this.assertLive();
    if (enabled === this.ligaturesValue) return;
    this.ligaturesValue = enabled;
    this.terminal.setLigatures(enabled);
    this.invalidateRenderState();
    this.pendingDamage = FULL_DAMAGE;
    this.notifyDamage();
  }

  ligatures(): boolean {
    return this.ligaturesValue;
  }

  formatTextRange(
    startLine: number,
    endLine: number,
    format: GhosttyTextFormat,
  ): string {
    this.assertLive();
    return this.terminal.formatTextRange(startLine, endLine, format);
  }

  setSearchQuery(query: string): GhosttySearchStatus {
    this.assertLive();
    return this.terminal.setSearchQuery(query);
  }

  clearSearch(): void {
    this.assertLive();
    this.terminal.clearSearch();
  }

  stepSearch(budget?: number): GhosttySearchStatus {
    this.assertLive();
    return this.terminal.stepSearch(budget);
  }

  selectSearchMatch(direction: "next" | "previous"): GhosttySearchStatus {
    this.assertLive();
    const status = this.terminal.selectSearchMatch(direction);
    this.invalidateRenderState();
    this.pendingDamage = FULL_DAMAGE;
    this.notifyDamage();
    return status;
  }

  searchViewportMatches(): readonly GhosttySearchViewportSpan[] {
    this.assertLive();
    const spans = this.terminal.searchViewportMatches();
    const match = this.blockMatch;
    if (!match) return spans;
    const row = match.line - this.viewportOriginLine();
    if (row < 0 || row >= this.rows) return spans;
    return [
      ...spans,
      {
        row,
        startColumn: match.col,
        endColumn: match.col + match.len,
        selected: true,
      },
    ];
  }

  consumeDamage(): TerminalDamage {
    this.assertLive();
    let damage = this.pendingDamage;
    if (this.damageNeedsResolution) {
      damage = mergeDamage(
        damage,
        damageFromRenderState(this.ensureRenderState()),
      );
    } else if (damage.kind !== "none") {
      this.ensureRenderState();
    }
    if (this.imagesChanged) {
      damage = FULL_DAMAGE;
      this.imagesChanged = false;
    }
    this.pendingDamage = NO_DAMAGE;
    this.damageNeedsResolution = false;
    this.damageNotificationPending = false;
    return damage;
  }

  renderFormat(): GhosttyRenderFormat {
    this.assertLive();
    return this.renderFormatValue;
  }

  consumeGpuFrame(options: GhosttyGpuFrameOptions = {}): GhosttyGpuFrame {
    this.assertLive();
    const state = this.ensureGpuState();

    const cellDamage = options.resync ? FULL_DAMAGE : this.pendingCellDamage;
    // Images are drawn from placements, not cell records: a change redraws
    // every row without re-uploading them.
    const damage =
      options.resync || this.imagesChanged
        ? FULL_DAMAGE
        : mergeDamage(this.pendingDamage, cellDamage);
    this.imagesChanged = false;
    this.pendingDamage = NO_DAMAGE;
    this.pendingCellDamage = NO_DAMAGE;
    this.damageNeedsResolution = false;
    this.damageNotificationPending = false;

    // Read the pending window now: `state.newGlyphs` is a snapshot from the
    // update, which an earlier frame may already have delivered.
    const pending = options.resync
      ? this.terminal.gpuGlyphTable()
      : this.terminal.pendingGpuGlyphs();
    const newGlyphs = pending.isEmpty ? NO_GLYPHS : pending.toArray();
    this.terminal.acknowledgeGpuGlyphs();

    const fullDamage = cellDamage.kind === "full";
    return {
      rows: state.rows,
      cols: state.cols,
      epoch: state.epoch,
      fullDamage,
      dirtyRanges: fullDamage
        ? [{ start: 0, end: state.rows - 1 }]
        : cellDamage.kind === "rows"
          ? cellDamage.ranges
          : NO_RANGES,
      damage,
      cells: state.cellsBytes,
      memory: this.terminal.wasmMemory,
      blinkingCells: state.blinkingCells,
      glyphCount: state.glyphCount,
      newGlyphs,
    };
  }

  viewport(): PackedTerminalViewport {
    this.assertLive();
    const state = this.ensureRenderState();
    if (this.packedRenderVersion !== this.renderVersion) {
      this.packRenderState(state);
      this.packedRenderVersion = this.renderVersion;
    }
    return {
      bytes: this.packedViewport,
      cellCount: state.cellCount,
      cellStride: CELL_STRIDE,
      cols: state.cols,
      rows: state.rows,
    };
  }

  renderCells(): TerminalCellReader {
    this.assertLive();
    this.directCellReader.update(this.ensureRenderState());
    return this.directCellReader;
  }

  cursor(): TerminalCursor {
    this.assertLive();
    const cursor = this.ensureCurrentState().cursor;
    return {
      x: cursor.column,
      y: cursor.row,
      visible: cursor.visible,
      blinking: cursor.blinking,
      style: cursor.style,
    };
  }

  setCursorOptions(
    style: "block" | "underline" | "bar",
    blinking: boolean,
  ): void {
    this.assertLive();
    this.terminal.setCursorOptions(style, blinking);
    this.invalidateRenderState();
    this.pendingDamage = FULL_DAMAGE;
    this.notifyDamage();
  }

  grapheme(row: number, column: number): string {
    this.assertLive();
    if (
      row < 0 ||
      row >= this.rowsValue ||
      column < 0 ||
      column >= this.colsValue
    ) {
      return "";
    }
    if (this.renderFormatValue === "gpu") {
      const line = this.readBufferLine(this.viewportOriginLine() + row);
      return line.cells[column] ?? "";
    }
    const state = this.ensureRenderState();
    return this.terminal.graphemeAt(state, row * state.cols + column);
  }

  hyperlinkAtViewportCell(row: number, column: number): string | null {
    return this.linkAtViewportCell(row, column)?.uri ?? null;
  }

  linkAtViewportCell(row: number, column: number): GhosttyViewportLink | null {
    this.assertLive();
    if (
      row < 0 ||
      row >= this.rowsValue ||
      column < 0 ||
      column >= this.colsValue
    ) {
      return null;
    }
    const state = this.ensureCurrentState();
    const index = row * state.cols + column;
    const explicit = this.terminal.hyperlinkAt(state, index);
    if (explicit) {
      // An OSC 8 link covers the contiguous cells carrying its URI.
      const limit = MAX_LINK_ROWS * state.cols;
      const cells = state.rows * state.cols;
      let start = index;
      while (
        start > 0 &&
        index - start < limit &&
        this.terminal.hyperlinkAt(state, start - 1) === explicit
      )
        start--;
      let end = index;
      while (
        end + 1 < cells &&
        end - index < limit &&
        this.terminal.hyperlinkAt(state, end + 1) === explicit
      )
        end++;
      return { uri: explicit, spans: viewportSpans(start, end, state.cols) };
    }
    const origin = this.viewportOriginLine();
    let cache = this.plainLinks;
    if (
      !cache ||
      cache.revision !== this.contentRevision ||
      cache.origin !== origin ||
      cache.cols !== state.cols ||
      row < cache.startRow ||
      row > cache.endRow
    ) {
      let startRow = row;
      let endRow = row;
      while (startRow > 0 && row - startRow < 8 && state.rowWrapped[startRow])
        startRow--;
      while (
        endRow + 1 < state.rows &&
        endRow - startRow < 8 &&
        state.rowWrapped[endRow + 1]
      )
        endRow++;
      let text = "";
      const offsets: number[] = [];
      const lines = this.readBufferLines(origin + startRow, origin + endRow);
      for (let y = startRow; y <= endRow; y++) {
        const cells = lines.get(origin + y)?.cells;
        for (let x = 0; x < state.cols; x++) {
          offsets.push(text.length);
          // Wide-character spacers read as "" and contribute no text.
          text += cells?.[x] ?? " ";
        }
      }
      cache = {
        revision: this.contentRevision,
        origin,
        cols: state.cols,
        startRow,
        endRow,
        offsets,
        links: detectTerminalLinks(text),
      };
      this.plainLinks = cache;
    }
    const offset = cache.offsets[(row - cache.startRow) * state.cols + column];
    const link = cache.links.find(
      (entry) => offset >= entry.start && offset < entry.end,
    );
    if (!link) return null;
    let first = -1;
    let last = -1;
    for (let cell = 0; cell < cache.offsets.length; cell++) {
      const at = cache.offsets[cell];
      if (at < link.start || at >= link.end) continue;
      if (first < 0) first = cell;
      last = cell;
    }
    const base = cache.startRow * state.cols;
    return {
      uri: link.uri,
      spans: viewportSpans(base + first, base + last, state.cols),
    };
  }

  scrollPosition(): ScrollPosition {
    this.assertLive();
    if (this.scrollPositionCurrent) return this.scrollPositionValue;
    this.scrollPositionValue = scrollPositionFromScrollbar(
      this.terminal.scrollbar(),
    );
    this.scrollPositionCurrent = true;
    return this.scrollPositionValue;
  }

  scrollBy(lines: number): boolean {
    this.assertLive();
    if (!Number.isFinite(lines) || lines === 0) return false;
    return this.scrollTo(this.scrollPosition().offset - Math.trunc(lines));
  }

  scrollTo(offset: number): boolean {
    this.assertLive();
    const current = this.scrollPosition();
    const next = this.modes().alternateScreen
      ? 0
      : clampInteger(Math.round(offset), 0, current.history);
    if (next === current.offset) return false;

    this.terminal.scrollViewportTo(current.history - next);
    this.scrollPositionValue = { offset: next, history: current.history };
    this.scrollPositionCurrent = true;
    this.invalidateRenderState();
    this.pendingDamage = FULL_DAMAGE;
    this.notifyDamage();
    return true;
  }

  scrollToBottom(): boolean {
    return this.scrollTo(0);
  }

  scrollToPrompt(delta: number): boolean {
    this.assertLive();
    if (!Number.isInteger(delta) || delta === 0) return false;
    if (this.modes().alternateScreen) return false;
    const before = this.scrollPosition().offset;
    this.terminal.scrollViewportToPrompt(delta);
    this.scrollPositionCurrent = false;
    if (this.scrollPosition().offset === before) return false;
    this.invalidateRenderState();
    this.pendingDamage = FULL_DAMAGE;
    this.notifyDamage();
    return true;
  }

  clear(): void {
    this.assertLive();
    this.setSelection(null);
    this.write(clearTerminalBufferSequence(this.cursor()));
  }

  revision(): number {
    this.assertLive();
    return this.contentRevision;
  }

  viewportOriginLine(): number {
    this.assertLive();
    return this.terminal.scrollbar().offset;
  }

  bufferLineAtViewportRow(row: number): number {
    this.assertLive();
    return (
      this.viewportOriginLine() +
      clampInteger(row, 0, Math.max(0, this.rowsValue - 1))
    );
  }

  enableSemanticMarkers(enabled: boolean): void {
    this.assertLive();
    this.terminal.enableSemanticMarkers(enabled);
  }

  semanticMarkerColumn(id: number): number | null {
    this.assertLive();
    return this.terminal.semanticMarkerColumn(id);
  }

  semanticMarkerLine(id: number): number | null {
    this.assertLive();
    return this.terminal.semanticMarkerLine(id);
  }

  readTextRange(
    startLine: number,
    endLine: number,
    startCol?: number,
    endCol?: number,
  ): string {
    this.assertLive();
    return this.terminal.readTextRange(startLine, endLine, startCol, endCol);
  }

  blockSearchActive(): boolean {
    return this.blockMatch !== null;
  }

  setBlockSearchMatch(
    match: { line: number; col: number; len: number } | null,
  ): void {
    this.blockMatch = match;
    this.pendingDamage = FULL_DAMAGE;
    this.notifyDamage();
  }

  readCellLine(line: number): readonly string[] {
    return this.readBufferLine(line).cells;
  }

  readCellLines(
    firstLine: number,
    lastLine: number,
  ): readonly (readonly string[])[] {
    this.assertLive();
    const lines = this.readBufferLines(firstLine, lastLine);
    const result: (readonly string[])[] = [];
    for (let line = firstLine; line <= lastLine; line++) {
      const read = lines.get(line);
      if (!read) break;
      result.push(read.cells);
    }
    return result;
  }

  bufferCursorLine(): number {
    this.assertLive();
    return this.terminal.bufferCursorLine();
  }

  wordRangeAt(point: TerminalBufferPoint): {
    readonly start: number;
    readonly end: number;
  } {
    this.assertLive();
    const cells = this.readBufferLine(point.line).cells;
    const column = clampInteger(point.column, 0, this.colsValue - 1);
    const category = wordCategory(cells[column] ?? "");
    let start = column;
    let end = column;
    while (start > 0 && wordCategory(cells[start - 1] ?? "") === category) {
      start -= 1;
    }
    while (
      end + 1 < this.colsValue &&
      wordCategory(cells[end + 1] ?? "") === category
    ) {
      end += 1;
    }
    return { start, end };
  }

  lineEndColumn(line: number): number {
    this.assertLive();
    const cells = this.readBufferLine(line).cells;
    for (let column = cells.length - 1; column >= 0; column -= 1) {
      if (cells[column].trim() !== "") return column;
    }
    return 0;
  }

  selectionText(selection: TerminalBufferSelection): string {
    this.assertLive();
    if (this.terminal.selection()) return this.terminal.selectionText();
    const normalized = normalizeBufferSelection(selection);
    const snapshots = this.readBufferLines(
      normalized.start.line,
      normalized.end.line,
    );
    const lines: string[] = [];

    for (
      let line = normalized.start.line;
      line <= normalized.end.line;
      line += 1
    ) {
      const snapshot = snapshots.get(line) ?? emptyBufferLine(this.colsValue);
      const startColumn = selection.rectangular
        ? normalized.left
        : line === normalized.start.line
          ? normalized.start.column
          : 0;
      const endColumn = selection.rectangular
        ? normalized.right
        : line === normalized.end.line
          ? normalized.end.column
          : this.colsValue - 1;
      let value = "";
      for (let column = startColumn; column <= endColumn; column += 1) {
        value += snapshot.cells[column] ?? "";
      }
      const text = value.trimEnd();
      if (lines.length > 0 && !selection.rectangular && snapshot.wrapped) {
        lines[lines.length - 1] += text;
      } else {
        lines.push(text);
      }
    }
    return lines.join("\n");
  }

  setSelection(selection: TerminalBufferSelection | null): void {
    this.assertLive();
    const previous = this.terminal.selection();
    this.terminal.setSelection(selection);
    const origin = this.viewportOriginLine();
    this.pendingDamage = mergeDamage(
      this.pendingDamage,
      mergeDamage(
        selectionDamage(previous, origin, this.rowsValue),
        selectionDamage(selection, origin, this.rowsValue),
      ),
    );
    this.notifyDamage();
  }

  trackedSelection(): TerminalBufferSelection | null {
    this.assertLive();
    return this.terminal.selection();
  }

  encodeKey(event: KeyEvent): Uint8Array {
    this.assertLive();
    return this.terminal.encodeKey(event);
  }

  mode(mode: number, isAnsi = false): boolean {
    this.assertLive();
    return this.terminal.mode(mode, isAnsi);
  }

  modes(): TerminalModes {
    this.assertLive();
    this.refreshModes();
    return this.modesValue;
  }

  private refreshModes(): void {
    const modeBits = this.terminal.modeBits();
    if (modeBits === this.modeBitsValue) return;
    this.modeBitsValue = modeBits;
    this.modesValue = modesFromBits(modeBits);
  }

  readText(maxLines: number): string {
    this.assertLive();
    const requestedLines = Math.max(0, Math.floor(maxLines));
    if (requestedLines === 0) return "";

    const scrollbar = this.terminal.scrollbar();
    const totalLines = scrollbar.total;
    const firstLine = Math.max(0, totalLines - requestedLines);
    return this.terminal.readTextRange(firstLine, totalLines - 1).trimEnd();
  }

  subscribeDamage(listener: () => void): () => void {
    this.assertLive();
    this.damageListeners.add(listener);
    return () => this.damageListeners.delete(listener);
  }

  setReplySink(sink: ((bytes: Uint8Array) => void) | null): void {
    this.assertLive();
    this.replySink = sink;
    if (sink) this.drainReplies();
  }

  diagnostics(): TerminalModelDiagnostics {
    const scrollbar = this.disposed
      ? { total: 0, length: 0 }
      : this.terminal.scrollbar();
    const resources = this.disposed ? null : this.terminal.resourceStats();
    return {
      backend: this.backend,
      cols: this.colsValue,
      rows: this.rowsValue,
      scrollbackLines: Math.max(0, scrollbar.total - scrollbar.length),
      disposed: this.disposed,
      writes: this.writeCount,
      renderStateUpdates: this.renderStateUpdateCount,
      bridgeCellCapacity: resources?.cellCapacity ?? 0,
      bridgeRowCapacity: resources?.rowCapacity ?? 0,
      renderStateResets: resources?.renderStateResets ?? 0,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.damageListeners.clear();
    this.replySink = null;
    this.eventSink = null;
    this.renderState = null;
    this.gpuState = null;
    this.directCellReader.clear();
    this.plainLinks = null;
    this.blockMatch = null;
    this.packedViewport = new Uint8Array(0);
    this.promptPresentation.dispose();
    this.resizePromptHold.dispose();
    this.synchronizedOutputPresentation.dispose();
    const callback = this.onDispose;
    this.onDispose = null;
    try {
      this.terminal.dispose();
    } finally {
      callback?.();
    }
  }

  private applyConfig(config: GhosttyTerminalConfig | undefined): void {
    if (!config) return;
    if (
      config.fgColor !== undefined ||
      config.bgColor !== undefined ||
      config.cursorColor !== undefined
    ) {
      this.terminal.setDefaultColors(
        config.fgColor ?? 0xffff_ffff,
        config.bgColor ?? 0xffff_ffff,
        config.cursorColor ?? 0xffff_ffff,
      );
    }
    if (config.palette && config.palette.length > 0) {
      this.terminal.setPalette(encodePalette(config.palette));
    }
    if (config.cursorStyle !== undefined || config.cursorBlink !== undefined) {
      this.terminal.setCursorOptions(
        config.cursorStyle ?? "block",
        config.cursorBlink ?? false,
      );
    }
  }

  /** Render state in whichever format the model currently produces. */
  private ensureCurrentState(): TeraxGhosttyRenderBase {
    return this.renderFormatValue === "gpu"
      ? this.ensureGpuState()
      : this.ensureRenderState();
  }

  private ensureRenderState(): TeraxGhosttyRenderState {
    if (this.renderFormatValue !== "soa") this.switchRenderFormat("soa");
    const state = this.renderState;
    if (
      !this.renderStateCurrent ||
      !state ||
      state.codepoints.buffer.byteLength === 0
    ) {
      this.renderState = this.terminal.updateRenderState();
      this.renderStateCurrent = true;
      if (this.terminal.kittyPlacementsChanged()) this.imagesChanged = true;
      this.renderVersion += 1;
      this.renderStateUpdateCount += 1;
      this.presentationResourcesReleased = false;
      // Dirty rows describe only the latest update; keep earlier ones that no
      // frame has consumed yet (for example after a hover forced an update).
      if (this.damageNeedsResolution) {
        this.pendingDamage = mergeDamage(
          this.pendingDamage,
          damageFromRenderState(this.renderState),
        );
      }
    }
    const current = this.renderState;
    if (!current) throw new Error("Ghostty render state is unavailable");
    return current;
  }

  private ensureGpuState(): TeraxGhosttyGpuRenderState {
    if (this.renderFormatValue !== "gpu") this.switchRenderFormat("gpu");
    const state = this.gpuState;
    if (!this.renderStateCurrent || !state) {
      const next = this.terminal.updateGpuRenderState();
      this.gpuState = next;
      this.renderStateCurrent = true;
      if (this.terminal.kittyPlacementsChanged()) this.imagesChanged = true;
      this.renderVersion += 1;
      this.renderStateUpdateCount += 1;
      this.presentationResourcesReleased = false;
      // Exact dirtiness is per update; accumulate it until a frame consumes it.
      this.pendingCellDamage = mergeDamage(
        this.pendingCellDamage,
        damageFromRenderState(next),
      );
      return next;
    }
    // Any WASM allocation (another terminal's output, a line read) can grow
    // the shared memory and detach every earlier view; the records themselves
    // are intact, so re-read the views without updating.
    if (state.cellsBytes.buffer !== this.terminal.wasmMemory.buffer) {
      this.gpuState = this.terminal.readGpuRenderState();
      return this.gpuState;
    }
    return state;
  }

  private switchRenderFormat(format: GhosttyRenderFormat): void {
    this.terminal.setRenderFormat(format);
    this.renderFormatValue = format;
    this.renderState = null;
    this.gpuState = null;
    this.directCellReader.clear();
    this.renderStateCurrent = false;
    this.packedViewport = new Uint8Array(0);
    this.packedRenderVersion = -1;
    this.pendingDamage = FULL_DAMAGE;
    this.pendingCellDamage = FULL_DAMAGE;
  }

  private invalidateRenderState(): void {
    this.renderStateCurrent = false;
  }

  private packRenderState(state: TeraxGhosttyRenderState): void {
    const byteLength = state.cellCount * CELL_STRIDE;
    if (this.packedViewport.byteLength !== byteLength) {
      this.packedViewport = new Uint8Array(byteLength);
    }
    const bytes = this.packedViewport;
    const words = new Uint32Array(
      bytes.buffer,
      bytes.byteOffset,
      byteLength / 4,
    );
    const halves = new Uint16Array(
      bytes.buffer,
      bytes.byteOffset,
      byteLength / 2,
    );

    for (let index = 0; index < state.cellCount; index += 1) {
      const cellOffset = index * CELL_STRIDE;
      const colorOffset = index * 4;
      words[index * 4] = state.codepoints[index];
      bytes[cellOffset + 4] = state.foregroundRgba[colorOffset];
      bytes[cellOffset + 5] = state.foregroundRgba[colorOffset + 1];
      bytes[cellOffset + 6] = state.foregroundRgba[colorOffset + 2];
      bytes[cellOffset + 7] = state.backgroundRgba[colorOffset];
      bytes[cellOffset + 8] = state.backgroundRgba[colorOffset + 1];
      bytes[cellOffset + 9] = state.backgroundRgba[colorOffset + 2];
      bytes[cellOffset + 10] = rendererFlags(
        state.styleFlags[index],
        state.underlineStyles[index],
      );
      bytes[cellOffset + 11] = rendererWidth(state.widths[index]);
      halves[index * 8 + 6] = Math.min(0xffff, state.linkIds[index]);
      bytes[cellOffset + 14] = Math.min(0xff, state.graphemeLengths[index]);
      bytes[cellOffset + 15] = 0;
    }
  }

  private readBufferLine(line: number): BufferLine {
    const scrollbar = this.terminal.scrollbar();
    if (scrollbar.total === 0) return emptyBufferLine(this.colsValue);
    const safeLine = clampInteger(line, 0, scrollbar.total - 1);
    return (
      this.readBufferLines(safeLine, safeLine).get(safeLine) ??
      emptyBufferLine(this.colsValue)
    );
  }

  private readBufferLines(
    firstLine: number,
    lastLine: number,
  ): Map<number, BufferLine> {
    const result = new Map<number, BufferLine>();
    const total = this.terminal.scrollbar().total;
    if (total === 0 || lastLine < firstLine) return result;

    const first = clampInteger(firstLine, 0, total - 1);
    const last = clampInteger(lastLine, first, total - 1);
    // Decoded straight from the screen: the viewport, the render state and
    // pending damage are untouched, and no presentation buffers are rebuilt.
    const lines = this.terminal.readLines(first, last);
    for (let index = 0; index < lines.length; index += 1) {
      result.set(first + index, lines[index]);
    }
    return result;
  }

  private drainReplies(): void {
    if (!this.replySink) return;
    const bytes = this.terminal.drainOutputBytes();
    if (bytes.byteLength > 0) this.replySink(bytes);
  }

  private drainEvents(): void {
    const events = this.terminal.drainEvents();
    for (const event of events) {
      this.promptPresentation.observe(event);
      this.resizePromptHold.observe(event);
      this.eventSink?.(event);
    }
  }

  private requestPresentation(): void {
    if (this.presentationSuppressed()) return;
    this.notifyDamage();
  }

  private notifyDamage(): void {
    if (
      this.promptPresentation.suppressed ||
      this.resizePromptHold.suppressed ||
      this.synchronizedOutputPresentation.suppressed ||
      this.damageNotificationPending ||
      this.damageListeners.size === 0
    ) {
      return;
    }
    this.damageNotificationPending = true;
    for (const listener of this.damageListeners) listener();
  }

  private assertLive(): void {
    if (this.disposed) throw new Error("Ghostty terminal model is disposed");
  }
}

class GhosttyRenderCellView implements TerminalCellReader {
  private state: TeraxGhosttyRenderState | null = null;

  get length(): number {
    return this.current().cellCount;
  }

  update(state: TeraxGhosttyRenderState): void {
    this.state = state;
  }

  clear(): void {
    this.state = null;
  }

  codepoint(index: number): number {
    return this.current().codepoints[index];
  }

  flags(index: number): number {
    const state = this.current();
    return rendererFlags(state.styleFlags[index], state.underlineStyles[index]);
  }

  width(index: number): number {
    return rendererWidth(this.current().widths[index]);
  }

  graphemeLength(index: number): number {
    return this.current().graphemeLengths[index];
  }

  underlineStyle(index: number): number {
    return this.current().underlineStyles[index];
  }

  underlineColorPacked(index: number): number {
    return packedRgb(this.current().underlineRgba, index * 4);
  }

  overline(index: number): boolean {
    return (this.current().styleFlags[index] & (1 << 7)) !== 0;
  }

  foreground(index: number): Rgb {
    const state = this.current();
    const offset = index * 4;
    return [
      state.foregroundRgba[offset],
      state.foregroundRgba[offset + 1],
      state.foregroundRgba[offset + 2],
    ];
  }

  foregroundPacked(index: number): number {
    return packedRgb(this.current().foregroundRgba, index * 4);
  }

  background(index: number): Rgb {
    const state = this.current();
    const offset = index * 4;
    return [
      state.backgroundRgba[offset],
      state.backgroundRgba[offset + 1],
      state.backgroundRgba[offset + 2],
    ];
  }

  backgroundPacked(index: number): number {
    return packedRgb(this.current().backgroundRgba, index * 4);
  }

  private current(): TeraxGhosttyRenderState {
    if (!this.state) throw new Error("Ghostty render cells are unavailable");
    return this.state;
  }
}

function emptyBufferLine(cols: number): BufferLine {
  return { cells: Array.from({ length: cols }, () => ""), wrapped: false };
}

function rendererWidth(width: number): number {
  if (width === 1) return 2;
  if (width === 2 || width === 3) return 0;
  return 1;
}

function rendererFlags(style: number, underlineStyle: number): number {
  let flags = 0;
  if ((style & (1 << 0)) !== 0) flags |= CellFlags.BOLD;
  if ((style & (1 << 1)) !== 0) flags |= CellFlags.ITALIC;
  if ((style & (1 << 2)) !== 0) flags |= CellFlags.FAINT;
  if ((style & (1 << 3)) !== 0) flags |= CellFlags.BLINK;
  if ((style & (1 << 4)) !== 0) flags |= CellFlags.INVERSE;
  if ((style & (1 << 5)) !== 0) flags |= CellFlags.INVISIBLE;
  if ((style & (1 << 6)) !== 0) flags |= CellFlags.STRIKETHROUGH;
  if (underlineStyle !== 0) flags |= CellFlags.UNDERLINE;
  return flags;
}

function packedRgb(colors: Uint8Array, offset: number): number {
  return (
    (colors[offset] << 16) | (colors[offset + 1] << 8) | colors[offset + 2]
  );
}

function encodePalette(palette: readonly number[]): Uint8Array {
  const colors = new Uint8Array(Math.min(256, palette.length) * 3);
  for (let index = 0; index < colors.byteLength / 3; index += 1) {
    const color = palette[index] >>> 0;
    colors[index * 3] = (color >>> 16) & 0xff;
    colors[index * 3 + 1] = (color >>> 8) & 0xff;
    colors[index * 3 + 2] = color & 0xff;
  }
  return colors;
}

function damageFromRenderState(state: TeraxGhosttyRenderBase): TerminalDamage {
  if (state.fullDamage) return FULL_DAMAGE;
  const ranges: TerminalRowRange[] = [];
  let first = -1;
  for (let row = 0; row < state.rows; row += 1) {
    if (state.dirtyRows[row] !== 0) {
      if (first < 0) first = row;
    } else if (first >= 0) {
      ranges.push({ start: first, end: row - 1 });
      first = -1;
    }
  }
  if (first >= 0) ranges.push({ start: first, end: state.rows - 1 });
  return ranges.length === 0 ? NO_DAMAGE : { kind: "rows", ranges };
}

function mergeDamage(
  previous: TerminalDamage,
  next: TerminalDamage,
): TerminalDamage {
  if (previous.kind === "full" || next.kind === "full") return FULL_DAMAGE;
  if (previous.kind === "none") return next;
  if (next.kind === "none") return previous;
  const sorted = [...previous.ranges, ...next.ranges].sort(
    (a, b) => a.start - b.start,
  );
  const ranges: TerminalRowRange[] = [];
  for (const range of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && range.start <= last.end + 1)
      ranges[ranges.length - 1] = {
        start: last.start,
        end: Math.max(last.end, range.end),
      };
    else ranges.push(range);
  }
  return { kind: "rows", ranges };
}

function selectionDamage(
  selection: TerminalBufferSelection | null,
  origin: number,
  rows: number,
): TerminalDamage {
  if (!selection) return NO_DAMAGE;
  const start = Math.max(
    0,
    Math.min(selection.anchor.line, selection.focus.line) - origin,
  );
  const end = Math.min(
    rows - 1,
    Math.max(selection.anchor.line, selection.focus.line) - origin,
  );
  return start > end ? NO_DAMAGE : { kind: "rows", ranges: [{ start, end }] };
}

function modesFromBits(bits: number): TerminalModes {
  if (bits === 0) return DEFAULT_MODES;
  return Object.freeze({
    alternateScreen: (bits & (1 << 0)) !== 0,
    bracketedPaste: (bits & (1 << 1)) !== 0,
    focusReporting: (bits & (1 << 2)) !== 0,
    mouseTracking: (bits & (1 << 3)) !== 0,
    synchronizedOutput: (bits & (1 << 4)) !== 0,
  });
}

function scrollPositionFromScrollbar(scrollbar: {
  readonly total: number;
  readonly length: number;
  readonly offset: number;
}): ScrollPosition {
  const history = Math.max(0, scrollbar.total - scrollbar.length);
  return {
    offset: Math.max(0, history - Math.min(history, scrollbar.offset)),
    history,
  };
}

function validateDimensions(cols: number, rows: number): void {
  if (
    !Number.isSafeInteger(cols) ||
    !Number.isSafeInteger(rows) ||
    cols <= 0 ||
    rows <= 0 ||
    cols > MAX_DIMENSION ||
    rows > MAX_DIMENSION ||
    cols * rows > MAX_CELLS
  ) {
    throw new RangeError(`Invalid terminal dimensions: ${cols}x${rows}`);
  }
}

function normalizeBufferSelection(selection: TerminalBufferSelection): {
  readonly start: TerminalBufferPoint;
  readonly end: TerminalBufferPoint;
  readonly left: number;
  readonly right: number;
} {
  const anchorFirst =
    selection.anchor.line < selection.focus.line ||
    (selection.anchor.line === selection.focus.line &&
      selection.anchor.column <= selection.focus.column);
  const start = anchorFirst ? selection.anchor : selection.focus;
  const end = anchorFirst ? selection.focus : selection.anchor;
  return {
    start,
    end,
    left: Math.min(selection.anchor.column, selection.focus.column),
    right: Math.max(selection.anchor.column, selection.focus.column),
  };
}

function wordCategory(value: string): "space" | "word" | "punctuation" {
  if (/\s/u.test(value)) return "space";
  if (/^[\p{Letter}\p{Number}_]$/u.test(value)) return "word";
  return "punctuation";
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
