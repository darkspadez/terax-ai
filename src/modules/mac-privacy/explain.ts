// Loaded with the first "Operation not permitted" on macOS, never at startup.
import { homeDir } from "@tauri-apps/api/path";
import {
  type Access,
  type RefusedArea,
  type SettingsPane,
  settingsPaneFor,
} from "./lib/areas";
import { privacyRefusal, refusalMessage } from "./lib/refusal";
import { fullDiskAccess } from "./native";

export type PrivacyRefusal = {
  area: RefusedArea;
  message: string;
  pane: SettingsPane;
};

let home: Promise<string | null> | undefined;
let access: Promise<Access> | undefined;

function homeFolder(): Promise<string | null> {
  home ??= homeDir().catch(() => null);
  return home;
}

// Full Disk Access changes in System Settings, so the answer lasts until the
// window next gains focus.
function currentAccess(): Promise<Access> {
  if (!access) {
    access = fullDiskAccess().catch(() => "unknown" as const);
    window.addEventListener(
      "focus",
      () => {
        access = undefined;
      },
      { once: true },
    );
  }
  return access;
}

/**
 * The grant behind an EPERM on `paths`, or null outside the protected places
 * or when Oarlock has Full Disk Access: then something else refused it, such as
 * a locked file.
 */
export async function explainRefusal(
  paths: string | readonly string[],
  error: unknown,
): Promise<PrivacyRefusal | null> {
  const area = privacyRefusal(paths, error, await homeFolder());
  if (!area || (await currentAccess()) === "allowed") return null;
  return { area, message: refusalMessage(area), pane: settingsPaneFor(area) };
}
