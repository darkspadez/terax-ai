import { generateText, type UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../tools/context";

const streamTextMock = vi.hoisted(() =>
  vi.fn((_options: Record<string, unknown>) => ({
    stream: new ReadableStream(),
  })),
);

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  streamText: streamTextMock,
}));
vi.mock("./native", () => ({ native: {} }));

// The native AI proxy (`ai_http_stream`): records each request and answers it
// with one JSON body through the packet protocol proxyFetch decodes.
const proxy = vi.hoisted(() => {
  type Channel = { onmessage: (value: ArrayBuffer) => void };
  const channels: Channel[] = [];
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const reply = { body: "{}" };
  const encoder = new TextEncoder();
  const send = (channel: Channel, kind: number, text = "") => {
    const bytes = encoder.encode(text);
    const packet = new Uint8Array(bytes.length + 1);
    packet[0] = kind;
    packet.set(bytes, 1);
    channel.onmessage(packet.buffer);
  };
  return {
    requests,
    reply,
    invoke: async (
      command: string,
      _body?: unknown,
      options?: { headers?: Record<string, string> },
    ) => {
      if (command !== "ai_http_stream") return undefined;
      const meta = JSON.parse(options?.headers?.["x-terax-ai-request"] ?? "{}");
      requests.push({ url: meta.url, headers: meta.headers ?? {} });
      const channel = channels[channels.length - 1];
      queueMicrotask(() => {
        const headers = { "content-type": "application/json" };
        send(channel, 0, JSON.stringify({ status: 200, headers }));
        send(channel, 1, reply.body);
        send(channel, 2);
      });
      return undefined;
    },
    Channel: class {
      onmessage = (_value: ArrayBuffer) => {};
      constructor() {
        channels.push(this);
      }
      toJSON() {
        return "__CHANNEL__";
      }
    },
  };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: proxy.invoke,
  Channel: proxy.Channel,
}));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
  workspaceScopeKey: () => "local",
}));

import { compatModelIdForEndpoint, MAX_AGENT_STEPS } from "../config";
import { TOOL_APPROVAL } from "../tools/tools";
import {
  buildConfiguredLanguageModel,
  buildLanguageModel,
  runAgentStream,
} from "./agent";
import { EMPTY_PROVIDER_KEYS } from "./keyring";

const toolContext = {
  getCwd: () => "/workspace",
  getWorkspaceRoot: () => "/workspace",
  getTerminalContext: () => null,
  isActiveTerminalPrivate: () => false,
  injectIntoActivePty: () => false,
  openPreview: () => false,
  spawnAgent: () => null,
  readAgentOutput: () => null,
  readCache: new Map(),
  getSessionId: () => "session",
} satisfies ToolContext;

const uiMessages: UIMessage[] = [
  { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
];

type StreamTextOptions = {
  instructions: unknown;
  tools: Record<string, unknown>;
  toolApproval: unknown;
  onStepEnd: (step: unknown) => void;
  onEnd: (event: unknown) => void;
};

async function startRun(extra: Record<string, unknown> = {}) {
  const run = await runAgentStream({
    keys: { ...EMPTY_PROVIDER_KEYS, openai: "sk-test" },
    modelId: "gpt-5.4-mini",
    toolContext,
    uiMessages,
    ...extra,
  });
  const options = streamTextMock.mock.calls[0][0] as StreamTextOptions;
  return { run, options };
}

beforeEach(() => {
  streamTextMock.mockClear();
});

describe("runAgentStream", () => {
  it("gates the agent's tools with the shared approval policy", async () => {
    const { run, options } = await startRun();
    expect(options.toolApproval).toBe(TOOL_APPROVAL);
    expect(Object.keys(options.tools).sort()).toEqual(
      Object.keys(TOOL_APPROVAL).sort(),
    );
    // The UI stream conversion receives the same tool set.
    expect(run.tools).toBe(options.tools);
  });

  it("passes the system prompt as instructions, never as a message", async () => {
    const { options } = await startRun({ planMode: true });
    expect(options.instructions).toEqual([
      expect.objectContaining({ role: "system" }),
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("PLAN MODE"),
      }),
    ]);
    expect(options).toMatchObject({ allowSystemInMessages: false });
  });

  it("reports per-step usage and the final status through the v7 callbacks", async () => {
    const onUsage = vi.fn();
    const onStep = vi.fn();
    const onFinishMeta = vi.fn();
    const { options } = await startRun({ onUsage, onStep, onFinishMeta });

    options.onStepEnd({
      toolCalls: [{ toolName: "read_file", input: { path: "/w/src/a.ts" } }],
      text: "",
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        inputTokenDetails: { cacheReadTokens: 100 },
      },
    });
    expect(onStep).toHaveBeenLastCalledWith("Reading a.ts");
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: 100,
      lastInputTokens: 120,
      lastCachedTokens: 100,
    });

    options.onEnd({ finishReason: "stop" });
    expect(onStep).toHaveBeenLastCalledWith(null);
    expect(onFinishMeta).toHaveBeenCalledWith({
      hitStepCap: false,
      finishReason: "stop",
    });
  });

  it("flags a run that used every allowed step", async () => {
    const onFinishMeta = vi.fn();
    const { options } = await startRun({ onFinishMeta });
    for (let i = 0; i < MAX_AGENT_STEPS; i++) {
      options.onStepEnd({ toolCalls: [], text: "" });
    }
    options.onEnd({ finishReason: "tool-calls" });
    expect(onFinishMeta).toHaveBeenCalledWith({
      hitStepCap: true,
      finishReason: "tool-calls",
    });
  });
});

