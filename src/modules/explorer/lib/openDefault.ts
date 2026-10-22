import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { create } from "zustand";
import { currentWorkspaceEnv } from "@/modules/workspace";

/** `fs_open_default`: "confirm" means nothing opened because the file runs as a program. */
type OpenOutcome = "opened" | "confirm";

type PendingRun = {
  readonly path: string;
  readonly resolve: (run: boolean) => void;
};

type RunPromptStore = {
  readonly pending: PendingRun | null;
  answer: (run: boolean) => void;
};

export const useRunPromptStore = create<RunPromptStore>((set, get) => ({
  pending: null,
  answer: (run) => {
    const pending = get().pending;
    if (!pending) return;
    set({ pending: null });
    pending.resolve(run);
  },
}));

/** Asks whether to run `path`. A newer question declines the one still open. */
export function confirmRun(path: string): Promise<boolean> {
  useRunPromptStore.getState().answer(false);
  return new Promise((resolve) => {
    useRunPromptStore.setState({ pending: { path, resolve } });
  });
}

/**
 * Opens a file in the app the OS associates with it. The backend opens a
 * document at once and refuses a file that would run as a program until the
 * user has confirmed running it here.
 */
export async function openInDefaultApp(path: string): Promise<void> {
  const workspace = currentWorkspaceEnv();
  try {
    const outcome = await invoke<OpenOutcome>("fs_open_default", {
      path,
      workspace,
    });
    if (outcome !== "confirm" || !(await confirmRun(path))) return;
    await invoke<OpenOutcome>("fs_open_default", {
      path,
      workspace,
      confirmed: true,
    });
  } catch (e) {
    toast.error("Could not open the file", { description: String(e) });
  }
}
