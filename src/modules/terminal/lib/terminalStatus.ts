import type { GhosttyProgressState } from "@terax/ghostty-core/protocol";
import { create } from "zustand";

/** An OSC 9;4 progress report; `value` is a percentage when the program sent one. */
export type TerminalProgress = {
  readonly state: Exclude<GhosttyProgressState, "remove">;
  readonly value: number | null;
};

/** What a terminal pane reports about itself, keyed by pane (leaf) id. */
export type TerminalLeafStatus = {
  /** Title set by the program (OSC 0/2); null when none or after a reset. */
  readonly title: string | null;
  readonly progress: TerminalProgress | null;
  /** The bell rang while the pane was not in front of the user. */
  readonly bell: boolean;
  /** A command is running (shell integration). */
  readonly running: boolean;
};

const IDLE: TerminalLeafStatus = Object.freeze({
  title: null,
  progress: null,
  bell: false,
  running: false,
});

type TerminalStatusStore = {
  leaves: Readonly<Record<number, TerminalLeafStatus>>;
  update: (leafId: number, patch: Partial<TerminalLeafStatus>) => void;
  /** The user looked at these panes: clear their bell marks. */
  acknowledgeBell: (leafIds: readonly number[]) => void;
  clear: (leafId: number) => void;
};

export const useTerminalStatusStore = create<TerminalStatusStore>((set) => ({
  leaves: {},
  update: (leafId, patch) =>
    set((state) => {
      const current = state.leaves[leafId] ?? IDLE;
      let changed = false;
      for (const key of Object.keys(patch) as (keyof TerminalLeafStatus)[]) {
        if (!sameValue(current[key], patch[key])) changed = true;
      }
      if (!changed) return state;
      return {
        leaves: { ...state.leaves, [leafId]: { ...current, ...patch } },
      };
    }),
  acknowledgeBell: (leafIds) =>
    set((state) => {
      let leaves: Record<number, TerminalLeafStatus> | null = null;
      for (const id of leafIds) {
        const current = state.leaves[id];
        if (!current?.bell) continue;
        leaves ??= { ...state.leaves };
        leaves[id] = { ...current, bell: false };
      }
      return leaves ? { leaves } : state;
    }),
  clear: (leafId) =>
    set((state) => {
      if (!(leafId in state.leaves)) return state;
      const leaves = { ...state.leaves };
      delete leaves[leafId];
      return { leaves };
    }),
}));

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => left[key] === right[key])
  );
}

export function terminalLeafStatus(leafId: number): TerminalLeafStatus {
  return useTerminalStatusStore.getState().leaves[leafId] ?? IDLE;
}

/**
 * What a terminal tab shows, from its panes: the active pane's program title
 * while a command runs there, the most urgent progress of any pane (error,
 * then paused, then running), and whether any pane rang the bell.
 */
export type TerminalTabStatus = {
  readonly title: string | null;
  readonly progress: TerminalProgress | null;
  readonly bell: boolean;
};

const PROGRESS_PRIORITY: Record<TerminalProgress["state"], number> = {
  error: 3,
  pause: 2,
  set: 1,
  indeterminate: 1,
};

export function selectTerminalTabStatus(
  leaves: Readonly<Record<number, TerminalLeafStatus>>,
  leafIds: readonly number[],
  activeLeafId: number,
): TerminalTabStatus {
  const active = leaves[activeLeafId];
  let progress: TerminalProgress | null = null;
  let bell = false;
  for (const id of leafIds) {
    const leaf = leaves[id];
    if (!leaf) continue;
    bell ||= leaf.bell;
    if (
      leaf.progress &&
      (!progress ||
        PROGRESS_PRIORITY[leaf.progress.state] >
          PROGRESS_PRIORITY[progress.state])
    ) {
      progress = leaf.progress;
    }
  }
  return {
    title: active?.running && active.title ? active.title : null,
    progress,
    bell,
  };
}
