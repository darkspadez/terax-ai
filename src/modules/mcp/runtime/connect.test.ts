// The client side for real: the official SDK client, Oarlock's transports and
// the native fetch protocol, against the SDK's own server, with the backend's
// commands emulated in process (stdio pipe; HTTP proxy with its origin gate).
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { SignInRequiredError } from "../lib/auth";
import type { McpServerConfig } from "../lib/config";
import { toToolOutput } from "../lib/results";

const host = vi.hoisted(() => {
  type Channel = { id: number; onmessage: (value: unknown) => void };
  return {
    channels: new Map<number, Channel>(),
    nextChannel: 1,
    handlers: new Map<string, (...args: never[]) => unknown>(),
    Channel: class {
      id: number;
      onmessage = (_value: unknown) => {};
      constructor() {
        this.id = host.nextChannel++;
        host.channels.set(this.id, this as unknown as Channel);
      }
      toJSON() {
        return this.id;
      }
    },
  };
});
vi.mock("@tauri-apps/api/core", () => ({
  Channel: host.Channel,
  invoke: async (command: string, args?: unknown, options?: unknown) => {
    const handler = host.handlers.get(command);
    return handler?.(...([args, options] as never[]));
  },
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "9.9.9" }));

import { registerRequestHost, useMcpRequests } from "../lib/requests";
import { connectServer } from "./connect";

/** `${NAME}` as written in a configuration file. */
const ref = (name: string) => ["$", "{", name, "}"].join("");

const encoder = new TextEncoder();

function demoServer(): McpServer {
  const server = new McpServer({ name: "demo", version: "1.2.3" });
  server.registerTool(
    "echo",
    {
      description: "Says it back",
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ text }) => ({
      content: [{ type: "text", text: `echo: ${text}` }],
    }),
  );
  server.registerTool(
    "weather",
    {
      description: "Structured",
      outputSchema: { temperature: z.number() },
    },
    async () => ({
      content: [{ type: "text", text: '{"temperature":21}' }],
      structuredContent: { temperature: 21 },
    }),
  );
  return server;
}

function stdioServer(): McpServerConfig {
  return {
    id: "s1",
    name: "demo",
    source: "settings",
    enabled: true,
    trusted: false,
    tools: {},
    secretsRevision: 0,
    transport: {
      type: "stdio",
      command: "demo",
      args: [],
      env: [{ name: "TOKEN", secret: true }],
      cwd: null,
    },
  };
}

afterEach(() => {
  host.handlers.clear();
  host.channels.clear();
});

describe("connectServer over the stdio host", () => {
  it("initializes, lists and calls tools through the native pipe", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await demoServer().connect(serverSide);
    await clientSide.start();
    const spawned: unknown[] = [];
    host.handlers.set("mcp_spawn", (args: Record<string, unknown>) => {
      spawned.push(args);
      // The channel reaches the backend as an object here (no IPC).
      const channel = args.onMessage as { onmessage: (v: unknown) => void };
      clientSide.onmessage = (message) =>
        channel.onmessage(encoder.encode(JSON.stringify(message)).buffer);
      return 5;
    });
    host.handlers.set("mcp_send", (args: { message: string }) =>
      clientSide.send(JSON.parse(args.message) as JSONRPCMessage),
    );
    host.handlers.set("mcp_kill", () => undefined);

    const connection = await connectServer(stdioServer(), "/bin/zsh");
    expect(spawned[0]).toMatchObject({
      serverId: "s1",
      command: "demo",
      env: {},
      secretEnv: ["TOKEN"],
      shell: "/bin/zsh",
    });
    expect(connection.remote).toBe(false);
    expect(connection.client.getServerVersion()).toMatchObject({
      name: "demo",
      version: "1.2.3",
    });
    const { tools } = await connection.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo", "weather"]);
    expect(tools[0].annotations).toEqual({ readOnlyHint: true });

    const echoed = await connection.client.callTool({
      name: "echo",
      arguments: { text: "hi" },
    });
    expect(toToolOutput(echoed, "demo", "echo")).toMatchObject({
      output: { content: [{ type: "text", text: "echo: hi" }] },
    });
    // Structured output passes the stand-in validator (AJV cannot run here).
    const weather = await connection.client.callTool({ name: "weather" });
    expect(weather.structuredContent).toEqual({ temperature: 21 });
    await connection.close();
  });

  it("offers sampling and form elicitation, answered by the user in this window", async () => {
    const server = demoServer();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    await clientSide.start();
    host.handlers.set("mcp_spawn", (args: Record<string, unknown>) => {
      const channel = args.onMessage as { onmessage: (v: unknown) => void };
      clientSide.onmessage = (message) =>
        channel.onmessage(encoder.encode(JSON.stringify(message)).buffer);
      return 7;
    });
    host.handlers.set("mcp_send", (args: { message: string }) =>
      clientSide.send(JSON.parse(args.message) as JSONRPCMessage),
    );
    host.handlers.set("mcp_kill", () => undefined);
    host.handlers.set("mcp_log_note", () => undefined);
    const unhost = registerRequestHost();
    try {
      const connection = await connectServer(stdioServer(), null);
      expect(server.server.getClientCapabilities()).toEqual({
        sampling: {},
        elicitation: { form: {} },
      });
      const asked = server.server.elicitInput({
        message: "Name?",
        requestedSchema: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      });
      await vi.waitFor(() =>
        expect(useMcpRequests.getState().elicitations).toHaveLength(1),
      );
      useMcpRequests
        .getState()
        .elicitations[0].answer({ action: "accept", content: { name: "Ann" } });
      await expect(asked).resolves.toEqual({
        action: "accept",
        content: { name: "Ann" },
      });
      await connection.close();
    } finally {
      unhost();
    }
  });

  it("reports why a server that exits during the handshake failed", async () => {
    host.handlers.set("mcp_spawn", (args: Record<string, unknown>) => {
      const exit = args.onExit as { onmessage: (v: unknown) => void };
      queueMicrotask(() =>
        exit.onmessage({
          code: 1,
          signal: null,
          reason: null,
          stderrTail: "Error: GITHUB_TOKEN is not set",
        }),
      );
      return 6;
    });
    host.handlers.set("mcp_send", () => undefined);
    host.handlers.set("mcp_kill", () => undefined);
    await expect(connectServer(stdioServer(), null)).rejects.toThrow(
      "Exited with code 1: Error: GITHUB_TOKEN is not set",
    );
  });
});

