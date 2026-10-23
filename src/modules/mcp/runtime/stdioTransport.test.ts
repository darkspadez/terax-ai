import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => {
  type Channel = { onmessage: (value: unknown) => void };
  return {
    channels: [] as Channel[],
    invoke: vi.fn(),
    Channel: class {
      onmessage = (_value: unknown) => {};
      constructor() {
        bridge.channels.push(this);
      }
      toJSON() {
        return "__CHANNEL__";
      }
    },
  };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: bridge.invoke,
  Channel: bridge.Channel,
}));

import { describeExit, TauriStdioTransport } from "./stdioTransport";

const encoder = new TextEncoder();
const launch = {
  serverId: "s1",
  command: "npx",
  args: ["-y", "server"],
  env: { MODE: "x" },
  secretEnv: ["TOKEN"],
  cwd: null,
  shell: "/bin/zsh",
};

function message(text: string) {
  bridge.channels[0].onmessage(encoder.encode(text).buffer);
}
function exit(info: Record<string, unknown>) {
  bridge.channels[1].onmessage({
    code: null,
    signal: null,
    reason: null,
    stderrTail: "",
    ...info,
  });
}

beforeEach(() => {
  bridge.channels.length = 0;
  bridge.invoke.mockReset();
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "mcp_spawn" ? 41 : undefined,
  );
});
afterEach(() => vi.useRealTimers());

describe("TauriStdioTransport", () => {
  it("spawns through the native host, secrets named rather than passed", async () => {
    const t = new TauriStdioTransport(launch);
    await t.start();
    expect(bridge.invoke).toHaveBeenCalledWith("mcp_spawn", {
      serverId: "s1",
      command: "npx",
      args: ["-y", "server"],
      env: { MODE: "x" },
      secretEnv: ["TOKEN"],
      cwd: null,
      shell: "/bin/zsh",
      onMessage: expect.anything(),
      onExit: expect.anything(),
    });
  });

  it("delivers valid JSON-RPC messages and reports anything else", async () => {
    const t = new TauriStdioTransport(launch);
    const onmessage = vi.fn();
    const onerror = vi.fn();
    t.onmessage = onmessage;
    t.onerror = onerror;
    await t.start();
    message('{"jsonrpc":"2.0","id":1,"result":{}}');
    message("{not json");
    message('{"hello":"world"}');
    expect(onmessage).toHaveBeenCalledTimes(1);
    expect(onmessage).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });
    expect(onerror).toHaveBeenCalledTimes(2);
  });

  it("sends one message at a time, in order", async () => {
    const t = new TauriStdioTransport(launch);
    await t.start();
    const order: string[] = [];
    let release: () => void = () => {};
    bridge.invoke.mockImplementation(
      async (command: string, args: { message: string }) => {
        if (command !== "mcp_send") return undefined;
        order.push(`start ${args.message}`);
        if (args.message.includes('"id":1')) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        order.push(`end ${args.message}`);
      },
    );
    const first = t.send({ jsonrpc: "2.0", id: 1, method: "a" });
    const second = t.send({ jsonrpc: "2.0", id: 2, method: "b" });
    await vi.waitFor(() => expect(order).toHaveLength(1));
    release();
    await Promise.all([first, second]);
    expect(order.map((o) => o.split(" ")[0])).toEqual([
      "start",
      "end",
      "start",
      "end",
    ]);
    expect(order[2]).toContain('"id":2');
  });

  it("closes once when the process exits and keeps how it ended", async () => {
    const t = new TauriStdioTransport(launch);
    const onclose = vi.fn();
    t.onclose = onclose;
    await t.start();
    exit({ code: 1, stderrTail: "warming up\nError: missing API key" });
    exit({ code: 1 });
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(t.exit?.code).toBe(1);
    await expect(t.send({ jsonrpc: "2.0", method: "x" })).rejects.toThrow(
      "not running",
    );
    message('{"jsonrpc":"2.0","id":1,"result":{}}');
  });

  it("stops the process on close", async () => {
    const t = new TauriStdioTransport(launch);
    await t.start();
    await t.close();
    expect(bridge.invoke).toHaveBeenCalledWith("mcp_kill", { id: 41 });
  });

  it("stops a process whose spawn finished after close", async () => {
    let finish: (id: number) => void = () => {};
    bridge.invoke.mockImplementation((command: string) =>
      command === "mcp_spawn"
        ? new Promise<number>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(),
    );
    const t = new TauriStdioTransport(launch);
    const started = t.start();
    await t.close();
    finish(9);
    await started;
    expect(bridge.invoke).toHaveBeenCalledWith("mcp_kill", { id: 9 });
  });
});

describe("describeExit", () => {
  it("says how it ended, with the last thing it printed", () => {
    expect(
      describeExit({
        code: 1,
        signal: null,
        reason: null,
        stderrTail: "a\nError: missing API key\n",
      }),
    ).toBe("Exited with code 1: Error: missing API key");
    expect(
      describeExit({ code: null, signal: 9, reason: null, stderrTail: "" }),
    ).toBe("Ended by signal 9");
    expect(
      describeExit({
        code: null,
        signal: 9,
        reason: "Stopped: the server sent a message over the 16 MiB limit",
        stderrTail: "",
      }),
    ).toBe("Stopped: the server sent a message over the 16 MiB limit");
  });
});
