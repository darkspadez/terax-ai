import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { joinCommandLine } from "@/modules/mcp/lib/commandLine";
import {
  type McpServerConfig,
  type McpToolOverride,
  secretRefs,
} from "@/modules/mcp/lib/config";
import {
  forgetKnownTools,
  type KnownTool,
  loadKnownTools,
  loadServers,
  onMcpChanged,
  saveServers,
} from "@/modules/mcp/lib/configStore";
import {
  applyStatusEvent,
  MCP_RESTART_EVENT,
  MCP_STATUS_EVENT,
  type StatusView,
  statusView,
  type WindowStatus,
} from "@/modules/mcp/lib/status";
import { MCP_TOOL_PREFIX, sanitizeNamePart } from "@/modules/mcp/lib/toolNames";
import { annotationLabels } from "@/modules/mcp/lib/toolSchema";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SectionHeader } from "../../components/SectionHeader";
import { SettingRow } from "../../components/SettingRow";
import {
  draftFromServer,
  emptyDraft,
  type ServerDraft,
  secretChanges,
  secretId,
  serverFromDraft,
} from "./draft";
import { ServerDialog } from "./ServerDialog";
import { ServerLogs } from "./ServerLogs";

type StatusEvent = {
  window: string;
  serverId: string;
  report: Omit<WindowStatus, "window"> | null;
};

function useMcpState() {
  const [servers, setServers] = useState<McpServerConfig[] | null>(null);
  const [knownTools, setKnownTools] = useState<Record<string, KnownTool[]>>({});
  const [statuses, setStatuses] = useState<WindowStatus[]>([]);

  useEffect(() => {
    let alive = true;
    const reloadServers = () =>
      void loadServers().then((s) => alive && setServers(s));
    const reloadTools = () =>
      void loadKnownTools().then((t) => alive && setKnownTools(t));
    reloadServers();
    reloadTools();
    void invoke<WindowStatus[]>("mcp_status_list").then(
      (list) => alive && setStatuses(list),
    );
    const unlisten = [
      onMcpChanged((change) =>
        change.kind === "servers" ? reloadServers() : reloadTools(),
      ),
      listen<StatusEvent>(MCP_STATUS_EVENT, (event) =>
        setStatuses((old) => applyStatusEvent(old, event.payload)),
      ),
    ];
    return () => {
      alive = false;
      for (const u of unlisten) void u.then((fn) => fn());
    };
  }, []);

  return { servers, setServers, knownTools, statuses };
}

/** Writes the list; every window running a server follows it. */
async function persist(
  next: McpServerConfig[],
  setServers: (s: McpServerConfig[]) => void,
) {
  setServers(next);
  await saveServers(next);
}

