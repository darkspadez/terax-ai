import { Button } from "@/components/ui/button";
import type { McpServerConfig } from "@/modules/mcp/lib/config";
import {
  type ProjectServers,
  type ProjectServerView,
  projectServerConfig,
  type ProjectServerRecord,
} from "@/modules/mcp/lib/projectServers";
import { decideProjectTrust, revokeProjectTrust } from "@/modules/skills/api";
import { ShieldKeyIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";

function folderName(root: string): string {
  const parts = root.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? root;
}

const STATE_TEXT: Record<ProjectServers["state"], string> = {
  allowed:
    "In use in this project's windows. Edit .mcp.json to change them: edits made in Terax keep your answer, a change from anywhere else asks again.",
  denied: "Not used: you chose not to use them.",
  pending:
    "Not in use yet. Answer the prompt in the project's window, or decide here.",
  changed:
    "Changed since your answer, so not in use. Answer the prompt in the project's window, or decide here.",
  unreviewable: "Cannot be used",
};

/**
 * The servers an open project's `.mcp.json` declares, under its project: what
 * the user decided about the file, and while it is allowed, a card per server
 * (no edit or remove: the file is the configuration).
 */
export function ProjectServersSection({
  listing,
  records,
  card,
  onError,
}: {
  listing: ProjectServers;
  records: Record<string, ProjectServerRecord>;
  card: (server: McpServerConfig, view: ProjectServerView) => ReactNode;
  onError: (error: unknown) => void;
}) {
  const { project, state, hash } = listing;
  const decide = (allow: boolean) => {
    if (!hash) return;
    decideProjectTrust({ root: project.root, workspace: project.workspace }, [
      { kind: "mcp-json", hash, allow },
    ]).catch(onError);
  };
  const forget = () =>
    revokeProjectTrust(project.key, "mcp-json").catch(onError);
  const reviewing = state === "pending" || state === "changed";

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-start gap-2.5 rounded-lg border border-border/60 bg-card/60 px-3 py-2">
        <HugeiconsIcon
          icon={ShieldKeyIcon}
          size={14}
          strokeWidth={1.75}
          className="mt-0.5 shrink-0 text-muted-foreground"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[12px] font-medium">
            Project {folderName(project.root)}
          </span>
          <span
            className="truncate font-mono text-[10.5px] text-muted-foreground"
            title={listing.path}
          >
            {listing.path}
          </span>
          <span
            className={
              state === "unreviewable"
                ? "text-[10.5px] text-destructive"
                : "text-[10.5px] text-muted-foreground"
            }
          >
            {STATE_TEXT[state]}
            {listing.problem ? `: ${listing.problem}` : ""}
          </span>
          {state !== "allowed" && listing.entries.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-1">
              {listing.entries.map((entry) => (
                <li key={entry.title} className="flex flex-col">
                  <span className="font-mono text-[11px]">{entry.title}</span>
                  {entry.detail ? (
                    <span className="line-clamp-2 font-mono text-[10px] text-muted-foreground">
                      {entry.detail}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {state === "denied" || state === "allowed" ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px]"
              onClick={() => void forget()}
            >
              Forget
            </Button>
          ) : null}
          {reviewing ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px]"
              onClick={() => decide(false)}
            >
              Don't use
            </Button>
          ) : null}
          {reviewing || state === "denied" ? (
            <Button
              size="sm"
              className="h-7 px-2 text-[11px]"
              disabled={!hash}
              onClick={() => decide(true)}
            >
              Use servers
            </Button>
          ) : null}
          {state === "allowed" ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px]"
              onClick={() => decide(false)}
            >
              Stop using
            </Button>
          ) : null}
        </div>
      </div>
      {listing.servers.map((view) => {
        const server = projectServerConfig(view, project, records[view.id]);
        if (!server) {
          return (
            <div
              key={view.id}
              className="rounded-lg border border-border/60 px-3 py-2 text-[11px]"
            >
              <span className="font-medium">{view.name}</span>
              <span className="block text-[10.5px] text-destructive">
                Cannot be used: {view.problem ?? "its entry is not valid"}
              </span>
            </div>
          );
        }
        return card(server, view);
      })}
    </section>
  );
}
