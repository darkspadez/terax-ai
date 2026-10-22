import { IS_WINDOWS } from "@/lib/platform";

/**
 * A native drag-drop point in CSS pixels. Tauri labels it physical everywhere,
 * but wry reports the webview's physical client pixels only on Windows
 * (WebView2) and logical points on macOS and Linux.
 */
export function dropPointToCss(
  x: number,
  y: number,
  physical: boolean,
  ratio: number,
): { x: number; y: number } {
  if (!physical || !(ratio > 0)) return { x, y };
  return { x: x / ratio, y: y / ratio };
}

/** `dropPointToCss` for this platform and display. */
export function nativeDropPoint(position: { x: number; y: number }): {
  x: number;
  y: number;
} {
  return dropPointToCss(
    position.x,
    position.y,
    IS_WINDOWS,
    window.devicePixelRatio,
  );
}