describe("connectServer over HTTP through the backend proxy", () => {
  it("speaks Streamable HTTP within the configured origin only", async () => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    await demoServer().connect(transport);
    const origin = "https://mcp.example.test";
    const opened: unknown[] = [];
    const urls: string[] = [];
    const readers = new Map<string, ReadableStreamDefaultReader<Uint8Array>>();
    host.handlers.set("mcp_http_open", (args: Record<string, unknown>) => {
      opened.push(args);
      return 3;
    });
    host.handlers.set("mcp_http_close", () => undefined);
    host.handlers.set("mcp_http_ack", () => undefined);
    host.handlers.set("mcp_http_cancel", (args: { requestId: string }) => {
      void readers.get(args.requestId)?.cancel();
    });
    host.handlers.set(
      "mcp_http_stream",
      async (
        body: Uint8Array,
        options: { headers: Record<string, string> },
      ) => {
        const meta = JSON.parse(options.headers["x-oarlock-mcp-request"]);
        const channel = host.channels.get(meta.onEvent);
        const send = (kind: number, bytes: Uint8Array = new Uint8Array()) => {
          const packet = new Uint8Array(bytes.length + 1);
          packet[0] = kind;
          packet.set(bytes, 1);
          channel?.onmessage(packet.buffer);
        };
        urls.push(`${meta.method} ${meta.url}`);
        expect(meta.session).toBe(3);
        // The backend's gate: nothing outside the configured origin.
        if (new URL(meta.url).origin !== origin) {
          send(3, encoder.encode("outside the server's origin"));
          return;
        }
        const response = await transport.handleRequest(
          new Request(meta.url, {
            method: meta.method,
            headers: meta.headers,
            body: body.byteLength > 0 ? new Uint8Array(body) : undefined,
          }),
        );
        send(
          0,
          encoder.encode(
            JSON.stringify({
              status: response.status,
              headers: Object.fromEntries(response.headers),
            }),
          ),
        );
        if (response.body) {
          const reader = response.body.getReader();
          readers.set(meta.requestId, reader);
          void (async () => {
            try {
              while (true) {
                const next = await reader.read();
                if (next.done) break;
                send(1, next.value);
              }
              send(2);
            } catch {
              // Cancelled.
            }
          })();
        } else {
          send(2);
        }
      },
    );

    const connection = await connectServer(
      {
        ...stdioServer(),
        transport: {
          type: "http",
          url: `${origin}/mcp`,
          headers: [
            { name: "X-Team", secret: false, value: "core" },
            { name: "Authorization", secret: true },
          ],
        },
      },
      null,
    );
    expect(opened[0]).toEqual({
      serverId: "s1",
      url: `${origin}/mcp`,
      headers: { "X-Team": "core" },
      secretHeaders: ["Authorization"],
    });
    expect(connection.remote).toBe(true);
    const result = await connection.client.callTool({
      name: "echo",
      arguments: { text: "over http" },
    });
    expect(result.content).toEqual([{ type: "text", text: "echo: over http" }]);
    await connection.close();
    expect(
      urls.some((u) => u.startsWith("POST https://mcp.example.test/mcp")),
    ).toBe(true);
    expect(urls.every((u) => u.includes(origin))).toBe(true);
  });
});

