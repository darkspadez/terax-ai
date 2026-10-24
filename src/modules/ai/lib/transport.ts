import { mcpToolsForRun } from "@/modules/mcp";
import type { UIMessage } from "@ai-sdk/react";
import { toUIMessageStream } from "ai";
import type { AgentSkills } from "@/modules/skills/catalog";
import { type CustomEndpoint, resolveContextLimit } from "../config";
import { runAgentStream, type AgentUsageDelta } from "./agent";
import { maxMemoryBytes } from "./compact";
import type { ProviderKeys, CustomEndpointKeys } from "./keyring";
import { formatAiError } from "./errors";
import { pathText } from "./messageBlocks";
import { native, type ProjectMemory } from "./native";
import type { ToolContext } from "../tools/tools";
import type { ApprovalMode } from "./approvalMode";
import type { ReasoningEffort } from "./reasoningEffort";

/**
 * The project's AGENTS.md for this run. The backend reads it and returns it only
 * while the user allows its current content (project trust), so it is asked on
 * every run: a withdrawn answer or a changed file stops reaching the model at
 * once. Without it the run goes on with no project memory. The whole file is
 * sent, whatever its size; above `limit` bytes (more than the model could take)
 * only its size comes back, and the run says it does not fit.
 */
async function readAgentsMd(
  workspaceRoot: string | null,
  limit: number,
): Promise<ProjectMemory | null> {
  if (!workspaceRoot) return null;
  try {
    return await native.readProjectMemory(workspaceRoot, limit);
  } catch {
    return null;
  }
}

type LiveSnapshot = {
  cwd: string | null;
  terminalPrivate: boolean;
  workspaceRoot: string | null;
  activeFile: string | null;
};

type Deps = {
  getKeys: () => ProviderKeys;
  toolContext: ToolContext;
  getModelId: () => string;
  getCustomInstructions: () => string;
  getAgentPersona: () => { name: string; instructions: string } | null;
  getLive: () => LiveSnapshot;
  getLmstudioBaseURL?: () => string | undefined;
  getLmstudioModelId?: () => string | undefined;
  getMlxBaseURL?: () => string | undefined;
  getMlxModelId?: () => string | undefined;
  getOllamaBaseURL?: () => string | undefined;
  getOllamaModelId?: () => string | undefined;
  getOpenaiCompatibleBaseURL?: () => string | undefined;
  getOpenaiCompatibleModelId?: () => string | undefined;
  getOpenaiCompatibleContextLimit?: () => number | undefined;
  getOpenrouterModelId?: () => string | undefined;
  getCustomEndpoints?: () => readonly CustomEndpoint[];
  getCustomEndpointKeys?: () => CustomEndpointKeys;
  onStep?: (step: string | null) => void;
  onUsage?: (delta: AgentUsageDelta) => void;
  onCompact?: (info: { droppedCount: number }) => void;
  onFinishMeta?: (info: { hitStepCap: boolean; finishReason: string }) => void;
  getPlanMode?: () => boolean;
  /** The conversation's approval mode, read on every gated tool call. */
  getApprovalMode?: () => ApprovalMode;
  /** The effort remembered for the run's model, if one was chosen. */
  getReasoningEffort?: () => ReasoningEffort | undefined;
  /** The skills a run in this workspace may use. */
  getSkills?: (workspaceRoot: string | null) => Promise<AgentSkills>;
};

type SendOptions = {
  messages: UIMessage[];
  abortSignal?: AbortSignal;
  [k: string]: unknown;
};

