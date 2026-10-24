import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import { invoke } from "@tauri-apps/api/core";
import type { McpServerConfig } from "../lib/config";
import { labelText } from "../lib/displayText";
import {
  cleanPrompts,
  cleanResources,
  cleanTemplates,
  MAX_PROMPTS,
  MAX_RESOURCES,
  MAX_TEMPLATES,
  type McpPromptEntry,
  type McpResourceEntry,
  type McpServerExtras,
  type McpTemplateEntry,
  useMcpExtras,
} from "../lib/extrasCatalog";
import { capText } from "../lib/toolSchema";

const MAX_PAGES = 20;
const LIST_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 60_000;
const COMPLETE_TIMEOUT_MS = 5_000;
const REFRESH_DEBOUNCE_MS = 300;
const MAX_COMPLETIONS = 100;

type ListKind = "resources" | "prompts";

type Entry = {
  server: McpServerConfig;
  client: Client;
  capabilities: ServerCapabilities | null;
  resources: McpResourceEntry[];
  templates: McpTemplateEntry[];
  prompts: McpPromptEntry[];
  timers: Partial<Record<ListKind, ReturnType<typeof setTimeout>>>;
  ready: Promise<void>;
};

/** Where a completion is asked for: a prompt's argument or a template's variable. */
export type CompletionRef =
  | { type: "ref/prompt"; name: string }
  | { type: "ref/resource"; uri: string };

function message(error: unknown): string {
  return capText(error instanceof Error ? error.message : String(error), 500);
}

async function allPages<T>(
  fetch: (cursor: string | undefined) => Promise<{
    items: unknown[];
    nextCursor?: string;
  }>,
  max: number,
): Promise<T[]> {
  const items: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await fetch(cursor);
    items.push(...result.items);
    if (!result.nextCursor || items.length >= max) break;
    cursor = result.nextCursor;
  }
  return items as T[];
}

function templateVariables(template: string): string[] | null {
  return new UriTemplate(template).variableNames;
}

/**
 * Resources, resource templates and prompts of the window's running
 * servers: listed when a server connects, cached, refreshed on the server's
 * `list_changed` notifications, and published for the composer
 * (`useMcpExtras`). Also reads a resource, expands a template, gets a prompt
 * and asks for completions on the user's behalf. The manager tells it when a
 * server connects, changes or ends.
 */
export class McpExtras {
  private entries = new Map<string, Entry>();

  connected(
    server: McpServerConfig,
    client: Client,
    capabilities: ServerCapabilities | null,
  ): void {
    this.ended(server.id);
    const entry: Entry = {
      server,
      client,
      capabilities,
      resources: [],
      templates: [],
      prompts: [],
      timers: {},
      ready: Promise.resolve(),
    };
    this.entries.set(server.id, entry);
    if (capabilities?.resources?.listChanged) {
      client.setNotificationHandler(ResourceListChangedNotificationSchema, () =>
        this.schedule(entry, "resources"),
      );
    }
    if (capabilities?.prompts?.listChanged) {
      client.setNotificationHandler(PromptListChangedNotificationSchema, () =>
        this.schedule(entry, "prompts"),
      );
    }
    this.publish();
    entry.ready = Promise.all([
      capabilities?.resources ? this.refresh(entry, "resources") : undefined,
      capabilities?.prompts ? this.refresh(entry, "prompts") : undefined,
    ]).then(() => undefined);
  }

