import { usePreferencesStore } from "@/modules/settings/preferences";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  McpError,
  type ServerCapabilities,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SignInRequiredError } from "../lib/auth";
import { type McpToolInfo, useMcpCatalog } from "../lib/catalog";
import { launchKey, type McpServerConfig } from "../lib/config";
import {
  loadWindowServers,
  onMcpChanged,
  saveKnownTools,
} from "../lib/configStore";
import {
  afterCrash,
  planConfigChange,
  startWaitDeadline,
} from "../lib/lifecycle";
import { MCP_RESTART_EVENT } from "../lib/status";
import { errorText, type McpToolOutput, toToolOutput } from "../lib/results";
import { exposedToolNames, toolKey } from "../lib/toolNames";
import {
  capText,
  cleanAnnotations,
  inputSchemaFor,
  isCallable,
  type McpListedTool,
  toolDescription,
} from "../lib/toolSchema";
import { type Connection, connectServer } from "./connect";

const MAX_TOOL_PAGES = 20;
const MAX_TOOLS_PER_SERVER = 1000;
const LIST_TIMEOUT_MS = 30_000;
/** A call waits this long without progress, and at most `CALL_MAX_MS`. */
const CALL_TIMEOUT_MS = 2 * 60_000;
const CALL_MAX_MS = 15 * 60_000;
const MAX_INSTRUCTIONS = 2000;
const REFRESH_DEBOUNCE_MS = 300;

type RunState = "starting" | "running" | "crashed";

type ServerRun = {
  server: McpServerConfig;
  launch: string;
  generation: number;
  state: RunState;
  startedAt: number;
  connection: Connection | null;
  tools: McpListedTool[];
  instructions: string | null;
  serverInfo: string | null;
  /** What the server offers, as it announced it (resources, prompts, ...). */
  capabilities: ServerCapabilities | null;
  error: string | null;
  crashes: number[];
  retryAt: number | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  /** Settles when the current start attempt has finished either way. */
  settled: Promise<void>;
};

/** A tool the agent may be offered, with what its gate depends on. */
export type OfferedTool = {
  info: McpToolInfo;
  description: string;
  inputSchema: Record<string, unknown>;
  alwaysAllow: boolean;
};

function message(error: unknown): string {
  return capText(error instanceof Error ? error.message : String(error), 2000);
}

function describeLaunch(server: McpServerConfig): string {
  const t = server.transport;
  return t.type === "stdio"
    ? [t.command, ...t.args].join(" ")
    : `${t.type === "sse" ? "SSE" : "Streamable HTTP"} ${t.url}`;
}

/** What a server offers besides tools, for its log. */
export function otherFeatures(
  capabilities: ServerCapabilities | null,
): string[] {
  if (!capabilities) return [];
  return (["resources", "prompts", "completions", "logging"] as const).filter(
    (feature) => capabilities[feature] !== undefined,
  );
}

async function listAllTools(client: Client): Promise<McpListedTool[]> {
  const tools: McpListedTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const result = await client.listTools(cursor ? { cursor } : undefined, {
      timeout: LIST_TIMEOUT_MS,
    });
    tools.push(...(result.tools as McpListedTool[]));
    if (!result.nextCursor || tools.length >= MAX_TOOLS_PER_SERVER) break;
    cursor = result.nextCursor;
  }
  return tools.slice(0, MAX_TOOLS_PER_SERVER);
}

/**
 * This window's MCP clients: one per enabled server, started when the agent
 * first needs tools, restarted with backoff after a crash, stopped when the
 * server is disabled or removed, restarted when its launch settings change.
 * Each app window has its own (a client lives in a page); the backend ends a
 * window's servers when it reloads or closes.
 */
export class McpManager {
  private runs = new Map<string, ServerRun>();
  private servers: McpServerConfig[] = [];
  private generation = 0;
  private offered = new Map<string, OfferedTool>();
  private listening: Promise<void> | null = null;

