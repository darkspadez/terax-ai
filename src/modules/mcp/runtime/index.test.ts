import { describe, expect, it, vi } from "vitest";

const manager = vi.hoisted(() => ({
  synced: [] as unknown[],
  starting: true,
  waited: 0,
  calls: [] as unknown[][],
}));

vi.mock("./manager", () => ({
  McpManager: class {
    extras = { kind: "extras", waitForLists: async () => {} };
    listen = async () => {};
    sync = (servers: unknown) => manager.synced.push(servers);
    hasStarting = () => manager.starting;
    waitForStarting = async () => {
      manager.waited += 1;
      manager.starting = false;
    };
    instructions = () => [{ server: "srv", text: "hi" }];
    offeredTools = () => [
      {
        info: {
          name: "mcp__srv__echo",
          serverId: "s1",
          serverName: "srv",
          tool: "echo",
          trusted: true,
        },
        description: "Echo",
        inputSchema: { type: "object", properties: {} },
        alwaysAllow: false,
      },
    ];
    callTool = async (...args: unknown[]) => {
      manager.calls.push(args);
      return {
        kind: "mcp",
        server: "srv",
        tool: "echo",
        content: [{ type: "text", text: "back" }],
        notes: [],
      };
    };
  },
}));

import { extras, prepareExtras, toolsForRun } from "./index";

describe("toolsForRun", () => {
  it("syncs the window's servers, waits for starting ones and builds agent tools", async () => {
    const onWaiting = vi.fn();
    const run = await toolsForRun([], { onWaiting });
    expect(manager.synced).toHaveLength(1);
    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(manager.waited).toBe(1);
    expect(run.access).toEqual({
      mcp__srv__echo: { trusted: true, alwaysAllow: false },
    });
    expect(run.instructions).toEqual([{ server: "srv", text: "hi" }]);

    const tool = run.tools.mcp__srv__echo as unknown as {
      type: string;
      description: string;
      metadata: unknown;
      execute: (input: unknown, options: unknown) => Promise<unknown>;
      toModelOutput: (options: { output: unknown }) => unknown;
    };
    expect(tool.type).toBe("dynamic");
    expect(tool.description).toBe("Echo");
    expect(tool.metadata).toEqual({
      mcp: { serverId: "s1", server: "srv", tool: "echo" },
    });
    const signal = new AbortController().signal;
    const output = await tool.execute({ a: 1 }, { abortSignal: signal });
    expect(manager.calls).toEqual([
      ["s1", "echo", { a: 1 }, signal, { trusted: true, alwaysAllow: false }],
    ]);
    expect(tool.toModelOutput({ output })).toEqual({
      type: "text",
      value: "back",
    });
  });

  it("does not wait when nothing is starting", async () => {
    manager.starting = false;
    const onWaiting = vi.fn();
    await toolsForRun([], { onWaiting });
    expect(onWaiting).not.toHaveBeenCalled();
  });
});

describe("prepareExtras", () => {
  it("syncs the window's servers for the composer and waits for starting ones", async () => {
    manager.starting = true;
    const synced = manager.synced.length;
    const waited = manager.waited;
    const onWaiting = vi.fn();
    await prepareExtras([], onWaiting);
    expect(manager.synced).toHaveLength(synced + 1);
    expect(manager.waited).toBe(waited + 1);
    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(extras()).toMatchObject({ kind: "extras" });
  });
});
