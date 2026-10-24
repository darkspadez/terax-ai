import { useSyncExternalStore } from "react";

/**
 * Whether this window shows what is behind it through its terminals (the
 * terminal opacity setting or a theme's translucent terminal background). Set
 * by the window's backdrop (`applyVibrancy`), so a window that never applies
 * one, such as the quick terminal, keeps its terminals opaque. While it is
 * set the page paints the terminal background at that opacity behind the
 * terminal area, and the renderers leave cells on the default background
 * transparent.
 */
let translucent = false;
const listeners = new Set<() => void>();

export function setTerminalTranslucent(value: boolean): void {
  if (value === translucent) return;
  translucent = value;
  for (const listener of [...listeners]) listener();
}

export function terminalTranslucent(): boolean {
  return translucent;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTerminalTranslucent(): boolean {
  return useSyncExternalStore(subscribe, terminalTranslucent);
}

/**
 * How opaque terminal backgrounds are: the theme's own alpha times the
 * setting. Below 1 the window is see-through there.
 */
export function terminalBackgroundOpacity(
  themeAlpha: number,
  setting: number,
): number {
  const clamp = (value: number) =>
    Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
  return clamp(themeAlpha) * clamp(setting);
}
