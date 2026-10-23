import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  servers: [] as { enabled: boolean }[],
  runtimeLoaded: false,
  tools: {} as Record<string, unknown>,
  fail: false,
}));

vi.mock("./lib/configStore", () => ({
  loadWindowServers: async () => state.servers,
}));
vi.mock("./runtime", () => {
  state.runtimeLoaded = true;
  return {
    toolsForRun: async () => {
      if (state.fail) throw new Error("boom");
      return { tools: state.tools, access: {}, instructions: [] };
    },
  };
});

import { mcpToolsForRun } from "./index";

beforeEach(() => {
  state.tools = {};
  state.fail = false;
});

describe("mcpToolsForRun", () => {
  it("loads nothing of the MCP client while no server is enabled", async () => {
    state.servers = [{ enabled: false }];
    expect(await mcpToolsForRun()).toBe(null);
    expect(state.runtimeLoaded).toBe(false);
  });

  it("loads the client once a server is enabled and returns its tools", async () => {
    state.servers = [{ enabled: true }];
    state.tools = { mcp__a__b: {} };
    expect(await mcpToolsForRun()).toEqual({
      tools: { mcp__a__b: {} },
      access: {},
      instructions: [],
    });
    expect(state.runtimeLoaded).toBe(true);
  });

  it("gives a run no MCP tools rather than failing it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    state.servers = [{ enabled: true }];
    state.fail = true;
    expect(await mcpToolsForRun()).toBe(null);
    state.fail = false;
    expect(await mcpToolsForRun()).toBe(null);
  });
});
