import { isTauri } from "@tauri-apps/api/core";

export async function readTerminalClipboard(): Promise<string> {
  try {
    if (isTauri()) {
      const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
      return await readText();
    }
    return (await navigator.clipboard?.readText()) ?? "";
  } catch {
    return "";
  }
}

export async function writeTerminalClipboard(text: string): Promise<void> {
  if (isTauri()) {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
    return;
  }
  if (!navigator.clipboard) throw new Error("Clipboard is unavailable");
  await navigator.clipboard.writeText(text);
}

/** Linux primary selection (copy-on-select, middle-click paste); a no-op elsewhere. */
export async function writePrimarySelection(text: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("terminal_primary_selection_write", { text });
  } catch {
    /* no primary selection on this platform or session */
  }
}

/** The Linux primary selection, or null where there is none. */
export async function readPrimarySelection(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string | null>("terminal_primary_selection_read");
  } catch {
    return null;
  }
}
