/**
 * What the AI toggle (Cmd+I, the status bar's AI button) does. An open panel
 * closes, also with no provider connected: another path (attaching a
 * command's output) opens it then, showing only the connect banner, which
 * has no close button of its own. A closed panel opens, or without a
 * provider Settings opens on Models.
 */
export function aiToggleAction(
  panelOpen: boolean,
  hasComposer: boolean,
): "close" | "open" | "connect" {
  if (panelOpen) return "close";
  return hasComposer ? "open" : "connect";
}