export function McpSection() {
  const { servers, setServers, knownTools, statuses } = useMcpState();
  const [dialog, setDialog] = useState<ServerDraft | null>(null);
  const [removing, setRemoving] = useState<McpServerConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((e: unknown) => setError(String(e)), []);

  const update = useCallback(
    (id: string, change: (s: McpServerConfig) => McpServerConfig) => {
      if (!servers) return;
      setError(null);
      persist(
        servers.map((s) => (s.id === id ? change(s) : s)),
        setServers,
      ).catch(report);
    },
    [servers, setServers, report],
  );

  const openEditor = async (server: McpServerConfig | null) => {
    if (!server) {
      setDialog(emptyDraft());
      return;
    }
    const refs = secretRefs(server.transport);
    const set = refs.length
      ? await invoke<boolean[]>("mcp_secret_status", {
          serverId: server.id,
          secrets: refs,
        }).catch(() => refs.map(() => false))
      : [];
    setDialog(
      draftFromServer(
        server,
        new Set(refs.filter((_, i) => set[i]).map(secretId)),
      ),
    );
  };

  const saveDraft = async (draft: ServerDraft) => {
    const current = servers ?? [];
    const changes = secretChanges(draft);
    for (const secret of changes.set) {
      await invoke("mcp_secret_set", {
        serverId: draft.id,
        kind: secret.kind,
        name: secret.name,
        value: secret.value,
      });
    }
    if (changes.remove.length > 0) {
      await invoke("mcp_secret_delete", {
        serverId: draft.id,
        secrets: changes.remove,
      });
    }
    const server = serverFromDraft(draft);
    // Switches flipped while the dialog was open are kept.
    const latest = current.find((s) => s.id === server.id);
    if (latest) {
      server.enabled = latest.enabled;
      server.trusted = latest.trusted;
      server.tools = latest.tools;
      server.secretsRevision = latest.secretsRevision;
    }
    if (changes.set.length > 0 || changes.remove.length > 0) {
      server.secretsRevision += 1;
    }
    await persist(
      latest
        ? current.map((s) => (s.id === server.id ? server : s))
        : [...current, server],
      setServers,
    );
  };

  const remove = async (server: McpServerConfig) => {
    const refs = secretRefs(server.transport);
    if (refs.length > 0) {
      await invoke("mcp_secret_delete", {
        serverId: server.id,
        secrets: refs,
      }).catch(() => {});
    }
    await persist(
      (servers ?? []).filter((s) => s.id !== server.id),
      setServers,
    );
    await forgetKnownTools(server.id).catch(() => {});
  };

  return (
    <div className="flex flex-col gap-5">
      <SectionHeader
        title="MCP servers"
        description="Give the agent tools from Model Context Protocol servers: programs Terax starts on this computer, or remote services."
      />
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">
          Servers run with your rights.
        </span>{" "}
        A local server is a program running as you, outside the folder limits
        Terax applies to its own file features and the agent's file tools. A
        remote server receives whatever the agent sends it. Add only servers you
        trust. Their tools ask before every call, even in Auto-approve, unless
        you mark the server Trusted, and what they return is treated as
        untrusted.
      </div>

      {error ? (
        <div className="text-[11px] text-destructive">{error}</div>
      ) : null}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Label>Servers</Label>
          <Button
            variant="outline"
            size="sm"
            className="h-6 gap-1 px-2 text-[11px]"
            onClick={() => void openEditor(null)}
          >
            <HugeiconsIcon icon={Add01Icon} size={11} strokeWidth={2} />
            Add server
          </Button>
        </div>
        {servers === null ? null : servers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 px-3 py-6 text-center text-[11.5px] text-muted-foreground">
            No servers yet. Add one with its command (for example{" "}
            <span className="font-mono">
              npx -y @modelcontextprotocol/server-everything
            </span>
            ) or its URL.
          </div>
        ) : (
          servers.map((server) => (
            <ServerCard
              key={server.id}
              server={server}
              tools={knownTools[server.id] ?? []}
              status={statusView(
                server.enabled,
                statuses.filter((s) => s.serverId === server.id),
              )}
              onUpdate={(change) => update(server.id, change)}
              onEdit={() => void openEditor(server)}
              onRemove={() => setRemoving(server)}
            />
          ))
        )}
      </div>

      {dialog ? (
        <ServerDialog
          draft={dialog}
          others={servers ?? []}
          onSave={saveDraft}
          onClose={() => setDialog(null)}
        />
      ) : null}

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The server stops in every window, and its secret values are
              deleted from the keychain.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (removing) remove(removing).catch(report);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function describeTransport(server: McpServerConfig): string {
  const t = server.transport;
  if (t.type === "stdio") return joinCommandLine([t.command, ...t.args]);
  return t.type === "sse" ? `${t.url} (SSE)` : t.url;
}

function statusText(status: StatusView, now: number): string {
  switch (status.state) {
    case "disabled":
      return "Off";
    case "idle":
      return "Starts when a window first needs it: an agent run, or the @ or / list";
    case "starting":
      return "Starting";
    case "running": {
      const parts = [
        status.serverInfo,
        status.toolCount === null
          ? null
          : `${status.toolCount} tool${status.toolCount === 1 ? "" : "s"}`,
        status.windows > 1 ? `in ${status.windows} windows` : null,
      ].filter(Boolean);
      return parts.length > 0 ? `Running: ${parts.join(", ")}` : "Running";
    }
    case "crashed": {
      const error = status.error ?? "it stopped unexpectedly";
      if (status.retryAtMs === null) {
        return `Stopped after repeated failures: ${error}. Restart it to try again.`;
      }
      const seconds = Math.max(0, Math.round((status.retryAtMs - now) / 1000));
      return `Failed: ${error}. Restarting in ${seconds} s.`;
    }
  }
}

const DOT: Record<StatusView["state"], string> = {
  disabled: "bg-muted-foreground/30",
  idle: "bg-muted-foreground/50",
  starting: "bg-amber-500",
  running: "bg-emerald-500",
  crashed: "bg-destructive",
};

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function ServerCard({
  server,
  tools,
  status,
  onUpdate,
  onEdit,
  onRemove,
}: {
  server: McpServerConfig;
  tools: KnownTool[];
  status: StatusView;
  onUpdate: (change: (s: McpServerConfig) => McpServerConfig) => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState(false);
  const now = useNow(status.state === "crashed" && status.retryAtMs !== null);
  const canRestart = status.state !== "disabled" && status.state !== "idle";

  return (
    <div className="rounded-lg border border-border/60 bg-card/60">
      <div className="flex items-start gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="mt-0.5 cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={open ? "Collapse" : "Expand"}
          aria-expanded={open}
        >
          <HugeiconsIcon
            icon={open ? ArrowDown01Icon : ArrowRight01Icon}
            size={12}
            strokeWidth={2}
          />
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                DOT[status.state],
              )}
            />
            <span className="truncate text-[12.5px] font-medium">
              {server.name}
            </span>
            {server.trusted ? (
              <span className="rounded border border-border/70 px-1 text-[9.5px] text-muted-foreground">
                Trusted
              </span>
            ) : null}
          </div>
          <span className="truncate font-mono text-[10.5px] text-muted-foreground">
            {describeTransport(server)}
          </span>
          <span
            className={cn(
              "text-[10.5px] leading-relaxed",
              status.state === "crashed"
                ? "text-destructive"
                : "text-muted-foreground",
            )}
          >
            {statusText(status, now)}
          </span>
        </div>
        <Switch
          checked={server.enabled}
          onCheckedChange={(enabled) => onUpdate((s) => ({ ...s, enabled }))}
          aria-label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`}
        />
      </div>
      {open ? (
        <div className="flex flex-col gap-3 border-t border-border/60 px-3 py-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={onEdit}
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              disabled={!canRestart}
              title={
                canRestart
                  ? "Restart it in every window running it"
                  : "Not running in any window"
              }
              onClick={() =>
                void emit(MCP_RESTART_EVENT, { serverId: server.id })
              }
            >
              Restart
            </Button>
            <Button
              size="sm"
              variant={logs ? "secondary" : "outline"}
              className="h-6 px-2 text-[11px]"
              onClick={() => setLogs((l) => !l)}
            >
              Logs
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-6 px-2 text-[11px] text-destructive hover:text-destructive"
              onClick={onRemove}
            >
              Remove
            </Button>
          </div>
          <SettingRow
            title="Trusted"
            description="Its tools follow the conversation's Ask or Auto-approve mode. Untrusted servers ask before every call, even in Auto-approve. What a server says about its tools (read-only and so on) never changes this."
          >
            <Switch
              checked={server.trusted}
              onCheckedChange={(trusted) =>
                onUpdate((s) => ({ ...s, trusted }))
              }
              aria-label={`Trust ${server.name}`}
            />
          </SettingRow>
          <ToolOverrides
            server={server}
            tools={tools}
            onChange={(tool, choice) =>
              onUpdate((s) => {
                const next = { ...s.tools };
                if (choice) next[tool] = choice;
                else delete next[tool];
                return { ...s, tools: next };
              })
            }
          />
          {logs ? <ServerLogs serverId={server.id} /> : null}
        </div>
      ) : null}
    </div>
  );
}

const CHOICES: { value: McpToolOverride | null; label: string }[] = [
  { value: null, label: "Default" },
  { value: "allow", label: "Always allow" },
  { value: "deny", label: "Never allow" },
];

function ToolOverrides({
  server,
  tools,
  onChange,
}: {
  server: McpServerConfig;
  tools: KnownTool[];
  onChange: (tool: string, choice: McpToolOverride | null) => void;
}) {
  const names = useMemo(() => new Set(tools.map((t) => t.name)), [tools]);
  // Choices for tools the server no longer lists are kept, and shown.
  const stale = Object.keys(server.tools).filter((name) => !names.has(name));
  const rows = [...tools, ...stale.map((name) => ({ name }) as KnownTool)];
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium text-muted-foreground">
        Tools
      </span>
      <span className="text-[10.5px] leading-relaxed text-muted-foreground">
        Default asks{" "}
        {server.trusted
          ? "as the conversation's mode says"
          : "before every call"}
        . Always allow runs a tool without asking, in every mode. Never allow
        keeps it from the agent entirely. The agent sees each as{" "}
        <span className="font-mono">
          {MCP_TOOL_PREFIX}
          {sanitizeNamePart(server.name)}__tool
        </span>
        .
      </span>
      {rows.length === 0 ? (
        <span className="text-[10.5px] text-muted-foreground">
          Its tools are listed here once it has run.
        </span>
      ) : (
        <div className="flex flex-col divide-y divide-border/50 rounded-md border border-border/60">
          {rows.map((tool) => {
            const choice = server.tools[tool.name] ?? null;
            const labels = annotationLabels(tool.annotations);
            return (
              <div
                key={tool.name}
                className="flex items-start justify-between gap-3 px-2.5 py-2"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate font-mono text-[11px]">
                    {tool.name}
                    {names.has(tool.name) ? null : (
                      <span className="ml-1.5 font-sans text-[10px] text-muted-foreground">
                        (no longer listed)
                      </span>
                    )}
                  </span>
                  {tool.title || tool.description ? (
                    <span className="line-clamp-2 text-[10.5px] text-muted-foreground">
                      {tool.title ?? tool.description}
                    </span>
                  ) : null}
                  {labels.length > 0 ? (
                    <span className="text-[10px] text-muted-foreground/80">
                      Server says: {labels.join(", ")}
                    </span>
                  ) : null}
                </div>
                <div className="flex shrink-0 rounded-md border border-border/70 p-0.5">
                  {CHOICES.map(({ value, label }) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => onChange(tool.name, value)}
                      className={cn(
                        "cursor-pointer rounded px-1.5 py-0.5 text-[10.5px] transition-colors",
                        choice === value
                          ? value === "deny"
                            ? "bg-destructive/10 font-medium text-destructive"
                            : "bg-muted font-medium text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
