/**
 * Importing servers from other apps (`mcp_import_scan`): what the backend
 * found, and the configuration each picked one becomes. Pure. Values that
 * look like secrets never reach the page: the backend writes them to the
 * keychain itself (`mcp_import_secrets`), and VS Code inputs are left for the
 * user to fill in.
 */

import { joinCommandLine } from "./commandLine";
import {
  isHttpUrl,
  isPort,
  type McpNamedValue,
  type McpServerConfig,
  type McpTransportConfig,
} from "./config";

export type ImportApp = "claude-desktop" | "claude-code" | "cursor" | "vscode";

export type ImportValue = {
  name: string;
  /** Null for a secret: the backend keeps it. */
  value: string | null;
  secret: boolean;
  /** A VS Code input the user fills in: its description. */
  input: string | null;
  /** How VS Code builds the value from the input, when it is more than it. */
  template: string | null;
};

type ImportTransport =
  | {
      type: "stdio";
      command: string;
      args: string[];
      env: ImportValue[];
      cwd: string | null;
    }
  | { type: "http" | "sse"; url: string; headers: ImportValue[] };

export type ImportedServer = {
  /** Its name in the file. */
  key: string;
  transport: ImportTransport | null;
  oauth: {
    clientId: string | null;
    scopes: string | null;
    callbackPort: number | null;
  } | null;
  warnings: string[];
  problem: string | null;
  fingerprint: string;
};

export type ImportSource = {
  app: ImportApp;
  label: string;
  paths: string[];
  found: boolean;
  error: string | null;
  servers: ImportedServer[];
};

const MAX_NAME = 64;
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

/** What a server runs: its command line, or its URL. */
function launchOf(transport: ImportTransport | McpTransportConfig): string {
  return transport.type === "stdio"
    ? joinCommandLine([transport.command, ...transport.args])
    : transport.url.trim().replace(/\/+$/, "");
}

/** The command line or URL, as the import screen shows it. */
export function describeImported(server: ImportedServer): string {
  if (!server.transport) return "";
  const what = launchOf(server.transport);
  return server.transport.type === "sse" ? `${what} (SSE)` : what;
}

/** Whether a configured server already runs the same command or URL. */
export function alreadyPresent(
  server: ImportedServer,
  existing: readonly McpServerConfig[],
): boolean {
  const transport = server.transport;
  if (!transport) return false;
  const launch = launchOf(transport);
  return existing.some(
    (s) =>
      (s.transport.type === "stdio") === (transport.type === "stdio") &&
      launchOf(s.transport) === launch,
  );
}

/** Why a found server cannot be imported, if it cannot. */
export function importProblem(server: ImportedServer): string | null {
  if (server.problem) return server.problem;
  const t = server.transport;
  if (!t) return "It has no command or URL.";
  if (t.type !== "stdio" && !isHttpUrl(t.url))
    return "Its URL is not an http or https URL Oarlock can use.";
  return null;
}

/** A name no configured server has: the file's, numbered when taken. */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  const base =
    name.replace(CONTROL_RE, " ").trim().slice(0, MAX_NAME).trim() || "server";
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const candidate = `${base.slice(0, MAX_NAME - suffix.length)}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function namedValues(values: readonly ImportValue[]): McpNamedValue[] {
  return values.map((v) =>
    v.secret || v.value === null
      ? { name: v.name, secret: true }
      : { name: v.name, secret: false, value: v.value },
  );
}

/**
 * The configuration an imported server gets: off and untrusted until the
 * user turns it on, its secrets named (the backend wrote their values).
 */
export function importedConfig(
  server: ImportedServer,
  app: ImportApp,
  id: string,
  name: string,
): McpServerConfig | null {
  const t = server.transport;
  if (!t || importProblem(server)) return null;
  let transport: McpTransportConfig;
  if (t.type === "stdio") {
    transport = {
      type: "stdio",
      command: t.command,
      args: [...t.args],
      env: namedValues(t.env),
      cwd: t.cwd,
    };
  } else {
    const clientId = server.oauth?.clientId?.trim();
    transport = {
      type: t.type,
      url: t.url.trim(),
      headers: namedValues(t.headers),
      ...(clientId
        ? {
            oauth: {
              clientId,
              clientSecret: false,
              scopes: server.oauth?.scopes ?? null,
              callbackPort: isPort(server.oauth?.callbackPort)
                ? (server.oauth?.callbackPort ?? null)
                : null,
            },
          }
        : {}),
    };
  }
  return {
    id,
    name,
    source: `imported:${app}`,
    enabled: false,
    trusted: false,
    transport,
    tools: {},
    secretsRevision: 0,
  };
}

/** Where an imported server's values go: the keychain, or left to fill in. */
export function secretNotes(server: ImportedServer): {
  keychain: string[];
  toFill: ImportValue[];
} {
  const t = server.transport;
  const values = !t ? [] : t.type === "stdio" ? t.env : t.headers;
  return {
    keychain: values.filter((v) => v.secret && !v.input).map((v) => v.name),
    toFill: values.filter((v) => v.input !== null),
  };
}
