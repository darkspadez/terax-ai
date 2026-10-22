import { ensureMonoFontsLoaded, resolveFontFamily } from "@/lib/fonts";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { TerminalBackendKind } from "@/modules/terminal/backend/contracts";
import {
  disposeGhosttyBlocks,
  ensureGhosttyBlocks,
  ghosttyBlocks,
} from "@/modules/terminal/ghostty/ghosttyBlockSessions";
import { loadSessionRenderer } from "@/modules/terminal/ghostty/loadSessionRenderer";
import { replaceSessionSurface } from "@/modules/terminal/ghostty/replaceSessionSurface";
import { initializeSessionGeneration as startSessionInitialization } from "@/modules/terminal/ghostty/sessionInitialization";
import { BoundedPtyWriter } from "@/modules/terminal/lib/BoundedPtyWriter";
import { LatestClipboardWrite } from "@/modules/terminal/lib/LatestClipboardWrite";
import { setLeafPresentation } from "@/modules/terminal/lib/ptyPresentation";
import { PtyResizeDelivery } from "@/modules/terminal/lib/ptyResizeDelivery";
import {
  ScrollbackRestoreGate,
  setScrollbackModelSource,
  terminalScrollback,
} from "@/modules/terminal/lib/terminalScrollbackRestore";
import { useTerminalFont } from "@/modules/terminal/lib/useTerminalFont";
import type { TerminalSearchController } from "@/modules/terminal/search/TerminalSearchController";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadFeatureFamilies, useFontFeatureStack } from "../lib/fontFeatures";
import { openPty, type PtySession } from "../lib/pty-bridge";
import {
  DROPPED_PATH_MIMES,
  droppedPathItems,
  terminalDragPosition,
} from "../lib/programDrop";
import {
  readClipboardImage,
  readPrimarySelection,
  type TerminalClipboardContent,
  writePrimarySelection,
  writeTerminalClipboard,
  writeTerminalClipboardContent,
} from "../lib/terminalClipboard";
import { useTerminalFontOffsets } from "../lib/terminalFontOffsets";
import { openTerminalLink } from "../lib/terminalLinkOpen";
import { requestTerminalPrompt } from "../lib/terminalPrompts";
import { useTerminalStatusStore } from "../lib/terminalStatus";
import { GhosttySemanticEventRouter } from "./core/GhosttySemanticEventRouter";
import { getGhosttyCoreRuntime } from "./GhosttyCoreRuntime";
import type {
  GhosttyDragPosition,
  GhosttyTerminalModelApi,
} from "./GhosttyTerminalModel";
import {
  measureTerminalFont,
  readTerminalGpuTheme,
  rgbToInt,
  type TerminalFontSpec,
} from "./gpu/terminalVisuals";
import {
  getWebGpuTerminalRuntime,
  webGpuTerminalRuntimeDiagnostics,
} from "./gpu/WebGpuTerminalRuntime";
import { WebGpuTerminalSurface } from "./gpu/WebGpuTerminalSurface";
import { GhosttyInputController } from "./input/GhosttyInputController";
import { encodeTerminalSubmission } from "./input/terminalInputEncoding";
import {
  colorSchemeFor,
  terminalIntegrationCallbacks,
  terminalVersion,
} from "./terminalIntegration";
import type {
  WebGlTerminalSurface,
  WebGlTerminalSurfaceOptions,
} from "./webgl/WebGlTerminalSurface";

type GhosttyBackend = Extract<TerminalBackendKind, `ghostty-${string}`>;
type GhosttySurface = WebGpuTerminalSurface | WebGlTerminalSurface;
type GhosttySurfaceBaseOptions = Omit<WebGlTerminalSurfaceOptions, "onError">;
type GhosttySessionFailure = {
  kind: "startup" | "renderer";
  message: string;
};

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

type Callbacks = {
  onModel?: (model: GhosttyTerminalModelApi | null) => void;
  onError?: (error: GhosttySessionFailure | null) => void;
  onSearchReady?: (search: TerminalSearchController) => void;
  onExit?: (code: number) => void;
  onCwd?: (cwd: string) => void;
};

type GhosttySession = {
  readonly leafId: number;
  readonly backend: GhosttyBackend;
  initialCwd: string | undefined;
  lastCwd: string | null;
  model: GhosttyTerminalModelApi | null;
  surface: GhosttySurface | null;
  surfaceOptions: GhosttySurfaceBaseOptions | null;
  input: GhosttyInputController | null;
  pty: PtySession | null;
  ptyResize: PtyResizeDelivery;
  writer: BoundedPtyWriter;
  container: HTMLDivElement | null;
  callbacks: Callbacks;
  visible: boolean;
  focused: boolean;
  startupError: string | null;
  rendererError: string | null;
  shellExited: boolean;
  disposed: boolean;
  generation: number;
  initializing: Promise<void> | null;
  startup: GhosttyStartupTimings;
  font: TerminalFontSpec;
};

type GhosttyStartupTimings = {
  startedAt: number;
  fontsReadyMs: number | null;
  coreReadyMs: number | null;
  gpuReadyMs: number | null;
  modelReadyMs: number | null;
  surfaceReadyMs: number | null;
  ptyReadyMs: number | null;
  firstOutputMs: number | null;
  firstFrameMs: number | null;
  firstPromptMs: number | null;
};

const sessions = new Map<number, GhosttySession>();

/** The preferences that shape how the renderers draw (`TerminalGpuTheme`). */
function terminalThemeOptions() {
  const preferences = usePreferencesStore.getState();
  return {
    minimumContrast: preferences.terminalMinimumContrast,
    customShader: preferences.terminalCustomShader?.source ?? null,
  };
}

