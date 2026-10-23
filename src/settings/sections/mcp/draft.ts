import {
  joinCommandLine,
  splitCommandLine,
} from "@/modules/mcp/lib/commandLine";
import {
  isPort,
  type McpNamedValue,
  type McpOAuthClient,
  type McpServerConfig,
  type McpTransportType,
  newServerId,
  OAUTH_CLIENT_SECRET,
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
  /** A sign-in client of the user's own (remote servers); empty: Terax registers. */
  oauthClientId: string;
  /** A new client secret, or "" to keep the saved one. */
  oauthSecret: string;
  /** A client secret is in the keychain. */
  oauthSecretSaved: boolean;
  oauthScopes: string;
  oauthPort: string;
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
    oauthClientId: "",
    oauthSecret: "",
    oauthSecretSaved: false,
    oauthScopes: "",
    oauthPort: "",
  };
}

const OAUTH_SECRET_ID = `oauth:${OAUTH_CLIENT_SECRET}`;

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
    oauthClientId: t.type === "stdio" ? "" : (t.oauth?.clientId ?? ""),
    oauthSecret: "",
    oauthSecretSaved:
      t.type !== "stdio" &&
      t.oauth?.clientSecret === true &&
      savedSecrets.has(OAUTH_SECRET_ID),
    oauthScopes: t.type === "stdio" ? "" : (t.oauth?.scopes ?? ""),
    oauthPort:
      t.type === "stdio" || t.oauth?.callbackPort == null
        ? ""
        : String(t.oauth.callbackPort),
  };
}

/** The sign-in client a draft configures, if any. */
function oauthOf(draft: ServerDraft): McpOAuthClient | null {
  const clientId = draft.oauthClientId.trim();
  if (!clientId) return null;
  const port = Number(draft.oauthPort.trim());
  return {
    clientId,
    clientSecret: Boolean(draft.oauthSecret) || draft.oauthSecretSaved,
    scopes: draft.oauthScopes.trim() || null,
    callbackPort: draft.oauthPort.trim() && isPort(port) ? port : null,
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
  const oauth = oauthOf(draft);
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
            ...(oauth ? { oauth } : {}),
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
  const set: SecretChanges["set"] = rows
    .filter((r) => r.secret && r.name.trim() && r.value)
    .map((r) => ({ kind, name: r.name.trim(), value: r.value }));
  const next = serverFromDraft(draft).transport;
  if (next.type !== "stdio" && next.oauth && draft.oauthSecret) {
    set.push({
      kind: "oauth",
      name: OAUTH_CLIENT_SECRET,
      value: draft.oauthSecret,
    });
  }
  const kept = new Set(secretRefs(next).map(secretId));
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
  if (draft.type !== "stdio") {
    const port = draft.oauthPort.trim();
    if (
      !draft.oauthClientId.trim() &&
      (draft.oauthSecret || draft.oauthScopes.trim() || port)
    ) {
      errors.oauth =
        "Enter the client ID these belong to, or clear them to let Terax register itself.";
    } else if (port && !isPort(Number(port))) {
      errors.oauth = "The callback port is a number from 1 to 65535.";
    }
  }
  return errors;
}

export function hasErrors(errors: DraftErrors): boolean {
  return Object.values(errors).some(Boolean);
}
