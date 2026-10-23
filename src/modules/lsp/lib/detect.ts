import { usePreferencesStore } from "@/modules/settings/preferences";
import { invoke } from "@tauri-apps/api/core";
import { useLspRuntimeStore } from "./runtimeStore";

const pending = new Map<string, Promise<string | null>>();

/**
 * The terminal shell set in Settings: servers get its environment (PATH), so
 * a binary is looked up through it. Null is the login shell.
 */
export function lspShell(): string | null {
  return usePreferencesStore.getState().terminalShell || null;
}

export function detectBinary(command: string): Promise<string | null> {
  const cached = useLspRuntimeStore.getState().detected[command];
  if (cached !== undefined) return Promise.resolve(cached);
  let p = pending.get(command);
  if (!p) {
    const request: Promise<string | null> = invoke<string | null>(
      "lsp_detect",
      { command, shell: lspShell() },
    )
      .catch(() => null)
      .then((path) => {
        // A lookup through a shell that is no longer set must not be kept.
        if (pending.get(command) !== request) return path;
        pending.delete(command);
        useLspRuntimeStore.getState().setDetected(command, path);
        return path;
      });
    p = request;
    pending.set(command, p);
  }
  return p;
}

export function redetectBinary(command: string): Promise<string | null> {
  pending.delete(command);
  useLspRuntimeStore.getState().clearDetected(command);
  return detectBinary(command);
}

/**
 * Another shell can find other servers: forget every lookup, and let enabled
 * servers without a session try again (their open files re-acquire).
 */
function handleShellChange(): void {
  pending.clear();
  useLspRuntimeStore.getState().resetDetections(
    Object.entries(usePreferencesStore.getState().lspActivation)
      .filter(([, activation]) => activation === "enabled")
      .map(([presetId]) => presetId),
  );
}

usePreferencesStore.subscribe((state, prev) => {
  if (state.terminalShell !== prev.terminalShell) handleShellChange();
});