setScrollbackModelSource((leafId) => {
  const session = sessions.get(leafId);
  return session && !session.disposed ? session.model : null;
});

// Bells rung while the window was in the background clear once it is back in
// front for the panes on screen.
if (typeof window !== "undefined") {
  window.addEventListener("focus", () => {
    const visible: number[] = [];
    for (const session of sessions.values()) {
      if (session.visible) visible.push(session.leafId);
    }
    useTerminalStatusStore.getState().acknowledgeBell(visible);
  });
}
const textEncoder = new TextEncoder();
/** Program clipboard writes (OSC 52, Kitty), the latest of a burst kept. */
const programClipboard = new LatestClipboardWrite<TerminalClipboardContent>(
  writeTerminalClipboardContent,
);

type Options = {
  leafId: number;
  backend: GhosttyBackend;
  container: React.RefObject<HTMLDivElement | null>;
  visible: boolean;
  focused: boolean;
  initialCwd?: string;
  blocks?: boolean;
  onExit?: (code: number) => void;
  onCwd?: (cwd: string) => void;
  onSearchReady?: (search: TerminalSearchController) => void;
};

export function useGhosttyTerminalSession({
  leafId,
  backend,
  container,
  visible,
  focused,
  initialCwd,
  blocks = false,
  onSearchReady,
  onExit,
  onCwd,
}: Options) {
  const [model, setModel] = useState<GhosttyTerminalModelApi | null>(null);
  const [error, setError] = useState<GhosttySessionFailure | null>(null);
  const { fontFamily, fontSize, fontWeight } = useTerminalFont();
  const letterSpacing = usePreferencesStore(
    (state) => state.terminalLetterSpacing,
  );
  const zoomLevel = usePreferencesStore((state) => state.zoomLevel);
  const lineHeight = usePreferencesStore((state) => state.terminalLineHeight);
  const fontFeatures = usePreferencesStore(
    (state) => state.terminalFontFeatures,
  );
  const family = useFontFeatureStack(resolveFontFamily(fontFamily), fontFeatures);
  const fontOffset = useTerminalFontOffsets(
    (state) => state.offsets[leafId] ?? 0,
  );
  const font = useMemo<TerminalFontSpec>(
    () => ({
      family,
      size: Math.max(4, Math.round((fontSize + fontOffset) * zoomLevel)),
      lineHeight,
      letterSpacing,
      weight: fontWeight,
    }),
    [
      family,
      fontSize,
      fontOffset,
      fontWeight,
      letterSpacing,
      lineHeight,
      zoomLevel,
    ],
  );
  const fontRef = useRef(font);
  fontRef.current = font;
  const callbackRef = useRef({ onSearchReady, onExit, onCwd });
  callbackRef.current = { onSearchReady, onExit, onCwd };
  const initialCwdRef = useRef(initialCwd);

  useEffect(() => {
    const session = ensureSession(
      leafId,
      backend,
      initialCwdRef.current,
      fontRef.current,
    );
    if (blocks) ensureGhosttyBlocks(leafId);
    const node = container.current;
    session.container = node;
    setModel(session.model);
    session.callbacks = {
      onModel: setModel,
      onError: setError,
      onSearchReady: (search) => callbackRef.current.onSearchReady?.(search),
      onExit: (code) => callbackRef.current.onExit?.(code),
      onCwd: (cwd) => callbackRef.current.onCwd?.(cwd),
    };
    setError(sessionFailure(session));
    if (session.surface) {
      session.callbacks.onSearchReady?.(session.surface.searchController());
    }
    if (session.lastCwd !== null) session.callbacks.onCwd?.(session.lastCwd);
    void initializeSession(session);
    return () => {
      if (session.container === node) {
        session.surface?.detach();
        session.container = null;
        session.callbacks = {};
      }
    };
  }, [leafId, backend, container, blocks]);

  useEffect(() => {
    const session = sessions.get(leafId);
    if (!session || session.backend !== backend) return;
    void updateSessionFont(session, font);
  }, [leafId, backend, font]);

  useEffect(() => {
    const session = ensureSession(leafId, backend, initialCwdRef.current);
    session.visible = visible;
    session.focused = focused;
    setLeafPresentation(leafId, visible, focused);
    session.model?.setVisible?.(visible);
    if (visible && document.hasFocus()) {
      useTerminalStatusStore.getState().acknowledgeBell([leafId]);
    }
    ghosttyBlocks(leafId)?.setVisible(visible);
    const surface = session.surface;
    if (!surface || session.rendererError) return;
    if (visible && session.container) {
      try {
        attachGhosttySurface(session, surface);
      } catch (error) {
        reportRendererFailure(session, toError(error));
      }
    } else {
      surface.setVisible(false);
      surface.detach();
    }
  }, [leafId, backend, visible, focused]);

  const cursorBlink = usePreferencesStore((state) => state.terminalCursorBlink);
  const cursorStyle = usePreferencesStore((state) => state.terminalCursorStyle);
  useEffect(() => {
    const session = sessions.get(leafId);
    session?.surface?.setCursorOptions(cursorBlink, cursorStyle);
    if (session?.surfaceOptions) {
      session.surfaceOptions = {
        ...session.surfaceOptions,
        cursorBlink,
        cursorStyle,
      };
    }
  }, [leafId, cursorBlink, cursorStyle]);

  const write = useCallback(
    (data: string) => {
      writeToGhosttySession(leafId, data);
    },
    [leafId],
  );
  const focus = useCallback(() => focusGhosttySession(leafId), [leafId]);
  const getBuffer = useCallback(
    (maxLines = 200) => sessions.get(leafId)?.model?.readText(maxLines) ?? null,
    [leafId],
  );
  const getSelection = useCallback(
    () => sessions.get(leafId)?.surface?.getSelection() ?? null,
    [leafId],
  );
  const applyTheme = useCallback(() => {
    const session = sessions.get(leafId);
    if (!session?.model || !session.surface) return;
    const theme = readTerminalGpuTheme(terminalThemeOptions());
    session.model.setColors(
      rgbToInt(theme.foreground),
      rgbToInt(theme.background),
      rgbToInt(theme.cursor),
      theme.palette.map(rgbToInt),
    );
    session.model.setColorScheme?.(colorSchemeFor(theme.background));
    session.surface.setTheme(theme);
    if (session.surfaceOptions)
      session.surfaceOptions = { ...session.surfaceOptions, theme };
  }, [leafId]);

  const retry = useCallback(() => {
    const session = sessions.get(leafId);
    if (session?.rendererError) {
      retryGhosttyRenderer(session);
      return;
    }
    void respawnGhosttySession(leafId).catch((error: unknown) =>
      setError({ kind: "startup", message: toError(error).message }),
    );
  }, [leafId]);

  return useMemo(
    () => ({
      error,
      model,
      retry,
      write,
      focus,
      getBuffer,
      getSelection,
      applyTheme,
    }),
    [write, focus, getBuffer, getSelection, applyTheme, error, retry, model],
  );
}

