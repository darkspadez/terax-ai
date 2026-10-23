// Resources, templates, prompts and completions for real: the SDK's own
// server and client over its in-memory transport.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { McpServerConfig } from "../lib/config";
import { useMcpExtras } from "../lib/extrasCatalog";

const notes = vi.hoisted(() => [] as unknown[]);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: unknown) => {
    if (command === "mcp_log_note") notes.push(args);
  },
}));

import { McpExtras } from "./extras";

function config(id = "s1", name = "Docs"): McpServerConfig {
  return {
    id,
    name,
    source: "settings",
    enabled: true,
    trusted: false,
    tools: {},
    secretsRevision: 0,
    transport: { type: "stdio", command: "x", args: [], env: [], cwd: null },
  };
}

function docsServer(): McpServer {
  const server = new McpServer({ name: "docs", version: "1.0.0" });
  server.registerResource(
    "readme",
    "docs://readme",
    { title: "Read me", mimeType: "text/markdown" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: "# Hello" }],
    }),
  );
  server.registerResource(
    "user",
    new ResourceTemplate("users://{team}/{name}", {
      list: undefined,
      complete: {
        name: (value, context) =>
          ["ann", "bob", "anna"]
            .filter((n) => n.startsWith(value))
            .map((n) => `${context?.arguments?.team ?? "?"}-${n}`),
      },
    }),
    { title: "A user" },
    async (uri, { team, name }) => ({
      contents: [{ uri: uri.href, text: `${team}/${name}` }],
    }),
  );
  server.registerPrompt(
    "review",
    {
      title: "Review code",
      description: "Reviews a snippet",
      argsSchema: {
        language: completable(z.string(), (value) =>
          ["rust", "ruby", "go"].filter((l) => l.startsWith(value)),
        ),
        code: z.string(),
      },
    },
    ({ language, code }) => ({
      messages: [
        {
          role: "user",
          content: { type: "text", text: `Review this ${language}: ${code}` },
        },
      ],
    }),
  );
  return server;
}

async function connect(server: McpServer): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  return client;
}

afterEach(() => {
  useMcpExtras.getState().setServers([]);
  notes.length = 0;
});

describe("McpExtras", () => {
  it("lists a server's resources, templates and prompts for the composer", async () => {
    const client = await connect(docsServer());
    const extras = new McpExtras();
    extras.connected(config(), client, client.getServerCapabilities() ?? null);
    await vi.waitFor(() =>
      expect(useMcpExtras.getState().servers[0]?.prompts).toHaveLength(1),
    );
    await vi.waitFor(() =>
      expect(useMcpExtras.getState().servers[0]?.resources).toHaveLength(1),
    );
    const [server] = useMcpExtras.getState().servers;
    expect(server).toMatchObject({
      serverId: "s1",
      serverName: "Docs",
      completions: true,
      resources: [
        {
          uri: "docs://readme",
          name: "readme",
          title: "Read me",
          mimeType: "text/markdown",
        },
      ],
      templates: [
        {
          uriTemplate: "users://{team}/{name}",
          name: "user",
          title: "A user",
          variables: ["team", "name"],
          optional: [],
        },
      ],
      prompts: [
        {
          name: "review",
          title: "Review code",
          description: "Reviews a snippet",
          arguments: [
            { name: "language", required: true },
            { name: "code", required: true },
          ],
        },
      ],
    });
  });

  it("reads resources and templates, gets prompts and asks for completions", async () => {
    const client = await connect(docsServer());
    const extras = new McpExtras();
    extras.connected(config(), client, client.getServerCapabilities() ?? null);
    await expect(extras.read("s1", "docs://readme")).resolves.toMatchObject({
      contents: [{ text: "# Hello" }],
    });
    const uri = extras.expand("users://{team}/{name}", {
      team: "core",
      name: "ann lee",
    });
    expect(uri).toBe("users://core/ann%20lee");
    await expect(
      extras.read(
        "s1",
        extras.expand("users://{team}/{name}", { team: "core", name: "ann" }),
      ),
    ).resolves.toMatchObject({ contents: [{ text: "core/ann" }] });
    await expect(
      extras.getPrompt("s1", "review", { language: "go", code: "x := 1" }),
    ).resolves.toMatchObject({
      messages: [{ content: { text: "Review this go: x := 1" } }],
    });
    await expect(
      extras.complete(
        "s1",
        { type: "ref/prompt", name: "review" },
        { name: "language", value: "r" },
        {},
      ),
    ).resolves.toEqual(["rust", "ruby"]);
    await expect(
      extras.complete(
        "s1",
        { type: "ref/resource", uri: "users://{team}/{name}" },
        { name: "name", value: "an" },
        { team: "core" },
      ),
    ).resolves.toEqual(["core-ann", "core-anna"]);
    // Suggestions only help: a failure is no suggestion.
    await expect(
      extras.complete(
        "s1",
        { type: "ref/prompt", name: "missing" },
        { name: "x", value: "" },
        {},
      ),
    ).resolves.toEqual([]);
    await expect(extras.read("other", "docs://readme")).rejects.toThrow(
      "This MCP server is not running.",
    );
  });

  it("refreshes when the server says its lists changed", async () => {
    const server = docsServer();
    const client = await connect(server);
    const extras = new McpExtras();
    extras.connected(config(), client, client.getServerCapabilities() ?? null);
    await vi.waitFor(() =>
      expect(useMcpExtras.getState().servers[0]?.resources).toHaveLength(1),
    );
    server.registerResource("changelog", "docs://changelog", {}, async (u) => ({
      contents: [{ uri: u.href, text: "v1" }],
    }));
    server.registerPrompt("explain", { description: "Explains" }, () => ({
      messages: [{ role: "user", content: { type: "text", text: "Explain" } }],
    }));
    await vi.waitFor(() =>
      expect(
        useMcpExtras.getState().servers[0]?.resources.map((r) => r.uri),
      ).toEqual(["docs://readme", "docs://changelog"]),
    );
    await vi.waitFor(() =>
      expect(
        useMcpExtras.getState().servers[0]?.prompts.map((p) => p.name),
      ).toEqual(["review", "explain"]),
    );
  });

  it("follows a rename and forgets a server that ended", async () => {
    const client = await connect(docsServer());
    const extras = new McpExtras();
    extras.connected(config(), client, client.getServerCapabilities() ?? null);
    extras.updated(config("s1", "Handbook"));
    expect(useMcpExtras.getState().servers[0]?.serverName).toBe("Handbook");
    extras.ended("s1");
    expect(useMcpExtras.getState().servers).toEqual([]);
    await expect(extras.read("s1", "docs://readme")).rejects.toThrow(
      "not running",
    );
  });

  it("notes a list that fails in the server's log and keeps the rest", async () => {
    const client = await connect(docsServer());
    const extras = new McpExtras();
    vi.spyOn(client, "listPrompts").mockRejectedValue(new Error("boom"));
    extras.connected(config(), client, client.getServerCapabilities() ?? null);
    await vi.waitFor(() =>
      expect(notes).toEqual([
        { serverId: "s1", text: "Could not list its prompts: boom" },
      ]),
    );
    await vi.waitFor(() =>
      expect(useMcpExtras.getState().servers[0]?.resources).toHaveLength(1),
    );
  });
});
