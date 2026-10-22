import { describe, expect, it } from "vitest";
import {
  compatModelIdForEndpoint,
  endpointIdFromCompatModel,
  estimateCost,
  getModelContextLimit,
  isCompatModelId,
  isResolvableModelId,
  LEGACY_COMPAT_ENDPOINT_ID,
  migrateLegacyCompatEndpoint,
  modelKeepsReasoning,
  modelSupportsTemperature,
  modelUsesReasoningTokens,
  MODELS,
  MODEL_CONTEXT_LIMITS,
  MODEL_PRICING,
  resolveContextLimit,
  resolveModel,
  type CustomEndpoint,
} from "./config";

const endpoint: CustomEndpoint = {
  id: "ab12cd34",
  name: "My LLM",
  baseURL: "https://api.example.com/v1",
  modelId: "llama-3.3-70b",
  contextLimit: 64_000,
};

describe("compat model id helpers", () => {
  it("round-trips endpoint id through the synthetic model id", () => {
    const mid = compatModelIdForEndpoint(endpoint.id);
    expect(isCompatModelId(mid)).toBe(true);
    expect(endpointIdFromCompatModel(mid)).toBe(endpoint.id);
  });

  it("treats static model ids as non-compat", () => {
    expect(isCompatModelId("gpt-5.4-mini")).toBe(false);
    expect(endpointIdFromCompatModel("gpt-5.4-mini")).toBe("");
  });
});

describe("resolveModel", () => {
  it("resolves a compat model id against its endpoint", () => {
    const mid = compatModelIdForEndpoint(endpoint.id);
    const info = resolveModel(mid, [endpoint]);
    expect(info.provider).toBe("openai-compatible");
    expect(info.id).toBe(mid);
    expect(info.label).toBe(endpoint.modelId);
  });

  it("falls back to a placeholder when the endpoint is gone", () => {
    const info = resolveModel(compatModelIdForEndpoint("missing"), []);
    expect(info.provider).toBe("openai-compatible");
  });

  it("resolves a static model id from the registry", () => {
    expect(resolveModel("gpt-5.4-mini").provider).toBe("openai");
  });

  it.each([
    ["gpt-5.6", "openai"],
    ["gpt-5.6-terra", "openai"],
    ["gpt-5.6-luna", "openai"],
    ["claude-fable-5", "anthropic"],
    ["claude-sonnet-5", "anthropic"],
    ["grok-4.5", "xai"],
  ] as const)("resolves current model %s through %s", (modelId, provider) => {
    expect(resolveModel(modelId).provider).toBe(provider);
  });

  it("throws on an unknown static model id", () => {
    expect(() => resolveModel("nope-not-real")).toThrow();
  });
});

describe("getModelContextLimit", () => {
  it("uses the per-endpoint override for compat models", () => {
    const mid = compatModelIdForEndpoint(endpoint.id);
    expect(getModelContextLimit(mid, endpoint.contextLimit)).toBe(64_000);
  });

  it("reads the static table for known models", () => {
    expect(getModelContextLimit("claude-opus-4-7")).toBe(1_000_000);
  });

  it.each([
    ["gpt-5.6", 1_050_000],
    ["gpt-5.6-terra", 1_050_000],
    ["gpt-5.6-luna", 1_050_000],
    ["claude-fable-5", 1_000_000],
    ["claude-sonnet-5", 1_000_000],
    ["grok-4.5", 500_000],
  ] as const)("uses the published context limit for %s", (modelId, limit) => {
    expect(getModelContextLimit(modelId)).toBe(limit);
  });
});

describe("current model pricing", () => {
  it.each([
    ["gpt-5.6", 5, 30, 0.5],
    ["gpt-5.6-terra", 2.5, 15, 0.25],
    ["gpt-5.6-luna", 1, 6, 0.1],
    ["claude-fable-5", 10, 50, 1],
    ["claude-sonnet-5", 3, 15, 0.3],
    ["grok-4.5", 2, 6, 0.5],
  ] as const)("uses the published token pricing for %s", (modelId, input, output, cacheRead) => {
    expect(MODEL_PRICING[modelId]).toEqual({ input, output, cacheRead });
  });
});

describe("modelKeepsReasoning", () => {
  it("keeps reasoning for compat endpoints (freeform provider)", () => {
    const info = resolveModel(compatModelIdForEndpoint(endpoint.id), [endpoint]);
    expect(modelKeepsReasoning(info)).toBe(true);
  });

  it("drops reasoning for plain non-reasoning models", () => {
    expect(modelKeepsReasoning(resolveModel("gpt-5.4-mini"))).toBe(false);
  });

  it("keeps reasoning for tagged reasoning models", () => {
    expect(modelKeepsReasoning(resolveModel("claude-opus-4-7"))).toBe(true);
  });
});

