import { generateText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./native", () => ({ native: {} }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
  workspaceScopeKey: () => "local",
}));

import {
  compatModelIdForEndpoint,
  getCompatModelInfo,
  MODELS,
  type ModelInfo,
  type ProviderId,
  resolveModel,
} from "../config";
import { buildLanguageModel } from "./agent";
import { EMPTY_PROVIDER_KEYS } from "./keyring";
import {
  effectiveReasoningEffort,
  normalizeReasoningEffortByModel,
  REASONING_EFFORTS,
  type ReasoningEffort,
  reasoningCallOptions,
  reasoningEfforts,
} from "./reasoningEffort";

const model = (id: string): ModelInfo => resolveModel(id);

describe("which models offer a reasoning effort", () => {
  it("offers it for the catalog's reasoning models the app can set", () => {
    const offered = MODELS.filter((m) => reasoningEfforts(m).length > 0)
      .map((m) => m.id)
      .sort();
    expect(offered).toEqual(
      [
        "claude-fable-5",
        "claude-opus-4-6",
        "claude-opus-4-7",
        "claude-opus-4-8",
        "claude-sonnet-5",
        "deepseek-v4-flash",
        "deepseek-v4-pro",
        "gemini-3.1-pro-preview",
        "gpt-5.5",
        "gpt-5.5-pro",
        "gpt-5.6",
        "gpt-5.6-luna",
        "gpt-5.6-terra",
        "grok-4-fast-reasoning",
        "grok-4.3",
        "grok-4.5",
      ].sort(),
    );
  });

  it("decides from the model metadata: only models tagged reasoning", () => {
    for (const m of MODELS) {
      if (!(m as ModelInfo).tags?.includes("reasoning")) {
        expect(reasoningEfforts(m), m.id).toEqual([]);
      }
    }
  });

  it("hides the picker for models whose capabilities are unknown", () => {
    for (const id of [
      "openrouter-custom",
      "openai-compatible-custom",
      "lmstudio-local",
      "mlx-local",
      "ollama-local",
    ]) {
      expect(reasoningEfforts(model(id)), id).toEqual([]);
    }
    const endpoint = getCompatModelInfo(compatModelIdForEndpoint("e1"), [
      {
        id: "e1",
        name: "Mine",
        baseURL: "https://llm.example.com/v1",
        modelId: "some-reasoner",
        contextLimit: 128_000,
      },
    ]);
    expect(reasoningEfforts(endpoint)).toEqual([]);
  });

  it("respects providers that cannot take an effort for a model", () => {
    // The AI SDK's xAI provider refuses reasoning effort for Grok 4.20.
    expect(reasoningEfforts(model("grok-4.20-reasoning"))).toEqual([]);
    // Groq's R1 distill takes no reasoning effort.
    expect(reasoningEfforts(model("deepseek-r1-distill-llama-70b"))).toEqual(
      [],
    );
    // DeepSeek's legacy reasoner alias always thinks.
    expect(reasoningEfforts(model("deepseek-reasoner"))).toEqual([]);
    // DeepSeek V4 switches thinking on or off.
    expect(reasoningEfforts(model("deepseek-v4-pro"))).toEqual(["off", "high"]);
    expect(reasoningEfforts(model("gpt-5.6"))).toEqual(REASONING_EFFORTS);
  });

  it("uses a remembered effort only while the model still offers it", () => {
    expect(effectiveReasoningEffort(model("gpt-5.6"), "low")).toBe("low");
    expect(effectiveReasoningEffort(model("gpt-5.6"), undefined)).toBe(
      undefined,
    );
    expect(effectiveReasoningEffort(model("gpt-5.6"), "max")).toBe(undefined);
    expect(effectiveReasoningEffort(model("deepseek-v4-pro"), "low")).toBe(
      undefined,
    );
    expect(effectiveReasoningEffort(model("gpt-5.4-mini"), "high")).toBe(
      undefined,
    );
  });

  it("keeps only well-formed remembered efforts", () => {
    expect(
      normalizeReasoningEffortByModel({
        "gpt-5.6": "high",
        "claude-sonnet-5": "off",
        bad: "max",
        worse: 3,
      }),
    ).toEqual({ "gpt-5.6": "high", "claude-sonnet-5": "off" });
    for (const value of [null, undefined, "high", ["high"], 1]) {
      expect(normalizeReasoningEffortByModel(value)).toEqual({});
    }
  });
});

