import { generateText, isStepCount } from "ai";
import { buildConfiguredLanguageModel } from "../lib/agent";
import type { ProviderKeys } from "../lib/keyring";
import type { LocalProviderConfig } from "../lib/modelTarget";
import { type TokenUsage, tokenUsage } from "../lib/usage";
import type { ToolContext } from "../tools/context";
import { buildFsTools } from "../tools/fs";
import { buildSearchTools } from "../tools/search";
import { TOOL_APPROVAL } from "../tools/tools";
import { SUBAGENTS, type SubagentType } from "./registry";

const SUBAGENT_MAX_STEPS = 12;

type Args = {
  type: SubagentType;
  prompt: string;
  keys: ProviderKeys;
  /** The chat's model id: a catalog model, a local server or an endpoint. */
  modelId: string;
  /** What that id resolves against (local servers, custom endpoints). */
  config: LocalProviderConfig;
  toolContext: ToolContext;
  onStep?: (label: string) => void;
  /** Each step's usage on the user's key, with the model id it ran on
   *  (`modelId`, which prices it). */
  onUsage?: (modelId: string, usage: TokenUsage) => void;
};

type RunResult = {
  summary: string;
  stepCount: number;
  durationMs: number;
};

export async function runSubagent({
  type,
  prompt,
  keys,
  modelId,
  config,
  toolContext,
  onStep,
  onUsage,
}: Args): Promise<RunResult> {
  const def = SUBAGENTS[type];
  if (!def) throw new Error(`unknown subagent type: ${type}`);

  const readOnly: Record<string, unknown> = {
    ...buildFsTools(toolContext),
    ...buildSearchTools(toolContext),
  };
  const tools: Record<string, unknown> = {};
  for (const t of def.tools) {
    if (t in readOnly) tools[t] = readOnly[t];
  }

  const model = await buildConfiguredLanguageModel(modelId, keys, config);

  const start = Date.now();
  const result = await generateText({
    model,
    instructions: def.systemPrompt,
    prompt,
    tools: tools as Parameters<typeof generateText>[0]["tools"],
    // Subagents only get read-only tools, but the shared policy still
    // applies: a mutating tool whitelisted by mistake stops for approval
    // (which a subagent cannot get) instead of running.
    toolApproval: TOOL_APPROVAL,
    stopWhen: isStepCount(SUBAGENT_MAX_STEPS),
    onStepEnd: (step) => {
      if (onUsage && step.usage) onUsage(modelId, tokenUsage(step.usage));
      if (!onStep) return;
      const last = step.toolCalls?.[step.toolCalls.length - 1];
      if (last) onStep(`${type}: ${last.toolName}`);
    },
  });

  return {
    summary: result.text || "(no output)",
    stepCount: result.steps?.length ?? 0,
    durationMs: Date.now() - start,
  };
}
