import type { JSONValue } from "ai";
import type { ModelInfo } from "../config";

/** How hard a reasoning model thinks before it answers. */
export type ReasoningEffort = "off" | "low" | "medium" | "high";

export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "off",
  "low",
  "medium",
  "high",
];

// The AI SDK's own list of xAI models that take no reasoning effort.
const XAI_WITHOUT_EFFORT = /^grok-4\.20(-\d{4})?-(non-)?reasoning$/;

/**
 * The efforts the composer offers for a model, or none to hide the picker.
 * Only catalog models tagged `reasoning` qualify, so custom endpoints, local
 * servers and gateway models (whose capabilities are unknown) never show it.
 *  - OpenAI, Anthropic, Google and xAI take every level through the AI SDK's
 *    `reasoning` call option, which each provider maps under its own
 *    constraints (see `reasoningCallOptions`).
 *  - DeepSeek's V4 models switch thinking on or off over its OpenAI-compatible
 *    API and think at one level when on, so they offer off and high.
 */
export function reasoningEfforts(model: ModelInfo): readonly ReasoningEffort[] {
  if (!model.tags?.includes("reasoning")) return [];
  switch (model.provider) {
    case "openai":
    case "anthropic":
    case "google":
      return REASONING_EFFORTS;
    case "xai":
      return XAI_WITHOUT_EFFORT.test(model.id) ? [] : REASONING_EFFORTS;
    case "deepseek":
      return model.id.startsWith("deepseek-v4-") ? ["off", "high"] : [];
    default:
      return [];
  }
}

/** A stored choice the model still offers, or undefined for its default. */
export function effectiveReasoningEffort(
  model: ModelInfo,
  stored: unknown,
): ReasoningEffort | undefined {
  return reasoningEfforts(model).find((effort) => effort === stored);
}

export type ReasoningCallOptions = {
  reasoning?: "none" | "low" | "medium" | "high";
  providerOptions?: Record<string, Record<string, JSONValue>>;
};

/**
 * The `streamText` options that apply an effort; empty when the model takes
 * none or no effort was chosen, which keeps the provider's default. The AI
 * SDK maps `reasoning` per provider: Anthropic's thinking (adaptive with an
 * effort, or a budget within the model's max tokens, temperature dropped),
 * OpenAI's `reasoningEffort`, Google's `thinkingConfig` (a level or a
 * budget) and xAI's `reasoningEffort`; a model that cannot turn reasoning
 * off gets its lowest setting for "off". DeepSeek's `thinking` switch is
 * passed through its OpenAI-compatible provider.
 */
export function reasoningCallOptions(
  model: ModelInfo,
  effort: ReasoningEffort | undefined,
): ReasoningCallOptions {
  if (effort === undefined || !reasoningEfforts(model).includes(effort)) {
    return {};
  }
  if (model.provider === "deepseek") {
    return {
      providerOptions: {
        deepseek:
          effort === "off"
            ? { thinking: { type: "disabled" } }
            : { thinking: { type: "enabled" }, reasoningEffort: effort },
      },
    };
  }
  return { reasoning: effort === "off" ? "none" : effort };
}

/** The remembered effort per model id, keeping only well-formed entries. */
export function normalizeReasoningEffortByModel(
  value: unknown,
): Record<string, ReasoningEffort> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, ReasoningEffort> = {};
  for (const [id, effort] of Object.entries(value)) {
    if (REASONING_EFFORTS.includes(effort as ReasoningEffort)) {
      out[id] = effort as ReasoningEffort;
    }
  }
  return out;
}
