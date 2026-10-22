import type {
  TerminalBackendKind,
  TerminalDamage,
  TerminalModel,
  TerminalRowRange,
} from "@/modules/terminal/backend/contracts";
import type { TerminalCellReader } from "@/modules/terminal/ghostty/core/packedCells";
import type {
  TeraxGhosttyDragPosition,
  TeraxGhosttyGpuGlyph,
  TeraxGhosttyKittyClipboardAnswer,
  TeraxGhosttyKittyPlacement,
  TeraxGhosttyMimeData,
  TeraxGhosttyMouseEvent,
  TeraxGhosttyTextFormat,
} from "@terax/ghostty-core/adapted";
import type {
  GhosttyDragOperation,
  GhosttyTerminalConfig,
  GhosttyTerminalEvent,
  KeyEvent,
} from "@terax/ghostty-core/protocol";

export type GhosttyTerminalModelOptions = {
  readonly backend: Extract<TerminalBackendKind, `ghostty-${string}`>;
  readonly cols: number;
  readonly rows: number;
  readonly config?: GhosttyTerminalConfig;
  readonly deviceAttributeFallback?: boolean;
  readonly onReply?: (bytes: Uint8Array) => void;
  readonly onEvent?: (event: GhosttyTerminalEvent) => void;
  readonly onDispose?: () => void;
};

export type GhosttyClipboardPolicy = {
  readonly readsToHost: boolean;
  readonly writesAllowed: boolean;
};

/** Where a drag is, in cells and in the terminal pixels mouse reports use. */
export type GhosttyDragPosition = TeraxGhosttyDragPosition;

export type TerminalBufferPoint = {
  readonly line: number;
  readonly column: number;
};

export type TerminalBufferSelection = {
  readonly anchor: TerminalBufferPoint;
  readonly focus: TerminalBufferPoint;
  readonly rectangular: boolean;
};

export type GhosttySearchStatus = {
  readonly active: boolean;
  readonly pending: boolean;
  readonly complete: boolean;
  readonly generation: number;
  readonly totalMatches: number;
  readonly selectedIndex: number;
};

export type GhosttySearchViewportSpan = {
  readonly row: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly selected: boolean;
};

/** Per-cell representation the model is currently producing. */
export type GhosttyRenderFormat = "soa" | "gpu";

export type GhosttyGpuGlyph = TeraxGhosttyGpuGlyph;

/** A Kitty graphics placement; see `TeraxGhosttyKittyPlacement`. */
export type GhosttyImagePlacement = TeraxGhosttyKittyPlacement;

/** A mouse event for `encodeMouse`; see `TeraxGhosttyMouseEvent`. */
export type GhosttyMouseEvent = TeraxGhosttyMouseEvent;

export type GhosttyTextFormat = TeraxGhosttyTextFormat;

/**
 * A link under a viewport cell (an OSC 8 hyperlink or a detected URL or
 * path) and the cells it covers, per viewport row, columns inclusive.
 */
export type GhosttyViewportLink = {
  readonly uri: string;
  readonly spans: readonly {
    readonly row: number;
    readonly startColumn: number;
    readonly endColumn: number;
  }[];
};

export type GhosttyGpuFrameOptions = {
  /**
   * The consumer has no glyph map or no uploaded cells for this model (a new
   * or re-leased surface): report full damage and deliver the complete glyph
   * table in `newGlyphs`, not only the delta.
   */
  readonly resync?: boolean;
};

/**
 * Everything a GPU renderer needs for one frame, produced by
 * `GhosttyTerminalModelApi.consumeGpuFrame()`. Cell records are 16 bytes per
 * cell; see `@terax/ghostty-core/adapted` (`GPU_CELL_*`, `decodeGpuCell`) for
 * the exact word layout. `cells` and `memory.buffer` are borrowed: use them
 * synchronously (for example `queue.writeBuffer`) before the next call into
 * the model, because any WASM allocation can replace `memory.buffer`.
 * Never store the frame, `cells` or `memory`: each model owns its WebAssembly
 * instance, and a retained reference keeps the whole linear memory alive after
 * `dispose()` (the engine only frees it once nothing references it).
 */
