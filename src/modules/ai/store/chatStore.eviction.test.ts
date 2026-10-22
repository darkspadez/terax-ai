import type { Chat, UIMessage } from "@ai-sdk/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/modules/ai/lib/sessions", () => ({
  loadAll: vi.fn(),
  newSessionId: vi.fn(() => "s-new"),
  saveSessionsList: vi.fn(async () => {}),
  saveActiveId: vi.fn(async () => {}),
  onSessionsChanged: vi.fn(async () => () => {}),
  loadMessages: vi.fn(async () => null),
  deleteSessionData: vi.fn(),
  deriveTitle: vi.fn(),
  saveMessages: vi.fn(),
}));

import { chats, touchChat, useChatStore } from "./chatStore";

function fakeChat(status: "ready" | "submitted" | "streaming" = "ready") {
  return {
    status,
    stop: vi.fn(async () => {}),
  } as unknown as Chat<UIMessage> & {
    stop: ReturnType<typeof vi.fn>;
  };
}

describe("chat eviction", () => {
  beforeEach(() => {
    chats.clear();
    useChatStore.setState({ activeSessionId: null });
  });

  it("never evicts a background chat while it is answering", () => {
    const streaming = fakeChat("streaming");
    const submitted = fakeChat("submitted");
    touchChat("streaming", streaming);
    touchChat("submitted", submitted);
    const idle: ReturnType<typeof fakeChat>[] = [];
    for (let i = 0; i < 7; i++) {
      const chat = fakeChat();
      idle.push(chat);
      touchChat(`idle-${i}`, chat);
    }

    // Over the cap by one: the oldest idle chat goes, the running ones stay.
    expect(chats.has("streaming")).toBe(true);
    expect(chats.has("submitted")).toBe(true);
    expect(streaming.stop).not.toHaveBeenCalled();
    expect(submitted.stop).not.toHaveBeenCalled();
    expect(chats.has("idle-0")).toBe(false);
    expect(idle[0].stop).toHaveBeenCalledOnce();
    expect(chats.size).toBe(8);
  });

  it("evicts a chat once it has finished answering", () => {
    const chat = fakeChat("streaming");
    touchChat("was-streaming", chat);
    for (let i = 0; i < 7; i++) touchChat(`idle-${i}`, fakeChat());
    (chat as { status: string }).status = "ready";

    touchChat("one-more", fakeChat());

    expect(chats.has("was-streaming")).toBe(false);
    expect(chat.stop).toHaveBeenCalledOnce();
  });
});
