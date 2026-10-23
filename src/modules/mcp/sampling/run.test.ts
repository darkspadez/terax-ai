import { beforeEach, describe, expect, it, vi } from "vitest";
import { SAMPLING_MAX_TOKENS, type SamplingDraft } from "../lib/sampling";

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  build: vi.fn(),
  efforts: {} as Record<string, string>,
}));

vi.mock("ai", () => ({ generateText: mocks.generateText }));
vi.mock("@/modules/ai/lib/agent", () => ({
  buildConfiguredLanguageModel: mocks.build,
}));
vi.mock("@/modules/ai/store/chatStore", () => ({
  useChatStore: { getState: () => ({ apiKeys: { anthropic: "sk" } }) },
}));
vi.mock("@/modules/ai/store/modelConfig", () => ({
  liveModelConfig: () => ({ ollamaModelId: "qwen3" }),
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: () => ({ reasoningEffortByModel: mocks.efforts }),
  },
}));

import { runSampling } from "./run";

const draft: SamplingDraft = {
  systemPrompt: "  Be brief.  ",
  maxTokens: 300,
  messages: [{ role: "user", text: "Capital of France?", images: [] }],
};

beforeEach(() => {
  mocks.generateText.mockReset();
  mocks.generateText.mockResolvedValue({ text: "Paris", finishReason: "stop" });
  mocks.build.mockReset();
  mocks.build.mockResolvedValue("MODEL");
  for (const key of Object.keys(mocks.efforts)) delete mocks.efforts[key];
});

describe("runSampling", () => {
  it("runs only the request: its prompt and messages, capped, without tools", async () => {
    const signal = new AbortController().signal;
    await expect(
      runSampling({
        modelId: "gemini-2.5-pro",
        draft,
        temperature: 0.3,
        stopSequences: ["END"],
        signal,
      }),
    ).resolves.toEqual({
      text: "Paris",
      finishReason: "stop",
      model: "gemini-2.5-pro",
    });
    expect(mocks.build).toHaveBeenCalledWith(
      "gemini-2.5-pro",
      { anthropic: "sk" },
      { ollamaModelId: "qwen3" },
    );
    const call = mocks.generateText.mock.calls[0][0];
    expect(call).toEqual({
      model: "MODEL",
      instructions: "Be brief.",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Capital of France?" }],
        },
      ],
      maxOutputTokens: 300,
      temperature: 0.3,
      stopSequences: ["END"],
      abortSignal: signal,
    });
    expect(call).not.toHaveProperty("tools");
  });

  it("never asks for more than the hard ceiling", async () => {
    await expect(
      runSampling({
        modelId: "gemini-2.5-pro",
        draft: { ...draft, maxTokens: SAMPLING_MAX_TOKENS + 1 },
        temperature: null,
        stopSequences: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/^Max tokens must be/);
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("keeps the model's chosen effort and then sends no temperature", async () => {
    mocks.efforts["claude-sonnet-5"] = "low";
    await runSampling({
      modelId: "claude-sonnet-5",
      draft: { ...draft, systemPrompt: "" },
      temperature: 0.7,
      stopSequences: [],
      signal: new AbortController().signal,
    });
    const call = mocks.generateText.mock.calls[0][0];
    expect(call.reasoning).toBe("low");
    expect(call).not.toHaveProperty("temperature");
    expect(call.instructions).toBeUndefined();
  });

  it("tells the server the model a local server runs", async () => {
    const out = await runSampling({
      modelId: "ollama-local",
      draft,
      temperature: null,
      stopSequences: [],
      signal: new AbortController().signal,
    });
    expect(out.model).toBe("qwen3");
  });
});
