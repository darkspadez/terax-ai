import type { UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

const model = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => () => model.current,
}));
vi.mock("./native", () => ({ native: {} }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
  workspaceScopeKey: () => "local",
}));

import type { ToolContext } from "../tools/context";
import { runAgentStream } from "./agent";
import { EMPTY_PROVIDER_KEYS } from "./keyring";
import {
  denyUnansweredApprovals,
  pendingApprovalIds,
  SUPERSEDED_APPROVAL_REASON,
} from "./toolApprovals";

const user = (id: string, text = "hi"): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

const toolCall = (
  id: string,
  state: string,
  approval: Record<string, unknown> | undefined = { id: `appr_${id}` },
  extra: Record<string, unknown> = {},
) =>
  ({
    type: "tool-bash_run",
    toolCallId: id,
    state,
    input: { command: "journalctl -p err" },
    ...(approval ? { approval } : {}),
    ...extra,
  }) as unknown as UIMessage["parts"][number];

const assistant = (
  id: string,
  ...parts: UIMessage["parts"][number][]
): UIMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "step-start" }, ...parts],
});

describe("denyUnansweredApprovals", () => {
  it("denies waiting and approved-but-unrun calls in new message objects", () => {
    const waiting = assistant("a1", toolCall("call_1", "approval-requested"));
    const approved = assistant(
      "a2",
      { type: "text", text: "running" },
      toolCall("call_2", "approval-responded", {
        id: "appr_call_2",
        approved: true,
      }),
    );
    const messages = [user("u1"), waiting, user("u2"), approved];

    const settled = denyUnansweredApprovals(messages);

    expect(settled).not.toBe(messages);
    expect(settled[0]).toBe(messages[0]);
    expect(settled[1]).not.toBe(waiting);
    expect(settled[1].parts[1]).toEqual({
      type: "tool-bash_run",
      toolCallId: "call_1",
      state: "output-denied",
      input: { command: "journalctl -p err" },
      approval: {
        id: "appr_call_1",
        approved: false,
        reason: SUPERSEDED_APPROVAL_REASON,
      },
    });
    expect(settled[3].parts[1]).toEqual({ type: "text", text: "running" });
    expect(settled[3].parts[2]).toMatchObject({
      toolCallId: "call_2",
      state: "output-denied",
      approval: { id: "appr_call_2", approved: false },
    });
    // The chat's own objects are never mutated.
    expect(waiting.parts[1]).toMatchObject({ state: "approval-requested" });
    expect(approved.parts[2]).toMatchObject({ state: "approval-responded" });
  });

  it("leaves answered calls and malformed parts alone", () => {
    const messages = [
      user("u1"),
      assistant(
        "a1",
        toolCall(
          "c1",
          "output-available",
          { id: "x1", approved: true },
          {
            output: "ok",
          },
        ),
        toolCall("c2", "output-error", undefined, { errorText: "boom" }),
        toolCall("c3", "output-denied", { id: "x3", approved: false }),
        toolCall("c4", "approval-responded", { id: "x4", approved: false }),
        toolCall("c5", "approval-requested", {}),
        toolCall("", "approval-requested"),
      ),
    ];
    expect(denyUnansweredApprovals(messages)).toBe(messages);
  });
});

describe("pendingApprovalIds", () => {
  it("lists only the newest message's waiting approvals", () => {
    const messages = [
      user("u1"),
      assistant("a1", toolCall("stale", "approval-requested")),
      user("u2"),
      assistant(
        "a2",
        toolCall("c1", "approval-requested"),
        toolCall("c2", "output-available", undefined, { output: "" }),
        toolCall("c3", "approval-requested"),
      ),
    ];
    expect(pendingApprovalIds(messages)).toEqual(["appr_c1", "appr_c3"]);
    expect(pendingApprovalIds([...messages, user("u3")])).toEqual([]);
    expect(pendingApprovalIds(messages.slice(0, 3))).toEqual([]);
  });
});

describe("a follow-up after an unanswered approval", () => {
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

  let runs = 0;
  async function run(uiMessages: UIMessage[]) {
    const mock = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: "stream-start", warnings: [] });
            c.enqueue({ type: "text-start", id: "t" });
            c.enqueue({ type: "text-delta", id: "t", delta: "ok" });
            c.enqueue({ type: "text-end", id: "t" });
            c.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            });
            c.close();
          },
        }),
      }),
    });
    model.current = mock;
    // Built models are cached per key; a fresh key picks up this mock.
    runs++;
    const result = await runAgentStream({
      keys: { ...EMPTY_PROVIDER_KEYS, openai: `sk-test-${runs}` },
      modelId: "gpt-5.4-mini",
      toolContext,
      uiMessages,
    });
    const errors: unknown[] = [];
    const reader = result.stream.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const part = next.value as { type: string; error?: unknown };
      if (part.type === "error") errors.push(part.error);
    }
    return { errors, prompts: mock.doStreamCalls.map((c) => c.prompt) };
  }

  it("reaches the model once a call approved after the follow-up is settled", async () => {
    // The session upstream locked: a superseded card approved after a
    // follow-up has no result, and every later request failed.
    const locked = [
      user("u1", "check logs"),
      assistant(
        "a1",
        toolCall("call_1", "approval-responded", {
          id: "appr_1",
          approved: true,
        }),
      ),
      user("u2", "never mind"),
      assistant("a2", { type: "text", text: "ok" }),
    ];
    const { errors, prompts } = await run([
      ...denyUnansweredApprovals(locked),
      user("u3", "next"),
    ]);
    expect(errors).toEqual([]);
    expect(prompts).toHaveLength(1);
    expect(JSON.stringify(prompts[0])).toContain(SUPERSEDED_APPROVAL_REASON);
  });

  it("tells the model a superseded call did not run", async () => {
    const { errors, prompts } = await run([
      ...denyUnansweredApprovals([
        user("u1", "check logs"),
        assistant("a1", toolCall("call_1", "approval-requested")),
      ]),
      user("u2", "never mind"),
    ]);
    expect(errors).toEqual([]);
    const prompt = JSON.stringify(prompts[0]);
    expect(prompt).toContain("call_1");
    expect(prompt).toContain(SUPERSEDED_APPROVAL_REASON);
  });
});
