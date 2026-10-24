import { toast } from "sonner";
import { flushPersist } from "@/modules/ai/store/chatStore";
import {
  type FlushResult,
  flushSessionWrites,
} from "@/modules/ai/lib/sessions";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openAppWindowCount, quitApp } from "@/lib/appWindow";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { Tab } from "@/modules/tabs";
import { leafHasForegroundProcess, leafIds } from "@/modules/terminal";
import { flushSpaces } from "@/modules/spaces/lib/useSpacePersistence";

async function anyTerminalBusy(tabs: Tab[]): Promise<boolean> {
  const leaves = tabs.flatMap((t) =>
    t.kind === "terminal" ? leafIds(t.paneTree) : [],
  );
  if (leaves.length === 0) return false;
  const checks = await Promise.all(leaves.map(leafHasForegroundProcess));
  return checks.some(Boolean);
}

/** How long closing waits for chat history to reach the disk. */
export const CLOSE_FLUSH_TIMEOUT_MS = 4_000;
/**
 * How long closing waits for terminal scrollback, saved alongside chat
 * history. Scrollback is a convenience, so it gets less time.
 */
export const CLOSE_SCROLLBACK_TIMEOUT_MS = 1_500;

/**
 * Failing to save chat history must never make the window impossible to close.
 * The first failed flush keeps the window open once, with a visible error and a
 * "Close anyway" action; any further close request closes immediately.
 */
export function closeAfterFlush(
  flush: Pick<FlushResult, "ok">,
  alreadyWarned: boolean,
): "close" | "warn" {
  return flush.ok || alreadyWarned ? "close" : "warn";
}

export async function boundedSpaceFlush(
  flush: () => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(flush),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch (error) {
    console.warn("Could not save spaces before closing", error);
  } finally {
    clearTimeout(timer);
  }
}

export type AppCloseBlocker = {
  dirtyEditors: number;
  busyTerminal: boolean;
};

/**
 * The opt-out only covers running processes, so it stays hidden whenever the
 * same prompt is also the last warning before discarding unsaved buffers.
 */
export function canOptOutOfAppClosePrompt(blocker: AppCloseBlocker): boolean {
  return blocker.busyTerminal && blocker.dirtyEditors === 0;
}

/** A close or quit waiting for the user to confirm. */
export type PendingAppClose = AppCloseBlocker & {
  /** Oarlock quits: a quit request, or the last window closing. */
  quits: boolean;
  /** The quit request this answers (`windows.rs`); null for a close. */
  quitRound: number | null;
};

function answerQuit(round: number, ok: boolean): void {
  void invoke("app_quit_ready", { round, ok }).catch(() => {});
}

/**
 * Guards closing this window and quitting Oarlock (asked of each window in turn
 * by `windows.rs`): running commands and unsaved files are confirmed first,
 * then chat history, scrollback and spaces are saved.
 */
export function useAppCloseGuard(tabsRef: RefObject<Tab[]>) {
  const [pendingAppClose, setPendingAppClose] =
    useState<PendingAppClose | null>(null);
  const forceClose = useRef(false);
  const closing = useRef(false);
  const warned = useRef(false);
  const closeWindow = useCallback(async () => {
    forceClose.current = true;
    try {
      await getCurrentWindow().close();
    } catch (error) {
      forceClose.current = false;
      toast.error("Could not close the window", {
        description: String(error),
      });
    }
  }, []);
  const blocker = useCallback(async (): Promise<AppCloseBlocker | null> => {
    // Opting out skips the per-leaf IPC entirely; it never relaxes the
    // unsaved-changes guard below.
    const busyTerminal =
      usePreferencesStore.getState().confirmCloseRunningTerminal &&
      (await anyTerminalBusy(tabsRef.current));
    // Count after the await so edits made during the IPC check are seen.
    const dirtyEditors = tabsRef.current.filter(
      (t) => t.kind === "editor" && t.dirty,
    ).length;
    return dirtyEditors > 0 || busyTerminal
      ? { dirtyEditors, busyTerminal }
      : null;
  }, [tabsRef]);
  /** Saves chat history, scrollback and spaces; reports the chat flush. */
  const saveState = useCallback(async () => {
    flushPersist();
    const [flush] = await Promise.all([
      flushSessionWrites({ timeoutMs: CLOSE_FLUSH_TIMEOUT_MS }),
      boundedSpaceFlush(flushSpaces, CLOSE_SCROLLBACK_TIMEOUT_MS),
    ]);
    return flush;
  }, []);
  const finishClose = useCallback(async () => {
    if (closing.current) return;
    closing.current = true;
    try {
      const flush = await saveState();
      if (closeAfterFlush(flush, warned.current) === "warn") {
        warned.current = true;
        toast.error("Could not save chat history", {
          id: "close-save-failed",
          duration: Number.POSITIVE_INFINITY,
          description: flush.timedOut
            ? "Saving is taking too long. The latest messages may be lost."
            : "The latest messages may be lost.",
          action: {
            label: "Close anyway",
            onClick: () => void closeWindow(),
          },
        });
        return;
      }
      await closeWindow();
    } finally {
      closing.current = false;
    }
  }, [closeWindow, saveState]);
  const finishQuit = useCallback(
    async (round: number) => {
      if (closing.current) return;
      closing.current = true;
      try {
        const flush = await saveState();
        if (closeAfterFlush(flush, warned.current) === "warn") {
          warned.current = true;
          answerQuit(round, false);
          toast.error("Could not save chat history", {
            id: "close-save-failed",
            duration: Number.POSITIVE_INFINITY,
            description: flush.timedOut
              ? "Saving is taking too long. The latest messages may be lost."
              : "The latest messages may be lost.",
            action: { label: "Quit anyway", onClick: () => void quitApp() },
          });
          return;
        }
        answerQuit(round, true);
      } finally {
        closing.current = false;
      }
    },
    [saveState],
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (forceClose.current) return;
        event.preventDefault();
        const found = await blocker();
        if (found) {
          const quits = (await openAppWindowCount()) <= 1;
          setPendingAppClose({ ...found, quits, quitRound: null });
        } else {
          void finishClose();
        }
      })
      .then((un) => {
        if (disposed) un();
        else unlisten = un;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [blocker, finishClose]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    const window = getCurrentWindow();
    void window
      .listen<number>("oarlock:quit-requested", async ({ payload: round }) => {
        const found = await blocker();
        if (!found) {
          void finishQuit(round);
          return;
        }
        // The user answers here, so this window comes forward.
        await window.unminimize().catch(() => {});
        await window.show().catch(() => {});
        await window.setFocus().catch(() => {});
        setPendingAppClose({ ...found, quits: true, quitRound: round });
      })
      .then((un) => {
        if (disposed) {
          un();
          return;
        }
        unlisten = un;
        // Only now can this window be asked before quitting.
        void invoke("app_window_ready").catch(() => {});
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [blocker, finishQuit]);

  const confirmAppClose = useCallback(() => {
    const round = pendingAppClose?.quitRound ?? null;
    setPendingAppClose(null);
    if (round === null) void finishClose();
    else void finishQuit(round);
  }, [pendingAppClose, finishClose, finishQuit]);

  const cancelAppClose = useCallback(() => {
    const round = pendingAppClose?.quitRound ?? null;
    if (round !== null) answerQuit(round, false);
    setPendingAppClose(null);
  }, [pendingAppClose]);

  return { pendingAppClose, confirmAppClose, cancelAppClose };
}
