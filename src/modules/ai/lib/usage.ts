import { estimateCost } from "../config";

/**
 * What a conversation's runs used on the user's keys, for its token and cost
 * meter: the agent's steps, its sub-agents' steps and the sampling requests
 * the user approved for an MCP server, each counted with the model that ran
 * it so its cost comes from that model's price. Pure.
 */

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  /** Of the input, what the provider read from its cache. */
  cachedInputTokens: number;
};

export type UsageMeter = {
  tokens: TokenUsage;
  /** The same usage by the model that ran it, keyed by its id in Terax. */
  tokensByModel: ReadonlyMap<string, TokenUsage>;
};

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
};

/** A usage report of the AI SDK, as the meter counts it. */
export function tokenUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number };
}): TokenUsage {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
  };
}

function sum(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  };
}

/** The meter with `usage` added, as used by `modelId`. */
export function addUsage(
  meter: UsageMeter,
  modelId: string,
  usage: TokenUsage,
): UsageMeter {
  const byModel = new Map(meter.tokensByModel);
  byModel.set(modelId, sum(byModel.get(modelId) ?? ZERO_USAGE, usage));
  return { tokens: sum(meter.tokens, usage), tokensByModel: byModel };
}

/**
 * What the usage cost, each model's tokens at that model's price. Null when
 * no model in it has a price; otherwise `unpricedTokens` are the tokens of
 * the models without one, which the cost leaves out.
 */
export function usageCost(
  byModel: ReadonlyMap<string, TokenUsage>,
): { usd: number; unpricedTokens: number } | null {
  let usd: number | null = null;
  let unpricedTokens = 0;
  for (const [modelId, usage] of byModel) {
    const cost = estimateCost(modelId, usage);
    if (cost === null) unpricedTokens += usage.inputTokens + usage.outputTokens;
    else usd = (usd ?? 0) + cost;
  }
  return usd === null ? null : { usd, unpricedTokens };
}
