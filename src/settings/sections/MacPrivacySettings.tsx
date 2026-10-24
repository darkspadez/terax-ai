import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IS_MAC } from "@/lib/platform";
import { cn } from "@/lib/utils";
import {
  type AreaStatus,
  areaStatus,
  PRIVACY_AREAS,
  type PrivacyArea,
  settingsPaneFor,
} from "@/modules/mac-privacy/lib/areas";
import { openPrivacySettings } from "@/modules/mac-privacy/native";
import { useFullDiskAccess } from "@/modules/mac-privacy/useFullDiskAccess";
import { SettingRow } from "../components/SettingRow";

const AREAS: Record<PrivacyArea, { title: string; description: string }> = {
  fullDiskAccess: {
    title: "Full Disk Access",
    description:
      "Every place below, and the data of apps such as Mail, Messages and Safari. macOS applies a change once Oarlock is reopened.",
  },
  desktop: { title: "Desktop folder", description: "~/Desktop" },
  documents: { title: "Documents folder", description: "~/Documents" },
  downloads: { title: "Downloads folder", description: "~/Downloads" },
  iCloudDrive: {
    title: "iCloud Drive",
    description: "~/Library/Mobile Documents",
  },
  cloudStorage: {
    title: "Cloud storage",
    description:
      "Dropbox, OneDrive, Google Drive and others under ~/Library/CloudStorage",
  },
  removableVolumes: {
    title: "Removable volumes",
    description: "USB drives and memory cards under /Volumes",
  },
  networkVolumes: {
    title: "Network volumes",
    description: "File shares from other computers under /Volumes",
  },
};

const STATUS: Record<AreaStatus, { label: string; dot: string }> = {
  checking: { label: "Checking…", dot: "bg-muted-foreground/40" },
  allowed: { label: "Allowed", dot: "bg-emerald-500" },
  denied: { label: "Not allowed", dot: "bg-destructive" },
  unknown: { label: "Unknown", dot: "bg-muted-foreground/40" },
  askedOnFirstUse: {
    label: "Asked on first use",
    dot: "bg-muted-foreground/40",
  },
};

/**
 * macOS privacy access (Settings, General). Nothing here opens a protected
 * folder, so looking never makes macOS ask.
 */
export function MacPrivacySettings() {
  return IS_MAC ? <PrivacyGroup /> : null;
}

function PrivacyGroup() {
  const fullDiskAccess = useFullDiskAccess();

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
        Privacy
      </span>
      {PRIVACY_AREAS.map((area) => {
        const status = areaStatus(area, fullDiskAccess);
        return (
          <SettingRow
            key={area}
            title={
              <span className="flex items-center gap-2">
                {AREAS[area].title}
                <StatusBadge status={status} />
              </span>
            }
            description={describe(area, status)}
          >
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() =>
                void openPrivacySettings(settingsPaneFor(area)).catch((error) =>
                  console.error("could not open System Settings", error),
                )
              }
            >
              Open System Settings
            </Button>
          </SettingRow>
        );
      })}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Programs started in Oarlock's terminals count as Oarlock. Without Full Disk
        Access, macOS tells Oarlock about a folder only when Oarlock opens it: it
        asks the first time and keeps the answer, which you can change under
        Files &amp; Folders. Checking here never asks.
      </p>
    </div>
  );
}

function describe(area: PrivacyArea, status: AreaStatus): string {
  const { description } = AREAS[area];
  if (area === "fullDiskAccess") {
    return status === "unknown"
      ? `${description} Oarlock could not tell whether it has it.`
      : description;
  }
  return status === "allowed"
    ? `${description} - allowed through Full Disk Access`
    : description;
}

function StatusBadge({ status }: { status: AreaStatus }) {
  const { label, dot } = STATUS[status];
  return (
    <Badge
      variant="outline"
      className="h-4 gap-1 border-border/60 bg-muted/40 px-1.5 text-[10px] font-normal text-muted-foreground"
    >
      <span className={cn("size-1.5 rounded-full", dot)} />
      {label}
    </Badge>
  );
}
