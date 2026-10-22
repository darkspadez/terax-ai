import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Terax's app windows (`src-tauri/src/modules/windows.rs`): `main` and the
 * extra windows the user opens, `w-<id>`. Each keeps its own spaces, saved
 * scrollback and active chat; preferences, chat history and the rest are
 * shared.
 */

const MAIN_WINDOW = "main";

const APP_WINDOW = /^(main|w-[A-Za-z0-9]{1,32})$/;

/** This page's window label; `main` outside Tauri (tests, a browser). */
export function appWindowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return MAIN_WINDOW;
  }
}

export function isAppWindowLabel(label: string): boolean {
  return APP_WINDOW.test(label);
}

export function isMainWindow(label = appWindowLabel()): boolean {
  return label === MAIN_WINDOW;
}

/** The window's spaces store, as `windows.rs` places it. */
export function spacesStorePath(label = appWindowLabel()): string {
  return isMainWindow(label)
    ? "terax-spaces.json"
    : `windows/${label}/terax-spaces.json`;
}

/** The key of the window's active chat in the chat store. */
export function activeChatKey(label = appWindowLabel()): string {
  return isMainWindow(label) ? "activeId" : `activeId:${label}`;
}

/** Where a new window's first terminal starts (`?cwd=`), if it was given. */
export function launchCwdFromUrl(search: string): string | null {
  const cwd = new URLSearchParams(search).get("cwd");
  return cwd ? cwd : null;
}

/** Opens another window, its first terminal in `cwd`. */
export function openNewWindow(cwd?: string | null): Promise<string> {
  return invoke<string>("app_window_open", { cwd: cwd ?? null });
}

/** Quits Terax once every window has confirmed. */
export function quitApp(): Promise<void> {
  return invoke("app_quit");
}

/** How many app windows are open, this one included. */
export async function openAppWindowCount(): Promise<number> {
  try {
    const { getAllWebviewWindows } = await import(
      "@tauri-apps/api/webviewWindow"
    );
    const windows = await getAllWebviewWindows();
    return windows.filter((window) => isAppWindowLabel(window.label)).length;
  } catch {
    return 1;
  }
}
