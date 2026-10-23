import { invoke } from "@tauri-apps/api/core";
import type { Access, SettingsPane } from "./lib/areas";

/** `mac_privacy_status`: probes files only Full Disk Access opens, which never prompts. macOS only. */
export async function fullDiskAccess(): Promise<Access> {
  const status = await invoke<{ fullDiskAccess: Access }>("mac_privacy_status");
  return status.fullDiskAccess;
}

/** Opens Privacy & Security in System Settings at `pane`. macOS only. */
export function openPrivacySettings(pane: SettingsPane): Promise<void> {
  return invoke("mac_privacy_open_settings", { pane });
}