  async waitForLists(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => entry.ready));
  }

  /** The server stopped, crashed or is restarting: its lists go. */
  ended(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    for (const timer of Object.values(entry.timers)) clearTimeout(timer);
    this.entries.delete(id);
    this.publish();
  }

  /** A change that keeps the connection (its name). */
  updated(server: McpServerConfig): void {
    const entry = this.entries.get(server.id);
    if (!entry) return;
    entry.server = server;
    this.publish();
  }

  /** Reads a resource; the content is the server's. */
  async read(
    serverId: string,
    uri: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const entry = this.running(serverId);
    return entry.client.readResource(
      { uri },
      { signal, timeout: READ_TIMEOUT_MS },
    );
  }

  /** A template filled in with the user's values (RFC 6570). */
  expand(uriTemplate: string, values: Record<string, string>): string {
    return new UriTemplate(uriTemplate).expand(values);
  }

  async getPrompt(
    serverId: string,
    name: string,
    args: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const entry = this.running(serverId);
    return entry.client.getPrompt(
      { name, arguments: args },
      { signal, timeout: READ_TIMEOUT_MS },
    );
  }

  /**
   * The server's suggestions for an argument (`completion/complete`), or
   * none when it does not offer completions or fails: suggestions only help.
   */
  async complete(
    serverId: string,
    ref: CompletionRef,
    argument: { name: string; value: string },
    context: Record<string, string>,
  ): Promise<string[]> {
    const entry = this.entries.get(serverId);
    if (!entry?.capabilities?.completions) return [];
    try {
      const result = await entry.client.complete(
        { ref, argument, context: { arguments: context } },
        { timeout: COMPLETE_TIMEOUT_MS },
      );
      const values = Array.isArray(result.completion?.values)
        ? result.completion.values
        : [];
      return [
        ...new Set(
          values
            .slice(0, MAX_COMPLETIONS)
            .map((v) => labelText(v, 500))
            .filter((v) => v.length > 0),
        ),
      ];
    } catch {
      return [];
    }
  }

  private running(serverId: string): Entry {
    const entry = this.entries.get(serverId);
    if (!entry) throw new Error("This MCP server is not running.");
    return entry;
  }

  private schedule(entry: Entry, kind: ListKind): void {
    if (this.entries.get(entry.server.id) !== entry) return;
    clearTimeout(entry.timers[kind]);
    entry.timers[kind] = setTimeout(() => {
      delete entry.timers[kind];
      void this.refresh(entry, kind);
    }, REFRESH_DEBOUNCE_MS);
  }

  private async refresh(entry: Entry, kind: ListKind): Promise<void> {
    const { client } = entry;
    const options = { timeout: LIST_TIMEOUT_MS };
    try {
      if (kind === "resources") {
        const [resources, templates] = await Promise.all([
          allPages<unknown>(async (cursor) => {
            const r = await client.listResources(
              cursor ? { cursor } : undefined,
              options,
            );
            return { items: r.resources, nextCursor: r.nextCursor };
          }, MAX_RESOURCES),
          allPages<unknown>(async (cursor) => {
            const r = await client.listResourceTemplates(
              cursor ? { cursor } : undefined,
              options,
            );
            return { items: r.resourceTemplates, nextCursor: r.nextCursor };
          }, MAX_TEMPLATES).catch(() => [] as unknown[]),
        ]);
        if (this.entries.get(entry.server.id) !== entry) return;
        entry.resources = cleanResources(resources);
        entry.templates = cleanTemplates(templates, templateVariables);
      } else {
        const prompts = await allPages<unknown>(async (cursor) => {
          const r = await client.listPrompts(
            cursor ? { cursor } : undefined,
            options,
          );
          return { items: r.prompts, nextCursor: r.nextCursor };
        }, MAX_PROMPTS);
        if (this.entries.get(entry.server.id) !== entry) return;
        entry.prompts = cleanPrompts(prompts);
      }
      this.publish();
    } catch (error) {
      if (this.entries.get(entry.server.id) !== entry) return;
      void invoke("mcp_log_note", {
        serverId: entry.server.id,
        text: `Could not list its ${kind}: ${message(error)}`,
      }).catch(() => {});
    }
  }

  private publish(): void {
    const servers: McpServerExtras[] = [...this.entries.values()]
      .map((entry) => ({
        serverId: entry.server.id,
        serverName: entry.server.name,
        resources: entry.resources,
        templates: entry.templates,
        prompts: entry.prompts,
        completions: entry.capabilities?.completions !== undefined,
      }))
      .sort((a, b) =>
        a.serverName.localeCompare(b.serverName, undefined, {
          sensitivity: "base",
        }),
      );
    useMcpExtras.getState().setServers(servers);
  }
}
