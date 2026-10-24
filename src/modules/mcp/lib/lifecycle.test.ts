import { describe, expect, it } from "vitest";
import { launchKey, type McpServerConfig } from "./config";
import {
  afterCrash,
  CRASH_WINDOW_MS,
  MAX_CRASHES,
  planConfigChange,
  RESTART_DELAYS_MS,
  START_WAIT_MS,
  startWaitDeadline,
} from "./lifecycle";

function server(id: string, overrides: Partial<McpServerConfig> = {}) {
  return {
    id,
    name: id,
    source: "settings",
    enabled: true,
    trusted: false,
    tools: {},
    secretsRevision: 0,
    transport: {
      type: "stdio",
      command: "npx",
      args: [id],
      env: [],
      cwd: null,
    },
    ...overrides,
  } satisfies McpServerConfig;
}

describe("afterCrash", () => {
  it("restarts with growing waits, then gives up", () => {
    let crashes: number[] = [];
    const delays: (number | null)[] = [];
    for (let i = 0; i <= MAX_CRASHES; i++) {
      const next = afterCrash(crashes, 1_000 + i);
      crashes = next.crashes;
      delays.push(next.delayMs);
    }
    expect(delays).toEqual([...RESTART_DELAYS_MS, null]);
  });

  it("forgets crashes older than the window", () => {
    const old = Array.from({ length: MAX_CRASHES }, (_, i) => i);
    const next = afterCrash(old, CRASH_WINDOW_MS + 10);
    expect(next.crashes).toEqual([CRASH_WINDOW_MS + 10]);
    expect(next.delayMs).toBe(RESTART_DELAYS_MS[0]);
  });
});

describe("planConfigChange", () => {
  it("starts new servers and stops disabled or removed ones", () => {
    const running = new Map([
      ["kept", launchKey(server("kept"))],
      ["off", launchKey(server("off"))],
      ["gone", launchKey(server("gone"))],
    ]);
    const plans = planConfigChange(running, [
      server("kept"),
      server("off", { enabled: false }),
      server("new"),
    ]);
    expect(
      plans.map((p) => `${p.kind}:${"id" in p ? p.id : p.server.id}`).sort(),
    ).toEqual(["start:new", "stop:gone", "stop:off", "update:kept"]);
  });

  it("restarts on a launch change and only updates on trust or tool choices", () => {
    const base = server("a");
    const running = new Map([["a", launchKey(base)]]);
    expect(
      planConfigChange(running, [
        { ...base, trusted: true, tools: { x: "deny" } },
      ])[0].kind,
    ).toBe("update");
    expect(
      planConfigChange(running, [{ ...base, secretsRevision: 1 }])[0].kind,
    ).toBe("restart");
    expect(
      planConfigChange(running, [
        server("a", {
          transport: {
            type: "http",
            url: "https://x.test/mcp",
            headers: [],
          },
        }),
      ])[0].kind,
    ).toBe("restart");
  });
});

describe("startWaitDeadline", () => {
  it("waits for the slowest server still within its start window", () => {
    expect(startWaitDeadline([], 0)).toBe(null);
    expect(
      startWaitDeadline([{ startedAt: 1000 }, { startedAt: 3000 }], 4000),
    ).toBe(3000 + START_WAIT_MS);
    expect(startWaitDeadline([{ startedAt: 0 }], START_WAIT_MS + 1)).toBe(null);
  });
});
