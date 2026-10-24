import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: { payload: unknown }) => void;
const native = vi.hoisted(() => ({
  listen: vi.fn(),
  emit: undefined as Handler | undefined,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: native.listen,
}));

async function load() {
  vi.resetModules();
  return import("./agentActivity");
}

beforeEach(() => {
  native.listen.mockReset();
  native.listen.mockImplementation(async (_event: string, cb: Handler) => {
    native.emit = cb;
    return () => undefined;
  });
});

describe("agent signal fan-out", () => {
  it("serves the store and every subscriber from one native listener", async () => {
    const mod = await load();
    const a = vi.fn();
    const b = vi.fn();
    mod.subscribeAgentSignals(a);
    mod.subscribeAgentSignals(b);
    await mod.ensureAgentActivityListener();

    expect(native.listen).toHaveBeenCalledTimes(1);
    expect(native.listen).toHaveBeenCalledWith(
      "oarlock:agent-signal",
      expect.any(Function),
    );

    native.emit?.({ payload: { id: 7, kind: "working", agent: "claude" } });
    expect(mod.useAgentActivityStore.getState().phases[7]).toBe("working");
    expect(a).toHaveBeenCalledWith({ id: 7, kind: "working", agent: "claude" });
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("runs subscribers after the store has applied the signal", async () => {
    const mod = await load();
    let seen: string | undefined;
    mod.subscribeAgentSignals((signal) => {
      seen = mod.useAgentActivityStore.getState().phases[signal.id];
    });
    await mod.ensureAgentActivityListener();
    native.emit?.({ payload: { id: 3, kind: "attention" } });
    expect(seen).toBe("attention");
  });

  it("stops delivering after unsubscribe and survives a throwing handler", async () => {
    const mod = await load();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const good = vi.fn();
    const off = mod.subscribeAgentSignals(good);
    mod.subscribeAgentSignals(() => {
      throw new Error("boom");
    });
    await mod.ensureAgentActivityListener();

    native.emit?.({ payload: { id: 1, kind: "started", agent: "codex" } });
    expect(good).toHaveBeenCalledTimes(1);
    expect(mod.useAgentActivityStore.getState().agents[1]).toBe("codex");

    off();
    native.emit?.({ payload: { id: 1, kind: "finished" } });
    expect(good).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("agent names from the terminal", () => {
  it("shows any name the terminal reports, known or not", async () => {
    const mod = await load();
    const seen = vi.fn();
    mod.subscribeAgentSignals(seen);
    await mod.ensureAgentActivityListener();

    native.emit?.({ payload: { id: 4, kind: "started", agent: "My Agent 9" } });
    expect(mod.useAgentActivityStore.getState().agents[4]).toBe("My Agent 9");
    expect(seen).toHaveBeenCalledWith({
      id: 4,
      kind: "started",
      agent: "My Agent 9",
    });
  });

  it("strips control and bidi characters before anything sees the name", async () => {
    const mod = await load();
    const seen = vi.fn();
    mod.subscribeAgentSignals(seen);
    await mod.ensureAgentActivityListener();

    native.emit?.({
      payload: { id: 5, kind: "started", agent: "\u202eev\u0007il\u2066" },
    });
    expect(mod.useAgentActivityStore.getState().agents[5]).toBe("evil");
    expect(seen.mock.calls[0][0].agent).toBe("evil");
  });

  it("sanitizes names into short plain text", async () => {
    const { sanitizeAgentName } = await load();
    expect(sanitizeAgentName("claude")).toBe("claude");
    expect(sanitizeAgentName("\u0000a\u001fb\u007fc\u0085d\u009be")).toBe(
      "abcde",
    );
    expect(
      sanitizeAgentName("a\u061cb\u200ec\u200fd\u202ae\u202bf\u202cg"),
    ).toBe("abcdefg");
    expect(sanitizeAgentName("x\u202dy\u2067z\u2068w\u2069")).toBe("xyzw");
    expect(sanitizeAgentName("line\u2028break\u2029")).toBe("linebreak");
    expect(sanitizeAgentName("  spaced  ")).toBe("spaced");
    expect(sanitizeAgentName("x".repeat(40))).toBe("x".repeat(32));
    // Capped by characters, so astral characters are never split.
    expect(
      Array.from(sanitizeAgentName("\u{1f600}".repeat(40)) ?? ""),
    ).toHaveLength(32);
  });

  it("drops names with nothing visible left", async () => {
    const { sanitizeAgentName } = await load();
    expect(sanitizeAgentName("")).toBeNull();
    expect(sanitizeAgentName(" \u202e\u0001 ")).toBeNull();
    expect(sanitizeAgentName(null)).toBeNull();
    expect(sanitizeAgentName(42)).toBeNull();
  });
});
