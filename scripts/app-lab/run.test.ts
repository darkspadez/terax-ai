import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  descendants,
  hostTimeout,
  parseArgs,
  ReportServer,
  scenarioJson,
} from "./run.ts";

// Scenario JSON and timeouts were produced by the earlier Python orchestrator for the same command
// lines (its floats print as integers here: JSON numbers carry no int/float distinction).

const AGENT = `exec /usr/local/bin/bun ${join(import.meta.dirname, "agent-sim.mjs")}`;
const BASE = {
  agentCommand: AGENT,
  window: { width: 1280, height: 820 },
  dwellMs: 3000,
  hiddenMs: 3000,
  visibleMs: 2000,
  warmupS: 5,
  hiddenAgents: 6,
  steps: 120,
  stepPoints: 4,
  stepIntervalMs: 16,
  live: true,
  localStorage: {},
};

function scenario(argv: string[]) {
  const args = parseArgs(argv);
  const json = scenarioJson(args, "/usr/local/bin/bun");
  return { json, timeout: hostTimeout(args, json) };
}

describe("scenarioJson", () => {
  it("fills the defaults of a tabs run", () => {
    expect(scenario(["--scenario", "tabs"])).toEqual({
      json: { name: "tabs", ...BASE, cycles: 40 },
      timeout: 840,
    });
  });

  it("maps every option and drops the unset ones", () => {
    const { json, timeout } = scenario([
      "--scenario",
      "split-drag",
      "--drag-seconds",
      "4.5",
      "--valve",
      "5:4:64:9",
      "--toggle",
      "keep-canvas",
      "--toggle",
      "fixed-backing=2560x1700",
      "--local-storage",
      "a=null",
      "--local-storage",
      "b=c=d",
      "--window",
      "1440X900.5",
      "--gc",
      "--no-switch",
      "--vibrancy",
      "on",
      "--instrument",
    ]);
    expect(json).toEqual({
      name: "split-drag",
      ...BASE,
      window: { width: 1440, height: 900.5 },
      localStorage: {
        a: null,
        b: "c=d",
        "terax:bench:keep-canvas": "1",
        "terax:bench:fixed-backing": "2560x1700",
      },
      gc: "private",
      noSwitch: true,
      valve: { everyS: 5, chunks: 4, chunkMb: 64 },
      dragS: 4.5,
      instrument: true,
      prefs: { windowVibrancy: true },
      cycles: 3,
    });
    expect(timeout).toBe(463.5);
  });

  it("derives the timeout from the scenario", () => {
    expect(
      scenario([
        "--scenario",
        "fs-churn",
        "--duration",
        "90",
        "--hold-tab",
        "2",
        "--agent-args",
        "--fast 1",
      ]),
    ).toEqual({
      json: {
        name: "fs-churn",
        ...BASE,
        agentCommand: `${AGENT} --fast 1`,
        holdTab: 2,
        tickS: 30,
        durationS: 90,
      },
      timeout: 335,
    });
    expect(
      scenario(["--scenario", "occlusion", "--hidden-ms", "2500"]).timeout,
    ).toBe(570);
    expect(
      scenario(["--scenario", "resize", "--resize-mode", "plain"]).timeout,
    ).toBe(420);
    expect(scenario(["--scenario", "idle", "--timeout", "33"]).timeout).toBe(
      33,
    );
  });
});

describe("descendants", () => {
  it("walks the process tree below a pid", () => {
    const table = new Map<number, [number, string]>([
      [1, [0, "launchd"]],
      [10, [1, "terax"]],
      [11, [10, "zsh"]],
      [12, [11, "bun"]],
      [13, [10, "zsh"]],
      [20, [1, "other"]],
    ]);
    expect(descendants(10, table).sort()).toEqual([11, 12, 13]);
    expect(descendants(99, table)).toEqual([]);
  });
});

describe("ReportServer", () => {
  it("answers a phase event only once it has been handled", async () => {
    const server = new ReportServer();
    await server.start();
    try {
      const preflight = await fetch(`${server.url}/event`, {
        method: "OPTIONS",
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
      await fetch(`${server.url}/log`, { method: "POST", body: "page error" });
      expect(server.log).toEqual(["page error"]);

      const response = fetch(`${server.url}/event`, {
        method: "POST",
        body: JSON.stringify({ phase: "switch-1" }),
      });
      const pending = await server.next(5);
      expect(pending?.event).toEqual({ phase: "switch-1" });
      let answered = false;
      void response.then(() => {
        answered = true;
      });
      await new Promise((done) => setTimeout(done, 50));
      expect(answered).toBe(false);
      if (pending) {
        pending.reply.retry = true;
        pending.done();
      }
      expect(await (await response).json()).toEqual({ retry: true });
      expect(await server.next(0.05)).toBeUndefined();
    } finally {
      server.close();
    }
  });
});
