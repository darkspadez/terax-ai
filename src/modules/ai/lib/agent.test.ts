import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../tools/context";

const streamTextMock = vi.hoisted(() =>
  vi.fn((_options: Record<string, unknown>) => ({
    stream: new ReadableStream(),
  })),
);

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  streamText: streamTextMock,
}));
vi.mock("./native", () => ({ native: {} }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
  workspaceScopeKey: () => "local",
}));

import { MAX_AGENT_STEPS } from "../config";
import { TOOL_APPROVAL } from "../tools/tools";
import { runAgentStream } from "./agent";
import { EMPTY_PROVIDER_KEYS } from "./keyring";

const toolContext = {
  getCwd: () => "/workspace",
  getWorkspaceRoot: () => "/workspace",
  getTerminalContext: () => null,
  isActiveTerminalPrivate: () => false,
  injectIntoActivePty: () => false,
  openPreview: () => false,
  spawnAgent: () => null,
  readAgentOutput: () => null,
  readCache: new Map(),
  getSessionId: () => "session",
} satisfies ToolContext;

const uiMessages: UIMessage[] = [
  { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
];

type StreamTextOptions = {
  instructions: unknown;
  tools: Record<string, unknown>;
  toolApproval: unknown;
  onStepEnd: (step: unknown) => void;
  onEnd: (event: unknown) => void;
};

async function startRun(extra: Record<string, unknown> = {}) {
  const run = await runAgentStream({
    keys: { ...EMPTY_PROVIDER_KEYS, openai: "sk-test" },
    modelId: "gpt-5.4-mini",
    toolContext,
    uiMessages,
    ...extra,
  });
  const options = streamTextMock.mock.calls[0][0] as StreamTextOptions;
  return { run, options };
}

beforeEach(() => {
  streamTextMock.mockClear();
});

describe("runAgentStream", () => {
  it("gates the agent's tools with the shared approval policy", async () => {
    const { run, options } = await startRun();
    expect(options.toolApproval).toBe(TOOL_APPROVAL);
    expect(Object.keys(options.tools).sort()).toEqual(
      Object.keys(TOOL_APPROVAL).sort(),
    );
    // The UI stream conversion receives the same tool set.
    expect(run.tools).toBe(options.tools);
  });

  it("passes the system prompt as instructions, never as a message", async () => {
    const { options } = await startRun({ planMode: true });
    expect(options.instructions).toEqual([
      expect.objectContaining({ role: "system" }),
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("PLAN MODE"),
      }),
    ]);
    expect(options).toMatchObject({ allowSystemInMessages: false });
  });

  it("reports per-step usage and the final status through the v7 callbacks", async () => {
    const onUsage = vi.fn();
    const onStep = vi.fn();
    const onFinishMeta = vi.fn();
    const { options } = await startRun({ onUsage, onStep, onFinishMeta });

    options.onStepEnd({
      toolCalls: [{ toolName: "read_file", input: { path: "/w/src/a.ts" } }],
      text: "",
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        inputTokenDetails: { cacheReadTokens: 100 },
      },
    });
    expect(onStep).toHaveBeenLastCalledWith("Reading a.ts");
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: 100,
      lastInputTokens: 120,
      lastCachedTokens: 100,
    });

    options.onEnd({ finishReason: "stop" });
    expect(onStep).toHaveBeenLastCalledWith(null);
    expect(onFinishMeta).toHaveBeenCalledWith({
      hitStepCap: false,
      finishReason: "stop",
    });
  });

  it("flags a run that used every allowed step", async () => {
    const onFinishMeta = vi.fn();
    const { options } = await startRun({ onFinishMeta });
    for (let i = 0; i < MAX_AGENT_STEPS; i++) {
      options.onStepEnd({ toolCalls: [], text: "" });
    }
    options.onEnd({ finishReason: "tool-calls" });
    expect(onFinishMeta).toHaveBeenCalledWith({
      hitStepCap: true,
      finishReason: "tool-calls",
    });
  });
});