  /** Follows Settings: configuration changes and restart requests. */
  listen(): Promise<void> {
    this.listening ??= (async () => {
      await onMcpChanged((change) => {
        if (change.kind === "servers") {
          void loadWindowServers().then((servers) => this.sync(servers));
        }
      });
      await listen<{ serverId: string }>(MCP_RESTART_EVENT, (event) => {
        this.restart(event.payload.serverId);
      });
    })();
    return this.listening;
  }

  /** Starts, stops, restarts or updates servers to match `servers`. */
  sync(servers: readonly McpServerConfig[]): void {
    this.servers = [...servers];
    const running = new Map(
      [...this.runs].map(([id, run]) => [id, run.launch] as const),
    );
    let changed = false;
    for (const plan of planConfigChange(running, servers)) {
      switch (plan.kind) {
        case "start":
          this.start(plan.server, []);
          break;
        case "stop":
          void this.stop(plan.id);
          break;
        case "restart":
          this.replace(plan.server.id);
          break;
        case "update": {
          const run = this.runs.get(plan.server.id);
          if (run) {
            run.server = plan.server;
            changed = true;
          }
          break;
        }
      }
    }
    if (changed) this.publish();
  }

  /** A restart the user asked for: the crash history starts over. */
  restart(id: string): void {
    const server = this.servers.find((s) => s.id === id && s.enabled);
    if (!server || !this.runs.has(id)) return;
    this.note(id, "Restarting (requested in Settings)");
    this.replace(id);
  }

  /**
   * Stops a server and starts it again with the configuration current by
   * then (a change meanwhile may have disabled it or started it already).
   */
  private replace(id: string): void {
    void this.stop(id).then(() => {
      const server = this.servers.find((s) => s.id === id && s.enabled);
      if (server && !this.runs.has(id)) this.start(server, []);
    });
  }