export function hasGhosttySession(leafId: number): boolean {
  return sessions.has(leafId);
}

export function writeToGhosttySession(leafId: number, data: string): boolean {
  const session = sessions.get(leafId);
  if (!session || session.shellExited || session.disposed) return false;
  return session.writer.enqueue(textEncoder.encode(data));
}

export function submitToGhosttySession(leafId: number, text: string): boolean {
  const session = sessions.get(leafId);
  if (!session || session.shellExited || session.disposed) return false;
  const data = encodeTerminalSubmission(
    text,
    session.model?.modes().bracketedPaste ?? false,
  );
  const accepted = session.writer.enqueue(textEncoder.encode(data));
  if (accepted) {
    const blocks = ghosttyBlocks(leafId);
    if (blocks) {
      blocks.everSubmitted = true;
      blocks.controller?.submitted(text);
      blocks.changed();
    }
  }
  return accepted;
}

export function interruptGhosttySession(leafId: number): boolean {
  const session = sessions.get(leafId);
  return session?.writer.enqueue(Uint8Array.of(3)) ?? false;
}

export function clearGhosttySession(leafId: number): boolean {
  const session = sessions.get(leafId);
  if (!session?.model || session.disposed) return false;
  ghosttyBlocks(leafId)?.controller?.clear();
  session.model.clear();
  focusGhosttySession(leafId);
  return true;
}

export function pasteIntoGhosttySession(leafId: number, text: string): boolean {
  const blocks = ghosttyBlocks(leafId);
  if (blocks?.getMode() === "prompt" && blocks.paste) {
    blocks.paste(text);
    return true;
  }
  const session = sessions.get(leafId);
  if (!session?.input) return false;
  session.input.paste(text);
  session.surface?.focus();
  return true;
}

/**
 * The leaf's terminal and where a drag at a client point is over it, when
 * its program registered for drops (Kitty OSC 72); null otherwise.
 */
function programDropTarget(
  leafId: number,
  clientX: number,
  clientY: number,
): { model: GhosttyTerminalModelApi; position: GhosttyDragPosition } | null {
  const session = sessions.get(leafId);
  const model = session?.model;
  const surface = session?.surface;
  if (!model || !surface || model.isDisposed?.() || !model.dropTargetActive?.())
    return null;
  const rect = surface.eventTarget().getBoundingClientRect();
  const position = terminalDragPosition(
    clientX - rect.left,
    clientY - rect.top + surface.gridShiftY(),
    surface.cellSize(),
    model.cellPixelSize?.() ?? null,
  );
  return position && { model, position };
}

/**
 * Offers a drag of files over the leaf to its program; false when the
 * program did not register for drops, so the drag is the app's.
 */
export function offerDragToGhosttySession(
  leafId: number,
  clientX: number,
  clientY: number,
): boolean {
  const target = programDropTarget(leafId, clientX, clientY);
  if (!target) return false;
  target.model.dragMove?.(target.position, DROPPED_PATH_MIMES);
  return true;
}

/** Drops files on the leaf's program; false when it takes no drops. */
export function dropOnGhosttySession(
  leafId: number,
  clientX: number,
  clientY: number,
  paths: readonly string[],
): boolean {
  const target = programDropTarget(leafId, clientX, clientY);
  if (!target) return false;
  target.model.drop?.(target.position, droppedPathItems(paths));
  return true;
}

/** The drag offered to the leaf's program left without dropping. */
export function leaveGhosttySessionDrag(leafId: number): void {
  const model = sessions.get(leafId)?.model;
  if (model && !model.isDisposed?.() && model.dropTargetActive?.())
    model.dragLeave?.();
}

export function ghosttySelectionForLeaf(leafId: number): string | null {
  return sessions.get(leafId)?.surface?.getSelection() ?? null;
}

export function ghosttyCwdForLeaf(leafId: number): string | null {
  return sessions.get(leafId)?.lastCwd ?? null;
}

export function ghosttyFocusedLeaf(): number | null {
  for (const [leafId, session] of sessions) {
    if (session.visible && session.focused) return leafId;
  }
  return null;
}

