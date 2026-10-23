import type { UIMessage } from "@ai-sdk/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A run reports its step, compaction, step cap, usage and errors to the
// conversation it belongs to; the user may open another while it answers.

type Deps = {
  toolContext: { getSessionId: () => string | null };
  onStep: (step: string | null) => void;
  onCompact: (info: { droppedCount: number }) => void;
  onFinishMeta: (info: { hitStepCap: boolean; finishReason: string }) => void;
  onUsage: (delta: {
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    lastInputTokens: number;
    lastCachedTokens: number;
  }) => void;
};

const transports = vi.hoisted(() => ({
  deps: new Map<string, Deps>(),
  /** Settles a run's request: it fails with the given error. */
  failRun: null as ((error: Error) => void) | null,
}));

vi.mock("../lib/transport", () => ({
  createContextAwareTransport: (deps: Deps) => {
    transports.deps.set(deps.toolContext.getSessionId() ?? "", deps);
    return {
      sendMessages: () =>
        new Promise((_, reject) => {
          transports.failRun = reject;
        }),
      reconnectToStream: async () => null,
    };
  },
}));
vi.mock("../lib/native", () => ({ native: {} }));
vi.mock("../lib/modelPrefs", () => ({ pushRecentModel: vi.fn() }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
  workspaceScopeKey: () => "local",
}));

import * as sessions from "../lib/sessions";
import { ZERO_USAGE } from "../lib/usage";
import { getOrCreateChat, sendUserMessage } from "./chatRuntime";
import { chats, seedMessages, useChatStore } from "./chatStore";

function depsOf(sessionId: string): Deps {
  getOrCreateChat(sessionId);
  const deps = transports.deps.get(sessionId);
  if (!deps) throw new Error(`no transport for ${sessionId}`);
  return deps;
}

/** Opens a conversation as the history list does. */
function open(id: string) {
  if (!chats.has(id)) seedMessages.set(id, [] as UIMessage[]);
  useChatStore.getState().switchSession(id);
  expect(useChatStore.getState().activeSessionId).toBe(id);
}

/** Everything a run of another conversation must leave as it is. */
function runState() {
  const { tokensByModel, approvalsPending, ...meta } =
    useChatStore.getState().agentMeta;
  return { ...meta, models: tokensByModel.size };
}

const UNTOUCHED = {
  status: "idle",
  step: null,
  error: null,
  tokens: ZERO_USAGE,
  lastInputTokens: 0,
  lastCachedTokens: 0,
  hitStepCap: false,
  compactionNotice: null,
  models: 0,
};

const usage = {
  modelId: "gpt-5.4-mini",
  inputTokens: 1_000,
  outputTokens: 50,
  cachedInputTokens: 800,
  lastInputTokens: 1_000,
  lastCachedTokens: 800,
};

beforeEach(() => {
  vi.spyOn(sessions, "saveActiveId").mockResolvedValue(undefined);
  vi.spyOn(sessions, "loadMessages").mockResolvedValue([]);
  chats.clear();
  seedMessages.clear();
  transports.deps.clear();
  transports.failRun = null;
  useChatStore.setState({
    sessions: ["s-a", "s-b"].map((id) => ({
      id,
      title: id,
      createdAt: 1,
      updatedAt: 1,
    })),
    activeSessionId: "s-a",
    sessionsHydrated: true,
  });
  useChatStore.getState().resetAgentMeta();
});

describe("a run of the open conversation", () => {
  it("shows its step, compaction notice and step cap", () => {
    const a = depsOf("s-a");
    a.onStep("Reading a.ts");
    a.onCompact({ droppedCount: 4 });
    a.onFinishMeta({ hitStepCap: true, finishReason: "tool-calls" });
    a.onUsage(usage);

    const meta = useChatStore.getState().agentMeta;
    expect(meta.step).toBe("Reading a.ts");
    expect(meta.compactionNotice?.droppedCount).toBe(4);
    expect(meta.hitStepCap).toBe(true);
    expect(meta.tokens.inputTokens).toBe(1_000);
    expect(meta.lastInputTokens).toBe(1_000);
  });

  it("shows its error", async () => {
    const sent = sendUserMessage(getOrCreateChat("s-a"), { text: "hi" });
    await vi.waitFor(() => expect(transports.failRun).not.toBeNull());
    transports.failRun?.(new Error("quota exceeded"));
    await sent;

    expect(useChatStore.getState().agentMeta).toMatchObject({
      status: "error",
      error: "quota exceeded",
    });
  });
});

describe("a run still answering after the user opens another conversation", () => {
  it("changes nothing in the conversation now open", () => {
    const a = depsOf("s-a");
    a.onStep("Reading a.ts");
    a.onCompact({ droppedCount: 4 });

    open("s-b");
    expect(runState()).toEqual(UNTOUCHED);

    a.onStep("Writing");
    a.onCompact({ droppedCount: 9 });
    a.onUsage(usage);
    a.onFinishMeta({ hitStepCap: true, finishReason: "tool-calls" });
    a.onStep(null);
    expect(runState()).toEqual(UNTOUCHED);

    // The open conversation's own run still reports.
    depsOf("s-b").onStep("Grepping");
    expect(useChatStore.getState().agentMeta.step).toBe("Grepping");
  });

  it("keeps its error out of the conversation now open", async () => {
    const sent = sendUserMessage(getOrCreateChat("s-a"), { text: "hi" });
    await vi.waitFor(() => expect(transports.failRun).not.toBeNull());

    open("s-b");
    transports.failRun?.(new Error("quota exceeded"));
    await sent;

    expect(runState()).toEqual(UNTOUCHED);
    // Its own chat still holds the error, which shows when it is opened.
    expect(getOrCreateChat("s-a").status).toBe("error");
  });

  it("leaves nothing behind when its conversation is opened again", () => {
    const a = depsOf("s-a");
    open("s-b");
    a.onCompact({ droppedCount: 9 });
    a.onFinishMeta({ hitStepCap: true, finishReason: "tool-calls" });

    // The store keeps no run state per conversation: opening one starts it
    // again, and the background run's notice and step cap are not kept.
    open("s-a");
    expect(runState()).toEqual(UNTOUCHED);
    a.onStep("Writing");
    expect(useChatStore.getState().agentMeta.step).toBe("Writing");
  });
});
