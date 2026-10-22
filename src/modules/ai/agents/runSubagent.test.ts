import { beforeEach, describe, expect, it, vi } from "vitest";

const providers = vi.hoisted(() => ({
  created: [] as { name: string; baseURL: string; apiKey?: string }[],
  models: [] as string[],
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
          doGenerate: async () => ({
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
          }),
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
