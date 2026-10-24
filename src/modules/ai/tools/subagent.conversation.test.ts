import type { ToolExecutionOptions } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A sub-agent's steps and tokens in its conversation, with the real chat
// store and runner.

const provider = vi.hoisted(() => ({
  /** Usage of each step: input, cached, output. The last one answers. */
  steps: [] as [number, number, number][],
  /** Runs before each step is answered. */
  beforeStep: null as ((step: number) => void) | null,
  calls: 0,
}));

vi.mock("@ai-sdk/openai-compatible", async () => {
  const { MockLanguageModelV4: Mock } = await import("ai/test");
  return {
    createOpenAICompatible: () => () =>
      new Mock({
        doGenerate: async () => {
          const step = provider.calls++;
          provider.beforeStep?.(step);
          const [input, cached, output] = provider.steps[step];
          const last = step === provider.steps.length - 1;
          return {
            content: last
              ? [{ type: "text", text: "found it" }]
              : [
                  {
                    type: "tool-call",
                    toolCallId: `call-${step}`,
                    toolName: "glob",
                    input: JSON.stringify({ pattern: "**/*.ts" }),
                  },
                ],
            finishReason: last
              ? { unified: "stop", raw: "stop" }
              : { unified: "tool-calls", raw: "tool_calls" },
            usage: {
              inputTokens: {
                total: input,
                noCache: input - cached,
                cacheRead: cached,
                cacheWrite: 0,
              },
              outputTokens: { total: output, text: output, reasoning: 0 },
            },
            warnings: [],
          };
        },
      }),
  };
});
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async delete() {}
    async entries() {
      return [];
    }
  },
}));
vi.mock("../lib/native", () => ({ native: {} }));
vi.mock("../lib/modelPrefs", () => ({ pushRecentModel: vi.fn() }));
vi.mock("../store/modelConfig", () => ({
  liveModelConfig: () => ({ ollamaModelId: "qwen3:8b" }),
}));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
  workspaceScopeKey: () => "local",
}));

import { ZERO_USAGE } from "../lib/usage";
import { useChatStore } from "../store/chatStore";
import type { ToolContext } from "./context";
import { buildSubagentTools } from "./subagent";

const toolOptions: ToolExecutionOptions<Record<string, unknown>> = {
  toolCallId: "tool-call",
  messages: [],
  context: {},
};

/** Runs a sub-agent from a run of conversation `sessionId`. */
async function runFrom(sessionId: string): Promise<unknown> {
  const ctx = {
    getCwd: () => "/workspace",
    getWorkspaceRoot: () => "/workspace",
    getTerminalContext: () => null,
    isActiveTerminalPrivate: () => false,
    injectIntoActivePty: () => false,
    openPreview: () => false,
    spawnAgent: () => null,
    readAgentOutput: () => null,
    readCache: new Map(),
    getSessionId: () => sessionId,
  } satisfies ToolContext;
  const execute = buildSubagentTools(ctx).run_subagent.execute;
  if (!execute) throw new Error("run_subagent has no execute");
  return execute(
    { type: "explore", prompt: "find the config loader" },
    toolOptions,
  );
}

/** What switching conversations does to the window's meter. */
function openConversation(id: string) {
  useChatStore.setState({ activeSessionId: id });
  useChatStore.getState().resetAgentMeta();
}

beforeEach(() => {
  provider.steps = [
    [1_000, 800, 50],
    [2_000, 1_500, 70],
  ];
  provider.beforeStep = null;
  provider.calls = 0;
  useChatStore.setState({ selectedModelId: "ollama-local" });
  openConversation("s-a");
});

describe("a sub-agent's usage", () => {
  it("is counted step by step in the conversation that started it, at the model it ran on", async () => {
    useChatStore.getState().patchAgentMeta({
      lastInputTokens: 9_000,
      lastCachedTokens: 8_000,
    });
    provider.beforeStep = (step) => {
      if (step === 1) {
        // The first step is in the meter before the second runs.
        expect(useChatStore.getState().agentMeta.tokens.inputTokens).toBe(
          1_000,
        );
      }
    };
    expect(await runFrom("s-a")).toMatchObject({ summary: "found it" });

    const meta = useChatStore.getState().agentMeta;
    const used = {
      inputTokens: 3_000,
      outputTokens: 120,
      cachedInputTokens: 2_300,
    };
    expect(meta.tokens).toEqual(used);
    expect([...meta.tokensByModel]).toEqual([["ollama-local", used]]);
    // The context indicator shows the conversation's own context, which the
    // sub-agent's does not change.
    expect(meta.lastInputTokens).toBe(9_000);
    expect(meta.lastCachedTokens).toBe(8_000);
  });

  it("is not counted in a conversation the user opened while it ran", async () => {
    provider.beforeStep = (step) => {
      if (step === 1) openConversation("s-b");
    };
    await runFrom("s-a");

    const meta = useChatStore.getState().agentMeta;
    expect(meta.tokens).toEqual(ZERO_USAGE);
    expect(meta.tokensByModel.size).toBe(0);
  });

  it("is not counted while another conversation is open", async () => {
    openConversation("s-b");
    await runFrom("s-a");
    expect(useChatStore.getState().agentMeta.tokens).toEqual(ZERO_USAGE);
  });
});

describe("a sub-agent's step label", () => {
  it("shows in the conversation that started it while it is open", async () => {
    const steps: (string | null)[] = [];
    provider.beforeStep = () =>
      steps.push(useChatStore.getState().agentMeta.step);
    await runFrom("s-a");
    expect(steps).toEqual([null, "explore: glob"]);
  });

  it("never shows in a conversation the user opened while it ran", async () => {
    const steps: (string | null)[] = [];
    provider.beforeStep = (step) => {
      if (step === 0) openConversation("s-b");
      steps.push(useChatStore.getState().agentMeta.step);
    };
    await runFrom("s-a");
    expect(steps).toEqual([null, null]);
    expect(useChatStore.getState().agentMeta.step).toBeNull();
  });
});
