import { describe, expect, it } from "vitest";
import { compatModelIdForEndpoint, type CustomEndpoint } from "../config";
import { EMPTY_PROVIDER_KEYS } from "./keyring";
import { modelConfigProblem, resolveModelTarget } from "./modelTarget";

const endpoint: CustomEndpoint = {
  id: "ep1",
  name: "My LLM",
  baseURL: "https://llm.example.com/v1",
  modelId: " llama-3.3-70b ",
  contextLimit: 64_000,
};

describe("resolveModelTarget", () => {
  it("sends a custom endpoint its own model id, base URL and key", () => {
    expect(
      resolveModelTarget(compatModelIdForEndpoint("ep1"), {
        customEndpoints: [endpoint],
        customEndpointKeys: { ep1: "sk-ep" },
      }),
    ).toEqual({
      provider: "openai-compatible",
      modelId: "llama-3.3-70b",
      options: { openaiCompatibleBaseURL: "https://llm.example.com/v1" },
      endpointKey: "sk-ep",
    });
  });

  it("sends a local server its configured model, never the placeholder id", () => {
    expect(
      resolveModelTarget("ollama-local", {
        ollamaBaseURL: "http://127.0.0.1:11434/v1",
        ollamaModelId: "qwen3:8b",
      }),
    ).toMatchObject({
      provider: "ollama",
      modelId: "qwen3:8b",
      options: { ollamaBaseURL: "http://127.0.0.1:11434/v1" },
    });
  });
});

describe("modelConfigProblem", () => {
  const keys = { ...EMPTY_PROVIDER_KEYS, openai: "sk-test" };

  it("is null for a model that can run", () => {
    expect(modelConfigProblem("gpt-5.4-mini", keys)).toBeNull();
    expect(
      modelConfigProblem(compatModelIdForEndpoint("ep1"), EMPTY_PROVIDER_KEYS, {
        customEndpoints: [endpoint],
      }),
    ).toBeNull();
  });

  it("names what is missing", () => {
    expect(modelConfigProblem("claude-haiku-4-5", keys)).toMatch(
      /^No API key configured for anthropic\./,
    );
    expect(
      modelConfigProblem(compatModelIdForEndpoint("gone"), keys, {
        customEndpoints: [endpoint],
      }),
    ).toBe("Custom endpoint not found: gone");
    expect(modelConfigProblem("ollama-local", keys)).toMatch(
      /^Ollama: no model id set\./,
    );
    expect(modelConfigProblem("not-a-model", keys)).toBe(
      "Unknown model: not-a-model",
    );
  });
});
