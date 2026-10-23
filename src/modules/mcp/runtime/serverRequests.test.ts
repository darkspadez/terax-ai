// Sampling and elicitation for real: the SDK's server asks, Terax's client
// handlers answer only with what the user gives (the window's requests).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateMessageResultSchema,
  ElicitResultSchema,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMcpExtras } from "../lib/extrasCatalog";
import { registerRequestHost, useMcpRequests } from "../lib/requests";

const notes = vi.hoisted(() => [] as string[]);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: { text: string }) => {
    if (command === "mcp_log_note") notes.push(args.text);
  },
}));

import { CLIENT_CAPABILITIES, handleServerRequests } from "./serverRequests";

const SERVER = { id: "s1", name: "Helper" };

async function connect(): Promise<{ server: McpServer; client: Client }> {
  const server = new McpServer({ name: "helper", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client(
    { name: "Terax", version: "1" },
    { capabilities: CLIENT_CAPABILITIES },
  );
  handleServerRequests(client, SERVER);
  await client.connect(clientSide);
  return { server, client };
}

let unhost: (() => void) | null = null;
function host() {
  unhost = registerRequestHost();
}

afterEach(() => {
  unhost?.();
  unhost = null;
  useMcpRequests.setState({ hosts: 0, sampling: [], elicitations: [] });
  useMcpExtras.getState().setServers([]);
  notes.length = 0;
});

const ask = {
  messages: [
    {
      role: "user" as const,
      content: { type: "text" as const, text: "Capital of France?" },
    },
  ],
  systemPrompt: "Answer in one word.",
  maxTokens: 20,
  includeContext: "thisServer" as const,
  modelPreferences: { hints: [{ name: "claude" }] },
};

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
}

const form = {
  message: "Who are you?",
  requestedSchema: {
    type: "object" as const,
    properties: {
      name: { type: "string" as const, title: "Name" },
      age: { type: "integer" as const, minimum: 0 },
    },
    required: ["name"],
  },
};

describe("sampling requests", () => {
  it("declare what Terax offers: sampling and form elicitation, no roots", async () => {
    const { server } = await connect();
    expect(server.server.getClientCapabilities()).toEqual({
      sampling: {},
      elicitation: { form: {} },
    });
  });

  it("wait for the user, whatever else is set, and return what the user approved", async () => {
    host();
    const { server } = await connect();
    const result = server.server.createMessage(ask);
    await vi.waitFor(() =>
      expect(useMcpRequests.getState().sampling).toHaveLength(1),
    );
    // Nothing answers on its own: no trust, mode or timer plays a part.
    await settle();
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await settle();
    expect(settled).toBe(false);
    const [pending] = useMcpRequests.getState().sampling;
    expect(pending).toMatchObject({
      serverId: "s1",
      serverName: "Helper",
      view: {
        systemPrompt: "Answer in one word.",
        maxTokens: 20,
        includeContext: "thisServer",
        hints: ["claude"],
        messages: [{ role: "user", text: "Capital of France?", images: [] }],
      },
    });
    pending.answer({
      kind: "result",
      text: "Paris",
      model: "gpt-5.4-mini",
      finishReason: "length",
    });
    await expect(result).resolves.toEqual({
      role: "assistant",
      content: { type: "text", text: "Paris" },
      model: "gpt-5.4-mini",
      stopReason: "maxTokens",
    });
  });

  it("returns the spec's rejection when the user denies", async () => {
    host();
    const { server } = await connect();
    const result = server.server.createMessage(ask);
    await vi.waitFor(() =>
      expect(useMcpRequests.getState().sampling).toHaveLength(1),
    );
    useMcpRequests.getState().sampling[0].answer({ kind: "denied" });
    await expect(result).rejects.toMatchObject({
      code: -1,
      message: expect.stringContaining(
        "The user declined the sampling request.",
      ),
    });
  });

  it("is refused while no window can show it, and while another waits", async () => {
    const { server } = await connect();
    await expect(server.server.createMessage(ask)).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
      message: expect.stringContaining("No Terax window can show this request"),
    });
    host();
    const first = server.server.createMessage(ask);
    await vi.waitFor(() =>
      expect(useMcpRequests.getState().sampling).toHaveLength(1),
    );
    await expect(server.server.createMessage(ask)).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
    });
    useMcpRequests.getState().sampling[0].answer({ kind: "denied" });
    await expect(first).rejects.toMatchObject({ code: -1 });
    expect(notes).toContain(
      "Refused a sampling request: No Terax window can show this request right now.",
    );
  });

  it("refuses tools and content it cannot send, before asking anyone", async () => {
    host();
    const { server } = await connect();
    await expect(
      server.server.request(
        {
          method: "sampling/createMessage",
          params: {
            ...ask,
            tools: [{ name: "t", inputSchema: { type: "object" } }],
          },
        },
        CreateMessageResultSchema,
      ),
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringContaining("Terax does not offer tools"),
    });
    await expect(
      server.server.createMessage({
        ...ask,
        messages: [
          {
            role: "user",
            content: { type: "audio", data: "AA", mimeType: "audio/wav" },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(useMcpRequests.getState().sampling).toEqual([]);
  });

  it("ends when the server cancels it, its first request included", async () => {
    host();
    const { server } = await connect();
    // Request id 0, which the SDK's own cancellation handling skips.
    const controller = new AbortController();
    const result = server.server.createMessage(ask, {
      signal: controller.signal,
    });
    await vi.waitFor(() =>
      expect(useMcpRequests.getState().sampling).toHaveLength(1),
    );
    controller.abort();
    await expect(result).rejects.toThrow();
    await vi.waitFor(() =>
      expect(useMcpRequests.getState().sampling).toEqual([]),
    );
    const again = new AbortController();
    const second = server.server.elicitInput(form, { signal: again.signal });
    await vi.waitFor(() =>
      expect(useMcpRequests.getState().elicitations).toHaveLength(1),
    );
    again.abort();
    await expect(second).rejects.toThrow();
    await vi.waitFor(() =>
      expect(useMcpRequests.getState().elicitations).toEqual([]),
    );
  });
});

describe("requests for information", () => {
  it("show the form and send only what the user submits", async () => {
    host();
    const { server } = await connect();
    const result = server.server.elicitInput(form);
    await vi.waitFor(() =>
      expect(useMcpRequests.getState().elicitations).toHaveLength(1),
    );
    const [pending] = useMcpRequests.getState().elicitations;
    expect(pending).toMatchObject({
      serverName: "Helper",
      message: "Who are you?",
      fields: [
        { name: "name", label: "Name", required: true, kind: "string" },
        { name: "age", kind: "number", integer: true, minimum: 0 },
      ],
    });
    pending.answer({ action: "accept", content: { name: "Ann", age: 30 } });
    await expect(result).resolves.toEqual({
      action: "accept",
      content: { name: "Ann", age: 30 },
    });
  });

  it("pass on a decline and a dismissal as the spec's actions", async () => {
    host();
    const { server } = await connect();
    const declined = server.server.elicitInput(form);
    await vi.waitFor(() =>
      expect(useMcpRequests.getState().elicitations).toHaveLength(1),
    );
    useMcpRequests.getState().elicitations[0].answer({ action: "decline" });
    await expect(declined).resolves.toEqual({ action: "decline" });
    const cancelled = server.server.elicitInput(form);
    await vi.waitFor(() =>
      expect(useMcpRequests.getState().elicitations).toHaveLength(1),
    );
    useMcpRequests.getState().elicitations[0].answer({ action: "cancel" });
    await expect(cancelled).resolves.toEqual({ action: "cancel" });
  });

  it("decline URL mode and schemas Terax cannot show, with the reason", async () => {
    host();
    const { server } = await connect();
    await expect(
      server.server.request(
        {
          method: "elicitation/create",
          params: {
            mode: "url",
            message: "Sign in",
            url: "https://example.com",
            elicitationId: "1",
          },
        },
        ElicitResultSchema,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(
      server.server.request(
        {
          method: "elicitation/create",
          params: {
            message: "Address?",
            requestedSchema: {
              type: "object",
              properties: { street: { type: "object", properties: {} } },
            },
          },
        },
        ElicitResultSchema,
      ),
      // The SDK's own schema check refuses it before it reaches Terax.
    ).rejects.toThrow(/street/);
    expect(useMcpRequests.getState().elicitations).toEqual([]);
  });

  it("allow one at a time per server, and end when the server stops", async () => {
    host();
    const { server, client } = await connect();
    const first = server.server.elicitInput(form);
    await vi.waitFor(() =>
      expect(useMcpRequests.getState().elicitations).toHaveLength(1),
    );
    await expect(server.server.elicitInput(form)).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
      message: expect.stringContaining("Another request for information"),
    });
    await client.close();
    await expect(first).rejects.toThrow();
    await vi.waitFor(() =>
      expect(useMcpRequests.getState().elicitations).toEqual([]),
    );
  });

  it("are shown under the server's current name", async () => {
    host();
    useMcpExtras.getState().setServers([
      {
        serverId: "s1",
        serverName: "Renamed",
        resources: [],
        templates: [],
        prompts: [],
        completions: false,
      },
    ]);
    const { server } = await connect();
    void server.server.elicitInput(form).catch(() => {});
    await vi.waitFor(() =>
      expect(useMcpRequests.getState().elicitations[0]?.serverName).toBe(
        "Renamed",
      ),
    );
  });
});
