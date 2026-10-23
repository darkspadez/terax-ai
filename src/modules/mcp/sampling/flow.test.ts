// A sampling request end to end: the SDK's server asks, the request waits in
// the window, the user approves it as the dialog does, the model runs on the
// user's key, the open conversation's meter counts it at the price of the
// model that ran, and the server gets the reply the user sent.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ generateText: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => undefined }));
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
  },
}));
vi.mock("ai", () => ({ generateText: mocks.generateText }));
vi.mock("@/modules/ai/lib/agent", () => ({
  buildConfiguredLanguageModel: async () => "MODEL",
}));

import { type TokenUsage, usageCost } from "@/modules/ai/lib/usage";
import {
  countConversationUsage,
  useChatStore,
} from "@/modules/ai/store/chatStore";
import { useMcpExtras } from "../lib/extrasCatalog";
import { registerRequestHost, useMcpRequests } from "../lib/requests";
import { initialDraft, samplingUsageNote } from "../lib/sampling";
import {
  CLIENT_CAPABILITIES,
  handleServerRequests,
} from "../runtime/serverRequests";
import { runSampling } from "./run";

const SERVER = { id: "s1", name: "Helper" };
const ask = {
  messages: [
    {
      role: "user" as const,
      content: { type: "text" as const, text: "Capital of France?" },
    },
  ],
  maxTokens: 50,
};

function usage(input: number, output: number): TokenUsage {
  return { inputTokens: input, outputTokens: output, cachedInputTokens: 0 };
}

function reply(input: number, output: number) {
  return {
    text: "Paris",
    finishReason: "stop",
    usage: { inputTokens: input, outputTokens: output },
  };
}

/** The server's request, once it waits for the user. */
async function serverAsks(): Promise<{ result: Promise<unknown> }> {
  const server = new McpServer({ name: "helper", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client(
    { name: "Terax", version: "1" },
    { capabilities: CLIENT_CAPABILITIES },
  );
  handleServerRequests(client, SERVER);
  await client.connect(clientSide);
  const result = server.server.createMessage(ask);
  await vi.waitFor(() =>
    expect(useMcpRequests.getState().sampling).toHaveLength(1),
  );
  return { result };
}

/** What the dialog's Approve and run, then Send, do. */
async function approveAndSend(modelId: string) {
  const [pending] = useMcpRequests.getState().sampling;
  const conversationId = useChatStore.getState().activeSessionId;
  const out = await runSampling({
    modelId,
    draft: initialDraft(pending.view),
    temperature: pending.view.temperature,
    stopSequences: pending.view.stopSequences,
    conversationId,
    signal: new AbortController().signal,
  });
  pending.answer({
    kind: "result",
    text: out.text,
    model: out.model,
    finishReason: out.finishReason,
  });
  return out;
}

let unhost: () => void = () => {};

beforeEach(() => {
  unhost = registerRequestHost();
  useChatStore.setState({
    activeSessionId: "s-a",
    selectedModelId: "claude-sonnet-5",
  });
  useChatStore.getState().resetAgentMeta();
  mocks.generateText.mockReset();
  mocks.generateText.mockResolvedValue(reply(1_000_000, 100_000));
});

afterEach(() => {
  unhost();
  useMcpRequests.setState({ hosts: 0, sampling: [], elicitations: [] });
  useMcpExtras.getState().setServers([]);
});

describe("an approved sampling request", () => {
  it("is counted in the open conversation at the price of the model that ran it", async () => {
    // The conversation's own run, on its model.
    countConversationUsage("s-a", "claude-sonnet-5", usage(1_000_000, 100_000));
    const { result } = await serverAsks();
    const out = await approveAndSend("claude-haiku-4-5");
    await expect(result).resolves.toMatchObject({
      content: { type: "text", text: "Paris" },
      stopReason: "endTurn",
    });
    expect(out.counted).toBe(true);
    const meta = useChatStore.getState().agentMeta;
    expect(meta.tokens).toEqual(usage(2_000_000, 200_000));
    expect([...meta.tokensByModel]).toEqual([
      ["claude-sonnet-5", usage(1_000_000, 100_000)],
      ["claude-haiku-4-5", usage(1_000_000, 100_000)],
    ]);
    // Per million tokens: $3 in and $15 out, then $1 in and $5 out.
    expect(usageCost(meta.tokensByModel)?.usd).toBeCloseTo(4.5 + 1.5, 9);
    // Only the agent's own requests say how full the context is.
    expect(meta.lastInputTokens).toBe(0);
    expect(samplingUsageNote(out.usage, out.counted)).toBe(
      "Used 1,100,000 tokens (1,000,000 in, 100,000 out), counted in this conversation's usage.",
    );
  });

  it("is not counted in a conversation opened after the user approved it", async () => {
    let finish: (value: unknown) => void = () => {};
    mocks.generateText.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { result } = await serverAsks();
    const running = approveAndSend("claude-haiku-4-5");
    await vi.waitFor(() => expect(mocks.generateText).toHaveBeenCalled());
    // As switching conversations does: the meter starts again.
    useChatStore.setState({ activeSessionId: "s-b" });
    useChatStore.getState().resetAgentMeta();
    finish(reply(40, 2));
    const out = await running;
    await expect(result).resolves.toMatchObject({
      content: { text: "Paris" },
    });
    expect(out.counted).toBe(false);
    expect(useChatStore.getState().agentMeta.tokensByModel.size).toBe(0);
  });

  it("is counted nowhere when the window has no conversation open", async () => {
    useChatStore.setState({ activeSessionId: null });
    const { result } = await serverAsks();
    const out = await approveAndSend("claude-haiku-4-5");
    await expect(result).resolves.toMatchObject({
      content: { text: "Paris" },
    });
    expect(out.counted).toBe(false);
    expect(useChatStore.getState().agentMeta.tokens).toEqual(usage(0, 0));
    expect(samplingUsageNote(out.usage, out.counted)).toBe(
      "Used 1,100,000 tokens (1,000,000 in, 100,000 out).",
    );
  });
});
