import type { BlockMode } from "@/modules/terminal/block/lib/modeMachine";
import {
  clearGhosttySession,
  disposeGhosttySession,
  dropOnGhosttySession,
  focusGhosttySession,
  ghosttyFocusedLeaf,
  ghosttyLeafHasForegroundProcess,
  ghosttyLeafIdForPty,
  ghosttyCwdForLeaf,
  ghosttyPtyIdForLeaf,
  ghosttySelectionForLeaf,
  ghosttySessionInAlternateScreen,
  type GhosttyScrollAction,
  hasGhosttySession,
  interruptGhosttySession,
  leaveGhosttySessionDrag,
  offerDragToGhosttySession,
  pasteIntoGhosttySession,
  scrollGhosttySession,
  submitToGhosttySession,
  whenGhosttySessionReady,
  writeToGhosttySession,
} from "@/modules/terminal/ghostty/useGhosttyTerminalSession";
import {
  disposeGhosttyBlocks,
  ensureGhosttyBlocks,
  ghosttyBlocks,
} from "@/modules/terminal/ghostty/ghosttyBlockSessions";
export type { WatermarkState } from "@/modules/terminal/ghostty/ghosttyBlockSessions";
import { forgetLeafPresentation } from "@/modules/terminal/lib/ptyPresentation";
import { useTerminalFontOffsets } from "@/modules/terminal/lib/terminalFontOffsets";
import type { WatermarkState } from "@/modules/terminal/ghostty/ghosttyBlockSessions";

export async function whenSessionReady(
  leafId: number,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(0, deadline - Date.now());
    if (hasGhosttySession(leafId)) {
      await withTimeout(whenGhosttySessionReady(leafId), remaining);
      return;
    }
    await delay(Math.min(10, remaining));
  }
}

export function writeToSession(leafId: number, data: string): boolean {
  return writeToGhosttySession(leafId, data);
}

export function submitToLeaf(leafId: number, text: string): void {
  submitToGhosttySession(leafId, text);
}

export function interruptLeaf(leafId: number): void {
  interruptGhosttySession(leafId);
}

export function pasteIntoSession(leafId: number, text: string): boolean {
  return pasteIntoGhosttySession(leafId, text);
}

/**
 * Offers a drag of files over the leaf to the program running there; false
 * when it did not register for drops (Kitty OSC 72), so the drop pastes.
 */
export function offerDragToSession(
  leafId: number,
  clientX: number,
  clientY: number,
): boolean {
  return offerDragToGhosttySession(leafId, clientX, clientY);
}

/** Drops files on the leaf's program; false when it takes no drops. */
export function dropOnSession(
  leafId: number,
  clientX: number,
  clientY: number,
  paths: readonly string[],
): boolean {
  return dropOnGhosttySession(leafId, clientX, clientY, paths);
}

/** A drag offered to the leaf's program left without dropping. */
export function leaveSessionDrag(leafId: number): void {
  leaveGhosttySessionDrag(leafId);
}

export function leafCwd(leafId: number): string | null {
  return ghosttyCwdForLeaf(leafId);
}

export function navigateFocusedBlocks(direction: -1 | 1): boolean {
  const leaf = ghosttyFocusedLeaf();
  if (leaf === null) return false;
  const controller = ghosttyBlocks(leaf)?.controller;
  if (controller) return controller.navigate(direction);
  // Plain terminals jump between the prompts shell integration marks.
  return scrollGhosttySession(
    leaf,
    direction < 0 ? "prompt-previous" : "prompt-next",
  );
}

/** Scrolls the focused pane (page, top, bottom). */
export function scrollFocusedTerminal(action: GhosttyScrollAction): boolean {
  const leaf = ghosttyFocusedLeaf();
  return leaf !== null && scrollGhosttySession(leaf, action);
}

/** The focused pane runs a full-screen program, which keeps its keys. */
export function focusedTerminalInAlternateScreen(): boolean {
  const leaf = ghosttyFocusedLeaf();
  return leaf !== null && ghosttySessionInAlternateScreen(leaf);
}

/** Grows, shrinks or resets the focused pane's text size. */
export function adjustFocusedTerminalFont(delta: number | "reset"): boolean {
  const leaf = ghosttyFocusedLeaf();
  if (leaf === null) return false;
  useTerminalFontOffsets.getState().adjust(leaf, delta);
  return true;
}

export function clearLeafBlockSelection(leafId: number): boolean {
  return ghosttyBlocks(leafId)?.controller?.clearSelection() ?? false;
}

export function leafGridSelection(leafId: number): string | null {
  return ghosttySelectionForLeaf(leafId);
}

export function getLeafBlockMode(leafId: number): BlockMode {
  return ghosttyBlocks(leafId)?.getMode() ?? "plain";
}

export function subscribeLeafBlockMode(
  leafId: number,
  callback: () => void,
): () => void {
  return ensureGhosttyBlocks(leafId).subscribeMode(callback);
}

export function setLeafInputFocus(
  leafId: number,
  callback: (() => void) | null,
): void {
  const state = callback ? ensureGhosttyBlocks(leafId) : ghosttyBlocks(leafId);
  if (state) state.focus = callback;
}

export function setLeafInputPaste(
  leafId: number,
  paste: ((text: string) => void) | null,
): void {
  const state = paste ? ensureGhosttyBlocks(leafId) : ghosttyBlocks(leafId);
  if (state) state.paste = paste;
}

export function setLeafInputKeyDown(
  leafId: number,
  handler: ((event: KeyboardEvent) => boolean) | null,
): void {
  const state = handler ? ensureGhosttyBlocks(leafId) : ghosttyBlocks(leafId);
  if (state) state.keyDown = handler;
}

export function focusLeafInput(leafId: number): void {
  const state = ghosttyBlocks(leafId);
  if (state?.getMode() === "prompt" && state.focus) state.focus();
  else focusGhosttySession(leafId);
}

export function getLeafDraft(leafId: number): string {
  return ghosttyBlocks(leafId)?.draft ?? "";
}

export function setLeafDraft(leafId: number, text: string): void {
  const state = ghosttyBlocks(leafId);
  if (state) state.draft = text;
}

export function setLeafInputActivity(leafId: number, active: boolean): void {
  const blocks = ghosttyBlocks(leafId);
  if (!blocks || blocks.inputActive === active) return;
  blocks.inputActive = active;
  blocks.changed();
}

export function blockWatermarkState(leafId: number): WatermarkState {
  return ghosttyBlocks(leafId)?.watermark() ?? "hidden";
}

export function clearFocusedTerminal(): boolean {
  const ghosttyLeaf = ghosttyFocusedLeaf();
  if (ghosttyLeaf !== null) return clearGhosttySession(ghosttyLeaf);
  return false;
}

export function leafIdForPty(ptyId: number): number | null {
  return ghosttyLeafIdForPty(ptyId);
}

export function ptyIdForLeaf(leafId: number): number | null {
  return ghosttyPtyIdForLeaf(leafId);
}

export async function leafHasForegroundProcess(
  leafId: number,
): Promise<boolean> {
  return ghosttyLeafHasForegroundProcess(leafId);
}

export function disposeSession(leafId: number): void {
  disposeGhosttySession(leafId);
  disposeGhosttyBlocks(leafId);
  forgetLeafPresentation(leafId);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
