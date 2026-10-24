import {
  type TerminalLeafStatus,
  useTerminalStatusStore,
} from "./terminalStatus";

/** The window's taskbar or dock progress, summed up over every terminal. */
export type WindowProgress = {
  readonly status: "none" | "normal" | "indeterminate" | "paused" | "error";
  /** Percentage; null for an indeterminate bar or none. */
  readonly value: number | null;
};

export const NO_WINDOW_PROGRESS: WindowProgress = Object.freeze({
  status: "none",
  value: null,
});

/** Higher wins: a failure or a pause needs the user more than a busy bar. */
const RANK = { set: 1, indeterminate: 2, pause: 3, error: 4 } as const;
const STATUS = {
  set: "normal",
  indeterminate: "indeterminate",
  pause: "paused",
  error: "error",
} as const;

/**
 * One progress for the window from every pane's OSC 9;4 report, the way
 * Windows Terminal fills the taskbar: the most urgent state wins (error, then
 * paused, then indeterminate, then normal), and among panes in that state the
 * least advanced value shows, so the bar fills only when everything is done.
 * An error or pause without a value shows a full bar so its colour is seen.
 */
export function windowProgressOf(
  leaves: Readonly<Record<number, TerminalLeafStatus>>,
): WindowProgress {
  let state: keyof typeof RANK | null = null;
  let value: number | null = null;
  for (const leaf of Object.values(leaves)) {
    const progress = leaf.progress;
    if (!progress) continue;
    if (state === null || RANK[progress.state] > RANK[state]) {
      state = progress.state;
      value = progress.value;
    } else if (RANK[progress.state] === RANK[state]) {
      if (progress.value !== null)
        value =
          value === null ? progress.value : Math.min(value, progress.value);
    }
  }
  if (state === null) return NO_WINDOW_PROGRESS;
  if (state === "indeterminate")
    return { status: "indeterminate", value: null };
  const shown = value ?? (state === "error" || state === "pause" ? 100 : 0);
  return {
    status: STATUS[state],
    value: Math.max(0, Math.min(100, Math.round(shown))),
  };
}

type ProgressSink = (progress: WindowProgress) => Promise<void> | void;

async function setWindowProgressBar(progress: WindowProgress): Promise<void> {
  try {
    const { getCurrentWindow, ProgressBarStatus } = await import(
      "@tauri-apps/api/window"
    );
    const status = {
      none: ProgressBarStatus.None,
      normal: ProgressBarStatus.Normal,
      indeterminate: ProgressBarStatus.Indeterminate,
      paused: ProgressBarStatus.Paused,
      error: ProgressBarStatus.Error,
    }[progress.status];
    await getCurrentWindow().setProgressBar(
      progress.value === null
        ? { status }
        : { status, progress: progress.value },
    );
  } catch {
    /* not in Tauri, or the platform has no progress bar */
  }
}

/**
 * Keeps the window's progress bar in step with the terminals' reports until
 * the returned function is called, which clears it. Writes only on change.
 */
export function startWindowProgress(
  sink: ProgressSink = setWindowProgressBar,
): () => void {
  let shown = NO_WINDOW_PROGRESS;
  const apply = (leaves: Readonly<Record<number, TerminalLeafStatus>>) => {
    const next = windowProgressOf(leaves);
    if (next.status === shown.status && next.value === shown.value) return;
    shown = next;
    void sink(next);
  };
  apply(useTerminalStatusStore.getState().leaves);
  const unsubscribe = useTerminalStatusStore.subscribe((state, previous) => {
    if (state.leaves !== previous.leaves) apply(state.leaves);
  });
  return () => {
    unsubscribe();
    if (shown.status !== "none") void sink(NO_WINDOW_PROGRESS);
    shown = NO_WINDOW_PROGRESS;
  };
}
