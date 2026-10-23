// Loaded by the main window on macOS until the notice has been answered.
import { toast } from "sonner";
import { shouldSuggestFullDiskAccess } from "./lib/suggestion";
import { fullDiskAccess, openPrivacySettings } from "./native";

/**
 * Suggests Full Disk Access in a notice that blocks nothing: Open System
 * Settings, or Not now. Either answer, or closing the notice, goes to
 * `keepAnswer`, so it shows once; the same action stays in Settings, General,
 * Privacy.
 */
export async function suggestFullDiskAccess(
  keepAnswer: () => Promise<void>,
): Promise<void> {
  const access = await fullDiskAccess().catch(() => "unknown" as const);
  if (!shouldSuggestFullDiskAccess(access)) return;

  let kept = false;
  const keep = () => {
    if (kept) return;
    kept = true;
    void keepAnswer().catch((error) =>
      console.error("[mac-privacy] could not keep the answer:", error),
    );
  };
  toast("Allow commands in Terax to reach protected folders?", {
    description:
      "macOS treats commands run in Terax as Terax: it asks before they open Desktop, Documents, Downloads, iCloud Drive or external drives, and keeps them out of data such as Mail and Safari. Full Disk Access allows all of it. It is also in Settings, General, Privacy.",
    duration: Number.POSITIVE_INFINITY,
    action: {
      label: "Open System Settings",
      onClick: () => {
        keep();
        void openPrivacySettings("fullDiskAccess").catch((error) =>
          console.error("[mac-privacy] could not open System Settings:", error),
        );
      },
    },
    cancel: { label: "Not now", onClick: keep },
    onDismiss: keep,
  });
}
