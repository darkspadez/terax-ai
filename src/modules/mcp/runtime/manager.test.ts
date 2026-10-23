import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "../lib/config";

type FakeClient = {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  listChanged?: () => void;
  getServerVersion: () => { name: string; version: string };
  getInstructions: () => string | undefined;
  getServerCapabilities: () => Record<string, unknown>;
  setNotificationHandler: (schema: unknown, handler: () => void) => void;
  listTools: () => Promise<{ tools: unknown[] }>;
  callTool: ReturnType<typeof vi.fn>;
};

const fakes = vi.hoisted(() => ({
  tools: new Map<string, unknown[]>(),
  failing: new Set<string>(),
  signIn: new Set<string>(),
  refused: new Set<string>(),
  remote: new Set<string>(),
  connects: [] as string[],
  closes: [] as string[],
  clients: new Map<string, FakeClient>(),
  invokes: [] as [string, Record<string, unknown>][],
  saved: [] as string[],
  held: new Set<string>(),
  releases: [] as (() => void)[],
}));

vi.mock("./connect", async () => {
  const { SignInRequiredError } = await import("../lib/auth");
  return {
    connectServer: async (server: McpServerConfig) => {
      fakes.connects.push(server.id);
      if (fakes.failing.has(server.id)) throw new Error("spawn failed");
      if (fakes.signIn.has(server.id)) throw new SignInRequiredError();
      const client: FakeClient = {
        getServerVersion: () => ({
          name: `${server.name}-srv`,
          version: "1.0",
        }),
        getInstructions: () => `Use ${server.name} wisely.`,
        getServerCapabilities: () => ({ tools: { listChanged: true } }),
        setNotificationHandler: (_schema, handler) => {
          client.listChanged = handler;
        },
        listTools: async () => {
          if (fakes.held.has(server.id)) {
            await new Promise<void>((resolve) => fakes.releases.push(resolve));
          }
          return { tools: fakes.tools.get(server.id) ?? [] };
        },
        callTool: vi.fn(async () => ({
          content: [{ type: "text", text: "ok" }],
        })),
      };
      fakes.clients.set(server.id, client);
      return {
        client,
        remote: fakes.remote.has(server.id),
        endReason: () => "Exited with code 1: boom",
        signInRequired: () => fakes.refused.has(server.id),
        close: async () => {
          fakes.closes.push(server.id);
        },
      };
    },
  };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, unknown>) => {
    fakes.invokes.push([command, args]);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async () => () => {},
}));
vi.mock("../lib/configStore", () => ({
  loadWindowServers: async () => [],
  onMcpChanged: async () => () => {},
  saveKnownTools: async (id: string) => {
    fakes.saved.push(id);
  },
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: { getState: () => ({ terminalShell: "" }) },
}));

import { useMcpCatalog } from "../lib/catalog";
import { useMcpExtras } from "../lib/extrasCatalog";
import { MAX_CRASHES, RESTART_DELAYS_MS } from "../lib/lifecycle";
import { McpManager, otherFeatures } from "./manager";

function server(
  id: string,
  overrides: Partial<McpServerConfig> = {},
): McpServerConfig {
  return {
    id,
    name: id,
    source: "settings",
    enabled: true,
    trusted: false,
    tools: {},
    secretsRevision: 0,
    transport: {
      type: "stdio",
      command: "npx",
      args: [id],
      env: [],
      cwd: null,
    },
    ...overrides,
  };
}

const tool = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  inputSchema: { type: "object", properties: {} },
  ...extra,
});

function statuses(id: string): string[] {
  return fakes.invokes
    .filter(
      ([command, args]) =>
        command === "mcp_status_report" &&
        (args.report as { serverId: string }).serverId === id,
    )
    .map(([, args]) => (args.report as { state: string }).state);
}

async function settle(manager: McpManager) {
  await manager.waitForStarting();
  await vi.waitFor(() => expect(manager.hasStarting()).toBe(false));
}

