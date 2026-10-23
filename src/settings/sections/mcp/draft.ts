import {
  joinCommandLine,
  splitCommandLine,
} from "@/modules/mcp/lib/commandLine";
import {
  type McpNamedValue,
  type McpServerConfig,
  type McpTransportType,
  newServerId,
  type SecretRef,
  type ServerDraftErrors,
  secretRefs,
  validateServer,
} from "@/modules/mcp/lib/config";

/**
 * The add and edit form of a server, and what saving it changes. Pure: the
 * dialog keeps a draft, saving turns it into a configuration plus the secret
 * values to write and delete. Secret values only ever flow from the form to
 * the keychain; a saved one is never read back, the form shows that it is set.
 */

export type ValueRow = {
  key: string;
  name: string;
  /** For a plain row its value; for a secret row a new value, or "" to keep. */
  value: string;
  secret: boolean;
  /** A secret row whose value is in the keychain already. */
  saved: boolean;
};

export type ServerDraft = {
  base: McpServerConfig | null;
  id: string;
  name: string;
  type: McpTransportType;
  commandLine: string;
  cwd: string;
  env: ValueRow[];
  url: string;
  headers: ValueRow[];
};

let rowCounter = 0;
export function newRow(partial: Partial<ValueRow> = {}): ValueRow {
  rowCounter += 1;
  return {
    key: `row-${rowCounter}`,
    name: "",
    value: "",
    secret: false,
    saved: false,
    ...partial,
  };
}

/** `kind:name` (lower case for headers), as `savedSecrets` lists them. */
export function secretId(ref: SecretRef): string {
  return `${ref.kind}:${ref.kind === "header" ? ref.name.toLowerCase() : ref.name}`;
}

function rowsOf(
  values: readonly McpNamedValue[],
  kind: SecretRef["kind"],
  saved: ReadonlySet<string>,
): ValueRow[] {
  return values.map((v) =>
    v.secret
      ? newRow({
          name: v.name,
          secret: true,
          saved: saved.has(secretId({ kind, name: v.name })),
        })
      : newRow({ name: v.name, value: v.value }),
  );
}

export function emptyDraft(): ServerDraft {
  return {
    base: null,
    id: newServerId(),
    name: "",
    type: "stdio",
    commandLine: "",
    cwd: "",
    env: [],
    url: "",
    headers: [],
  };
}

export function draftFromServer(
  server: McpServerConfig,
  savedSecrets: ReadonlySet<string>,
): ServerDraft {
  const t = server.transport;
  return {
    base: server,
    id: server.id,
    name: server.name,
    type: t.type,
    commandLine:
      t.type === "stdio" ? joinCommandLine([t.command, ...t.args]) : "",
    cwd: t.type === "stdio" ? (t.cwd ?? "") : "",
    env: t.type === "stdio" ? rowsOf(t.env, "env", savedSecrets) : [],
    url: t.type === "stdio" ? "" : t.url,
    headers:
      t.type === "stdio" ? [] : rowsOf(t.headers, "header", savedSecrets),
  };
}

function valuesOf(rows: readonly ValueRow[]): McpNamedValue[] {
  return rows
    .filter((r) => r.name.trim())
    .map((r) =>
      r.secret
        ? { name: r.name.trim(), secret: true }
        : { name: r.name.trim(), secret: false, value: r.value },
    );
}

/** The configuration a draft saves (secret values aside). */
export function serverFromDraft(draft: ServerDraft): McpServerConfig {
  const base = draft.base;
  const words = splitCommandLine(draft.commandLine);
  return {
    id: draft.id,
    name: draft.name.trim(),
    source: base?.source ?? "settings",
    // A new server starts enabled: adding it is the user's choice to use it.
    enabled: base?.enabled ?? true,
    trusted: base?.trusted ?? false,
    tools: base?.tools ?? {},
    secretsRevision: base?.secretsRevision ?? 0,
    transport:
      draft.type === "stdio"
        ? {
            type: "stdio",
            command: words[0] ?? "",
            args: words.slice(1),
            env: valuesOf(draft.env),
            cwd: draft.cwd.trim() || null,
          }
        : {
            type: draft.type,
            url: draft.url.trim(),
            headers: valuesOf(draft.headers),
          },
  };
}

export type SecretChanges = {
  set: (SecretRef & { value: string })[];
  remove: SecretRef[];
};

/**
 * What saving writes to the keychain: new values typed into secret rows, and
 * the removal of secrets the server no longer has (a row removed or made
 * plain, or the other transport chosen).
 */
export function secretChanges(draft: ServerDraft): SecretChanges {
  const kind: SecretRef["kind"] = draft.type === "stdio" ? "env" : "header";
  const rows = draft.type === "stdio" ? draft.env : draft.headers;
  const set = rows
    .filter((r) => r.secret && r.name.trim() && r.value)
    .map((r) => ({ kind, name: r.name.trim(), value: r.value }));
  const kept = new Set(
    rows
      .filter((r) => r.secret && r.name.trim())
      .map((r) => secretId({ kind, name: r.name.trim() })),
  );
  const remove = draft.base
    ? secretRefs(draft.base.transport).filter((ref) => !kept.has(secretId(ref)))
    : [];
  return { set, remove };
}

export type DraftErrors = ServerDraftErrors & { secrets?: string };

export function draftErrors(
  draft: ServerDraft,
  others: readonly McpServerConfig[],
): DraftErrors {
  const errors: DraftErrors = validateServer(serverFromDraft(draft), others);
  if (
    draft.type === "stdio" &&
    splitCommandLine(draft.commandLine).length === 0
  )
    errors.command = "Enter the command that starts the server.";
  const rows = draft.type === "stdio" ? draft.env : draft.headers;
  if (rows.some((r) => !r.name.trim() && r.value)) {
    errors.values = "Give every value a name.";
  }
  const missing = rows.find(
    (r) => r.secret && r.name.trim() && !r.saved && !r.value,
  );
  if (missing)
    errors.secrets = `Enter the secret value of ${missing.name.trim()}.`;
  return errors;
}

export function hasErrors(errors: DraftErrors): boolean {
  return Object.values(errors).some(Boolean);
}