describe("buildLanguageModel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("opts Anthropic requests into browser access so the webview's preflight passes", async () => {
    const webviewFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-haiku-4-5",
            content: [{ type: "text", text: "hi" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", webviewFetch);
    const model = await buildLanguageModel(
      "anthropic",
      { ...EMPTY_PROVIDER_KEYS, anthropic: "sk-ant-test" },
      "claude-haiku-4-5",
    );
    await generateText({ model, prompt: "hello" });

    const request = new Request(...webviewFetch.mock.calls[0]);
    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request.headers.get("anthropic-dangerous-direct-browser-access")).toBe(
      "true",
    );
  });

  it("sends OpenCode's session header to an OpenCode custom endpoint, through the native proxy", async () => {
    proxy.reply.body = JSON.stringify({
      id: "c1",
      object: "chat.completion",
      created: 0,
      model: "deepseek-v4-pro",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const endpoints = [
      {
        id: "ocgo0001",
        name: "OpenCode Go",
        baseURL: "https://opencode.ai/zen/go/v1",
        modelId: "deepseek-v4-pro",
        contextLimit: 128_000,
      },
      {
        id: "other001",
        name: "Other",
        baseURL: "https://llm.example.com/v1",
        modelId: "m",
        contextLimit: 128_000,
      },
    ];
    for (const endpoint of endpoints) {
      const model = await buildConfiguredLanguageModel(
        compatModelIdForEndpoint(endpoint.id),
        EMPTY_PROVIDER_KEYS,
        {
          customEndpoints: endpoints,
          customEndpointKeys: { [endpoint.id]: "sk-endpoint" },
        },
      );
      await generateText({ model, prompt: "hello" });
    }

    const [opencode, other] = proxy.requests;
    expect(opencode.url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    expect(opencode.headers.authorization).toBe("Bearer sk-endpoint");
    expect(opencode.headers["x-opencode-session"]).toMatch(/^[0-9a-f]+$/);
    expect(other.url).toBe("https://llm.example.com/v1/chat/completions");
    expect(other.headers).not.toHaveProperty("x-opencode-session");
  });

  it("moves <think> reasoning out of a custom endpoint's answer", async () => {
    proxy.reply.body = JSON.stringify({
      id: "c2",
      object: "chat.completion",
      created: 0,
      model: "MiniMax-M2.7",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "<think>plan the reply</think>Hello!",
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const endpoint = {
      id: "minimax1",
      name: "MiniMax",
      baseURL: "https://api.minimax.io/v1",
      modelId: "MiniMax-M2.7",
      contextLimit: 200_000,
    };
    const model = await buildConfiguredLanguageModel(
      compatModelIdForEndpoint(endpoint.id),
      EMPTY_PROVIDER_KEYS,
      { customEndpoints: [endpoint] },
    );
    const result = await generateText({ model, prompt: "hi" });
    expect(result.text).toBe("Hello!");
    expect(result.reasoningText).toBe("plan the reply");
  });
});