export async function whenGhosttySessionReady(
  leafId: number,
): Promise<boolean> {
  const session = sessions.get(leafId);
  if (!session) return false;
  await session.initializing;
  return (
    !!session.pty &&
    !!session.model &&
    !session.startupError &&
    !session.disposed
  );
}

export function ghosttyPtyIdForLeaf(leafId: number): number | null {
  return sessions.get(leafId)?.pty?.id ?? null;
}

export function ghosttyLeafIdForPty(ptyId: number): number | null {
  for (const [leafId, session] of sessions) {
    if (session.pty?.id === ptyId) return leafId;
  }
  return null;
}

export async function ghosttyLeafHasForegroundProcess(
  leafId: number,
): Promise<boolean> {
  const session = sessions.get(leafId);
  if (!session?.pty || session.shellExited) return false;
  try {
    return await invoke<boolean>("pty_has_foreground_process", {
      id: session.pty.id,
    });
  } catch (error) {
    console.error(
      "[terax] Ghostty pty_has_foreground_process failed for leaf",
      leafId,
      error,
    );
    return false;
  }
}

export function disposeGhosttySession(leafId: number): boolean {
  const session = sessions.get(leafId);
  if (!session) return false;
  session.disposed = true;
  session.generation += 1;
  session.input?.dispose();
  session.surface?.dispose();
  disposeGhosttyBlocks(leafId);
  session.model?.dispose();
  session.ptyResize.reset();
  session.writer.dispose();
  void session.pty?.close();
  session.pty = null;
  sessions.delete(leafId);
  useTerminalStatusStore.getState().clear(leafId);
  useTerminalFontOffsets.getState().clear(leafId);
  return true;
}

export type GhosttyScrollAction =
  | "page-up"
  | "page-down"
  | "top"
  | "bottom"
  | "prompt-previous"
  | "prompt-next";

/** Scrolls a pane's viewport; false when there is nothing to scroll. */
export function scrollGhosttySession(
  leafId: number,
  action: GhosttyScrollAction,
): boolean {
  const model = sessions.get(leafId)?.model;
  if (!model || model.isDisposed?.()) return false;
  const page = Math.max(1, model.rows - 1);
  switch (action) {
    case "page-up":
      return model.scrollBy(-page);
    case "page-down":
      return model.scrollBy(page);
    case "top":
      return model.scrollTo(model.scrollPosition().history);
    case "bottom":
      return model.scrollToBottom();
    case "prompt-previous":
      return model.scrollToPrompt?.(-1) ?? false;
    case "prompt-next":
      return model.scrollToPrompt?.(1) ?? false;
  }
}

/** The pane runs a full-screen program (alternate screen). */
export function ghosttySessionInAlternateScreen(leafId: number): boolean {
  return sessions.get(leafId)?.model?.modes().alternateScreen ?? false;
}

async function respawnGhosttySession(
  leafId: number,
  cwd?: string,
): Promise<boolean> {
  const session = sessions.get(leafId);
  if (!session || session.disposed) return false;
  session.generation += 1;
  session.input?.dispose();
  session.input = null;
  session.surface?.dispose();
  session.surface = null;
  session.surfaceOptions = null;
  ghosttyBlocks(leafId)?.detach();
  session.model?.dispose();
  session.model = null;
  session.callbacks.onModel?.(null);
  session.ptyResize.reset();
  session.writer.detach();
  session.writer.clear();
  await session.pty?.close();
  session.pty = null;
  session.shellExited = false;
  session.lastCwd = null;
  session.initialCwd = cwd ?? session.initialCwd;
  session.startupError = null;
  session.rendererError = null;
  session.callbacks.onError?.(null);
  session.initializing = null;
  await initializeSession(session);
  return true;
}

export function ghosttySessionDiagnostics() {
  return [...sessions.values()].map((session) => ({
    leafId: session.leafId,
    blocks: ghosttyBlocks(session.leafId)?.controller?.diagnostics() ?? null,
    pty: session.pty?.id ?? null,
    visible: session.visible,
    focused: session.focused,
    shellExited: session.shellExited,
    startupError: session.startupError,
    rendererError: session.rendererError,
    model: session.model?.diagnostics() ?? null,
    surface: session.surface?.diagnostics() ?? null,
    ptyResize: session.ptyResize.diagnostics(),
    pendingInputBytes: session.writer.pendingBytes,
    startup: startupDiagnostics(session.startup),
  }));
}

export function ghosttySessionResourceTotals() {
  let modelCellCapacity = 0;
  let modelRowCapacity = 0;
  let scrollbackLines = 0;
  let surfaceCpuBytes = 0;
  let surfaceGpuBufferBytes = 0;
  let canvasColorBytes = 0;
  let estimatedSwapchainBytes = 0;

  for (const session of sessions.values()) {
    const model = session.model?.diagnostics();
    modelCellCapacity += model?.bridgeCellCapacity ?? 0;
    modelRowCapacity += model?.bridgeRowCapacity ?? 0;
    scrollbackLines += model?.scrollbackLines ?? 0;
    const surface = session.surface;
    if (!surface) continue;
    if (surface.backend === "ghostty-webgpu") {
      const stats = surface.diagnostics();
      surfaceCpuBytes += stats.cpuBufferBytes;
      surfaceGpuBufferBytes += stats.gpuBufferBytes;
      canvasColorBytes += stats.canvasColorBytes;
      estimatedSwapchainBytes += stats.estimatedSwapchainBytes;
      continue;
    }
    const stats = surface.diagnostics();
    const renderer = stats.renderer;
    if (!renderer) continue;
    surfaceCpuBytes += renderer.cpuBufferBytes;
    surfaceGpuBufferBytes += renderer.gpuBufferBytes;
    canvasColorBytes += renderer.canvasColorBytes;
  }

  // The WebGPU swapchain belongs to the window canvases, not to the panes drawing into them.
  const windowCanvasBytes =
    webGpuTerminalRuntimeDiagnostics()?.canvases.colorBytes ?? 0;
  canvasColorBytes += windowCanvasBytes;
  estimatedSwapchainBytes += windowCanvasBytes * 3;

  return {
    modelCellCapacity,
    modelRowCapacity,
    scrollbackLines,
    surfaceCpuBytes,
    surfaceGpuBufferBytes,
    canvasColorBytes,
    estimatedSwapchainBytes,
  };
}

