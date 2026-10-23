/**
 * MCP server configuration: the model Settings edits and the client runs.
 * Pure: parsing, validation and what a change means for a running server.
 * Secret values are never part of it; an entry marked `secret` names a value
 * kept in the keychain, which only the backend reads.
 */

export type McpTransportType = "stdio" | "http" | "sse";

/** A variable or header. A secret one has no value here. */
export type McpNamedValue =
  | { name: string; secret: false; value: string }
  | { name: string; secret: true };

type McpStdioTransport = {
  type: "stdio";
  command: string;
  args: string[];
  env: McpNamedValue[];
  /** Absolute; null starts in the home folder. */
  cwd: string | null;
};

/**
 * A client the user registered with the server's authorization server, for
 * sign-in. Without one, Terax registers itself (dynamic client registration).
 */
export type McpOAuthClient = {
  clientId: string;
  /** Its secret is in the keychain (`<server>/oauth/client-secret`). */
  clientSecret: boolean;
  /** Space-separated; null lets the server's metadata decide. */
  scopes: string | null;
  /** The loopback port its redirect URI was registered with; null: any. */
  callbackPort: number | null;
};

type McpHttpTransport = {
  /** Streamable HTTP, or the legacy HTTP+SSE transport. */
  type: "http" | "sse";
  url: string;
  headers: McpNamedValue[];
  /** Sign-in with a client of the user's own; absent when Terax registers. */
  oauth?: McpOAuthClient;
};

export type McpTransportConfig = McpStdioTransport | McpHttpTransport;

/** Per-tool choice; a tool without one follows the server's rule. */
export type McpToolOverride = "allow" | "deny";

/**
 * Where a server came from: added in Settings, imported from another app's
 * configuration, or a project's `.mcp.json`.
 */
type McpServerSource = "settings" | `imported:${string}` | `project:${string}`;

export type McpServerConfig = {
  id: string;
  name: string;
  source: McpServerSource;
  enabled: boolean;
  /** Its tools follow the conversation's approval mode instead of asking. */
  trusted: boolean;
  transport: McpTransportConfig;
  /** Keyed by the server's own tool name. */
  tools: Record<string, McpToolOverride>;
  /** Changes whenever a secret value is set, so running servers restart. */
  secretsRevision: number;
};

const MAX_SERVER_NAME = 64;

const SERVER_ID_RE = /^[a-z0-9-]{1,64}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
/** Headers the backend owns; a server's configuration may not set them. */
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "transfer-encoding",
  "upgrade",
  "trailer",
  "expect",
  "cookie",
]);

export function newServerId(): string {
  return crypto.randomUUID();
}

function isValidServerId(id: unknown): id is string {
  return typeof id === "string" && SERVER_ID_RE.test(id);
}

function isValidEnvName(name: string): boolean {
  return ENV_NAME_RE.test(name);
}

export function isValidHeaderName(name: string): boolean {
  return HEADER_NAME_RE.test(name) && !RESERVED_HEADERS.has(name.toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNamedValues(
  raw: unknown,
  valid: (name: string) => boolean,
): McpNamedValue[] {
  if (!Array.isArray(raw)) return [];
  const out: McpNamedValue[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.name !== "string") continue;
    const name = entry.name;
    if (!valid(name) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    if (entry.secret === true) out.push({ name, secret: true });
    else if (typeof entry.value === "string")
      out.push({ name, secret: false, value: entry.value });
  }
  return out;
}

const MAX_SCOPES = 2048;

function parseOAuthClient(raw: unknown): McpOAuthClient | undefined {
  if (!isRecord(raw) || typeof raw.clientId !== "string") return undefined;
  const clientId = raw.clientId.trim();
  if (!clientId || clientId.length > 2048) return undefined;
  const scopes =
    typeof raw.scopes === "string" && raw.scopes.trim()
      ? raw.scopes.trim().slice(0, MAX_SCOPES)
      : null;
  return {
    clientId,
    clientSecret: raw.clientSecret === true,
    scopes,
    callbackPort: isPort(raw.callbackPort) ? raw.callbackPort : null,
  };
}

export function isPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value < 65536
  );
}

/** Parses a transport as stored (or as a project's `.mcp.json` declares it). */
export function parseTransport(
  raw: unknown,
  opts: { strictUrl?: boolean } = {},
): McpTransportConfig | null {
  if (!isRecord(raw)) return null;
  if (raw.type === "stdio") {
    if (typeof raw.command !== "string" || !raw.command.trim()) return null;
    const args = Array.isArray(raw.args)
      ? raw.args.filter((a): a is string => typeof a === "string")
      : [];
    return {
      type: "stdio",
      command: raw.command,
      args,
      env: parseNamedValues(raw.env, isValidEnvName),
      cwd: typeof raw.cwd === "string" && raw.cwd.trim() ? raw.cwd : null,
    };
  }
  if (raw.type === "http" || raw.type === "sse") {
    if (typeof raw.url !== "string") return null;
    // A project server's URL may hold `${VAR}`s the backend expands.
    if (opts.strictUrl !== false && !isHttpUrl(raw.url)) return null;
    const oauth = parseOAuthClient(raw.oauth);
    return {
      type: raw.type,
      url: raw.url,
      headers: parseNamedValues(raw.headers, isValidHeaderName),
      ...(oauth ? { oauth } : {}),
    };
  }
  return null;
}

function parseSource(raw: unknown): McpServerSource {
  if (
    typeof raw === "string" &&
    (raw.startsWith("imported:") || raw.startsWith("project:"))
  ) {
    return raw as McpServerSource;
  }
  return "settings";
}