  /**
   * Waits for servers still starting, for at most `START_WAIT_MS` since each
   * began, so the first message after launch sees their tools.
   */
  async waitForStarting(signal?: AbortSignal): Promise<void> {
    const starting = [...this.runs.values()].filter(
      (r) => r.state === "starting",
    );
    const deadline = startWaitDeadline(starting, Date.now());
    if (deadline === null || signal?.aborted) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    await Promise.race([
      Promise.allSettled(starting.map((r) => r.settled)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deadline - Date.now());
      }),
      new Promise<void>((resolve) => {
        onAbort = () => resolve();
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }

  hasStarting(): boolean {
    return [...this.runs.values()].some((r) => r.state === "starting");
  }

  offeredTools(): OfferedTool[] {
    return [...this.offered.values()];
  }

  /** What running servers ask the model to know, capped. */
  instructions(): { server: string; text: string }[] {
    return this.orderedRuns()
      .filter((r) => r.state === "running" && r.instructions?.trim())
      .map((r) => ({
        server: r.server.name,
        text: capText((r.instructions ?? "").trim(), MAX_INSTRUCTIONS),
      }));
  }

  async callTool(
    serverId: string,
    tool: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<McpToolOutput> {
    const run = this.runs.get(serverId);
    const connection = run?.state === "running" ? run.connection : null;
    if (!run || !connection) {
      const name = run?.server.name ?? "This MCP server";
      throw new Error(
        `${name} is not running${run?.error ? ` (${run.error})` : ""}.`,
      );
    }
    const generation = run.generation;
    let result: unknown;
    try {
      result = await connection.client.callTool(
        {
          name: tool,
          arguments:
            typeof input === "object" && input !== null
              ? (input as Record<string, unknown>)
              : {},
        },
        undefined,
        {
          signal,
          timeout: CALL_TIMEOUT_MS,
          resetTimeoutOnProgress: true,
          maxTotalTimeout: CALL_MAX_MS,
          onprogress: () => {},
        },
      );
    } catch (error) {
      const text = message(error);
      // A remote session that failed outside the protocol (network, an
      // expired session) is reconnected; protocol errors are the tool's.
      if (
        connection.remote &&
        !(error instanceof McpError) &&
        !signal?.aborted
      ) {
        void connection.close();
        const signIn = connection.signInRequired();
        this.crash(
          run,
          generation,
          signIn ? new SignInRequiredError().message : text,
          signIn,
        );
      }
      throw new Error(errorText(null, text));
    }
    const out = toToolOutput(result, run.server.name, tool);
    if ("error" in out) throw new Error(out.error);
    return out.output;
  }

  private current(run: ServerRun, generation: number): boolean {
    return (
      this.runs.get(run.server.id) === run && run.generation === generation
    );
  }

  private orderedRuns(): ServerRun[] {
    const order = new Map(this.servers.map((s, i) => [s.id, i] as const));
    return [...this.runs.values()].sort(
      (a, b) => (order.get(a.server.id) ?? 0) - (order.get(b.server.id) ?? 0),
    );
  }

  private start(server: McpServerConfig, crashes: number[]): void {
    const generation = ++this.generation;
    const run: ServerRun = {
      server,
      launch: launchKey(server),
      generation,
      state: "starting",
      startedAt: Date.now(),
      connection: null,
      tools: [],
      instructions: null,
      serverInfo: null,
      capabilities: null,
      error: null,
      crashes,
      retryAt: null,
      retryTimer: null,
      refreshTimer: null,
      settled: Promise.resolve(),
    };
    this.runs.set(server.id, run);
    this.report(run);
    this.note(server.id, `Starting: ${describeLaunch(server)}`);
    run.settled = this.connect(run, generation);
  }

  private async connect(run: ServerRun, generation: number): Promise<void> {
    let connection: Connection | null = null;
    try {
      connection = await connectServer(
        run.server,
        usePreferencesStore.getState().terminalShell || null,
      );
      if (!this.current(run, generation)) {
        await connection.close();
        return;
      }
      run.connection = connection;
      const opened = connection;
      opened.client.onclose = () => {
        if (!this.current(run, generation)) return;
        this.crash(
          run,
          generation,
          opened.endReason() ?? "The connection closed.",
        );
      };
      opened.client.onerror = (error) => {
        if (this.current(run, generation))
          this.note(run.server.id, message(error));
      };
      const version = opened.client.getServerVersion();
      run.serverInfo = version
        ? capText(`${version.title ?? version.name} ${version.version}`, 200)
        : null;
      run.instructions = opened.client.getInstructions() ?? null;
      const capabilities = opened.client.getServerCapabilities() ?? null;
      run.capabilities = capabilities;
      if (capabilities?.tools?.listChanged) {
        opened.client.setNotificationHandler(
          ToolListChangedNotificationSchema,
          () => this.scheduleRefresh(run, generation),
        );
      }
      const tools = capabilities?.tools
        ? await listAllTools(opened.client)
        : [];
      if (!this.current(run, generation)) return;
      run.tools = tools;
      run.state = "running";
      run.error = null;
      const others = otherFeatures(capabilities);
      this.note(
        run.server.id,
        `Connected to ${run.serverInfo ?? "the server"}: ${tools.length} tool${tools.length === 1 ? "" : "s"}${others.length > 0 ? ` (it also offers ${others.join(", ")})` : ""}`,
      );
      this.report(run);
      this.publish();
      this.remember(run);
    } catch (error) {
      if (connection && run.connection !== connection) {
        await connection.close().catch(() => {});
      }
      if (!this.current(run, generation)) return;
      this.crash(
        run,
        generation,
        message(error),
        error instanceof SignInRequiredError,
      );
    }
  }

  /** A failure; one that needs sign-in waits for it instead of retrying. */
  private crash(
    run: ServerRun,
    generation: number,
    error: string,
    signIn = false,
  ): void {
    if (!this.current(run, generation) || run.state === "crashed") return;
    const connection = run.connection;
    run.connection = null;
    if (connection) void connection.close();
    if (run.refreshTimer) clearTimeout(run.refreshTimer);
    const now = Date.now();
    const next = signIn
      ? { crashes: run.crashes, delayMs: null }
      : afterCrash(run.crashes, now);
    run.state = "crashed";
    run.error = error;
    run.tools = [];
    run.crashes = next.crashes;
    run.retryAt = next.delayMs === null ? null : now + next.delayMs;
    this.note(
      run.server.id,
      signIn
        ? `Stopped: ${error}`
        : next.delayMs === null
          ? `Stopped after ${next.crashes.length} failures: ${error}. Restart it from Settings.`
          : `Failed: ${error}. Restarting in ${Math.round(next.delayMs / 1000)} s`,
    );
    this.report(run);
    this.publish();
    if (next.delayMs !== null) {
      run.retryTimer = setTimeout(() => {
        if (!this.current(run, generation)) return;
        this.start(run.server, run.crashes);
      }, next.delayMs);
    }
  }

  private async stop(id: string): Promise<void> {
    const run = this.runs.get(id);
    if (!run) return;
    this.runs.delete(id);
    if (run.retryTimer) clearTimeout(run.retryTimer);
    if (run.refreshTimer) clearTimeout(run.refreshTimer);
    void invoke("mcp_status_report", {
      report: {
        serverId: id,
        state: "stopped",
        error: null,
        serverInfo: null,
        toolCount: null,
        retryAtMs: null,
      },
    }).catch(() => {});
    this.note(id, "Stopped");
    this.publish();
    await run.connection?.close();
  }

  private scheduleRefresh(run: ServerRun, generation: number): void {
    if (run.refreshTimer) clearTimeout(run.refreshTimer);
    run.refreshTimer = setTimeout(() => {
      run.refreshTimer = null;
      const client = run.connection?.client;
      if (!client || !this.current(run, generation)) return;
      listAllTools(client).then(
        (tools) => {
          if (!this.current(run, generation) || run.state !== "running") return;
          run.tools = tools;
          this.note(run.server.id, `Tools changed: ${tools.length}`);
          this.report(run);
          this.publish();
          this.remember(run);
        },
        (error) =>
          this.note(
            run.server.id,
            `Could not refresh tools: ${message(error)}`,
          ),
      );
    }, REFRESH_DEBOUNCE_MS);
  }

  /** Recomputes the agent's MCP tools and the window's catalog. */
  private publish(): void {
    const runs = this.orderedRuns().filter((r) => r.state === "running");
    const candidates = runs.flatMap((run) =>
      run.tools
        .filter((tool) => isCallable(tool))
        .map((tool) => ({ run, tool, schema: inputSchemaFor(tool) })),
    );
    const names = exposedToolNames(
      candidates.map(({ run, tool }) => ({
        serverId: run.server.id,
        serverName: run.server.name,
        tool: tool.name,
      })),
    );
    const offered = new Map<string, OfferedTool>();
    const catalog: Record<string, McpToolInfo> = {};
    for (const { run, tool, schema } of candidates) {
      const override = run.server.tools[tool.name];
      const name = names.get(toolKey(run.server.id, tool.name));
      if (!name || !schema || override === "deny") continue;
      const info: McpToolInfo = {
        name,
        serverId: run.server.id,
        serverName: run.server.name,
        tool: tool.name,
        title: tool.title ?? tool.annotations?.title,
        annotations: cleanAnnotations(tool.annotations),
        trusted: run.server.trusted,
      };
      catalog[name] = info;
      offered.set(name, {
        info,
        description: toolDescription(tool),
        inputSchema: schema,
        alwaysAllow: override === "allow",
      });
    }
    this.offered = offered;
    useMcpCatalog.getState().setTools(catalog);
  }

  private remember(run: ServerRun): void {
    void saveKnownTools(
      run.server.id,
      run.tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        annotations: tool.annotations,
      })),
    ).catch(() => {});
  }

  private report(run: ServerRun): void {
    void invoke("mcp_status_report", {
      report: {
        serverId: run.server.id,
        state: run.state,
        error: run.error,
        serverInfo: run.serverInfo,
        toolCount: run.state === "running" ? run.tools.length : null,
        retryAtMs: run.retryAt,
      },
    }).catch(() => {});
  }

  private note(serverId: string, text: string): void {
    void invoke("mcp_log_note", { serverId, text }).catch(() => {});
  }
}