function ensureSession(
  leafId: number,
  backend: GhosttyBackend,
  initialCwd?: string,
  font?: TerminalFontSpec,
): GhosttySession {
  const existing = sessions.get(leafId);
  if (existing) {
    if (existing.backend !== backend) {
      throw new Error(
        `Ghostty backend changed for live leaf ${leafId}; reload is required`,
      );
    }
    return existing;
  }
  const ptyResize = new PtyResizeDelivery((cols, rows) => {
    const pty = sessions.get(leafId)?.pty;
    if (!pty) return false;
    void pty.resize(cols, rows);
    return true;
  });
  const session: GhosttySession = {
    leafId,
    backend,
    initialCwd,
    lastCwd: null,
    model: null,
    surface: null,
    surfaceOptions: null,
    input: null,
    pty: null,
    ptyResize,
    writer: new BoundedPtyWriter((error) => {
      console.error("[terax] Ghostty PTY write failed:", error);
    }),
    container: null,
    callbacks: {},
    visible: false,
    focused: false,
    startupError: null,
    rendererError: null,
    shellExited: false,
    disposed: false,
    generation: 0,
    initializing: null,
    startup: createStartupTimings(),
    font:
      font ??
      ({
        family: "monospace",
        size: 14,
        lineHeight: 1.2,
        letterSpacing: 0,
        weight: "400",
      } satisfies TerminalFontSpec),
  };
  sessions.set(leafId, session);
  return session;
}

function initializeSession(session: GhosttySession): Promise<void> {
  return startSessionInitialization(
    session,
    (generation) => initializeSessionGeneration(session, generation),
    (error) => {
      session.shellExited = session.pty === null;
      if (!session.pty) {
        session.input?.dispose();
        session.input = null;
        session.surface?.dispose();
        session.surface = null;
        session.surfaceOptions = null;
        ghosttyBlocks(session.leafId)?.detach();
        session.model?.dispose();
        session.model = null;
        session.writer.clear();
        session.ptyResize.reset();
      }
      session.startupError = toError(error).message;
      console.error("[terax] Ghostty session initialization failed:", error);
      session.callbacks.onError?.(sessionFailure(session));
    },
  );
}

