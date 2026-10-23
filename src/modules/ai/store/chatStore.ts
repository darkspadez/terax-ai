import type { Chat, UIMessage } from "@ai-sdk/react";
import { toast } from "sonner";
import { create } from "zustand";
import { DEFAULT_MODEL_ID, type ProviderId } from "../config";
import { useTodosStore } from "./todoStore";
import {
  addUsage,
  type TokenUsage,
  type UsageMeter,
  ZERO_USAGE,
} from "../lib/usage";
import { EMPTY_PROVIDER_KEYS, type ProviderKeys, type CustomEndpointKeys } from "../lib/keyring";
import {
  deleteSessionData,
  deriveTitle,
  loadAll,
  loadMessages,
  newSessionId,
  onSessionsChanged,
  saveActiveId,
  saveMessages,
  saveSessionsList,
  type SessionMeta,
} from "../lib/sessions";
import { pushRecentModel } from "../lib/modelPrefs";
import { persistDelay } from "../lib/persistSchedule";
import { type ApprovalMode, normalizeApprovalMode } from "../lib/approvalMode";
import { usePreferencesStore } from "@/modules/settings/preferences";

export type Live = {
  getCwd: () => string | null;
  getTerminalContext: () => string | null;
  isActiveTerminalPrivate: () => boolean;
  injectIntoActivePty: (text: string) => boolean;
  getWorkspaceRoot: () => string | null;
  getActiveFile: () => string | null;
  openPreview: (url: string) => boolean;
  spawnManagedAgent: (
    prompt: string,
    sessionId: string,
  ) => { tabId: number; leafId: number } | null;
  readLeafBuffer: (leafId: number) => string | null;
};

export type AgentRunStatus =
  | "idle"
  | "thinking"
  | "streaming"
  | "awaiting-approval"
  | "error";

export type AgentMeta = {
  status: AgentRunStatus;
  step: string | null;
  approvalsPending: number;
  error: string | null;
  tokens: TokenUsage;
  /** The same tokens by the model that used them, for the cost. */
  tokensByModel: UsageMeter["tokensByModel"];
  lastInputTokens: number;
  lastCachedTokens: number;
  hitStepCap: boolean;
  compactionNotice: { droppedCount: number; at: number } | null;
};

const IDLE_META: AgentMeta = {
  status: "idle",
  step: null,
  approvalsPending: 0,
  error: null,
  tokens: ZERO_USAGE,
  tokensByModel: new Map(),
  lastInputTokens: 0,
  lastCachedTokens: 0,
  hitStepCap: false,
  compactionNotice: null,
};

type MiniState = {
  open: boolean;
};

type PendingSelection = {
  id: string;
  text: string;
  source: "terminal" | "editor";
};

type ApprovalResponder = (
  approvalId: string,
  approved: boolean,
) => void;

type StoreState = {
  live: Live;
  setLive: (live: Live) => void;

  /**
   * Set by AgentRunBridge each render. Lets surfaces outside the chat hook
   * tree (e.g. the AI diff tab in the editor area) resolve a pending tool
   * approval through the active session's `addToolApprovalResponse`.
   */
  approvalResponder: ApprovalResponder | null;
  setApprovalResponder: (fn: ApprovalResponder | null) => void;
  respondToApproval: (approvalId: string, approved: boolean) => void;

  apiKeys: ProviderKeys;
  setApiKeys: (keys: ProviderKeys) => void;
  setApiKey: (provider: ProviderId, key: string | null) => void;

  customEndpointKeys: CustomEndpointKeys;
  setCustomEndpointKeys: (keys: CustomEndpointKeys) => void;

  selectedModelId: string;
  setSelectedModelId: (id: string) => void;

  mini: MiniState;
  openMini: () => void;
  closeMini: () => void;
  toggleMini: () => void;

  panelOpen: boolean;
  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;

  focusSignal: number;
  pendingPrefill: string | null;
  focusInput: (prefill?: string | null) => void;
  consumePrefill: () => string | null;

  pendingSelections: PendingSelection[];
  attachSelection: (text: string, source: "terminal" | "editor") => void;
  consumeSelections: () => PendingSelection[];

  agentMeta: AgentMeta;
  patchAgentMeta: (patch: Partial<AgentMeta>) => void;
  resetAgentMeta: () => void;

  // Sessions
  sessionsHydrated: boolean;
  sessions: SessionMeta[];
  activeSessionId: string | null;
  hydrateSessions: () => Promise<void>;
  /** The shared history list as another window changed it. */
  adoptSessionsList: (list: SessionMeta[]) => void;
  newSession: () => string;
  switchSession: (id: string) => void;
  deleteSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  /** Chooses whether this conversation's gated tools ask or run unasked. */
  setSessionApprovalMode: (id: string, mode: ApprovalMode) => void;
  /** Persist messages of a session and bump its updatedAt + auto-title. */
  persistMessages: (id: string, messages: UIMessage[]) => void;
};

