import { expect, it, vi } from "vitest";
import type { SessionMeta } from "@/modules/ai/lib/sessions";
import { useChatStore } from "@/modules/ai/store/chatStore";

const sessions = vi.hoisted(() => ({
  loadAll: vi.fn(async () => ({
    sessions: [] as SessionMeta[],
    activeId: null,
    activeElsewhere: new Set<string>(),
  })),
  onSessionsChanged: vi.fn(async () => () => {}),
  newSessionId: vi.fn(() => "s-new"),
  saveSessionsList: vi.fn(async () => {}),
  saveActiveId: vi.fn(async () => {}),
}));
vi.mock("@/modules/ai/lib/sessions", () => ({
  ...sessions,
  deleteSessionData: vi.fn(),
  deriveTitle: vi.fn(),
  loadMessages: vi.fn(),
  saveMessages: vi.fn(),
}));

it("creates one initial conversation when startup hydration overlaps", async () => {
  await Promise.all([
    useChatStore.getState().hydrateSessions(),
    useChatStore.getState().hydrateSessions(),
  ]);
  expect(sessions.newSessionId).toHaveBeenCalledOnce();
  expect(sessions.saveSessionsList).toHaveBeenCalledOnce();
  expect(sessions.saveActiveId).toHaveBeenCalledOnce();
  expect(useChatStore.getState()).toMatchObject({
    sessionsHydrated: true,
    activeSessionId: "s-new",
  });
});

const meta = (id: string, title: string): SessionMeta => ({
  id,
  title,
  createdAt: 1,
  updatedAt: 2,
});

it("reopens the newest untitled conversation instead of stacking another", async () => {
  useChatStore.setState({ sessions: [], sessionsHydrated: false });
  sessions.newSessionId.mockClear();
  sessions.saveSessionsList.mockClear();
  sessions.loadAll.mockResolvedValueOnce({
    sessions: [meta("old-1", "New chat"), meta("old-2", "Real work")],
    activeId: null,
    activeElsewhere: new Set<string>(),
  });

  await useChatStore.getState().hydrateSessions();

  expect(sessions.newSessionId).not.toHaveBeenCalled();
  expect(sessions.saveSessionsList).not.toHaveBeenCalled();
  expect(useChatStore.getState().activeSessionId).toBe("old-1");
  expect(useChatStore.getState().sessions.map((s) => s.id)).toEqual([
    "old-1",
    "old-2",
  ]);
});

it("prepends a fresh conversation when the newest one has a title", async () => {
  useChatStore.setState({ sessions: [], sessionsHydrated: false });
  sessions.loadAll.mockResolvedValueOnce({
    sessions: [meta("old-1", "Real work")],
    activeId: null,
    activeElsewhere: new Set<string>(),
  });

  await useChatStore.getState().hydrateSessions();

  expect(useChatStore.getState().activeSessionId).toBe("s-new");
  expect(useChatStore.getState().sessions.map((s) => s.title)).toEqual([
    "New chat",
    "Real work",
  ]);
});
