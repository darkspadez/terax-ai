import type { UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

const model = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => () => model.current,
}));
const native = vi.hoisted(() => ({
  writeFile: vi.fn(async () => {}),
  canonicalize: vi.fn(async (path: string) => path),
}));
vi.mock("./native", () => ({ native }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
  workspaceScopeKey: () => "local",
}));

import type { ToolContext } from "../tools/context";
import type { ApprovalState } from "../tools/tools";
import { runAgentStream } from "./agent";
import { normalizeApprovalMode } from "./approvalMode";
import { EMPTY_PROVIDER_KEYS } from "./keyring";

describe("normalizeApprovalMode", () => {
  it("auto-approves only when explicitly asked to", () => {
    expect(normalizeApprovalMode("auto")).toBe("auto");
    for (const value of ["ask", undefined, null, "AUTO", "yolo", 1, true]) {
      expect(normalizeApprovalMode(value)).toBe("ask");
    }
  });
});

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** A model that calls one tool, then answers in text. */
function callingModel(toolName: string, input: unknown) {
  let calls = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const first = calls++ === 0;
      return {
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: "stream-start", warnings: [] });
            if (first) {
              c.enqueue({
                type: "tool-call",
                toolCallId: "call_1",
                toolName,
                input: JSON.stringify(input),
              });
            } else {
              c.enqueue({ type: "text-start", id: "t" });
              c.enqueue({ type: "text-delta", id: "t", delta: "done" });
              c.enqueue({ type: "text-end", id: "t" });
            }
            c.enqueue({
              type: "finish",
              finishReason: first
                ? { unified: "tool-calls", raw: "tool_calls" }
                : { unified: "stop", raw: "stop" },
              usage,
            });
            c.close();
          },
        }),
      };
    },
  });
}

let runs = 0;
async function run(
  toolName: string,
  input: unknown,
  state: ApprovalState,
  spawnAgent: ToolContext["spawnAgent"] = () => null,
) {
  model.current = callingModel(toolName, input);
  // Built models are cached per key; a fresh key picks up this mock.
  runs++;
  const result = await runAgentStream({
    keys: { ...EMPTY_PROVIDER_KEYS, openai: `sk-approval-${runs}` },
    modelId: "gpt-5.4-mini",
    toolContext: {
      getCwd: () => "/workspace",
      getWorkspaceRoot: () => "/workspace",
      getTerminalContext: () => null,
      isActiveTerminalPrivate: () => false,
      injectIntoActivePty: () => false,
      openPreview: () => false,
      spawnAgent,
      readAgentOutput: () => null,
      readCache: new Map(),
      getSessionId: () => "session",
    },
    uiMessages: [
      { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
    ] satisfies UIMessage[],
    approvalState: () => state,
  });
  const parts: { type: string; output?: unknown }[] = [];
  const reader = result.stream.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    parts.push(next.value as { type: string; output?: unknown });
  }
  return {
    approvals: parts.filter((p) => p.type === "tool-approval-request"),
    outputs: parts
      .filter((p) => p.type === "tool-result")
      .map((p) => p.output as { error?: string }),
  };
}

const AUTO: ApprovalState = { mode: "auto", planMode: false };
const ASK: ApprovalState = { mode: "ask", planMode: false };

describe("Auto-approve in a real run", () => {
  it("runs a shell command without asking, and its deny-list still refuses", async () => {
    const { approvals, outputs } = await run(
      "bash_run",
      { command: "rm -rf /" },
      AUTO,
    );
    expect(approvals).toEqual([]);
    expect(outputs[0]?.error).toContain("filesystem root");
  });

  it("still refuses a write to a protected path", async () => {
    native.writeFile.mockClear();
    const { approvals, outputs } = await run(
      "write_file",
      { path: "/workspace/.env", content: "TOKEN=x" },
      AUTO,
    );
    expect(approvals).toEqual([]);
    expect(outputs[0]?.error).toMatch(/refused|blocked|protected|secret/i);
    expect(native.writeFile).not.toHaveBeenCalled();
  });

  it("writes an ordinary file without asking", async () => {
    native.writeFile.mockClear();
    const { approvals } = await run(
      "write_file",
      { path: "/workspace/notes.txt", content: "hi" },
      AUTO,
    );
    expect(approvals).toEqual([]);
    expect(native.writeFile).toHaveBeenCalledWith("/workspace/notes.txt", "hi");
  });

  it("still asks before launching a coding agent", async () => {
    const spawnAgent = vi.fn(() => ({ tabId: 1, leafId: 1 }));
    const { approvals, outputs } = await run(
      "spawn_coding_agent",
      { prompt: "fix the tests" },
      AUTO,
      spawnAgent,
    );
    expect(approvals).toHaveLength(1);
    expect(outputs).toEqual([]);
    expect(spawnAgent).not.toHaveBeenCalled();
  });

  it("asks in Ask mode", async () => {
    const { approvals, outputs } = await run(
      "bash_run",
      { command: "rm -rf /" },
      ASK,
    );
    expect(approvals).toHaveLength(1);
    expect(outputs).toEqual([]);
  });
});
