import { nativeDropPoint } from "@/lib/nativeDropPoint";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect } from "react";
import { useTerminalDropStore } from "./dropStore";
import { formatDroppedPaths } from "./quoteShellPath";
import {
  dropOnSession,
  leaveSessionDrag,
  offerDragToSession,
  pasteIntoSession,
} from "./terminalSessionApi";

export type TerminalPathDropTarget = {
  updateTarget: (clientX: number, clientY: number) => boolean;
  dropPath: (paths: string[], clientX: number, clientY: number) => boolean;
  clearTarget: () => void;
};

/**
 * Hands drags to the program in a leaf when it registered for drops (Kitty
 * OSC 72); each call is false when the program did not, so the app pastes.
 */
type TerminalProgramDrop = {
  offer: (leafId: number, clientX: number, clientY: number) => boolean;
  drop: (
    leafId: number,
    clientX: number,
    clientY: number,
    paths: string[],
  ) => boolean;
  leave: (leafId: number) => void;
};

type TerminalPathDropDeps = {
  leafIdAtPoint: (clientX: number, clientY: number) => number | null;
  paste: (leafId: number, text: string) => boolean;
  setTarget: (leafId: number | null) => void;
  program?: TerminalProgramDrop;
};

function leafIdAt(x: number, y: number): number | null {
  const el = document.elementFromPoint(x, y);
  const leafEl = el?.closest<HTMLElement>("[data-pane-leaf]");
  if (!leafEl) return null;
  const id = Number(leafEl.dataset.paneLeaf);
  return Number.isFinite(id) ? id : null;
}

/**
 * Tracks the terminal leaf under a drag. A program there that registered for
 * drops gets the drag itself (no paste overlay); otherwise dropped paths are
 * pasted shell-quoted.
 */
export function createTerminalPathDropTarget({
  leafIdAtPoint,
  paste,
  setTarget,
  program,
}: TerminalPathDropDeps): TerminalPathDropTarget {
  // The leaf whose program is being offered the drag.
  let programLeaf: number | null = null;
  const leaveProgram = (unless: number | null) => {
    if (programLeaf === null || programLeaf === unless) return;
    program?.leave(programLeaf);
    programLeaf = null;
  };
  return {
    updateTarget(clientX, clientY) {
      const leafId = leafIdAtPoint(clientX, clientY);
      leaveProgram(leafId);
      if (leafId !== null && program?.offer(leafId, clientX, clientY)) {
        programLeaf = leafId;
        setTarget(null);
        return true;
      }
      leaveProgram(null);
      setTarget(leafId);
      return leafId !== null;
    },
    dropPath(paths, clientX, clientY) {
      setTarget(null);
      const leafId = leafIdAtPoint(clientX, clientY);
      leaveProgram(leafId);
      if (leafId === null) return false;
      if (program?.drop(leafId, clientX, clientY, paths)) {
        programLeaf = null;
        return true;
      }
      leaveProgram(null);
      paste(leafId, formatDroppedPaths(paths));
      return true;
    },
    clearTarget() {
      leaveProgram(null);
      setTarget(null);
    },
  };
}

const terminalPathDropTarget = createTerminalPathDropTarget({
  leafIdAtPoint: leafIdAt,
  paste: pasteIntoSession,
  setTarget: (leafId) => useTerminalDropStore.getState().setTarget(leafId),
  program: {
    offer: offerDragToSession,
    drop: dropOnSession,
    leave: leaveSessionDrag,
  },
});

/** Wires native OS file drops into the terminal pane under the cursor: shows a
 * drop overlay on that pane while dragging, and bracketed-pastes the
 * shell-quoted path(s) on drop, unless the program there registered for drops
 * and takes them itself. Drops outside any terminal leaf are ignored. */
export function useTerminalFileDrop(): TerminalPathDropTarget {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const target = terminalPathDropTarget;

    void getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === "leave") {
          target.clearTarget();
          return;
        }
        const { x, y } = nativeDropPoint(p.position);
        if (p.type === "enter" || p.type === "over") {
          target.updateTarget(x, y);
          return;
        }
        if (p.type === "drop") {
          if (p.paths.length) target.dropPath(p.paths, x, y);
          else target.clearTarget();
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((err) => console.error("[terax] drag-drop listen failed:", err));

    return () => {
      disposed = true;
      target.clearTarget();
      unlisten?.();
    };
  }, []);

  return terminalPathDropTarget;
}
