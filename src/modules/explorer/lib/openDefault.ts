import { invoke } from "@tauri-apps/api/core";
import { showFileError } from "@/modules/mac-privacy";
import { currentWorkspaceEnv } from "@/modules/workspace";

/** `fs_open_default`: "cancelled" means the file runs as a program and the user said no. */
type OpenOutcome = "opened" | "cancelled";

/**
 * Opens a file in the app the OS associates with it. The backend opens a
 * document at once; for a file that would run as a program it asks first in
 * the OS's own dialog, which nothing in the page can answer.
 */
export async function openInDefaultApp(path: string): Promise<void> {
  try {
    await invoke<OpenOutcome>("fs_open_default", {
      path,
      workspace: currentWorkspaceEnv(),
    });
  } catch (e) {
    showFileError("Could not open the file", {
      path,
      error: e,
      description: String(e),
    });
  }
}
