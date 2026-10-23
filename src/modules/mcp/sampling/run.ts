import { modelSupportsTemperature, resolveModel } from "@/modules/ai/config";
import { buildConfiguredLanguageModel } from "@/modules/ai/lib/agent";
import { reasoningCallOptions } from "@/modules/ai/lib/reasoningEffort";
import {
  countConversationUsage,
  useChatStore,
} from "@/modules/ai/store/chatStore";
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
import { type TokenUsage, tokenUsage } from "@/modules/ai/lib/usage";

/**
 * Runs a sampling request the user approved: the chosen model, the
 * request's system prompt and messages only (no conversation, no tools, no
 * Oarlock instructions), at most the approved number of tokens and never more
 * than `SAMPLING_MAX_TOKENS`. The effort remembered for the model applies as
 * in the chat; a temperature only when the model takes one and no effort is
 * set. What it used is counted in the meter of the conversation the user
 * approved it in. Loaded when the user approves.
 */
export async function runSampling(opts: {
  modelId: string;
  draft: SamplingDraft;
  temperature: number | null;
  stopSequences: readonly string[];
  /** The conversation open in the window when the user approved, if any. */
  conversationId: string | null;
  signal: AbortSignal;
}): Promise<{
  text: string;
  finishReason: string;
  model: string;
  usage: TokenUsage;
  /** Whether the conversation's meter counted the usage. */
  counted: boolean;
}> {
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
  const usage = tokenUsage(result.usage);
  // Spent once the model answered, sent back or not. Priced by the id in
  // Oarlock (`target.modelId` is the provider's name, told to the server). With
  // no conversation open in the window there is no meter to count it in.
  const counted =
    opts.conversationId !== null &&
    countConversationUsage(opts.conversationId, opts.modelId, usage);
  return {
    text: result.text,
    finishReason: result.finishReason ?? "",
    model: target.modelId,
    usage,
    counted,
  };
}
