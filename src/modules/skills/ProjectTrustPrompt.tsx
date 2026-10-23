import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Cancel01Icon, ShieldKeyIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { toast } from "sonner";
import { decideProjectTrust, projectTrustStatus } from "./api";
import {
  acceptLabel,
  askingItems,
  isSkillsItem,
  promptGroups,
  promptTitle,
  trustDecisions,
} from "./trust";
import type { ProjectTrustStatus, TrustItem, TrustItemKind } from "./types";

type Props = {
  status: ProjectTrustStatus;
  /** Closed without an answer: asked again next time. */
  onDismiss: () => void;
  onDecided: (status: ProjectTrustStatus) => void;
};

function folderName(root: string): string {
  const parts = root.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? root;
}

/**
 * Asks whether to use what a project provides (its TERAX.md instructions, its
 * skills, its `.mcp.json` servers). Not modal: work goes on around it.
 */
export function ProjectTrustPrompt({ status, onDismiss, onDecided }: Props) {
  const asking = askingItems(status);
  const unreviewable = status.items.filter(
    (item) => item.state === "unreviewable",
  );
  const [allowed, setAllowed] = useState<Set<TrustItemKind>>(
    () => new Set(asking.map((item) => item.kind)),
  );
  const [busy, setBusy] = useState(false);
  const { project } = status;

  const decide = async (trust: boolean) => {
    setBusy(true);
    try {
      const chosen = trust ? allowed : new Set<TrustItemKind>();
      onDecided(
        await decideProjectTrust(
          { root: project.root, workspace: project.workspace },
          trustDecisions(asking, chosen),
        ),
      );
    } catch (error) {
      toast.error("Could not save your choice", {
        description: error instanceof Error ? error.message : String(error),
      });
      const fresh = await projectTrustStatus(
        project.root,
        project.workspace,
      ).catch(() => null);
      if (fresh) onDecided(fresh);
    } finally {
      setBusy(false);
    }
  };

  const several = asking.length > 1;
  const groups = promptGroups(asking);
  const toggle = (kind: TrustItemKind, on: boolean) =>
    setAllowed((prev) => {
      const next = new Set(prev);
      if (on) next.add(kind);
      else next.delete(kind);
      return next;
    });

  return (
    <div
      role="dialog"
      aria-labelledby="project-trust-title"
      onKeyDown={(e) => {
        if (e.key === "Escape") onDismiss();
      }}
      className="fixed right-3 bottom-9 z-50 flex w-95 max-w-[calc(100vw-1.5rem)] flex-col gap-3 rounded-xl border border-border/70 bg-popover p-3.5 text-popover-foreground shadow-xl"
    >
      <div className="flex items-start gap-2.5">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/60">
          <HugeiconsIcon icon={ShieldKeyIcon} size={15} strokeWidth={1.75} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span id="project-trust-title" className="text-[13px] font-medium">
            {promptTitle(asking, folderName(project.root))}
          </span>
          <span
            className="truncate font-mono text-[10.5px] text-muted-foreground"
            title={project.root}
          >
            {project.root}
          </span>
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Not now"
          title="Not now"
          onClick={onDismiss}
        >
          <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
        </Button>
      </div>

      <div className="flex flex-col gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
        {groups.instructions ? (
          <p>
            TERAX.md holds the project's instructions: Terax adds them to every
            AI run here and the AI follows them (each edit and command still
            asks as the conversation's approval mode says).
          </p>
        ) : null}
        {groups.skills ? (
          <p>
            Skills are instructions the AI follows, and they can bundle scripts
            it runs through its shell tool (each command still asks as the
            conversation's approval mode says).
          </p>
        ) : null}
        {groups.servers ? (
          <p>
            MCP servers in .mcp.json are programs Terax starts with your rights,
            outside its folder limits, or remote services the AI sends data to.
            Their tools ask before every call unless you mark a server Trusted
            in Settings.
          </p>
        ) : null}
        <p>
          Use them only from projects you trust. Until then the AI never sees
          them. Edits made in Terax keep your answer; a change from anywhere
          else asks again.
        </p>
      </div>

      <div className="flex max-h-56 flex-col gap-2 overflow-y-auto">
        {asking.map((item) => (
          <TrustItemCard
            key={item.kind}
            item={item}
            checked={allowed.has(item.kind)}
            onCheckedChange={several ? (on) => toggle(item.kind, on) : null}
          />
        ))}
        {unreviewable.map((item) => (
          <div
            key={item.kind}
            className="rounded-lg border border-border/60 px-2.5 py-2 text-[11px]"
          >
            <span className="font-mono">{item.path}</span>
            <span className="block text-destructive">
              Cannot be used: {item.problem}
            </span>
          </div>
        ))}
      </div>

      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void decide(false)}
        >
          Don't use
        </Button>
        <Button
          size="sm"
          disabled={busy || (several && allowed.size === 0)}
          onClick={() => void decide(true)}
        >
          {acceptLabel(asking)}
        </Button>
      </div>
    </div>
  );
}

function TrustItemCard({
  item,
  checked,
  onCheckedChange,
}: {
  item: TrustItem;
  checked: boolean;
  onCheckedChange: ((on: boolean) => void) | null;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-card/50 px-2.5 py-2">
      <div className="flex items-center gap-2 text-[11.5px]">
        {onCheckedChange ? (
          <Checkbox
            id={`trust-${item.kind}`}
            checked={checked}
            onCheckedChange={(v) => onCheckedChange(v === true)}
          />
        ) : null}
        <label
          htmlFor={`trust-${item.kind}`}
          className="min-w-0 flex-1 truncate font-mono"
          title={item.path}
        >
          {item.path}
        </label>
        {item.state === "changed" ? (
          <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[9.5px] text-amber-600 dark:text-amber-400">
            Changed since your answer
          </span>
        ) : null}
      </div>
      {item.kind === "terax-md" ? (
        <MemoryPreview item={item} />
      ) : (
        <ItemEntries item={item} />
      )}
    </div>
  );
}

/** A TERAX.md's size and line count, then its first lines as plain text. */
function MemoryPreview({ item }: { item: TrustItem }) {
  const entry = item.entries[0];
  if (!entry) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10.5px] text-muted-foreground">{entry.title}</span>
      {entry.detail ? (
        <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 px-2 py-1.5 font-mono text-[10.5px] leading-snug text-muted-foreground">
          {entry.detail}
        </pre>
      ) : null}
    </div>
  );
}

function ItemEntries({ item }: { item: TrustItem }) {
  return (
    <ul className="flex flex-col gap-1">
      {item.entries.map((entry) => (
        <li key={entry.title} className="flex flex-col">
          <span className="font-mono text-[11px]">{entry.title}</span>
          {entry.detail ? (
            <span className="line-clamp-2 text-[10.5px] text-muted-foreground">
              {entry.detail}
            </span>
          ) : null}
        </li>
      ))}
      {item.entries.length === 0 ? (
        <li className="text-[10.5px] text-muted-foreground">
          {isSkillsItem(item.kind) ? "No skills in it yet." : "No servers."}
        </li>
      ) : null}
    </ul>
  );
}
