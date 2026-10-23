import type { RefusedArea } from "./areas";
import { isOperationNotPermitted } from "./operationNotPermitted";

/** Below the home folder. Only Full Disk Access opens the `Library` ones. */
const HOME_AREAS: readonly (readonly [string, RefusedArea])[] = [
  ["Desktop", "desktop"],
  ["Documents", "documents"],
  ["Downloads", "downloads"],
  ["Library/Mobile Documents", "iCloudDrive"],
  ["Library/Mail", "fullDiskAccess"],
  ["Library/Messages", "fullDiskAccess"],
  ["Library/Safari", "fullDiskAccess"],
  ["Library/Cookies", "fullDiskAccess"],
  ["Library/HomeKit", "fullDiskAccess"],
  ["Library/IdentityServices", "fullDiskAccess"],
  ["Library/Suggestions", "fullDiskAccess"],
  ["Library/PersonalizationPortrait", "fullDiskAccess"],
  ["Library/Metadata/CoreSpotlight", "fullDiskAccess"],
  ["Library/Application Support/com.apple.TCC", "fullDiskAccess"],
  ["Library/Application Support/CallHistoryDB", "fullDiskAccess"],
  ["Library/Application Support/MobileSync", "fullDiskAccess"],
];

const SYSTEM_AREAS: readonly (readonly [string, RefusedArea])[] = [
  ["/Library/Application Support/com.apple.TCC", "fullDiskAccess"],
  ["/Library/Preferences/com.apple.TimeMachine.plist", "fullDiskAccess"],
];

/** A volume's own folder or anything in it; /Volumes itself is not protected. */
const VOLUME = /^\/volumes\/[^/]+(\/|$)/;

/**
 * The privacy grant that refused `error` on `path` (or the first of `paths`
 * that names one), or null when it is not a privacy refusal: another error, or
 * a path outside the protected places. `home` is the user's home folder, null
 * while unknown. Paths compare without regard to case, as macOS volumes do by
 * default.
 */
export function privacyRefusal(
  paths: string | readonly string[],
  error: unknown,
  home: string | null,
): RefusedArea | null {
  if (!isOperationNotPermitted(error)) return null;
  const homeKey = home ? comparable(home) : null;
  for (const path of typeof paths === "string" ? [paths] : paths) {
    const area = areaOf(comparable(path), homeKey);
    if (area) return area;
  }
  return null;
}

function areaOf(path: string, home: string | null): RefusedArea | null {
  if (!path.startsWith("/")) return null;
  if (home && home !== "/") {
    for (const [below, area] of HOME_AREAS) {
      if (within(path, `${home}/${below.toLowerCase()}`)) return area;
    }
  }
  for (const [place, area] of SYSTEM_AREAS) {
    if (within(path, place.toLowerCase())) return area;
  }
  return VOLUME.test(path) ? "volumes" : null;
}

function within(path: string, place: string): boolean {
  return path === place || path.startsWith(`${place}/`);
}

/** Lower case, with empty, `.` and `..` segments resolved. */
function comparable(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  const resolved = `${path.startsWith("/") ? "/" : ""}${segments.join("/")}`;
  return resolved.toLowerCase();
}

const REFUSALS: Record<RefusedArea, string> = {
  fullDiskAccess:
    "Only apps with Full Disk Access may open this, and Terax does not have it.",
  desktop:
    "macOS privacy settings do not allow Terax to use your Desktop folder.",
  documents:
    "macOS privacy settings do not allow Terax to use your Documents folder.",
  downloads:
    "macOS privacy settings do not allow Terax to use your Downloads folder.",
  iCloudDrive: "macOS privacy settings do not allow Terax to use iCloud Drive.",
  volumes:
    "macOS privacy settings do not allow Terax to use removable or network volumes.",
};

/** One sentence naming the grant a refusal needs. */
export function refusalMessage(area: RefusedArea): string {
  return REFUSALS[area];
}