async function initializeSessionGeneration(
  session: GhosttySession,
  generation: number,
): Promise<void> {
  // Starts loading saved history now; it is written before any shell output.
  const scrollback = new ScrollbackRestoreGate(
    terminalScrollback.takeRestore(session.leafId),
  );
  const preferences = usePreferencesStore.getState();
  const startup = createStartupTimings();
  session.startup = startup;
  const alive = () => !session.disposed && generation === session.generation;
  const mark = (key: keyof Omit<GhosttyStartupTimings, "startedAt">) => {
    if (alive() && startup[key] === null) {
      startup[key] = performance.now() - startup.startedAt;
    }
  };
  const theme = readTerminalGpuTheme(terminalThemeOptions());
  const coreRuntime = getGhosttyCoreRuntime();
  const metricsPromise = (async () => {
    await ensureMonoFontsLoaded();
    await loadFeatureFamilies(session.font.family);
    await document.fonts.ready;
    const initialFont = session.font;
    let metrics = await measureTerminalFont(initialFont);
    if (fontSpecKey(initialFont) !== fontSpecKey(session.font)) {
      metrics = await measureTerminalFont(session.font);
    }
    mark("fontsReadyMs");
    return metrics;
  })();
  const corePromise = coreRuntime.preload().then(() => mark("coreReadyMs"));
  const webGpuPreload = { error: null as Error | null };
  const rendererPromise =
    session.backend === "ghostty-webgpu"
      ? getWebGpuTerminalRuntime()
          .catch((error: unknown) => {
            webGpuPreload.error = toError(error);
          })
          .then(() => mark("gpuReadyMs"))
      : Promise.resolve().then(() => mark("gpuReadyMs"));
  const [metrics] = await Promise.all([
    metricsPromise,
    corePromise,
    rendererPromise,
  ]);
  if (!alive()) return;

  // Events name reads of this model; a later model must not answer them.
  let eventModel: GhosttyTerminalModelApi | null = null;
  const semanticEvents = new GhosttySemanticEventRouter({
    ...terminalIntegrationCallbacks({
      leafId: session.leafId,
      userIsLooking: () => session.visible && document.hasFocus(),
      reply: (bytes) => session.writer.enqueue(bytes, true),
      answerKittyClipboardRead: (id, answer) => {
        if (eventModel && !eventModel.isDisposed?.())
          eventModel.answerClipboardRead?.(id, answer);
      },
      pointerTarget: () => session.surface?.eventTarget() ?? null,
    }),
    onCwd: (cwd) => {
      if (session.lastCwd === cwd) return;
      session.lastCwd = cwd;
      session.callbacks.onCwd?.(cwd);
    },
    onClipboard: (text) => {
      programClipboard.enqueue(text);
    },
    onKittyClipboardWrite: (content, primary) => {
      if (!primary) programClipboard.enqueue(content);
      else if (typeof content === "string") void writePrimarySelection(content);
    },
    onOverflow: (dropped) => {
      console.warn(
        `[terax] Ghostty semantic event queue dropped ${dropped} event(s)`,
      );
    },
    onCommandState: (running) => {
      if (!running) mark("firstPromptMs");
    },
  });
  const model = await coreRuntime.createModel({
    leafId: session.leafId,
    backend: session.backend,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    config: {
      scrollbackLimit: preferences.terminalScrollback,
      fgColor: rgbToInt(theme.foreground),
      bgColor: rgbToInt(theme.background),
      cursorColor: rgbToInt(theme.cursor),
      palette: theme.palette.map(rgbToInt),
      cursorStyle: preferences.terminalCursorStyle,
      cursorBlink: preferences.terminalCursorBlink,
    },
    onReply: (bytes) => session.writer.enqueue(bytes, true),
    onEvent: (event) => {
      semanticEvents.handle(event);
      ghosttyBlocks(session.leafId)?.controller?.handle(
        event,
        session.lastCwd ?? session.initialCwd ?? "",
      );
    },
  });
  eventModel = model;
  if (session.disposed || generation !== session.generation) {
    model.dispose();
    return;
  }
  mark("modelReadyMs");
  model.setColorScheme?.(colorSchemeFor(theme.background));
  model.setVisible?.(session.visible);
  model.setTerminalVersion?.(await terminalVersion());
  if (!alive()) {
    model.dispose();
    return;
  }
  scrollback.connect((bytes) => {
    if (!alive() || model.isDisposed?.()) return;
    model.write(bytes);
    ghosttyBlocks(session.leafId)?.changed();
  });
  session.model = model;
  session.callbacks.onModel?.(model);
  const blockSession = ghosttyBlocks(session.leafId);
  if (blockSession) {
    blockSession.cellHeight = () => session.surface?.cellSize().height ?? 0;
    // The shell/prompt input switch only depends on the block mode, so it runs
    // when the mode changes instead of after every PTY chunk.
    blockSession.modeEffect = () => applyBlockInputMode(session);
  }
  await blockSession?.attach(model, () => session.surface?.requestFrame());
  if (!alive()) {
    if (ghosttyBlocks(session.leafId)?.model === model)
      ghosttyBlocks(session.leafId)?.detach();
    model.dispose();
    return;
  }

  const surfaceBaseOptions: GhosttySurfaceBaseOptions = {
    model,
    metrics,
    theme,
    cursorBlink: preferences.terminalCursorBlink,
    cursorStyle: preferences.terminalCursorStyle,
    onResize: (cols: number, rows: number) => {
      session.ptyResize.send(cols, rows);
    },
    onFirstFrame: () => mark("firstFrameMs"),
    onFrame: () => ghosttyBlocks(session.leafId)?.present(),
    onRequestFocus: () => focusGhosttySession(session.leafId),
    onOpenLink: (uri: string) => {
      void openTerminalLink(
        uri,
        session.lastCwd ?? session.initialCwd ?? null,
        () => focusGhosttySession(session.leafId),
      );
    },
  };
  session.surfaceOptions = surfaceBaseOptions;
  let webGpuFallbackStarted = false;
  const webGpuSurfaceOptions = {
    ...surfaceBaseOptions,
    onError: (error: Error) => {
      logSurfaceError("ghostty-webgpu", error);
      if (webGpuFallbackStarted) return;
      webGpuFallbackStarted = true;
      queueMicrotask(() => {
        fallbackWebGpuSurface(session, generation, surfaceBaseOptions, error);
      });
    },
  };
  let surface: GhosttySurface | null = null;
  if (session.backend === "ghostty-webgpu" && !webGpuPreload.error) {
    try {
      surface = await WebGpuTerminalSurface.create(webGpuSurfaceOptions);
    } catch (error) {
      webGpuPreload.error = toError(error);
    }
  }
  if (!surface) {
    surface = await loadSessionRenderer(
      session,
      generation,
      () => import("@/modules/terminal/ghostty/webgl/WebGlTerminalSurface"),
      (renderer) =>
        createWebGlFallbackSurface(
          session,
          generation,
          surfaceBaseOptions,
          renderer.WebGlTerminalSurface,
        ),
    );
    if (!surface) return;
  }
  if (webGpuPreload.error) {
    console.warn(
      "[terax] WebGPU initialization failed; preserving the Ghostty session with WebGL:",
      webGpuPreload.error.message,
    );
  }
  if (session.disposed || generation !== session.generation) {
    surface.dispose();
    model.dispose();
    return;
  }
  mark("surfaceReadyMs");
  session.surface = surface;
  session.input = createGhosttyInput(session, model, surface);

  if (session.visible && session.container) {
    try {
      attachGhosttySurface(session, surface);
    } catch (error) {
      if (surface.backend !== "ghostty-webgpu") throw error;
      try {
        surface = await replaceGhosttySurface(
          session,
          generation,
          surfaceBaseOptions,
        );
      } catch (fallbackError) {
        throw new Error(
          `WebGPU surface attachment failed (${toError(error).message}); WebGL fallback also failed (${toError(fallbackError).message})`,
        );
      }
      if (!surface) return;
      webGpuFallbackStarted = true;
      console.warn(
        "[terax] WebGPU surface attachment failed; preserved the Ghostty session with WebGL:",
        toError(error).message,
      );
    }
  }
  session.callbacks.onSearchReady?.(surface.searchController());

  const startCols = model.cols;
  const startRows = model.rows;
  const pty = await openPty(
    startCols,
    startRows,
    {
      onData: (bytes) => {
        if (!session.disposed && generation === session.generation) {
          mark("firstOutputMs");
          scrollback.write(bytes);
        }
      },
      onExit: (code) => {
        if (session.disposed || generation !== session.generation) return;
        session.shellExited = true;
        session.writer.detach();
        session.pty = null;
        session.callbacks.onExit?.(code);
      },
    },
    session.initialCwd,
    !!ghosttyBlocks(session.leafId),
    preferences.terminalShell || undefined,
    session.leafId,
  );
  if (session.disposed || generation !== session.generation) {
    await pty.close();
    return;
  }
  if (session.shellExited) {
    await pty.close();
    return;
  }
  mark("ptyReadyMs");
  session.pty = pty;
  session.writer.attach(pty);
  if (model.cols !== startCols || model.rows !== startRows) {
    session.ptyResize.send(model.cols, model.rows);
  }
}

