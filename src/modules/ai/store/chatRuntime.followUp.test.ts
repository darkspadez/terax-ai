import { Chat } from "@ai-sdk/react";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/native", () => ({ native: {} }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
  workspaceScopeKey: () => "local",
}));

import { SUPERSEDED_APPROVAL_REASON } from "../lib/toolApprovals";
import { getOrCreateChat, sendMessage, sendUserMessage } from "./chatRuntime";
import { useChatStore } from "./chatStore";

function recordingChat(messages: UIMessage[]) {
  const sent: UIMessage[][] = [];
  const transport: ChatTransport<UIMessage> = {
    sendMessages: async ({ messages }) => {
      sent.push(messages);
      return new ReadableStream<UIMessageChunk>({
        start(c) {
          c.close();
        },
      });
    },
    reconnectToStream: async () => null,
  };
  return { chat: new Chat<UIMessage>({ transport, messages }), sent };
}

describe("sendUserMessage", () => {
  it("settles a waiting approval as denied before the follow-up is sent", async () => {
    const waiting: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-bash_run",
          toolCallId: "call_1",
          state: "approval-requested",
          input: { command: "rm -rf build" },
          approval: { id: "appr_1" },
        },
      ],
    };
    const { chat, sent } = recordingChat([
      { id: "u1", role: "user", parts: [{ type: "text", text: "clean" }] },
      waiting,
    ]);

    await sendUserMessage(chat, { text: "never mind" });

    expect(sent).toHaveLength(1);
    expect(sent[0].map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(sent[0][1].parts[0]).toMatchObject({
      state: "output-denied",
      approval: {
        id: "appr_1",
        approved: false,
        reason: SUPERSEDED_APPROVAL_REASON,
      },
    });
    // The chat state holds the settled message (so it is persisted and the
    // card re-renders), not the original object rewritten in place.
    expect(chat.messages[1]).not.toBe(waiting);
    expect(chat.messages[1].parts[0]).toMatchObject({ state: "output-denied" });
    expect(waiting.parts[0]).toMatchObject({ state: "approval-requested" });
  });
});

describe("sendMessage", () => {
  it("sends Continue when the selected model is a custom endpoint", async () => {
    useChatStore.setState({
      activeSessionId: "continue-session",
      selectedModelId: "compat-ab12cd34",
    });
    await expect(sendMessage("Continue from where you stopped.")).resolves.toBe(
      true,
    );
    expect(getOrCreateChat("continue-session").messages[0]).toMatchObject({
      role: "user",
      parts: [{ type: "text", text: "Continue from where you stopped." }],
    });
  });
});
