/**
 * The macOS privacy grants (System Settings, Privacy & Security) that decide
 * which files Terax, and every program its terminals start, may read.
 */
export type PrivacyArea =
  | "fullDiskAccess"
  | "desktop"
  | "documents"
  | "downloads"
  | "iCloudDrive"
  | "removableVolumes"
  | "networkVolumes";

/**
 * Where a refused file lies. A path under /Volumes does not tell a removable
 * volume from a network one, so a refusal there names both.
 */
export type RefusedArea =
  | Exclude<PrivacyArea, "removableVolumes" | "networkVolumes">
  | "volumes";

/** Mirrors `SettingsPane` in `mac_privacy.rs`. */
export type SettingsPane = "fullDiskAccess" | "filesAndFolders";

/** Full Disk Access as `mac_privacy_status` reports it. */
export type Access = "allowed" | "denied" | "unknown";

export const PRIVACY_AREAS: readonly PrivacyArea[] = [
  "fullDiskAccess",
  "desktop",
  "documents",
  "downloads",
  "iCloudDrive",
  "removableVolumes",
  "networkVolumes",
];

/** Full Disk Access has a pane of its own; every folder and volume switch is under Files and Folders. */
export function settingsPaneFor(area: PrivacyArea | RefusedArea): SettingsPane {
  return area === "fullDiskAccess" ? "fullDiskAccess" : "filesAndFolders";
}

/**
 * What Terax can say about an area without making macOS ask. `askedOnFirstUse`:
 * only opening it would tell, and that could put up the prompt.
 */
export type AreaStatus =
  | "checking"
  | "allowed"
  | "denied"
  | "unknown"
  | "askedOnFirstUse";

/**
 * Full Disk Access is probed silently and covers every folder and volume.
 * Without it, a folder's own switch stays with macOS until Terax opens the
 * folder.
 */
export function areaStatus(
  area: PrivacyArea,
  fullDiskAccess: Access | null,
): AreaStatus {
  if (fullDiskAccess === null) return "checking";
  if (area === "fullDiskAccess") return fullDiskAccess;
  return fullDiskAccess === "allowed" ? "allowed" : "askedOnFirstUse";
}
