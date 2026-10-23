import { describe, expect, it } from "vitest";
import { estimateCost } from "../config";
import {
  addUsage,
  type TokenUsage,
  tokenUsage,
  type UsageMeter,
  usageCost,
  ZERO_USAGE,
} from "./usage";

const EMPTY: UsageMeter = { tokens: ZERO_USAGE, tokensByModel: new Map() };

function usage(input: number, output: number, cached = 0): TokenUsage {
  return {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: cached,
  };
}

describe("tokenUsage", () => {
  it("reads the AI SDK's report, a missing count as none", () => {
    expect(
      tokenUsage({
        inputTokens: 120,
        outputTokens: 30,
        inputTokenDetails: { cacheReadTokens: 100 },
      }),
    ).toEqual(usage(120, 30, 100));
    expect(tokenUsage({})).toEqual(ZERO_USAGE);
  });
});

describe("addUsage", () => {
  it("adds to the totals and to the model that used it", () => {
    const once = addUsage(EMPTY, "claude-sonnet-5", usage(1000, 100, 800));
    const twice = addUsage(once, "claude-sonnet-5", usage(500, 50));
    const sampled = addUsage(twice, "claude-haiku-4-5", usage(40, 2));
    expect(sampled.tokens).toEqual(usage(1540, 152, 800));
    expect([...sampled.tokensByModel]).toEqual([
      ["claude-sonnet-5", usage(1500, 150, 800)],
      ["claude-haiku-4-5", usage(40, 2)],
    ]);
  });

  it("leaves the meter it was given as it was", () => {
    const before = addUsage(EMPTY, "m", usage(1, 1));
    addUsage(before, "m", usage(5, 5));
    expect(before.tokens).toEqual(usage(1, 1));
    expect(before.tokensByModel.get("m")).toEqual(usage(1, 1));
    expect(EMPTY.tokensByModel.size).toBe(0);
  });
});

describe("usageCost", () => {
  it("prices each model's tokens at that model's price", () => {
    const meter = addUsage(
      addUsage(EMPTY, "claude-sonnet-5", usage(1_000_000, 100_000)),
      "claude-haiku-4-5",
      usage(1_000_000, 100_000),
    );
    // Per million tokens: $3 in and $15 out, then $1 in and $5 out.
    expect(usageCost(meter.tokensByModel)?.usd).toBeCloseTo(4.5 + 1.5, 9);
    // Not every token at the conversation's model, as one total would be.
    expect(estimateCost("claude-sonnet-5", meter.tokens)).toBeCloseTo(9, 9);
    expect(usageCost(meter.tokensByModel)?.unpricedTokens).toBe(0);
  });

  it("keeps the tokens of a model without a price out of the cost", () => {
    const meter = addUsage(
      addUsage(EMPTY, "claude-haiku-4-5", usage(1_000_000, 0)),
      "ollama-local",
      usage(300, 20),
    );
    expect(usageCost(meter.tokensByModel)).toEqual({
      usd: 1,
      unpricedTokens: 320,
    });
  });

  it("has no cost when no model in it has a price", () => {
    expect(usageCost(EMPTY.tokensByModel)).toBeNull();
    expect(
      usageCost(addUsage(EMPTY, "ollama-local", usage(10, 5)).tokensByModel),
    ).toBeNull();
  });
});