/** Answers every request of the emulated backend with `status`. */
function answerEvery(
  status: number,
  headers: Record<string, string>,
  seen: { url: string; headers: Record<string, string> }[],
) {
  host.handlers.set("mcp_http_close", () => undefined);
  host.handlers.set("mcp_http_ack", () => undefined);
  host.handlers.set("mcp_http_cancel", () => undefined);
  host.handlers.set(
    "mcp_http_stream",
    async (_body: Uint8Array, options: { headers: Record<string, string> }) => {
      const meta = JSON.parse(options.headers["x-oarlock-mcp-request"]);
      seen.push({ url: meta.url, headers: meta.headers });
      const channel = host.channels.get(meta.onEvent);
      const send = (kind: number, bytes: Uint8Array = new Uint8Array()) => {
        const packet = new Uint8Array(bytes.length + 1);
        packet[0] = kind;
        packet.set(bytes, 1);
        channel?.onmessage(packet.buffer);
      };
      send(0, encoder.encode(JSON.stringify({ status, headers })));
      send(1, encoder.encode('{"error":"unauthorized"}'));
      send(2);
    },
  );
}

function httpServer(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    ...stdioServer(),
    transport: {
      type: "http",
      url: "https://mcp.example.test/mcp",
      headers: [],
    },
    ...overrides,
  };
}

describe("signing in", () => {
  it("fails a server that refuses the connection with sign-in required, never retrying it as a crash", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    host.handlers.set("mcp_http_open", () => 4);
    answerEvery(
      401,
      {
        "www-authenticate":
          'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource"',
        "x-oarlock-sign-in": "required",
      },
      seen,
    );
    const failed = await connectServer(httpServer(), null).catch((e) => e);
    expect(failed).toBeInstanceOf(SignInRequiredError);
    expect(seen.length).toBeGreaterThan(0);
  });

  it("treats a 401 the backend does not mark (a wrong API key) as an ordinary failure", async () => {
    host.handlers.set("mcp_http_open", () => 4);
    answerEvery(401, {}, []);
    const failed = await connectServer(httpServer(), null).catch((e) => e);
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(SignInRequiredError);
  });

  it("never puts a token in a request: the backend adds it", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    host.handlers.set("mcp_http_open", () => 4);
    answerEvery(401, {}, seen);
    await connectServer(httpServer(), null).catch(() => {});
    for (const request of seen) {
      expect(
        Object.keys(request.headers).map((h) => h.toLowerCase()),
      ).not.toContain("authorization");
    }
  });
});

describe("project servers", () => {
  it("start a local one in the backend from the trusted entry, never from the page's copy", async () => {
    const spawned: Record<string, unknown>[] = [];
    host.handlers.set("mcp_spawn", () => {
      throw new Error(
        "a project server is never spawned from the page's command",
      );
    });
    host.handlers.set("mcp_project_spawn", (args: Record<string, unknown>) => {
      spawned.push(args);
      const exit = args.onExit as { onmessage: (v: unknown) => void };
      queueMicrotask(() =>
        exit.onmessage({ code: 1, signal: null, reason: null, stderrTail: "" }),
      );
      return 9;
    });
    host.handlers.set("mcp_send", () => undefined);
    host.handlers.set("mcp_kill", () => undefined);
    await expect(
      connectServer(
        {
          ...stdioServer(),
          id: "prj-0123456789ab-0123456789ab",
          source: "project:/work/p",
        },
        "/bin/zsh",
      ),
    ).rejects.toThrow("Exited with code 1");
    expect(Object.keys(spawned[0]).sort()).toEqual([
      "onExit",
      "onMessage",
      "serverId",
      "shell",
    ]);
    expect(spawned[0].serverId).toBe("prj-0123456789ab-0123456789ab");
  });

  it("open a remote one at the URL the backend expanded", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const opened: unknown[] = [];
    host.handlers.set("mcp_http_open", () => {
      throw new Error("a project server is never opened from the page's URL");
    });
    host.handlers.set(
      "mcp_project_http_open",
      (args: Record<string, unknown>) => {
        opened.push(args);
        return { id: 8, url: "https://expanded.example.test/mcp" };
      },
    );
    answerEvery(401, {}, seen);
    await connectServer(
      httpServer({
        id: "prj-0123456789ab-0123456789ab",
        source: "project:/work/p",
        transport: {
          type: "http",
          url: `https://${ref("HOST")}/mcp`,
          headers: [],
        },
      }),
      null,
    ).catch(() => {});
    expect(opened).toEqual([
      { serverId: "prj-0123456789ab-0123456789ab", shell: null },
    ]);
    expect(seen[0].url).toBe("https://expanded.example.test/mcp");
  });
});