describe("reasoningCallOptions", () => {
  it("leaves the model's default when no effort was chosen", () => {
    expect(reasoningCallOptions(model("gpt-5.6"), undefined)).toEqual({});
  });

  it("sends nothing for a model that offers no effort", () => {
    expect(reasoningCallOptions(model("gpt-5.4-mini"), "high")).toEqual({});
    expect(reasoningCallOptions(model("ollama-local"), "off")).toEqual({});
    expect(reasoningCallOptions(model("deepseek-v4-pro"), "low")).toEqual({});
  });

  it("maps through the AI SDK's reasoning option for the native providers", () => {
    for (const id of [
      "gpt-5.6",
      "claude-sonnet-5",
      "gemini-3.1-pro-preview",
      "grok-4.3",
    ]) {
      expect(reasoningCallOptions(model(id), "off"), id).toEqual({
        reasoning: "none",
      });
      for (const effort of ["low", "medium", "high"] as const) {
        expect(reasoningCallOptions(model(id), effort), id).toEqual({
          reasoning: effort,
        });
      }
    }
  });

  it("switches DeepSeek's thinking through its compatible API", () => {
    expect(reasoningCallOptions(model("deepseek-v4-pro"), "off")).toEqual({
      providerOptions: { deepseek: { thinking: { type: "disabled" } } },
    });
    expect(reasoningCallOptions(model("deepseek-v4-flash"), "high")).toEqual({
      providerOptions: {
        deepseek: { thinking: { type: "enabled" }, reasoningEffort: "high" },
      },
    });
  });
});

/** The request body a provider sends for one call with this effort. */
async function requestBody(
  provider: ProviderId,
  modelId: string,
  effort: ReasoningEffort,
): Promise<Record<string, unknown>> {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ error: { message: "stop here" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const built = await buildLanguageModel(
    provider,
    { ...EMPTY_PROVIDER_KEYS, [provider]: `key-${provider}` },
    modelId,
  );
  await generateText({
    model: built,
    prompt: "hello",
    maxRetries: 0,
    ...reasoningCallOptions(model(modelId), effort),
  }).catch(() => {});
  expect(fetchMock).toHaveBeenCalledOnce();
  const init = fetchMock.mock.calls[0][1];
  return JSON.parse(String(init?.body));
}

describe("each provider's request for an effort", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("Anthropic: adaptive thinking with an effort, never with a temperature", async () => {
    const high = await requestBody("anthropic", "claude-sonnet-5", "high");
    expect(high.thinking).toMatchObject({ type: "adaptive" });
    expect(high.output_config).toMatchObject({ effort: "high" });
    expect(high).not.toHaveProperty("temperature");

    const off = await requestBody("anthropic", "claude-sonnet-5", "off");
    expect(off.thinking).toEqual({ type: "disabled" });

    // A model that always thinks gets its lowest effort for "off".
    const always = await requestBody("anthropic", "claude-fable-5", "off");
    expect(always.output_config).toMatchObject({ effort: "low" });
    expect(always.thinking).not.toEqual({ type: "disabled" });
  });

  it("OpenAI: reasoning effort, none for off", async () => {
    const low = await requestBody("openai", "gpt-5.6", "low");
    expect(low.reasoning).toMatchObject({ effort: "low" });
    const off = await requestBody("openai", "gpt-5.6", "off");
    expect(off.reasoning).toMatchObject({ effort: "none" });
  });

  it("Google: a thinking level, the model's lowest for off", async () => {
    const high = await requestBody("google", "gemini-3.1-pro-preview", "high");
    expect(high.generationConfig).toMatchObject({
      thinkingConfig: { thinkingLevel: "high" },
    });
    const off = await requestBody("google", "gemini-3.1-pro-preview", "off");
    expect(off.generationConfig).toMatchObject({
      thinkingConfig: { thinkingLevel: "low" },
    });
  });

  it("xAI: reasoning effort", async () => {
    const medium = await requestBody("xai", "grok-4.3", "medium");
    expect(medium.reasoning).toMatchObject({ effort: "medium" });
  });

  it("DeepSeek: the thinking switch and its effort", async () => {
    const high = await requestBody("deepseek", "deepseek-v4-pro", "high");
    expect(high.thinking).toEqual({ type: "enabled" });
    expect(high.reasoning_effort).toBe("high");
    const off = await requestBody("deepseek", "deepseek-v4-pro", "off");
    expect(off.thinking).toEqual({ type: "disabled" });
    expect(off).not.toHaveProperty("reasoning_effort");
  });
});
