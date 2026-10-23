import { Switch } from "@/components/ui/switch";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setAiAllFolders, setAppAllFolders } from "@/modules/settings/store";
import { FolderUnlockedIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { SettingRow } from "../components/SettingRow";

const GROUP_ID = "settings-folder-access";

/** Who may reach every folder, in words; null while neither may. */
function allFoldersSummary(app: boolean, ai: boolean): string | null {
  if (app && ai) return "The app and the AI tools can access all folders";
  if (app) return "The app can access all folders";
  if (ai) return "AI tools can access all folders";
  return null;
}

/**
 * Two switches that lift the authorized-folder limit, each on its own and at
 * the user's own risk: one for the app's file features, one for the AI tools.
 */
export function FolderAccessSettings() {
  const app = usePreferencesStore((s) => s.appAllFolders);
  const ai = usePreferencesStore((s) => s.aiAllFolders);

  return (
    <div id={GROUP_ID} className="flex scroll-mt-4 flex-col gap-2">
      <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
        Folder access
      </span>
      <p className="text-[11px] text-muted-foreground">
        Oarlock works in the folders you open, browse or run a terminal in. Each
        switch below lifts that limit for one side only.
      </p>
      <SettingRow
        title={<RiskTitle>Allow the app to access all folders</RiskTitle>}
        description="The explorer, editor, previews, search, file watching, path completion and Open in Default App work in any folder, not only the ones you opened. Previews still skip dot folders such as .ssh, and running a program still asks. The AI tools are not affected."
      >
        <Switch
          checked={app}
          onCheckedChange={(v) => void setAppAllFolders(v)}
          aria-label="Allow the app to access all folders"
        />
      </SettingRow>
      <SettingRow
        title={<RiskTitle>Allow AI tools to access all folders</RiskTitle>}
        description="The agent's tools can read, list, search, write and edit files, create folders and run commands in any folder, not only the ones you opened. Secret files such as ~/.ssh and .env stay refused, and edits and commands still ask unless Auto-approve is on. The app is not affected."
      >
        <Switch
          checked={ai}
          onCheckedChange={(v) => void setAiAllFolders(v)}
          aria-label="Allow AI tools to access all folders"
        />
      </SettingRow>
    </div>
  );
}

function RiskTitle({ children }: { children: ReactNode }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {children}
      <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px text-[9.5px] font-medium text-amber-700 dark:text-amber-400">
        At your own risk
      </span>
    </span>
  );
}

/**
 * Shown on every Settings tab while either switch is on. A click goes to the
 * switches.
 */
export function FolderAccessIndicator({
  onShowGeneral,
}: {
  onShowGeneral: () => void;
}) {
  const app = usePreferencesStore((s) => s.appAllFolders);
  const ai = usePreferencesStore((s) => s.aiAllFolders);
  const summary = allFoldersSummary(app, ai);
  if (summary === null) return null;

  const show = () => {
    onShowGeneral();
    // After the General tab has rendered.
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        document
          .getElementById(GROUP_ID)
          ?.scrollIntoView({ block: "start", behavior: "smooth" }),
      ),
    );
  };

  return (
    <button
      type="button"
      onClick={show}
      title={`${summary}. Click to change it.`}
      aria-label={`${summary}. Show the setting.`}
      className="mx-2 flex h-6 shrink-0 items-center gap-1 rounded-md border border-amber-500/45 bg-amber-500/15 px-1.5 text-[10.5px] font-medium text-amber-700 transition-colors hover:bg-amber-500/25 dark:text-amber-400"
    >
      <HugeiconsIcon icon={FolderUnlockedIcon} size={11} strokeWidth={2} />
      <span>All folders</span>
    </button>
  );
}