export function createContextAwareTransport(deps: Deps) {
  const run = async (options: SendOptions) => {
    const live = deps.getLive();
    const contextLimit = resolveContextLimit(
      deps.getModelId(),
      deps.getCustomEndpoints?.() ?? [],
      deps.getOpenaiCompatibleContextLimit?.(),
    );
    const [projectMemory, mcp, skills] = await Promise.all([
      readAgentsMd(live.workspaceRoot, maxMemoryBytes(contextLimit)),
      mcpToolsForRun({
        signal: options.abortSignal,
        onWaiting: () => deps.onStep?.("Starting MCP servers"),
      }),
      deps.getSkills?.(live.workspaceRoot),
    ]);
    const envBlock = formatEnvBlock(live);
    const messagesForRun = envBlock
      ? injectEnvIntoLastUser(options.messages, envBlock)
      : options.messages;
    const run = await runAgentStream({
      keys: deps.getKeys(),
      modelId: deps.getModelId(),
      customInstructions: deps.getCustomInstructions(),
      agentPersona: deps.getAgentPersona(),
      toolContext: deps.toolContext,
      onStep: deps.onStep,
      onUsage: deps.onUsage,
      onCompact: deps.onCompact,
      onFinishMeta: deps.onFinishMeta,
      lmstudioBaseURL: deps.getLmstudioBaseURL?.(),
      lmstudioModelId: deps.getLmstudioModelId?.(),
      mlxBaseURL: deps.getMlxBaseURL?.(),
      mlxModelId: deps.getMlxModelId?.(),
      ollamaBaseURL: deps.getOllamaBaseURL?.(),
      ollamaModelId: deps.getOllamaModelId?.(),
      openaiCompatibleBaseURL: deps.getOpenaiCompatibleBaseURL?.(),
      openaiCompatibleModelId: deps.getOpenaiCompatibleModelId?.(),
      openaiCompatibleContextLimit: deps.getOpenaiCompatibleContextLimit?.(),
      openrouterModelId: deps.getOpenrouterModelId?.(),
      customEndpoints: deps.getCustomEndpoints?.(),
      customEndpointKeys: deps.getCustomEndpointKeys?.(),
      planMode: deps.getPlanMode?.(),
      approvalState: () => ({
        mode: deps.getApprovalMode?.() ?? "ask",
        planMode: deps.getPlanMode?.() ?? false,
      }),
      reasoningEffort: deps.getReasoningEffort?.(),
      projectMemory,
      mcp,
      skills,
      uiMessages: messagesForRun,
      abortSignal: options.abortSignal,
    });
    return toUIMessageStream({
      stream: run.stream,
      tools: run.tools,
      originalMessages: options.messages,
      onError: formatAiError,
    });
  };

  return {
    sendMessages: run,
    async reconnectToStream(): Promise<null> {
      return null;
    },
  };
}

function injectEnvIntoLastUser(
  messages: UIMessage[],
  envBlock: string,
): UIMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const parts = m.parts as ReadonlyArray<{ type: string; text?: string }>;
    let textIdx = -1;
    for (let j = 0; j < parts.length; j++) {
      if (parts[j].type === "text") {
        textIdx = j;
        break;
      }
    }
    const nextParts =
      textIdx === -1
        ? [{ type: "text", text: envBlock }, ...parts]
        : parts.map((p, idx) =>
            idx === textIdx
              ? { ...p, text: `${envBlock}\n\n${p.text ?? ""}` }
              : p,
          );
    const out = messages.slice();
    out[i] = { ...m, parts: nextParts } as UIMessage;
    return out;
  }
  return messages;
}

/** The run's environment for the model. A path is a folder or file name the
 *  user did not type, so it may hold a newline or `</env>`: each stays on its
 *  own line (`pathText`). */
function formatEnvBlock(live: LiveSnapshot): string | null {
  const lines: string[] = [];
  if (live.workspaceRoot) {
    lines.push(`workspace_root: ${pathText(live.workspaceRoot)}`);
  }
  if (live.cwd) lines.push(`active_terminal_cwd: ${pathText(live.cwd)}`);
  if (live.activeFile) lines.push(`active_file: ${pathText(live.activeFile)}`);
  if (live.terminalPrivate) lines.push("active_terminal_mode: private");
  if (lines.length === 0) return null;
  return `<env>\n${lines.join("\n")}\n</env>`;
}
