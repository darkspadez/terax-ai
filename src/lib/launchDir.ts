import { invoke } from "@tauri-apps/api/core";
import { isMainWindow, launchCwdFromUrl } from "./appWindow";

let cached: string | undefined;

/**
 * The main window starts where Terax was launched (drained once); another
 * window where the window that opened it was (`?cwd=`), else in the
 * process's directory.
 */
export async function initLaunchDir(): Promise<void> {
  const dir =
    (isMainWindow()
      ? await invoke<string | null>("get_launch_dir").catch(() => null)
      : launchCwdFromUrl(window.location.search)) ??
    (await invoke<string>("workspace_current_dir").catch(() => null));
  cached = dir ? dir.replace(/\\/g, "/") : undefined;
}

export function getLaunchDir(): string | undefined {
  return cached;
}

/**
 * Drains the files passed via the OS "Open With" action (CLI args on
 * Linux/Windows, macOS open-files event). Drained once so HMR / re-mounts
 * can't replay them. Returns [] when the app wasn't launched with a file.
 */
export async function consumeLaunchFiles(): Promise<string[]> {
  // Launch files are the main window's; later ones arrive as events.
  if (!isMainWindow()) return [];
  const files = await invoke<string[]>("get_launch_files").catch(() => []);
  return files.map((f) => f.replace(/\\/g, "/"));
}
