import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSyncExternalStore } from "react";
import { IS_MAC } from "@/lib/platform";

/** Whether the window fills its screen, the two ways chrome cares about. */
export type WindowFrame = {
  readonly maximized: boolean;
  readonly fullscreen: boolean;
};

type FrameWindow = {
  onResized(handler: () => void): Promise<() => void>;
  isMaximized(): Promise<boolean>;
  isFullscreen(): Promise<boolean>;
};

const NORMAL: WindowFrame = { maximized: false, fullscreen: false };

let frame = NORMAL;
const listeners = new Set<() => void>();

/**
 * Calls `read` and hands its result to `apply` every time `changed` reports a
 * change, one read at a time: a change during a read asks for one more read
 * after it, so the last state always lands and an older read never overwrites
 * a newer one, and a resize drag costs a read per round trip, not per event.
 * The listener is registered before the first read, so a change between the
 * two is not lost. A failed read keeps the last state.
 */
export async function followWindowFrame(
  changed: (handler: () => void) => Promise<() => void>,
  read: () => Promise<WindowFrame>,
  apply: (frame: WindowFrame) => void,
): Promise<() => void> {
  let reading = false;
  let again = false;
  let stopped = false;
  const sync = () => {
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    void read()
      .then((next) => {
        if (!stopped) apply(next);
      })
      .catch(() => {})
      .finally(() => {
        reading = false;
        if (again && !stopped) {
          again = false;
          sync();
        }
      });
  };
  const unlisten = await changed(sync);
  sync();
  return () => {
    stopped = true;
    unlisten();
  };
}

/**
 * The frame as chrome reads it: macOS draws its own corners, so only
 * fullscreen (which hides the traffic lights) matters there.
 */
function readFrame(window: FrameWindow): Promise<WindowFrame> {
  return Promise.all([
    IS_MAC ? false : window.isMaximized(),
    window.isFullscreen(),
  ]).then(([maximized, fullscreen]) => ({ maximized, fullscreen }));
}

function publish(next: WindowFrame): void {
  if (
    next.maximized === frame.maximized &&
    next.fullscreen === frame.fullscreen
  ) {
    return;
  }
  frame = next;
  const root = document.documentElement;
  root.toggleAttribute("data-window-maximized", next.maximized);
  root.toggleAttribute("data-window-fullscreen", next.fullscreen);
  for (const listener of [...listeners]) listener();
}

/**
 * Keeps `data-window-maximized` and `data-window-fullscreen` on `<html>` in
 * step with the current window, for chrome that changes with them (squared
 * corners, no traffic-light inset), and `useWindowFrame` for components.
 */
export function installWindowFrame(): void {
  const window = getCurrentWindow();
  void followWindowFrame(
    (handler) => window.onResized(handler),
    () => readFrame(window),
    publish,
  ).catch(() => {});
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useWindowFrame(): WindowFrame {
  return useSyncExternalStore(
    subscribe,
    () => frame,
    () => NORMAL,
  );
}
