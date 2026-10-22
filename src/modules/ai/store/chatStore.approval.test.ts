import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "@/modules/ai/lib/sessions";

const prefs = vi.hoisted(() => ({
  aiApprovalMode: "ask" as string,
  init: vi.fn(async () => {}),
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: { getState: () => prefs },
}));

const sessions = vi.hoisted(() => {
  let next = 0;
  return {
    loadAll: vi.fn(async () => ({
      sessions: [] as SessionMeta[],
      activeId: null,
      activeElsewhere: new Set<string>(),
    })),
    onSessionsChanged: vi.fn(async () => () => {}),
    newSessionId: vi.fn(() => `s-${++next}`),
    saveSessionsList: vi.fn(async (_list: SessionMeta[]) => {}),
    saveActiveId: vi.fn(async () => {}),
  };
});
vi.mock("@/modules/ai/lib/sessions", () => ({
  ...sessions,
  deleteSessionData: vi.fn(),
  deriveTitle: vi.fn(),
  loadMessages: vi.fn(),
  saveMessages: vi.fn(),
}));

import { sessionApprovalMode, useChatStore } from "./chatStore";

const meta = (id: string, title: string, approvalMode?: unknown): SessionMeta =>
  ({
    id,
    title,
    createdAt: 1,
    updatedAt: 2,
    ...(approvalMode === undefined ? {} : { approvalMode }),
  }) as SessionMeta;

function mode(id: string) {
  const state = useChatStore.getState();
  return sessionApprovalMode(state.sessions, id);
}

beforeEach(() => {
  prefs.aiApprovalMode = "ask";
  prefs.init.mockClear();
  sessions.saveSessionsList.mockClear();
  useChatStore.setState({
    sessions: [],
    activeSessionId: null,
    sessionsHydrated: false,
  });
});

describe("conversation approval modes", () => {
  it("asks for a conversation from before modes, or with a damaged mode", () => {
    const list = [meta("old", "Work"), meta("bad", "Bad", "yolo")];
    expect(sessionApprovalMode(list, "old")).toBe("ask");
    expect(sessionApprovalMode(list, "bad")).toBe("ask");
    expect(sessionApprovalMode(list, "missing")).toBe("ask");
    expect(sessionApprovalMode(list, null)).toBe("ask");
    expect(sessionApprovalMode([meta("a", "A", "auto")], "a")).toBe("auto");
  });

  it("starts new conversations in the Settings default", () => {
    const asked = useChatStore.getState().newSession();
    expect(mode(asked)).toBe("ask");
    prefs.aiApprovalMode = "auto";
    const auto = useChatStore.getState().newSession();
    expect(mode(auto)).toBe("auto");
    // Changing the default does not touch a conversation already started.
    expect(mode(asked)).toBe("ask");
  });

  it("waits for the preferences before seeding the startup conversation", async () => {
    let release = () => {};
    prefs.init.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            prefs.aiApprovalMode = "auto";
            resolve();
          };
        }),
    );
    const hydrated = useChatStore.getState().hydrateSessions();
    await Promise.resolve();
    release();
    await hydrated;
    const id = useChatStore.getState().activeSessionId;
    expect(id).not.toBeNull();
    expect(mode(id ?? "")).toBe("auto");
  });

  it("seeds a reused empty conversation with today's default", async () => {
    prefs.aiApprovalMode = "auto";
    sessions.loadAll.mockResolvedValueOnce({
      sessions: [meta("new-1", "New chat", "ask"), meta("w", "Work")],
      activeId: null,
      activeElsewhere: new Set<string>(),
    });
    await useChatStore.getState().hydrateSessions();
    expect(useChatStore.getState().activeSessionId).toBe("new-1");
    expect(mode("new-1")).toBe("auto");
    expect(mode("w")).toBe("ask");
    expect(sessions.saveSessionsList).toHaveBeenCalledOnce();
  });

  it("switches one conversation without moving it in history", () => {
    useChatStore.setState({
      sessions: [meta("a", "A"), meta("b", "B")],
      activeSessionId: "a",
    });
    useChatStore.getState().setSessionApprovalMode("a", "auto");
    expect(mode("a")).toBe("auto");
    expect(mode("b")).toBe("ask");
    const a = useChatStore.getState().sessions.find((s) => s.id === "a");
    expect(a?.updatedAt).toBe(2);
    expect(sessions.saveSessionsList).toHaveBeenLastCalledWith(
      useChatStore.getState().sessions,
    );

    // Turning it off again is one call, and a repeat writes nothing.
    useChatStore.getState().setSessionApprovalMode("a", "ask");
    expect(mode("a")).toBe("ask");
    sessions.saveSessionsList.mockClear();
    useChatStore.getState().setSessionApprovalMode("a", "ask");
    expect(sessions.saveSessionsList).not.toHaveBeenCalled();
  });
});