const NOOP_LIVE: Live = {
  getCwd: () => null,
  getTerminalContext: () => null,
  isActiveTerminalPrivate: () => false,
  injectIntoActivePty: () => false,
  getWorkspaceRoot: () => null,
  getActiveFile: () => null,
  openPreview: () => false,
  spawnManagedAgent: () => null,
  readLeafBuffer: () => null,
};

/** New conversations start in the Settings default (Ask unless changed). */
function defaultApprovalMode(): ApprovalMode {
  return normalizeApprovalMode(usePreferencesStore.getState().aiApprovalMode);
}

function newSessionMeta(id: string): SessionMeta {
  const now = Date.now();
  return {
    id,
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    approvalMode: defaultApprovalMode(),
  };
}

/** A conversation's approval mode; Ask for an unknown conversation. */
export function sessionApprovalMode(
  sessions: readonly SessionMeta[],
  id: string | null,
): ApprovalMode {
  if (id === null) return "ask";
  return normalizeApprovalMode(sessions.find((s) => s.id === id)?.approvalMode);
}

const CHATS_LRU_CAP = 8;
export const chats = new Map<string, Chat<UIMessage>>();

export function touchChat(id: string, c: Chat<UIMessage>) {
  if (chats.has(id)) chats.delete(id);
  chats.set(id, c);
  if (chats.size <= CHATS_LRU_CAP) return;
  // The touched and the active chat are kept even when they are the oldest,
  // and so is a background chat still answering (stopping it would cut its
  // reply off); eviction moves on to the next oldest instead of stopping.
  const activeId = useChatStore.getState().activeSessionId;
  for (const [key, chat] of chats) {
    if (chats.size <= CHATS_LRU_CAP) break;
    if (key === id || key === activeId || isRunning(chat)) continue;
    flushPersistEntry(key);
    void chat.stop();
    chats.delete(key);
  }
}

function isRunning(chat: Chat<UIMessage>): boolean {
  return chat.status === "submitted" || chat.status === "streaming";
}
// Initial messages for a session, populated at hydration time and consumed
// when the matching Chat is constructed.
export const seedMessages = new Map<string, UIMessage[]>();

// Per-token message persistence is scheduled, not debounced per token: see
// `persistSchedule.ts`. Streaming saves are plain atomic replaces; the flush
// functions below (turn end, switch, eviction, close) are durable.
const pendingPersist = new Map<
  string,
  { latest: UIMessage[]; timer: ReturnType<typeof setTimeout>; firstAt: number }
>();
const lastPersistedAt = new Map<string, number>();

function commitPersist(id: string, durable: boolean) {
  const entry = pendingPersist.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingPersist.delete(id);
  lastPersistedAt.set(id, Date.now());
  void saveMessages(id, entry.latest, { durable });
}

function schedulePersist(id: string, messages: UIMessage[]) {
  const now = Date.now();
  const existing = pendingPersist.get(id);
  if (existing) clearTimeout(existing.timer);
  const firstAt = existing?.firstAt ?? now;
  const timer = setTimeout(
    () => commitPersist(id, false),
    persistDelay(now, firstAt, lastPersistedAt.get(id) ?? null),
  );
  pendingPersist.set(id, { latest: messages, timer, firstAt });
}

function flushPersistEntry(id: string) {
  commitPersist(id, true);
}

export function flushPersist(id?: string): void {
  if (id) {
    flushPersistEntry(id);
    return;
  }
  for (const key of Array.from(pendingPersist.keys())) flushPersistEntry(key);
}

