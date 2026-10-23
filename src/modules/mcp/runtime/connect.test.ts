// The client side for real: the official SDK client, Terax's transports and
// the native fetch protocol, against the SDK's own server, with the backend's
// commands emulated in process (stdio pipe; HTTP proxy with its origin gate).
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
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

import { connectServer } from "./connect";

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
        const meta = JSON.parse(options.headers["x-terax-mcp-request"]);
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
