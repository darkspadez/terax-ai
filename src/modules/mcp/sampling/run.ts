import { modelSupportsTemperature, resolveModel } from "@/modules/ai/config";
import { buildConfiguredLanguageModel } from "@/modules/ai/lib/agent";
import { reasoningCallOptions } from "@/modules/ai/lib/reasoningEffort";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { liveModelConfig } from "@/modules/ai/store/modelConfig";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { generateText } from "ai";
import {
  SAMPLING_MAX_TOKENS,
  type SamplingDraft,
  samplingDraftProblem,
  samplingModelMessages,
} from "../lib/sampling";
import { resolveModelTarget } from "@/modules/ai/lib/modelTarget";

/**
 * Runs a sampling request the user approved: the chosen model, the
 * request's system prompt and messages only (no conversation, no tools, no
 * Terax instructions), at most the approved number of tokens and never more
 * than `SAMPLING_MAX_TOKENS`. The effort remembered for the model applies as
 * in the chat; a temperature only when the model takes one and no effort is
 * set. Loaded when the user approves.
 */
export async function runSampling(opts: {
  modelId: string;
  draft: SamplingDraft;
  temperature: number | null;
  stopSequences: readonly string[];
  signal: AbortSignal;
}): Promise<{ text: string; finishReason: string; model: string }> {
  const problem = samplingDraftProblem(opts.draft);
  if (problem) throw new Error(problem);
  const config = liveModelConfig();
  const model = await buildConfiguredLanguageModel(
    opts.modelId,
    useChatStore.getState().apiKeys,
    config,
  );
  const info = resolveModel(opts.modelId, config.customEndpoints ?? []);
  const reasoning = reasoningCallOptions(
    info,
    usePreferencesStore.getState().reasoningEffortByModel[opts.modelId],
  );
  const target = resolveModelTarget(opts.modelId, config);
  const useTemperature =
    opts.temperature !== null &&
    Object.keys(reasoning).length === 0 &&
    modelSupportsTemperature(target.provider, target.modelId);
  const result = await generateText({
    model,
    instructions: opts.draft.systemPrompt.trim() || undefined,
    messages: samplingModelMessages(opts.draft.messages),
    maxOutputTokens: Math.min(opts.draft.maxTokens, SAMPLING_MAX_TOKENS),
    ...(useTemperature ? { temperature: opts.temperature ?? undefined } : {}),
    ...(opts.stopSequences.length > 0
      ? { stopSequences: [...opts.stopSequences] }
      : {}),
    ...reasoning,
    abortSignal: opts.signal,
  });
  return {
    text: result.text,
    finishReason: result.finishReason ?? "",
    model: target.modelId,
  };
}