export type GhosttyGpuFrame = {
  readonly rows: number;
  readonly cols: number;
  /**
   * Glyph-id epoch. If it differs from the previous frame's, drop every
   * id-to-atlas mapping; `newGlyphs` then holds the whole table.
   */
  readonly epoch: number;
  /**
   * Upload every row: stored records are stale (first frame, resize, release
   * or compaction, new glyph epoch, format switch, resync). Scrolling and
   * palette changes are not `fullDamage`: every row is re-encoded natively and
   * only rows whose bytes changed appear in `dirtyRanges`.
   */
  readonly fullDamage: boolean;
  /**
   * Inclusive, sorted, coalesced row ranges whose records changed since the
   * previous consumed frame. `[{ start: 0, end: rows - 1 }]` on `fullDamage`;
   * empty when no record changed (redundant rewrites are filtered natively).
   */
  readonly dirtyRanges: readonly TerminalRowRange[];
  /**
   * Redraw damage, a superset of `dirtyRanges`: it also covers overlay state
   * that never alters records (selection rows, block-search match, cursor
   * options). `kind === "none"` means nothing needs drawing.
   */
  readonly damage: TerminalDamage;
  /** `rows * cols * 16` bytes of cell records, a view into `memory.buffer`. */
  readonly cells: Uint8Array;
  /** The WASM linear memory backing `cells`, for zero-copy `writeBuffer`. */
  readonly memory: WebAssembly.Memory;
  /** Visible cells that blink and draw a glyph; arm the blink timer only if > 0. */
  readonly blinkingCells: number;
  /** Glyphs interned in this epoch (valid ids are `1..glyphCount`). */
  readonly glyphCount: number;
  /** Glyphs to rasterize/map before drawing this frame. Owned copies. */
  readonly newGlyphs: readonly GhosttyGpuGlyph[];
};

