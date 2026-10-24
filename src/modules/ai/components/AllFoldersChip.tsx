import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { FolderUnlockedIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

/**
 * Shown in the composer while "Allow AI tools to access all folders" is on,
 * so the wider reach is never silent. A click opens the setting.
 */
export function AllFoldersChip() {
  const on = usePreferencesStore((s) => s.aiAllFolders);
  if (!on) return null;
  return (
    <button
      type="button"
      onClick={() => void openSettingsWindow("general")}
      title="AI tools can read, write and run commands in any folder, not only the ones you opened. Secret files such as ~/.ssh and .env stay refused. Change it in Settings, General, Folder access."
      aria-label="AI tools can access all folders. Open the setting."
      className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-amber-500/45 bg-amber-500/15 px-1.5 text-[10.5px] font-medium text-amber-700 transition-colors hover:bg-amber-500/25 dark:text-amber-400"
    >
      <HugeiconsIcon icon={FolderUnlockedIcon} size={11} strokeWidth={2} />
      <span>All folders</span>
    </button>
  );
}
