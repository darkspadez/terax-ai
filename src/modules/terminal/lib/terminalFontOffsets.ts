import { create } from "zustand";

/** Per-pane font size steps, in points, on top of the configured size. */
export const TERMINAL_FONT_OFFSET_LIMIT = 24;

type TerminalFontOffsets = {
  readonly offsets: Readonly<Record<number, number>>;
  /** Grows (positive) or shrinks one pane's text; 0 resets it. */
  adjust: (leafId: number, delta: number | "reset") => void;
  clear: (leafId: number) => void;
};

export const useTerminalFontOffsets = create<TerminalFontOffsets>((set) => ({
  offsets: {},
  adjust: (leafId, delta) =>
    set((state) => {
      const current = state.offsets[leafId] ?? 0;
      const next =
        delta === "reset"
          ? 0
          : Math.max(
              -TERMINAL_FONT_OFFSET_LIMIT,
              Math.min(TERMINAL_FONT_OFFSET_LIMIT, current + delta),
            );
      if (next === current) return state;
      const offsets = { ...state.offsets };
      if (next === 0) delete offsets[leafId];
      else offsets[leafId] = next;
      return { offsets };
    }),
  clear: (leafId) =>
    set((state) => {
      if (!(leafId in state.offsets)) return state;
      const offsets = { ...state.offsets };
      delete offsets[leafId];
      return { offsets };
    }),
}));