export interface GhosttyTerminalModelApi extends TerminalModel {
  isDisposed?(): boolean;
  /**
   * The cell format the model currently produces. Models start as `"soa"`.
   * `consumeGpuFrame()` switches to `"gpu"`; `renderCells()`, `viewport()`
   * and `consumeDamage()` switch back to `"soa"`. Each switch releases the
   * other format's buffers and forces full damage, so a surface should stick
   * to one format.
   */
  renderFormat(): GhosttyRenderFormat;
  /**
   * GPU-format equivalent of `consumeDamage()` + `renderCells()`: updates the
   * render state if output arrived, resets pending damage, and returns the
   * packed cell records with exact dirty rows and newly interned glyphs.
   * Call `deferPresentation()` first, exactly as for the SoA path; this method
   * does not itself honor synchronized-output suppression.
   */
  consumeGpuFrame(options?: GhosttyGpuFrameOptions): GhosttyGpuFrame;
  renderCells(): TerminalCellReader;
  presentationSuppressed(): boolean;
  deferPresentation(): boolean;
  /** App lab only: a resize erased the prompt and the shell has not printed it again. */
  promptErased?(): boolean;
  releasePresentationResources(): void;
  compactPresentationResources(): void;
  setColors(
    foreground: number,
    background: number,
    cursor: number,
    palette: readonly number[],
  ): boolean;
  setPixelSize(widthPx: number, heightPx: number): void;
  setSearchQuery(query: string): GhosttySearchStatus;
  clearSearch(): void;
  stepSearch(budget?: number): GhosttySearchStatus;
  selectSearchMatch(direction: "next" | "previous"): GhosttySearchStatus;
  searchViewportMatches(): readonly GhosttySearchViewportSpan[];
  setCursorOptions(
    style: "block" | "underline" | "bar",
    blinking: boolean,
  ): void;
  grapheme(row: number, column: number): string;
  hyperlinkAtViewportCell(row: number, column: number): string | null;
  /** The link under a viewport cell with the cells it covers (hover underline). */
  linkAtViewportCell?(row: number, column: number): GhosttyViewportLink | null;
  scrollPosition(): { readonly offset: number; readonly history: number };
  scrollBy(lines: number): boolean;
  scrollTo(offset: number): boolean;
  scrollToBottom(): boolean;
  /** Scrolls by shell prompts (OSC 133): -1 earlier, +1 later. */
  scrollToPrompt?(delta: number): boolean;
  clear(): void;
  revision(): number;
  viewportOriginLine(): number;
  bufferLineAtViewportRow(row: number): number;
  wordRangeAt(point: TerminalBufferPoint): {
    readonly start: number;
    readonly end: number;
  };
  lineEndColumn(line: number): number;
  selectionText(selection: TerminalBufferSelection): string;
  setSelection?(selection: TerminalBufferSelection | null): void;
  trackedSelection?(): TerminalBufferSelection | null;
  encodeKey(event: KeyEvent): Uint8Array;
  mode(mode: number, isAnsi?: boolean): boolean;
  setReplySink(sink: ((bytes: Uint8Array) => void) | null): void;
  enableSemanticMarkers?(enabled: boolean): void;
  semanticMarkerColumn?(id: number): number | null;
  semanticMarkerLine?(id: number): number | null;
  readTextRange?(
    startLine: number,
    endLine: number,
    startCol?: number,
    endCol?: number,
  ): string;
  bufferCursorLine?(): number;
  readCellLine?(line: number): readonly string[];
  /** Cells of buffer lines `firstLine..lastLine` in one read (search scans). */
  readCellLines?(
    firstLine: number,
    lastLine: number,
  ): readonly (readonly string[])[];
  blockSearchActive?(): boolean;
  setBlockSearchMatch?(
    match: { line: number; col: number; len: number } | null,
  ): void;
  /**
   * Kitty image placements of the last render update (`consumeGpuFrame`,
   * `consumeDamage`), sorted by z. Pixel views are borrowed like `cells`:
   * upload them before the next call into the model.
   */
  imagePlacements?(): readonly GhosttyImagePlacement[];
  /** Placements with a z below this are drawn under cell backgrounds too. */
  imageBackgroundZLimit?(): number;
  /**
   * Advances Kitty animations to `nowMs` (any monotonic clock); returns the
   * delay until the next frame change, or null when nothing animates.
   */
  advanceImageAnimations?(nowMs: number): number | null;
  /**
   * Encodes a mouse event for the program's tracking mode and format, or an
   * empty array when the program does not want it.
   */
  encodeMouse?(event: GhosttyMouseEvent): Uint8Array;
  /** Reports the next motion even within the cell last reported. */
  resetMouseMotion?(): void;
  /**
   * Size of one cell in the terminal pixels of `setPixelSize` (the units of
   * `encodeMouse` positions); 1x1 until a pixel size is set.
   */
  cellPixelSize?(): { readonly width: number; readonly height: number };
  /** Light or dark, answered to DSR 996 and reported under mode 2031. */
  setColorScheme?(scheme: "dark" | "light"): void;
  /** Whether the terminal can be seen (DSR 998, mode 2033). */
  setVisible?(visible: boolean): void;
  /** The XTVERSION reply, e.g. "terax 0.6.3". */
  setTerminalVersion?(version: string): void;
  /** Kitty image bytes per screen; 0 disables the protocol. */
  setImageStorageLimit?(bytes: number): void;
  /**
   * Whether runs of punctuation are drawn as one sequence so a font's
   * ligatures join across cells (`gpu/ligatureRuns.ts`). On by default; the
   * GPU format interns the runs natively, SoA renderers apply the rule.
   */
  setLigatures?(enabled: boolean): void;
  ligatures?(): boolean;
  /**
   * Kitty clipboard (OSC 5522) access, refused by default. Reads the host
   * takes are held and reported (`kitty-clipboard-read`) for
   * `answerClipboardRead`; allowed writes are reported
   * (`kitty-clipboard-write`). OSC 52 is unaffected.
   */
  setClipboardPolicy?(policy: GhosttyClipboardPolicy): void;
  /**
   * Whether a paste would go to the program as a Kitty paste event: it set
   * mode 5522 and its reads come to the host.
   */
  pasteEventsWanted?(): boolean;
  /**
   * A paste the user made from a clipboard holding `mimes`: true when the
   * program set mode 5522 and was sent a Kitty paste event instead of the
   * text (it reads the clipboard itself, with a grant that skips the prompt).
   */
  sendPasteEvent?(primary: boolean, mimes: readonly string[]): boolean;
  /** Answers a held Kitty clipboard read; false when none is held by `id`. */
  answerClipboardRead?(
    id: number,
    answer: TeraxGhosttyKittyClipboardAnswer,
  ): boolean;
  /** The program registered for drops (Kitty OSC 72). */
  dropTargetActive?(): boolean;
  /** The program's answer to the current drag; null before it answers. */
  dragAccepted?(): GhosttyDragOperation | null;
  /** A native drag over the terminal carrying `mimes`, for the program. */
  dragMove?(position: GhosttyDragPosition, mimes: readonly string[]): void;
  /** A native drop with its data (at most 16 representations). */
  drop?(
    position: GhosttyDragPosition,
    items: readonly TeraxGhosttyMimeData[],
  ): void;
  /** The native drag left without dropping. */
  dragLeave?(): void;
  /** A buffer range as plain text, VT sequences or HTML, soft wraps joined. */
  formatTextRange?(
    startLine: number,
    endLine: number,
    format: GhosttyTextFormat,
  ): string;
}