beforeEach(() => {
  fakes.tools.clear();
  fakes.failing.clear();
  fakes.signIn.clear();
  fakes.refused.clear();
  fakes.remote.clear();
  fakes.connects.length = 0;
  fakes.closes.length = 0;
  fakes.clients.clear();
  fakes.invokes.length = 0;
  fakes.saved.length = 0;
  fakes.held.clear();
  fakes.releases.length = 0;
  useMcpCatalog.getState().setTools({});
  useMcpExtras.getState().setServers([]);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("McpManager", () => {
  it("starts enabled servers and offers their tools", async () => {
    fakes.tools.set("gh", [tool("create_issue"), tool("search")]);
    const manager = new McpManager();
    manager.sync([server("gh"), server("off", { enabled: false })]);
    await settle(manager);
    expect(fakes.connects).toEqual(["gh"]);
    expect(statuses("gh")).toEqual(["starting", "running"]);
    expect(manager.offeredTools().map((t) => t.info.name)).toEqual([
      "mcp__gh__create_issue",
      "mcp__gh__search",
    ]);
    expect(Object.keys(useMcpCatalog.getState().tools)).toEqual([
      "mcp__gh__create_issue",
      "mcp__gh__search",
    ]);
    expect(manager.instructions()).toEqual([
      { server: "gh", text: "Use gh wisely." },
    ]);
    expect(fakes.saved).toEqual(["gh"]);
  });

  it("never offers a tool the user never allows, or one it cannot call", async () => {
    fakes.tools.set("s", [
      tool("kept"),
      tool("blocked"),
      tool("allowed"),
      tool("tasks", { execution: { taskSupport: "required" } }),
      tool("weird", { inputSchema: { type: "array" } }),
    ]);
    const manager = new McpManager();
    manager.sync([
      server("s", { tools: { blocked: "deny", allowed: "allow" } }),
    ]);
    await settle(manager);
    const offered = manager.offeredTools();
    expect(offered.map((t) => t.info.tool)).toEqual(["kept", "allowed"]);
    expect(offered.map((t) => t.alwaysAllow)).toEqual([false, true]);
  });

  it("updates trust and tool choices without restarting the server", async () => {
    fakes.tools.set("s", [tool("a"), tool("b")]);
    const manager = new McpManager();
    manager.sync([server("s")]);
    await settle(manager);
    manager.sync([server("s", { trusted: true, tools: { b: "deny" } })]);
    expect(fakes.connects).toEqual(["s"]);
    expect(
      manager.offeredTools().map((t) => [t.info.tool, t.info.trusted]),
    ).toEqual([["a", true]]);
  });

  it("restarts a server whose launch settings change, and stops a disabled one", async () => {
    const manager = new McpManager();
    manager.sync([server("s")]);
    await settle(manager);
    manager.sync([server("s", { secretsRevision: 1 })]);
    await vi.waitFor(() => expect(fakes.connects).toEqual(["s", "s"]));
    await settle(manager);
    expect(fakes.closes).toEqual(["s"]);
    manager.sync([server("s", { enabled: false })]);
    await vi.waitFor(() => expect(fakes.closes).toEqual(["s", "s"]));
    expect(statuses("s").slice(-1)[0]).toBe("stopped");
    expect(manager.offeredTools()).toEqual([]);
  });

  it("restarts after a crash with backoff, then gives up", async () => {
    vi.useFakeTimers();
    fakes.failing.add("s");
    const manager = new McpManager();
    manager.sync([server("s")]);
    for (let i = 0; i < MAX_CRASHES; i++) {
      await vi.waitFor(() =>
        expect(statuses("s").slice(-1)[0]).toBe("crashed"),
      );
      await vi.advanceTimersByTimeAsync(RESTART_DELAYS_MS[i]);
    }
    await vi.waitFor(() =>
      expect(fakes.connects).toHaveLength(MAX_CRASHES + 1),
    );
    await vi.waitFor(() => expect(statuses("s").slice(-1)[0]).toBe("crashed"));
    const last = fakes.invokes
      .filter(([command]) => command === "mcp_status_report")
      .slice(-1)[0]?.[1].report as { retryAtMs: number | null; error: string };
    expect(last.retryAtMs).toBe(null);
    expect(last.error).toBe("spawn failed");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fakes.connects).toHaveLength(MAX_CRASHES + 1);
  });

  it("waits for sign-in instead of retrying a server that refuses it", async () => {
    vi.useFakeTimers();
    fakes.signIn.add("s");
    const manager = new McpManager();
    manager.sync([server("s")]);
    await vi.waitFor(() => expect(statuses("s").slice(-1)[0]).toBe("crashed"));
    const last = fakes.invokes
      .filter(([command]) => command === "mcp_status_report")
      .slice(-1)[0]?.[1].report as { retryAtMs: number | null; error: string };
    expect(last.retryAtMs).toBe(null);
    expect(last.error).toContain("Sign in required");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fakes.connects).toEqual(["s"]);
    // Settings restarts it once the user signed in.
    fakes.signIn.delete("s");
    manager.restart("s");
    await vi.waitFor(() => expect(statuses("s").slice(-1)[0]).toBe("running"));
  });

  it("stops a running remote server whose sign-in lapsed, without retrying", async () => {
    vi.useFakeTimers();
    fakes.remote.add("r");
    fakes.tools.set("r", [tool("a")]);
    const manager = new McpManager();
    manager.sync([server("r")]);
    await vi.waitFor(() => expect(statuses("r").slice(-1)[0]).toBe("running"));
    fakes.refused.add("r");
    fakes.clients
      .get("r")
      ?.callTool.mockRejectedValueOnce(new Error("HTTP 401"));
    await expect(manager.callTool("r", "a", {})).rejects.toThrow("HTTP 401");
    expect(statuses("r").slice(-1)[0]).toBe("crashed");
    const last = fakes.invokes
      .filter(([command]) => command === "mcp_status_report")
      .slice(-1)[0]?.[1].report as { retryAtMs: number | null; error: string };
    expect(last).toMatchObject({ retryAtMs: null });
    expect(last.error).toContain("Sign in required");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fakes.connects).toEqual(["r"]);
  });

  it("treats a closed connection as a crash and starts it again", async () => {
    vi.useFakeTimers();
    fakes.tools.set("s", [tool("a")]);
    const manager = new McpManager();
    manager.sync([server("s")]);
    await vi.waitFor(() => expect(statuses("s").slice(-1)[0]).toBe("running"));
    fakes.clients.get("s")?.onclose?.();
    expect(statuses("s").slice(-1)[0]).toBe("crashed");
    expect(manager.offeredTools()).toEqual([]);
    await vi.advanceTimersByTimeAsync(RESTART_DELAYS_MS[0]);
    await vi.waitFor(() => expect(statuses("s").slice(-1)[0]).toBe("running"));
    expect(fakes.connects).toEqual(["s", "s"]);
  });

  it("restarts on request, starting the crash count over", async () => {
    const manager = new McpManager();
    manager.sync([server("s")]);
    await settle(manager);
    manager.restart("s");
    manager.restart("unknown");
    await vi.waitFor(() => expect(fakes.connects).toEqual(["s", "s"]));
  });

  it("refreshes the tool list when the server says it changed", async () => {
    vi.useFakeTimers();
    fakes.tools.set("s", [tool("a")]);
    const manager = new McpManager();
    manager.sync([server("s")]);
    await vi.waitFor(() => expect(statuses("s").slice(-1)[0]).toBe("running"));
    fakes.tools.set("s", [tool("a"), tool("b")]);
    fakes.clients.get("s")?.listChanged?.();
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() =>
      expect(manager.offeredTools().map((t) => t.info.tool)).toEqual([
        "a",
        "b",
      ]),
    );
  });

  it("calls tools and turns a reported error into the call's error", async () => {
    fakes.tools.set("s", [tool("a")]);
    const manager = new McpManager();
    manager.sync([server("s")]);
    await settle(manager);
    await expect(manager.callTool("s", "a", { x: 1 })).resolves.toMatchObject({
      kind: "mcp",
      content: [{ type: "text", text: "ok" }],
    });
    const client = fakes.clients.get("s");
    expect(client?.callTool).toHaveBeenCalledWith(
      { name: "a", arguments: { x: 1 } },
      undefined,
      expect.objectContaining({ resetTimeoutOnProgress: true }),
    );
    client?.callTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: "nope" }],
    });
    await expect(manager.callTool("s", "a", {})).rejects.toThrow("nope");
    await expect(manager.callTool("missing", "a", {})).rejects.toThrow(
      "not running",
    );
  });

  it("reconnects a remote server after a transport failure, not after a protocol error", async () => {
    vi.useFakeTimers();
    fakes.remote.add("r");
    fakes.tools.set("r", [tool("a")]);
    const manager = new McpManager();
    manager.sync([server("r")]);
    await vi.waitFor(() => expect(statuses("r").slice(-1)[0]).toBe("running"));
    const client = fakes.clients.get("r");
    client?.callTool.mockRejectedValueOnce(new McpError(-32602, "bad args"));
    await expect(manager.callTool("r", "a", {})).rejects.toThrow("bad args");
    expect(statuses("r").slice(-1)[0]).toBe("running");
    client?.callTool.mockRejectedValueOnce(new TypeError("network down"));
    await expect(manager.callTool("r", "a", {})).rejects.toThrow(
      "network down",
    );
    expect(statuses("r").slice(-1)[0]).toBe("crashed");
    await vi.advanceTimersByTimeAsync(RESTART_DELAYS_MS[0]);
    await vi.waitFor(() => expect(fakes.connects).toEqual(["r", "r"]));
  });

  it("waits for a starting server no longer than the start window", async () => {
    vi.useFakeTimers();
    fakes.held.add("slow");
    fakes.tools.set("slow", [tool("a")]);
    const manager = new McpManager();
    manager.sync([server("slow")]);
    let waited = false;
    const wait = manager.waitForStarting().then(() => {
      waited = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(waited).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    await wait;
    expect(waited).toBe(true);
    expect(manager.offeredTools()).toEqual([]);
    for (const release of fakes.releases) release();
    await vi.waitFor(() => expect(manager.offeredTools()).toHaveLength(1));
  });

  it("keeps the composer's view of running servers: started, renamed, stopped, crashed", async () => {
    vi.useFakeTimers();
    const names = () =>
      useMcpExtras.getState().servers.map((s) => [s.serverId, s.serverName]);
    const manager = new McpManager();
    manager.sync([server("a"), server("b")]);
    await vi.waitFor(() =>
      expect(names()).toEqual([
        ["a", "a"],
        ["b", "b"],
      ]),
    );
    manager.sync([server("a", { name: "Zed" }), server("b")]);
    expect(names()).toEqual([
      ["b", "b"],
      ["a", "Zed"],
    ]);
    manager.sync([
      server("a", { name: "Zed" }),
      server("b", { enabled: false }),
    ]);
    expect(names()).toEqual([["a", "Zed"]]);
    fakes.clients.get("a")?.onclose?.();
    expect(names()).toEqual([]);
    await vi.advanceTimersByTimeAsync(RESTART_DELAYS_MS[0]);
    await vi.waitFor(() => expect(names()).toEqual([["a", "Zed"]]));
  });

  it("stops waiting as soon as the starting servers are up", async () => {
    fakes.tools.set("quick", [tool("a")]);
    const manager = new McpManager();
    manager.sync([server("quick")]);
    await manager.waitForStarting();
    expect(manager.offeredTools()).toHaveLength(1);
  });
});

describe("otherFeatures", () => {
  it("names what a server offers besides tools", () => {
    expect(otherFeatures(null)).toEqual([]);
    expect(
      otherFeatures({ tools: {}, prompts: {}, resources: { subscribe: true } }),
    ).toEqual(["resources", "prompts"]);
  });
});
