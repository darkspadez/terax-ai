import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";
import { type McpServerConfig, parseServers } from "./config";
import {
  type ProjectServerRecord,
  type ProjectServers,
  parseRecords,
  projectConfigs,
} from "./projectServers";
import { capText, cleanAnnotations, type McpAnnotations } from "./toolSchema";

/**
 * Servers, what the user chose for project servers, and the tools each listed
 * when it last ran (for Settings).
 */
const STORE_PATH = "oarlock-mcp.json";
const KEY_SERVERS = "servers";
const KEY_PROJECT_SERVERS = "projectServers";
const TOOLS_PREFIX = "tools:";
const MAX_KNOWN_TOOLS = 500;

/**
 * Store change events reach only the writing webview, so every write is
 * announced: windows restart what changed, Settings re-reads.
 */
const MCP_CHANGED_EVENT = "oarlock://mcp-changed";
/**
 * What a window may run from its project changes with trust decisions
 * (`project_trust::CHANGED_EVENT`, also sent when a window opens or leaves a
 * project) and with the project's files (`skills::CHANGED_EVENT`).
 */
const PROJECT_EVENTS = ["project-trust:changed", "skills:changed"];

export type McpChange =
  | { kind: "servers" }
  | { kind: "tools"; serverId: string };

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: false });

export async function loadServers(): Promise<McpServerConfig[]> {
  return parseServers(await store.get<unknown>(KEY_SERVERS));
}

export async function saveServers(
  servers: readonly McpServerConfig[],
): Promise<void> {
  await store.set(KEY_SERVERS, servers);
  await store.save();
  await emit(MCP_CHANGED_EVENT, { kind: "servers" } satisfies McpChange);
}

export async function loadProjectRecords(): Promise<
  Record<string, ProjectServerRecord>
> {
  return parseRecords(await store.get<unknown>(KEY_PROJECT_SERVERS));
}

/** Keeps what the user chose for one project server. */
export async function saveProjectRecord(
  id: string,
  record: ProjectServerRecord,
): Promise<void> {
  const records = await loadProjectRecords();
  await store.set(KEY_PROJECT_SERVERS, { ...records, [id]: record });
  await store.save();
  await emit(MCP_CHANGED_EVENT, { kind: "servers" } satisfies McpChange);
}

/**
 * The servers of the calling window's project, or with `all` (Settings) of
 * every open project; listed only while the user allows their `.mcp.json`.
 */
export function listProjectServers(all: boolean): Promise<ProjectServers[]> {
  return invoke<ProjectServers[]>("mcp_project_servers", { all });
}

/** What this window runs: the configured servers and its project's. */
export async function loadWindowServers(): Promise<McpServerConfig[]> {
  const [servers, records, projects] = await Promise.all([
    loadServers(),
    loadProjectRecords(),
    listProjectServers(false).catch((error) => {
      console.warn("[mcp] project servers unavailable", error);
      return [];
    }),
  ]);
  return [...servers, ...projectConfigs(projects, records)];
}

/** A tool as Settings lists it for per-tool choices. */
export type KnownTool = {
  name: string;
  title?: string;
  description?: string;
  annotations?: McpAnnotations;
};

function cleanKnownTools(raw: unknown): KnownTool[] {
  if (!Array.isArray(raw)) return [];
  const out: KnownTool[] = [];
  for (const entry of raw.slice(0, MAX_KNOWN_TOOLS)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, title, description, annotations } = entry as Record<
      string,
      unknown
    >;
    if (typeof name !== "string" || !name) continue;
    out.push({
      name: capText(name, 200),
      ...(typeof title === "string" ? { title: capText(title, 200) } : {}),
      ...(typeof description === "string"
        ? { description: capText(description, 400) }
        : {}),
      ...(cleanAnnotations(annotations)
        ? { annotations: cleanAnnotations(annotations) }
        : {}),
    });
  }
  return out;
}

export async function loadKnownTools(): Promise<Record<string, KnownTool[]>> {
  const out: Record<string, KnownTool[]> = {};
  for (const [key, value] of await store.entries<unknown>()) {
    if (key.startsWith(TOOLS_PREFIX)) {
      out[key.slice(TOOLS_PREFIX.length)] = cleanKnownTools(value);
    }
  }
  return out;
}

/** One key per server, so windows recording different servers never race. */
export async function saveKnownTools(
  serverId: string,
  tools: readonly KnownTool[],
): Promise<void> {
  const key = `${TOOLS_PREFIX}${serverId}`;
  const next = cleanKnownTools(tools);
  const current = cleanKnownTools(await store.get<unknown>(key));
  if (JSON.stringify(current) === JSON.stringify(next)) return;
  await store.set(key, next);
  await store.save();
  await emit(MCP_CHANGED_EVENT, {
    kind: "tools",
    serverId,
  } satisfies McpChange);
}

export async function forgetKnownTools(serverId: string): Promise<void> {
  await store.delete(`${TOOLS_PREFIX}${serverId}`);
  await store.save();
}

/** Configuration changes, and changes of what the open projects provide. */
export async function onMcpChanged(
  handler: (change: McpChange) => void,
): Promise<UnlistenFn> {
  const stops = await Promise.all([
    listen<McpChange>(MCP_CHANGED_EVENT, (event) => handler(event.payload)),
    ...PROJECT_EVENTS.map((name) =>
      listen(name, () => handler({ kind: "servers" })),
    ),
  ]);
  return () => {
    for (const stop of stops) stop();
  };
}