describe("model sampling capabilities", () => {
  it.each([
    ["openai", "gpt-5.4-nano"],
    ["openai", "gpt-5.6"],
    ["anthropic", "claude-fable-5"],
    ["anthropic", "claude-sonnet-5"],
  ] as const)("omits temperature for %s/%s", (provider, modelId) => {
    expect(modelSupportsTemperature(provider, modelId)).toBe(false);
  });

  it("keeps temperature for models that accept sampling parameters", () => {
    expect(modelSupportsTemperature("openai", "gpt-4.1-mini")).toBe(true);
    expect(modelSupportsTemperature("xai", "grok-4.5")).toBe(true);
  });

  it("defaults unknown provider models to temperature support", () => {
    expect(modelSupportsTemperature("openai-compatible", "custom-model")).toBe(
      true,
    );
  });

  it.each([
    ["openai", "gpt-5.4-nano"],
    ["openai", "gpt-5.6-luna"],
    ["anthropic", "claude-sonnet-5"],
    ["xai", "grok-4.5"],
    ["groq", "openai/gpt-oss-20b"],
  ] as const)("allocates a reasoning output budget for %s/%s", (provider, modelId) => {
    expect(modelUsesReasoningTokens(provider, modelId)).toBe(true);
  });
});

describe("migrateLegacyCompatEndpoint", () => {
  it("migrates a fully configured legacy endpoint under a stable id", () => {
    const migrate = () =>
      migrateLegacyCompatEndpoint(
        "https://api.example.com/v1",
        "llama-3.3-70b",
        32_000,
      );
    const out = migrate();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: LEGACY_COMPAT_ENDPOINT_ID,
      baseURL: "https://api.example.com/v1",
      modelId: "llama-3.3-70b",
      contextLimit: 32_000,
    });
    // Derived again on every load: a model id pointing at it must survive.
    expect(migrate()[0].id).toBe(out[0].id);
  });

  it("skips migration when base URL or model id is missing", () => {
    expect(migrateLegacyCompatEndpoint("", "m", 1)).toEqual([]);
    expect(migrateLegacyCompatEndpoint("u", "  ", 1)).toEqual([]);
  });
});

describe("resolveContextLimit", () => {
  it("takes a custom endpoint's limit from its settings", () => {
    const id = compatModelIdForEndpoint(endpoint.id);
    expect(resolveContextLimit(id, [endpoint], 32_000)).toBe(64_000);
    expect(resolveContextLimit(id, [], 32_000)).toBe(128_000);
    expect(resolveContextLimit("openai-compatible-custom", [], 32_000)).toBe(
      32_000,
    );
    expect(resolveContextLimit("gpt-5.4-mini", [endpoint])).toBe(
      MODEL_CONTEXT_LIMITS["gpt-5.4-mini"],
    );
  });
});

describe("isResolvableModelId", () => {
  it("accepts catalog ids and rejects unknown ones", () => {
    expect(isResolvableModelId("gpt-5.4-mini", [])).toBe(true);
    expect(isResolvableModelId("nope-not-real", [endpoint])).toBe(false);
    expect(isResolvableModelId("", [endpoint])).toBe(false);
  });

  it("accepts a compat id only while its endpoint exists and is complete", () => {
    const id = compatModelIdForEndpoint(endpoint.id);
    expect(isResolvableModelId(id, [endpoint])).toBe(true);
    expect(isResolvableModelId(id, [])).toBe(false);
    expect(isResolvableModelId(id, [{ ...endpoint, baseURL: "  " }])).toBe(
      false,
    );
    expect(isResolvableModelId(id, [{ ...endpoint, modelId: "" }])).toBe(
      false,
    );
  });
});

describe("model catalog invariants", () => {
  const allIds: string[] = MODELS.map((m) => m.id);

  it("keeps the context-limit table free of stale catalog ids", () => {
    const stale = Object.keys(MODEL_CONTEXT_LIMITS).filter(
      (id) => !allIds.includes(id),
    );
    expect(stale).toEqual([]);
  });

  it("keeps the pricing table free of stale catalog ids", () => {
    const stale = Object.keys(MODEL_PRICING).filter(
      (id) => !allIds.includes(id),
    );
    expect(stale).toEqual([]);
  });
});

describe("estimateCost", () => {
  const usage = {
    inputTokens: 2_000_000,
    outputTokens: 1_000_000,
    cachedInputTokens: 500_000,
  };

  it("returns null without a model id or a priced model", () => {
    expect(estimateCost(undefined, usage)).toBeNull();
    expect(
      estimateCost("unknown-model", {
        inputTokens: 1,
        outputTokens: 1,
        cachedInputTokens: 0,
      }),
    ).toBeNull();
  });

  it("charges fresh tokens at input price and cached tokens at cache price", () => {
    expect(estimateCost("gpt-5.6", usage)).toBeCloseTo(37.75, 6);
  });

  it("falls back to the input price when a model has no cache-read rate", () => {
    const grok = { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 400_000 };
    expect(estimateCost("grok-4.20-reasoning", grok)).toBeCloseTo(3, 6);
  });

  it("never charges negative fresh tokens when cache exceeds input", () => {
    const over = { inputTokens: 100, outputTokens: 0, cachedInputTokens: 900 };
    expect(estimateCost("gpt-5.6", over)).toBeGreaterThanOrEqual(0);
  });
});
