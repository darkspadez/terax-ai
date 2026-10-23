import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMcpExtras } from "./lib/extrasCatalog";

const state = vi.hoisted(() => ({
  servers: [] as { enabled: boolean }[],
  runtimeLoaded: false,
  prepared: 0,
  wait: false,
  fail: false,
  startingSeen: [] as boolean[],
}));

vi.mock("./lib/configStore", () => ({
  loadServers: async () => state.servers,
}));
vi.mock("./runtime", async () => {
  state.runtimeLoaded = true;
  const { useMcpExtras } = await import("./lib/extrasCatalog");
  return {
    prepareExtras: async (_servers: unknown, onWaiting: () => void) => {
      state.prepared += 1;
      if (state.fail) throw new Error("boom");
      if (state.wait) {
        onWaiting();
        state.startingSeen.push(useMcpExtras.getState().starting);
      }
    },
    extras: () => ({
      read: async (_id: string, uri: string) => ({ read: uri }),
      expand: (template: string, values: Record<string, string>) =>
        template.replace("{x}", values.x),
      getPrompt: async (_id: string, name: string) => ({ prompt: name }),
      complete: async () => ["a"],
    }),
  };
});

import {
  completeMcpArgument,
  ensureMcpExtras,
  getMcpPrompt,
  readMcpResource,
  readMcpTemplate,
} from "./extras";

beforeEach(() => {
  state.prepared = 0;
  state.wait = false;
  state.fail = false;
  state.startingSeen = [];
});

describe("ensureMcpExtras", () => {
  it("only reads the configuration while no server is enabled", async () => {
    state.servers = [{ enabled: false }];
    await ensureMcpExtras();
    expect(state.runtimeLoaded).toBe(false);
    // Completions need a running client: none without the runtime.
    await expect(
      completeMcpArgument(
        "s",
        { type: "ref/prompt", name: "p" },
        { name: "a", value: "" },
        {},
      ),
    ).resolves.toEqual([]);
  });

  it("starts the servers once a server is enabled, saying so while they start", async () => {
    state.servers = [{ enabled: true }];
    state.wait = true;
    await Promise.all([ensureMcpExtras(), ensureMcpExtras()]);
    expect(state.runtimeLoaded).toBe(true);
    expect(state.prepared).toBe(1);
    expect(state.startingSeen).toEqual([true]);
    expect(useMcpExtras.getState().starting).toBe(false);
  });

  it("never fails: the server's status says why", async () => {
    state.servers = [{ enabled: true }];
    state.fail = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(ensureMcpExtras()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("the composer's calls", () => {
  it("go to the running client", async () => {
    await expect(readMcpResource("s", "doc://a")).resolves.toEqual({
      read: "doc://a",
    });
    await expect(readMcpTemplate("s", "t://{x}", { x: "1" })).resolves.toEqual({
      uri: "t://1",
      result: { read: "t://1" },
    });
    await expect(getMcpPrompt("s", "p", {})).resolves.toEqual({ prompt: "p" });
    await expect(
      completeMcpArgument(
        "s",
        { type: "ref/prompt", name: "p" },
        { name: "a", value: "" },
        {},
      ),
    ).resolves.toEqual(["a"]);
  });
});