export const useChatStore = create<StoreState>((set, get) => ({
  live: NOOP_LIVE,
  setLive: (live) => set({ live }),

  approvalResponder: null,
  setApprovalResponder: (fn) => set({ approvalResponder: fn }),
  respondToApproval: (approvalId, approved) => {
    const fn = get().approvalResponder;
    if (fn) fn(approvalId, approved);
  },

  apiKeys: { ...EMPTY_PROVIDER_KEYS },
  setApiKeys: (keys) => set({ apiKeys: keys }),
  setApiKey: (provider, key) => {
    set({ apiKeys: { ...get().apiKeys, [provider]: key } });
  },

  customEndpointKeys: {},
  setCustomEndpointKeys: (keys) => set({ customEndpointKeys: keys }),

  selectedModelId: DEFAULT_MODEL_ID,
  setSelectedModelId: (id) => {
    set({ selectedModelId: id });
    void pushRecentModel(id);
  },

  mini: { open: false },
  openMini: () => set({ mini: { open: true } }),
  closeMini: () => set({ mini: { open: false } }),
  toggleMini: () => set((s) => ({ mini: { open: !s.mini.open } })),

  panelOpen: false,
  openPanel: () => set({ panelOpen: true }),
  closePanel: () => set({ panelOpen: false }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),

  focusSignal: 0,
  pendingPrefill: null,
  focusInput: (prefill = null) =>
    set((s) => ({
      panelOpen: true,
      focusSignal: s.focusSignal + 1,
      pendingPrefill: prefill ?? null,
    })),
  consumePrefill: () => {
    const v = get().pendingPrefill;
    if (v != null) set({ pendingPrefill: null });
    return v;
  },

  pendingSelections: [],
  attachSelection: (text, source) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const id = `sel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({
      panelOpen: true,
      focusSignal: s.focusSignal + 1,
      pendingSelections: [...s.pendingSelections, { id, text: trimmed, source }],
    }));
  },
  consumeSelections: () => {
    const v = get().pendingSelections;
    if (v.length > 0) set({ pendingSelections: [] });
    return v;
  },

  agentMeta: IDLE_META,
  patchAgentMeta: (patch) =>
    set((s) => ({ agentMeta: { ...s.agentMeta, ...patch } })),
  resetAgentMeta: () => set({ agentMeta: IDLE_META }),

  sessionsHydrated: false,
  sessions: [],
  activeSessionId: null,

  hydrateSessions: async () => {
    if (get().sessionsHydrated) return;
    // The new conversation below starts in the Settings default, so wait for
    // the preferences (loading in parallel at startup) rather than race them.
    const [{ sessions, activeElsewhere }] = await Promise.all([
      loadAll(),
      usePreferencesStore
        .getState()
        .init()
        .catch(() => {}),
    ]);
    if (get().sessionsHydrated) return;

    // Reuse the most recent untitled "New chat" session if one exists from
    // the previous run — no point stacking empty placeholder sessions every
    // launch — unless another window has it open. Otherwise prepend a fresh one.
    const reusable =
      sessions[0]?.title === "New chat" && !activeElsewhere?.has(sessions[0].id)
        ? sessions[0]
        : null;
    let nextSessions: SessionMeta[];
    let freshId: string;
    if (reusable) {
      // It is this launch's new conversation, so it takes today's default.
      const mode = defaultApprovalMode();
      nextSessions =
        normalizeApprovalMode(reusable.approvalMode) === mode
          ? sessions
          : sessions.map((s) =>
              s.id === reusable.id ? { ...s, approvalMode: mode } : s,
            );
      freshId = reusable.id;
      if (nextSessions !== sessions) void saveSessionsList(nextSessions);
    } else {
      freshId = newSessionId();
      nextSessions = [newSessionMeta(freshId), ...sessions];
      void saveSessionsList(nextSessions);
    }
    void saveActiveId(freshId);

    set({
      sessions: nextSessions,
      activeSessionId: freshId,
      sessionsHydrated: true,
    });
    // Other windows add, rename and delete chats in the shared list.
    void onSessionsChanged((list) => get().adoptSessionsList(list)).catch(
      () => {},
    );
  },

  adoptSessionsList: (list) => {
    const state = get();
    if (JSON.stringify(list) === JSON.stringify(state.sessions)) return;
    const active = state.activeSessionId;
    if (active === null || list.some((s) => s.id === active)) {
      set({ sessions: list });
      return;
    }
    // Another window deleted the chat open here.
    set({ sessions: list });
    if (list.length > 0) get().switchSession(list[0].id);
    else get().newSession();
  },

  newSession: () => {
    const id = newSessionId();
    const next = [newSessionMeta(id), ...get().sessions];
    set({ sessions: next, activeSessionId: id, agentMeta: IDLE_META });
    void saveSessionsList(next);
    void saveActiveId(id);
    return id;
  },

  switchSession: (id) => {
    if (get().activeSessionId === id) return;
    if (!get().sessions.some((s) => s.id === id)) return;

    // Lazily seed the chat with persisted messages the first time we open
    // this session. Subsequent switches reuse the cached Chat instance.
    const flip = () => {
      set({ activeSessionId: id, agentMeta: IDLE_META });
      void saveActiveId(id);
    };
    if (chats.has(id) || seedMessages.has(id)) {
      flip();
      return;
    }
    void loadMessages(id)
      .then((m) => {
        if (m && m.length > 0 && !chats.has(id)) seedMessages.set(id, m);
        flip();
      })
      .catch((error) => {
        // Stay on the current conversation: opening this one empty could later
        // overwrite a healthy file that was only momentarily unreadable.
        toast.error("Could not open conversation", {
          id: `conversation-open:${id}`,
          description: String(error),
        });
      });
  },

  deleteSession: (id) => {
    const remaining = get().sessions.filter((s) => s.id !== id);
    chats.get(id)?.stop();
    chats.delete(id);
    seedMessages.delete(id);
    const pend = pendingPersist.get(id);
    if (pend) {
      clearTimeout(pend.timer);
      pendingPersist.delete(id);
    }
    lastPersistedAt.delete(id);
    void deleteSessionData(id);
    void useTodosStore.getState().clearSession(id);

    if (remaining.length === 0) {
      const fresh = newSessionMeta(newSessionId());
      set({ sessions: [fresh], activeSessionId: fresh.id });
      void saveSessionsList([fresh]);
      void saveActiveId(fresh.id);
      return;
    }

    const wasActive = get().activeSessionId === id;
    const nextActive = wasActive ? remaining[0].id : get().activeSessionId;
    set({ sessions: remaining, activeSessionId: nextActive });
    void saveSessionsList(remaining);
    if (wasActive) void saveActiveId(nextActive);
  },

  renameSession: (id, title) => {
    const next = get().sessions.map((s) =>
      s.id === id ? { ...s, title, updatedAt: Date.now() } : s,
    );
    set({ sessions: next });
    void saveSessionsList(next);
  },

  setSessionApprovalMode: (id, mode) => {
    const sessions = get().sessions;
    const meta = sessions.find((s) => s.id === id);
    if (!meta || normalizeApprovalMode(meta.approvalMode) === mode) return;
    // Not a change to the conversation itself: its place in history stays.
    const next = sessions.map((s) =>
      s.id === id ? { ...s, approvalMode: mode } : s,
    );
    set({ sessions: next });
    void saveSessionsList(next);
  },

  persistMessages: (id, messages) => {
    // Streaming fires this per token; the write itself is scheduled.
    schedulePersist(id, messages);

    // Update zustand session list only when the derived title actually
    // changes — otherwise we'd rewrite the sessions array (and trigger
    // re-renders + a store write) on every token.
    const sessions = get().sessions;
    const meta = sessions.find((s) => s.id === id);
    if (!meta) return;
    const isUntitled = !meta.title || meta.title === "New chat";
    if (!isUntitled) return;
    const nextTitle = deriveTitle(messages);
    if (nextTitle === meta.title) return;
    const next = sessions.map((s) =>
      s.id === id ? { ...s, title: nextTitle, updatedAt: Date.now() } : s,
    );
    set({ sessions: next });
    void saveSessionsList(next);
  },
}));

/** The open conversation's approval mode. */
export function useActiveApprovalMode(): ApprovalMode {
  return useChatStore((s) =>
    sessionApprovalMode(s.sessions, s.activeSessionId),
  );
}

/**
 * Counts what `modelId` used for a conversation in its meter. The meter is
 * the open conversation's and starts again when another opens, so usage for
 * any other (a run still answering after a switch) is not counted. True when
 * it was counted.
 */
export function countConversationUsage(
  sessionId: string,
  modelId: string,
  usage: TokenUsage,
): boolean {
  const state = useChatStore.getState();
  if (state.activeSessionId !== sessionId) return false;
  state.patchAgentMeta(addUsage(state.agentMeta, modelId, usage));
  return true;
}

export function getChat(sessionId?: string): Chat<UIMessage> | undefined {
  if (sessionId) return chats.get(sessionId);
  const id = useChatStore.getState().activeSessionId;
  return id ? chats.get(id) : undefined;
}
