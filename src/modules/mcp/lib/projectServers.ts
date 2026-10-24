/**
 * Servers a project's `.mcp.json` declares, as the backend lists them for the
 * window's project (`mcp_project_servers`), and what the user chose for each.
 * Pure. The backend lists them only while the user allows the file's current
 * content; it expands their `${VAR}`s itself when it starts one.
 *
 * Choices are kept per server id with the hash of the server's own entry:
 * Trusted and Always allow hold only for the entry they were made for (a
 * changed command or URL asks again), while Off and Never allow always hold.
 */

import type { OpenProject, TrustItem } from "@/modules/skills/types";
import {
  type McpServerConfig,
  type McpToolOverride,
  parseTransport,
} from "./config";

export type ProjectServerView = {
  id: string;
  name: string;
  /** As written in the file: values may hold `${VAR}`s. */
  transport: unknown;
  entryHash: string;
  /** The environment variables it reads. */
  variables: string[];
  warnings: string[];
  problem: string | null;
};

export type ProjectServers = {
  project: OpenProject;
  /** The file, spelled as the window spells the project. */
  path: string;
  state: TrustItem["state"];
  /** The content hash a decision is made for. */
  hash: string | null;
  problem: string | null;
  /** What each server runs, for review. */
  entries: TrustItem["entries"];
  /** Listed only while the user allows the file's current content. */
  servers: ProjectServerView[];
};

export type ProjectServerRecord = {
  /** The entry the choices were made for. */
  entryHash: string;
  enabled: boolean;
  trusted: boolean;
  tools: Record<string, McpToolOverride>;
};

const ID_RE = /^prj-[0-9a-f]{12}-[0-9a-f]{12}$/;

function isProjectServerId(id: string): boolean {
  return ID_RE.test(id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The stored choices, damaged entries dropped. */
export function parseRecords(
  raw: unknown,
): Record<string, ProjectServerRecord> {
  const out: Record<string, ProjectServerRecord> = {};
  if (!isRecord(raw)) return out;
  for (const [id, value] of Object.entries(raw)) {
    if (!isProjectServerId(id) || !isRecord(value)) continue;
    if (typeof value.entryHash !== "string") continue;
    const tools: Record<string, McpToolOverride> = {};
    if (isRecord(value.tools)) {
      for (const [tool, choice] of Object.entries(value.tools)) {
        if (choice === "allow" || choice === "deny") tools[tool] = choice;
      }
    }
    out[id] = {
      entryHash: value.entryHash,
      enabled: value.enabled !== false,
      trusted: value.trusted === true,
      tools,
    };
  }
  return out;
}

/** The choices that hold for the entry as it is now. */
export function effectiveRecord(
  record: ProjectServerRecord | undefined,
  entryHash: string,
): Omit<ProjectServerRecord, "entryHash"> {
  if (!record) return { enabled: true, trusted: false, tools: {} };
  if (record.entryHash === entryHash) return record;
  const tools: Record<string, McpToolOverride> = {};
  for (const [tool, choice] of Object.entries(record.tools)) {
    if (choice === "deny") tools[tool] = choice;
  }
  return { enabled: record.enabled, trusted: false, tools };
}

/**
 * The configuration a project server runs with: on unless turned off, never
 * trusted until the user says so. Null for one that cannot be used.
 */
export function projectServerConfig(
  view: ProjectServerView,
  project: OpenProject,
  record: ProjectServerRecord | undefined,
): McpServerConfig | null {
  if (view.problem || !isProjectServerId(view.id)) return null;
  const transport = parseTransport(view.transport, { strictUrl: false });
  if (!transport) return null;
  const choices = effectiveRecord(record, view.entryHash);
  return {
    id: view.id,
    name: view.name.trim().slice(0, 64) || view.id,
    source: `project:${project.root}`,
    enabled: choices.enabled,
    trusted: choices.trusted,
    transport,
    tools: choices.tools,
    secretsRevision: 0,
  };
}

/** The record a changed project server is kept as. */
export function recordOf(
  server: Pick<McpServerConfig, "enabled" | "trusted" | "tools">,
  entryHash: string,
): ProjectServerRecord {
  return {
    entryHash,
    enabled: server.enabled,
    trusted: server.trusted,
    tools: { ...server.tools },
  };
}

/** Every usable server of the listed projects. */
export function projectConfigs(
  projects: readonly ProjectServers[],
  records: Record<string, ProjectServerRecord>,
): McpServerConfig[] {
  return projects.flatMap((p) =>
    p.servers.flatMap((view) => {
      const config = projectServerConfig(view, p.project, records[view.id]);
      return config ? [config] : [];
    }),
  );
}
