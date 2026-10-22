import { invoke } from "@tauri-apps/api/core";
import {
  isMainWindow,
  launchCwdFromUrl,
  launchFolderFromUrl,
  withoutLaunchParams,
} from "./appWindow";

let cached: string | undefined;
let explicit: string | undefined;
let openedNow = false;

const forwardSlashes = (path: string) => path.replace(/\\/g, "/");

/**
 * The main window starts in the folder Terax was launched with (drained
 * once); another window in the folder a later launch opened it on, else where
 * the window that opened it was (`?cwd=`); else in the process's directory.
 */
export async function initLaunchDir(): Promise<void> {
  let folder: string | null;
  let cwd: string | null = null;
  if (isMainWindow()) {
    folder = await invoke<string | null>("get_launch_dir").catch(() => null);
  } else {
    const { search, pathname, hash } = window.location;
    folder = launchFolderFromUrl(search);
    cwd = launchCwdFromUrl(search);
    openedNow = folder !== null || cwd !== null;
    const rest = withoutLaunchParams(search);
    if (rest !== search) {
      window.history.replaceState(
        window.history.state,
        "",
        `${pathname}${rest}${hash}`,
      );
    }
  }
  const dir =
    folder ??
    cwd ??
    (await invoke<string>("workspace_current_dir").catch(() => null));
  explicit = folder ? forwardSlashes(folder) : undefined;
  cached = dir ? forwardSlashes(dir) : undefined;
}

export function getLaunchDir(): string | undefined {
  return cached;
}

/**
 * A folder Terax was asked to open (command line, Open in Terax, a later
 * launch), as opposed to the directory it merely started in: it wins over the
 * restored spaces.
 */
export function getExplicitLaunchDir(): string | undefined {
  return explicit;
}

/**
 * Whether this window was opened just now (New Window, a later launch) rather
 * than restored or started with the app: it comes to the front when it shows.
 */
export function isOpenedNow(): boolean {
  return openedNow;
}

/**
 * Takes the files the OS asked this window to open ("Open With": arguments
 * on Linux and Windows, a later launch, the macOS open-files event). Taken
 * once, so a reload or re-mount can't replay them; [] when none wait.
 */
export async function consumeLaunchFiles(): Promise<string[]> {
  const files = await invoke<string[]>("get_launch_files").catch(() => []);
  return files.map((f) => f.replace(/\\/g, "/"));
}