function createGhosttyInput(
  session: GhosttySession,
  model: GhosttyTerminalModelApi,
  surface: GhosttySurface,
): GhosttyInputController {
  const insertPromptText = (text: string): boolean => {
    const blocks = ghosttyBlocks(session.leafId);
    if (blocks?.getMode() !== "prompt" || !blocks.paste) return false;
    blocks.paste(text);
    return true;
  };
  return new GhosttyInputController({
    model,
    input: surface.inputElement(),
    pointerTarget: surface.eventTarget(),
    cellSize: () => ({
      width: surface.cellSize().width,
      height: surface.cellSize().height,
    }),
    gridShiftY: () => surface.gridShiftY(),
    onData: (bytes) => {
      if (
        ghosttyBlocks(session.leafId)?.getMode() === "prompt" &&
        !(bytes.length === 1 && bytes[0] === 3)
      )
        return;
      session.writer.enqueue(bytes);
    },
    onKeyDown: (event) => {
      const blocks = ghosttyBlocks(session.leafId);
      return (
        blocks?.getMode() === "prompt" && (blocks.keyDown?.(event) ?? false)
      );
    },
    onText: insertPromptText,
    onPaste: insertPromptText,
    optionAsAlt: () =>
      usePreferencesStore.getState().terminalBehavior.optionAsAlt,
    scrollMultiplier: () =>
      usePreferencesStore.getState().terminalBehavior.scrollMultiplier,
    confirmPaste: async (text) =>
      !usePreferencesStore.getState().terminalBehavior.pasteProtection ||
      (await requestTerminalPrompt({ kind: "paste", text })) === "allow",
    onSelectionFinished: () => {
      const mode = usePreferencesStore.getState().terminalBehavior.copyOnSelect;
      const text = mode === "off" ? null : surface.getSelection();
      if (!text) return;
      void writePrimarySelection(text);
      if (mode === "clipboard")
        void writeTerminalClipboard(text).catch(() => {});
    },
    onMiddleClick: () => {
      if (
        !/Linux|X11/.test(navigator.userAgent) ||
        /Android/.test(navigator.userAgent)
      )
        return false;
      void readPrimarySelection().then((text) => {
        if (text) session.input?.pasteFromClipboard(text, true);
      });
      return true;
    },
    clipboardHasImage: async () => (await readClipboardImage()) !== null,
    getSelection: () => surface.getSelection(),
    onCopy: () => {
      const text = surface.getSelection();
      if (!text) return false;
      void writeTerminalClipboard(text).catch(() => {});
      return true;
    },
  });
}

export function focusGhosttySession(leafId: number): void {
  const session = sessions.get(leafId);
  if (session) focusSessionSurface(session, session.surface);
}

function focusSessionSurface(
  session: GhosttySession,
  surface: GhosttySurface | null,
): void {
  const blocks = ghosttyBlocks(session.leafId);
  if (blocks?.getMode() === "prompt" && blocks.focus) blocks.focus();
  else surface?.focus();
}

function applyBlockInputMode(
  session: GhosttySession,
  surface = session.surface,
): void {
  const input = surface?.inputElement();
  const blocks = ghosttyBlocks(session.leafId);
  if (!input || !blocks) return;
  const prompt = blocks.getMode() === "prompt";
  const changed =
    input.getAttribute("data-terax-block-prompt") !== String(prompt);
  if (!changed) return;
  input.setAttribute("data-terax-block-prompt", String(prompt));
  surface?.setCursorEnabled(!prompt);
  if (session.visible && session.focused) focusSessionSurface(session, surface);
}

/**
 * Cell height only: a plain read of cached font metrics. The per-frame block
 * overlay needs nothing else, and unlike {@link ghosttyBlockGeometry} it forces
 * no layout.
 */
export function ghosttyBlockCellHeight(leafId: number): number {
  return sessions.get(leafId)?.surface?.cellSize().height ?? 0;
}

/**
 * Surface top edge plus cell height. Reads the bounding rect (forces layout),
 * so it is for one-off pointer hit-testing, never for per-frame work.
 */
export function ghosttyBlockGeometry(
  leafId: number,
): { top: number; height: number } | null {
  const surface = sessions.get(leafId)?.surface;
  return surface
    ? {
        top: surface.eventTarget().getBoundingClientRect().top,
        height: surface.cellSize().height,
      }
    : null;
}

function attachGhosttySurface(
  session: GhosttySession,
  surface: GhosttySurface,
): void {
  if (!session.container) return;
  surface.attach(session.container);
  surface.setVisible(true);
  surface.setFocused(session.focused);
  applyBlockInputMode(session, surface);
  if (session.focused) focusSessionSurface(session, surface);
}

