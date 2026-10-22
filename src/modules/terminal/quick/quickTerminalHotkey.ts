import { usePreferencesStore } from "@/modules/settings/preferences";
import type { QuickTerminalHotkey } from "@/modules/settings/terminalBehavior";
import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { toast } from "sonner";

/** The accelerator to register for a hotkey preference, or null for none. */
export function quickTerminalAccelerator(
  hotkey: QuickTerminalHotkey,
): string | null {
  return hotkey === "off" ? null : hotkey;
}

type Register = (accelerator: string | null) => Promise<unknown>;
type Report = (error: unknown) => void;

const register: Register = (accelerator) =>
  invoke("quick_terminal_set_hotkey", { accelerator });

const report: Report = (error) => {
  toast.error("Could not set the quick terminal hotkey", {
    description: String(error),
  });
};

/**
 * Registers `hotkey` system-wide, replacing the previous one ("off" removes
 * it). A hotkey the system refuses (taken by another app, or a Wayland
 * session without global shortcuts) is reported, never thrown.
 */
export async function applyQuickTerminalHotkey(
  hotkey: QuickTerminalHotkey,
  registerHotkey: Register = register,
  reportError: Report = report,
): Promise<void> {
  try {
    await registerHotkey(quickTerminalAccelerator(hotkey));
  } catch (error) {
    reportError(error);
  }
}

/**
 * Keeps the quick terminal hotkey registered as the preference says. Main
 * window only: the registration is process-wide.
 */
export function useQuickTerminalHotkey(): void {
  const hydrated = usePreferencesStore((state) => state.hydrated);
  const hotkey = usePreferencesStore(
    (state) => state.terminalBehavior.quickTerminalHotkey,
  );
  useEffect(() => {
    if (hydrated) void applyQuickTerminalHotkey(hotkey);
  }, [hydrated, hotkey]);
}
