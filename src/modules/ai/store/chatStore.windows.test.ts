import { expect, it, vi } from "vitest";
import { useChatStore } from "@/modules/ai/store/chatStore";

const chat = (id: string, title = "New chat") => ({
  id,
  title,
  createdAt: 1,
  updatedAt: 1,
});

const sessions = vi.hoisted(() => ({
  loadAll: vi.fn(),
  newSessionId: vi.fn(() => "s-new"),
  saveSessionsList: vi.fn(async () => {}),
  saveActiveId: vi.fn(async () => {}),
  onSessionsChanged: vi.fn(async () => () => {}),
  loadMessages: vi.fn(async () => null),
}));
vi.mock("@/modules/ai/lib/sessions", () => ({
  ...sessions,
  deleteSessionData: vi.fn(),
  deriveTitle: vi.fn(),
  saveMessages: vi.fn(),
}));

it("leaves another window's new chat to it and follows the shared list", async () => {
  sessions.loadAll.mockResolvedValue({
    sessions: [chat("s-1"), chat("s-2", "Old")],
    activeId: null,
    // The other window has the untitled chat open.
    activeElsewhere: new Set(["s-1"]),
  });
  await useChatStore.getState().hydrateSessions();
  expect(useChatStore.getState().activeSessionId).toBe("s-new");
  expect(sessions.onSessionsChanged).toHaveBeenCalledOnce();

  // Another window renamed a chat: the list follows, the open chat stays.
  const renamed = [chat("s-new"), chat("s-1", "Renamed"), chat("s-2", "Old")];
  useChatStore.getState().adoptSessionsList(renamed);
  expect(useChatStore.getState().sessions).toEqual(renamed);
  expect(useChatStore.getState().activeSessionId).toBe("s-new");

  // Another window deleted the chat open here: this window moves on.
  useChatStore.getState().adoptSessionsList([chat("s-2", "Old")]);
  await vi.waitFor(() =>
    expect(useChatStore.getState().activeSessionId).toBe("s-2"),
  );
});