function createWebGlFallbackSurface(
  session: GhosttySession,
  generation: number,
  options: GhosttySurfaceBaseOptions,
  Surface: typeof WebGlTerminalSurface,
): WebGlTerminalSurface {
  const surface = new Surface({
    ...options,
    onError: (error) => {
      queueMicrotask(() => {
        if (
          !session.disposed &&
          generation === session.generation &&
          session.surface === surface
        ) {
          reportRendererFailure(session, error);
        }
      });
    },
  });
  return surface;
}

async function fallbackWebGpuSurface(
  session: GhosttySession,
  generation: number,
  options: GhosttySurfaceBaseOptions,
  cause: Error,
): Promise<void> {
  const failedSurface = session.surface;
  if (
    session.disposed ||
    generation !== session.generation ||
    failedSurface?.backend !== "ghostty-webgpu" ||
    !session.model
  ) {
    return;
  }

  try {
    if (!(await replaceGhosttySurface(session, generation, options))) return;
  } catch (error) {
    if (
      session.disposed ||
      session.generation !== generation ||
      session.surface !== failedSurface
    )
      return;
    reportRendererFailure(
      session,
      new Error(
        `WebGPU failed (${cause.message}); WebGL fallback failed (${toError(error).message})`,
      ),
    );
    return;
  }
  console.warn(
    "[terax] WebGPU renderer failed; preserved the live Ghostty model, PTY, and scrollback with WebGL:",
    cause.message,
  );
}

async function replaceGhosttySurface(
  session: GhosttySession,
  generation: number,
  options: GhosttySurfaceBaseOptions,
): Promise<GhosttySurface | null> {
  return loadSessionRenderer(
    session,
    generation,
    () => import("@/modules/terminal/ghostty/webgl/WebGlTerminalSurface"),
    (renderer) => {
      const currentOptions = session.surfaceOptions ?? options;
      const replacement = replaceSessionSurface(
        session,
        () =>
          createWebGlFallbackSurface(
            session,
            generation,
            currentOptions,
            renderer.WebGlTerminalSurface,
          ),
        (surface) => {
          if (session.visible && session.container)
            attachGhosttySurface(session, surface);
        },
        (surface) => createGhosttyInput(session, currentOptions.model, surface),
      );
      session.rendererError = null;
      session.callbacks.onError?.(sessionFailure(session));
      session.callbacks.onSearchReady?.(replacement.searchController());
      return replacement;
    },
  );
}

function reportRendererFailure(session: GhosttySession, error: Error): void {
  if (session.disposed) return;
  logSurfaceError(session.surface?.backend ?? session.backend, error);
  session.rendererError = error.message;
  session.surface?.setVisible(false);
  session.surface?.detach();
  session.callbacks.onError?.(sessionFailure(session));
}

async function retryGhosttyRenderer(session: GhosttySession): Promise<void> {
  if (session.disposed || !session.model || !session.surfaceOptions) return;
  const generation = session.generation;
  const failedSurface = session.surface;
  try {
    await replaceGhosttySurface(session, generation, session.surfaceOptions);
  } catch (error) {
    if (
      session.disposed ||
      session.generation !== generation ||
      session.surface !== failedSurface
    )
      return;
    reportRendererFailure(session, toError(error));
  }
}

function sessionFailure(session: GhosttySession): GhosttySessionFailure | null {
  if (session.startupError)
    return { kind: "startup", message: session.startupError };
  if (session.rendererError)
    return { kind: "renderer", message: session.rendererError };
  return null;
}

function logSurfaceError(backend: GhosttyBackend, error: Error): void {
  console.error(
    `[terax] ${backend} surface failed:`,
    error.message,
    error.stack ?? error,
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function createStartupTimings(): GhosttyStartupTimings {
  return {
    startedAt: performance.now(),
    fontsReadyMs: null,
    coreReadyMs: null,
    gpuReadyMs: null,
    modelReadyMs: null,
    surfaceReadyMs: null,
    ptyReadyMs: null,
    firstOutputMs: null,
    firstFrameMs: null,
    firstPromptMs: null,
  };
}

function startupDiagnostics(startup: GhosttyStartupTimings) {
  return {
    fontsReadyMs: startup.fontsReadyMs,
    coreReadyMs: startup.coreReadyMs,
    gpuReadyMs: startup.gpuReadyMs,
    modelReadyMs: startup.modelReadyMs,
    surfaceReadyMs: startup.surfaceReadyMs,
    ptyReadyMs: startup.ptyReadyMs,
    firstOutputMs: startup.firstOutputMs,
    firstFrameMs: startup.firstFrameMs,
    firstPromptMs: startup.firstPromptMs,
  };
}

async function updateSessionFont(
  session: GhosttySession,
  font: TerminalFontSpec,
): Promise<void> {
  if (fontSpecKey(session.font) === fontSpecKey(font)) return;
  session.font = font;
  if (!session.surface || session.disposed) return;

  await ensureMonoFontsLoaded();
  await loadFeatureFamilies(font.family);
  await document.fonts.ready;
  const metrics = await measureTerminalFont(font);
  if (
    session.disposed ||
    !session.surface ||
    fontSpecKey(session.font) !== fontSpecKey(font)
  ) {
    return;
  }
  session.surface.setFontMetrics(metrics);
  ghosttyBlocks(session.leafId)?.changed();
  if (session.surfaceOptions)
    session.surfaceOptions = { ...session.surfaceOptions, metrics };
}

function fontSpecKey(font: TerminalFontSpec): string {
  return [
    font.family,
    font.size,
    font.lineHeight,
    font.letterSpacing,
    font.weight,
  ].join("|");
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const leafId of [...sessions.keys()]) disposeGhosttySession(leafId);
  });
}