function parseOverrides(raw: unknown): Record<string, McpToolOverride> {
  const out: Record<string, McpToolOverride> = {};
  if (!isRecord(raw)) return out;
  for (const [tool, value] of Object.entries(raw)) {
    if (value === "allow" || value === "deny") out[tool] = value;
  }
  return out;
}

/**
 * The servers a stored value describes. Anything malformed is dropped, never
 * guessed at: a damaged entry must not start a program. A repeated id or name
 * keeps the first.
 */
export function parseServers(raw: unknown): McpServerConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: McpServerConfig[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry) || !isValidServerId(entry.id)) continue;
    if (typeof entry.name !== "string" || !isValidServerName(entry.name))
      continue;
    const transport = parseTransport(entry.transport);
    if (!transport) continue;
    const nameKey = entry.name.trim().toLowerCase();
    if (ids.has(entry.id) || names.has(nameKey)) continue;
    ids.add(entry.id);
    names.add(nameKey);
    out.push({
      id: entry.id,
      name: entry.name.trim(),
      source: parseSource(entry.source),
      enabled: entry.enabled === true,
      trusted: entry.trusted === true,
      transport,
      tools: parseOverrides(entry.tools),
      secretsRevision:
        typeof entry.secretsRevision === "number" &&
        Number.isSafeInteger(entry.secretsRevision)
          ? entry.secretsRevision
          : 0,
    });
  }
  return out;
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function isValidServerName(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= MAX_SERVER_NAME &&
    !CONTROL_RE.test(trimmed)
  );
}

export function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0 &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/**
 * What a running server was started with: when it changes the server
 * restarts. Trust, per-tool choices and the name do not: they change what the
 * agent is offered, not the connection.
 */
export function launchKey(server: McpServerConfig): string {
  return JSON.stringify([server.transport, server.secretsRevision]);
}

export type SecretRef = { kind: "env" | "header" | "oauth"; name: string };

/** The name of the one OAuth secret Settings keeps (`names::OAUTH_CLIENT_SECRET`). */
export const OAUTH_CLIENT_SECRET = "client-secret";

export function secretRefs(transport: McpTransportConfig): SecretRef[] {
  if (transport.type === "stdio") {
    return transport.env
      .filter((e) => e.secret)
      .map((e) => ({ kind: "env" as const, name: e.name }));
  }
  const refs: SecretRef[] = transport.headers
    .filter((h) => h.secret)
    .map((h) => ({ kind: "header" as const, name: h.name }));
  if (transport.oauth?.clientSecret) {
    refs.push({ kind: "oauth", name: OAUTH_CLIENT_SECRET });
  }
  return refs;
}

/** A server a project's `.mcp.json` declares (its id is the backend's). */
export function isProjectServer(server: Pick<McpServerConfig, "source">) {
  return server.source.startsWith("project:");
}

/** Remote, and configured without an `Authorization` header of its own. */
export function usesSignIn(server: McpServerConfig): boolean {
  const t = server.transport;
  return (
    t.type !== "stdio" &&
    !t.headers.some((h) => h.name.toLowerCase() === "authorization")
  );
}

/** Plain values by name, and the names of secret ones. */
export function splitValues(entries: readonly McpNamedValue[]): {
  plain: Record<string, string>;
  secret: string[];
} {
  const plain: Record<string, string> = {};
  const secret: string[] = [];
  for (const entry of entries) {
    if (entry.secret) secret.push(entry.name);
    else plain[entry.name] = entry.value;
  }
  return { plain, secret };
}

export type ServerDraftErrors = Partial<
  Record<"name" | "command" | "url" | "cwd" | "values" | "oauth", string>
>;

/** What Settings refuses to save, by field. */
export function validateServer(
  server: McpServerConfig,
  others: readonly McpServerConfig[],
): ServerDraftErrors {
  const errors: ServerDraftErrors = {};
  const name = server.name.trim();
  if (!isValidServerName(name)) {
    errors.name = name
      ? `Use at most ${MAX_SERVER_NAME} characters, without line breaks.`
      : "Give the server a name.";
  } else if (
    others.some(
      (o) =>
        o.id !== server.id &&
        o.name.trim().toLowerCase() === name.toLowerCase(),
    )
  ) {
    errors.name = "Another server has this name.";
  }
  const t = server.transport;
  if (t.type === "stdio") {
    if (!t.command.trim())
      errors.command = "Enter the command that starts the server.";
    const cwd = t.cwd?.trim();
    if (cwd && !isAbsolutePath(cwd)) errors.cwd = "Use an absolute path.";
    const bad = t.env.find((e) => !isValidEnvName(e.name));
    if (bad)
      errors.values = `"${bad.name}" is not a valid variable name (letters, digits and _).`;
  } else {
    if (!isHttpUrl(t.url))
      errors.url =
        "Enter an http or https URL, without a user name or password.";
    const bad = t.headers.find((h) => !isValidHeaderName(h.name));
    if (bad) errors.values = `"${bad.name}" cannot be used as a header name.`;
    if (t.oauth && !t.oauth.clientId.trim())
      errors.oauth = "Enter the client ID, or leave sign-in to Terax.";
  }
  const entries = t.type === "stdio" ? t.env : t.headers;
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = entry.name.toLowerCase();
    if (seen.has(key)) {
      errors.values = `"${entry.name}" is listed twice.`;
      break;
    }
    seen.add(key);
  }
  return errors;
}

export function isAbsolutePath(path: string): boolean {
  return (
    path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith("\\\\")
  );
}
