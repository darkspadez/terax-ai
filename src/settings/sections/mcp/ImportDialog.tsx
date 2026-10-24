import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  type McpServerConfig,
  newServerId,
  secretRefs,
} from "@/modules/mcp/lib/config";
import {
  alreadyPresent,
  describeImported,
  type ImportedServer,
  type ImportSource,
  importedConfig,
  importProblem,
  secretNotes,
  uniqueName,
} from "@/modules/mcp/lib/importConfig";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";

type PickResult = { serverId: string; error: string | null };

function pickKey(source: ImportSource, server: ImportedServer): string {
  return `${source.app}\u0000${server.key}`;
}

/**
 * Lists the servers other apps on this computer configure and imports the
 * ones the user picks: off and untrusted, their secret values written to the
 * keychain by the backend.
 */
export function ImportDialog({
  existing,
  onImport,
  onClose,
}: {
  existing: readonly McpServerConfig[];
  onImport: (servers: McpServerConfig[]) => Promise<void>;
  onClose: () => void;
}) {
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  // The apps' files are read once, when the dialog opens.
  const opened = useRef(existing);

  useEffect(() => {
    let alive = true;
    invoke<ImportSource[]>("mcp_import_scan").then(
      (found) => {
        if (!alive) return;
        setSources(found);
        setPicked(
          new Set(
            found.flatMap((source) =>
              source.servers
                .filter(
                  (s) =>
                    !importProblem(s) && !alreadyPresent(s, opened.current),
                )
                .map((s) => pickKey(source, s)),
            ),
          ),
        );
      },
      (error) => alive && setScanError(String(error)),
    );
    return () => {
      alive = false;
    };
  }, []);

  const count = picked.size;
  const anyFound = useMemo(
    () => sources?.some((s) => s.servers.length > 0) ?? false,
    [sources],
  );

  const toggle = (key: string, on: boolean) =>
    setPicked((old) => {
      const next = new Set(old);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const runImport = async () => {
    if (!sources) return;
    setBusy(true);
    setFailures([]);
    const taken = new Set(existing.map((s) => s.name.trim().toLowerCase()));
    const configs: McpServerConfig[] = [];
    const picks: {
      app: ImportSource["app"];
      key: string;
      fingerprint: string;
      serverId: string;
    }[] = [];
    for (const source of sources) {
      for (const server of source.servers) {
        if (!picked.has(pickKey(source, server))) continue;
        const id = newServerId();
        const name = uniqueName(server.key, taken);
        const config = importedConfig(server, source.app, id, name);
        if (!config) continue;
        taken.add(name.toLowerCase());
        configs.push(config);
        picks.push({
          app: source.app,
          key: server.key,
          fingerprint: server.fingerprint,
          serverId: id,
        });
      }
    }
    try {
      const results = await invoke<PickResult[]>("mcp_import_secrets", {
        picks,
      });
      const failed = new Map(
        results
          .filter((r) => r.error)
          .map((r) => [r.serverId, r.error ?? ""] as const),
      );
      for (const config of configs.filter((c) => failed.has(c.id))) {
        const refs = secretRefs(config.transport);
        if (refs.length > 0) {
          await invoke("mcp_secret_delete", {
            serverId: config.id,
            secrets: refs,
          }).catch(() => {});
        }
      }
      await onImport(configs.filter((c) => !failed.has(c.id)));
      if (failed.size > 0) {
        setFailures(
          configs
            .filter((c) => failed.has(c.id))
            .map((c) => `${c.name}: ${failed.get(c.id)}`),
        );
        setPicked(new Set());
      } else {
        onClose();
      }
    } catch (error) {
      setFailures([String(error)]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm">Import MCP servers</DialogTitle>
          <DialogDescription className="text-[11px] leading-relaxed">
            Servers configured in other apps on this computer. Imported servers
            start off and untrusted: check each one, then turn it on. Values
            that look like secrets (keys, tokens, passwords, credentials in
            URLs) go to your system keychain, never into Oarlock's settings file;
            the others are kept as they are.
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto pr-1">
          {scanError ? (
            <span className="text-[11px] text-destructive">{scanError}</span>
          ) : sources === null ? (
            <span className="text-[11px] text-muted-foreground">
              Looking for servers…
            </span>
          ) : (
            sources.map((source) => (
              <SourceSection
                key={source.app}
                source={source}
                existing={existing}
                picked={picked}
                onToggle={toggle}
              />
            ))
          )}
          {sources !== null && !anyFound ? (
            <span className="text-[11px] text-muted-foreground">
              None of these apps has servers configured.
            </span>
          ) : null}
        </div>
        {failures.length > 0 ? (
          <div className="flex flex-col gap-0.5 text-[11px] text-destructive">
            <span>Not imported:</span>
            {failures.map((f) => (
              <span key={f}>{f}</span>
            ))}
          </div>
        ) : null}
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {failures.length > 0 ? "Close" : "Cancel"}
          </Button>
          <Button
            size="sm"
            disabled={busy || count === 0}
            onClick={() => void runImport()}
          >
            {count === 1 ? "Import 1 server" : `Import ${count} servers`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SourceSection({
  source,
  existing,
  picked,
  onToggle,
}: {
  source: ImportSource;
  existing: readonly McpServerConfig[];
  picked: ReadonlySet<string>;
  onToggle: (key: string, on: boolean) => void;
}) {
  const summary = source.error
    ? `Could not read it: ${source.error}`
    : !source.found
      ? "Not found"
      : source.servers.length === 0
        ? "No servers"
        : `${source.servers.length} server${source.servers.length === 1 ? "" : "s"}`;
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12px] font-medium">{source.label}</span>
        <span
          className={cn(
            "text-[10.5px]",
            source.error ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {summary}
        </span>
      </div>
      {source.paths.map((path) => (
        <span
          key={path}
          className="truncate font-mono text-[10px] text-muted-foreground/80"
          title={path}
        >
          {path}
        </span>
      ))}
      {source.servers.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border/50 rounded-md border border-border/60">
          {source.servers.map((server) => {
            const key = pickKey(source, server);
            return (
              <ImportRow
                key={key}
                id={key}
                server={server}
                present={alreadyPresent(server, existing)}
                checked={picked.has(key)}
                onToggle={(on) => onToggle(key, on)}
              />
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function ImportRow({
  id,
  server,
  present,
  checked,
  onToggle,
}: {
  id: string;
  server: ImportedServer;
  present: boolean;
  checked: boolean;
  onToggle: (on: boolean) => void;
}) {
  const problem = importProblem(server);
  const { keychain, toFill } = secretNotes(server);
  const checkboxId = `import-${id}`;
  return (
    <li className="flex items-start gap-2.5 px-2.5 py-2">
      <Checkbox
        id={checkboxId}
        className="mt-0.5"
        checked={checked}
        disabled={problem !== null}
        onCheckedChange={(v) => onToggle(v === true)}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <label
          htmlFor={checkboxId}
          className="flex items-center gap-1.5 text-[11.5px] font-medium"
        >
          <span className="truncate">{server.key}</span>
          {present ? (
            <span className="shrink-0 rounded bg-muted/60 px-1 py-0.5 text-[9.5px] font-normal text-muted-foreground">
              Already added
            </span>
          ) : null}
        </label>
        <span
          className="truncate font-mono text-[10.5px] text-muted-foreground"
          title={describeImported(server)}
        >
          {describeImported(server)}
        </span>
        {problem ? (
          <span className="text-[10.5px] text-destructive">
            Cannot be imported: {problem}
          </span>
        ) : null}
        {keychain.length > 0 ? (
          <span className="text-[10.5px] text-muted-foreground">
            To the keychain: {keychain.join(", ")}
          </span>
        ) : null}
        {toFill.map((value) => (
          <span
            key={value.name}
            className="text-[10.5px] text-amber-700 dark:text-amber-400"
          >
            Enter {value.name} after importing (VS Code asks for "{value.input}"
            {value.template ? `, as ${value.template}` : ""}).
          </span>
        ))}
        {server.warnings.map((warning) => (
          <span key={warning} className="text-[10.5px] text-muted-foreground">
            Note: {warning}
          </span>
        ))}
      </div>
    </li>
  );
}
