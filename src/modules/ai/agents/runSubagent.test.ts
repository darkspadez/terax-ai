import { beforeEach, describe, expect, it, vi } from "vitest";

const providers = vi.hoisted(() => ({
  created: [] as { name: string; baseURL: string; apiKey?: string }[],
  models: [] as string[],
  tools: [] as string[],
  /** Steps that call a tool first, each with its usage: input, cached, output. */
  toolSteps: [] as [number, number, number][],
}));
vi.mock("@ai-sdk/openai-compatible", async () => {
  const { MockLanguageModelV4: Mock } = await import("ai/test");
  return {
    createOpenAICompatible:
      (config: { name: string; baseURL: string; apiKey?: string }) =>
      (modelId: string) => {
        providers.created.push(config);
        providers.models.push(modelId);
        return new Mock({
          doGenerate: async (options: { tools?: { name: string }[] }) => {
            providers.tools.push(...(options.tools ?? []).map((t) => t.name));
            const toolStep = providers.toolSteps.shift();
            if (toolStep) {
              const [input, cached, output] = toolStep;
              return {
                content: [
                  {
                    type: "tool-call",
                    toolCallId: `call-${providers.toolSteps.length}`,
                    toolName: "glob",
                    input: JSON.stringify({ pattern: "**/*.ts" }),
                  },
                ],
                finishReason: { unified: "tool-calls", raw: "tool_calls" },
                usage: {
                  inputTokens: {
                    total: input,
                    noCache: input - cached,
                    cacheRead: cached,
                    cacheWrite: 0,
                  },
                  outputTokens: { total: output, text: output, reasoning: 0 },
                },
                warnings: [],
              };
            }
            return {
              content: [{ type: "text", text: "found it" }],
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
              warnings: [],
            };
          },
        });
      },
  };
});
vi.mock("../lib/native", () => ({ native: {} }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
  workspaceScopeKey: () => "local",
}));

import { EMPTY_PROVIDER_KEYS } from "../lib/keyring";
import type { ToolContext } from "../tools/context";
import { runSubagent } from "./runSubagent";

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

beforeEach(() => {
  providers.created.length = 0;
  providers.models.length = 0;
  providers.tools.length = 0;
  providers.toolSteps.length = 0;
});

describe("runSubagent", () => {
  it("runs on the chat's custom endpoint", async () => {
    const result = await runSubagent({
      type: "explore",
      prompt: "find the config loader",
      keys: EMPTY_PROVIDER_KEYS,
      modelId: "compat-sub00001",
      config: {
        customEndpoints: [
          {
            id: "sub00001",
            name: "Box",
            baseURL: "https://llm.sub.example/v1",
            modelId: "qwen3-coder",
            contextLimit: 128_000,
          },
        ],
        customEndpointKeys: { sub00001: "sk-sub" },
      },
      toolContext,
    });
    expect(result.summary).toBe("found it");
    expect(providers.created).toEqual([
      expect.objectContaining({
        name: "openai-compatible",
        baseURL: "https://llm.sub.example/v1",
        apiKey: "sk-sub",
      }),
    ]);
    expect(providers.models).toEqual(["qwen3-coder"]);
  });

  it("gets only its read-only built-in tools, never the window's MCP tools", async () => {
    const { useMcpCatalog } = await import("@/modules/mcp/lib/catalog");
    useMcpCatalog.getState().setTools({
      mcp__srv__write: {
        name: "mcp__srv__write",
        serverId: "s",
        serverName: "srv",
        tool: "write",
        trusted: true,
      },
    });
    await runSubagent({
      type: "general",
      prompt: "look around",
      keys: EMPTY_PROVIDER_KEYS,
      modelId: "ollama-local",
      config: { ollamaModelId: "qwen3:8b" },
      toolContext,
    });
    useMcpCatalog.getState().setTools({});
    expect(providers.tools.length).toBeGreaterThan(0);
    expect(providers.tools.filter((name) => name.startsWith("mcp__"))).toEqual(
      [],
    );
    expect(
      providers.tools.every((name) =>
        ["read_file", "list_directory", "grep", "glob"].includes(name),
      ),
    ).toBe(true);
  });

  it("reports every step's usage with the model id it ran on", async () => {
    providers.toolSteps.push([120, 100, 30]);
    const onUsage = vi.fn();
    const result = await runSubagent({
      type: "explore",
      prompt: "find the config loader",
      keys: EMPTY_PROVIDER_KEYS,
      modelId: "ollama-local",
      config: { ollamaModelId: "qwen3:8b" },
      toolContext,
      onUsage,
    });
    expect(result.stepCount).toBe(2);
    // Priced by Terax's id for the model, not the server's name for it.
    expect(onUsage.mock.calls).toEqual([
      [
        "ollama-local",
        { inputTokens: 120, outputTokens: 30, cachedInputTokens: 100 },
      ],
      [
        "ollama-local",
        { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
      ],
    ]);
  });

  it("sends a local server its configured model, not the placeholder id", async () => {
    await runSubagent({
      type: "explore",
      prompt: "find the config loader",
      keys: EMPTY_PROVIDER_KEYS,
      modelId: "ollama-local",
      config: {
        ollamaBaseURL: "http://127.0.0.1:11435/v1",
        ollamaModelId: "qwen3:8b",
      },
      toolContext,
    });
    expect(providers.created).toEqual([
      expect.objectContaining({
        name: "ollama",
        baseURL: "http://127.0.0.1:11435/v1",
      }),
    ]);
    expect(providers.models).toEqual(["qwen3:8b"]);
  });
});
