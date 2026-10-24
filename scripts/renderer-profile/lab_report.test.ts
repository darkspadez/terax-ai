import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compare,
  computeMetrics,
  dump,
  interval,
  load,
  type Report,
  roundMetrics,
  type Sample,
  summarize,
  table,
} from "./lab_report.ts";

// Expected values were produced by the earlier Python implementation of this module from the
// same reports.

const MIB = 1048576;
const S = 1e9;

const counters = (
  cpu: number,
  energy: number | null,
  wakeups: number,
  instructions: number,
) => ({
  start_abstime: 7,
  cpu_ns: cpu,
  pcpu_ns: Math.floor(cpu / 4),
  energy_nj: energy,
  interrupt_wakeups: wakeups,
  idle_wakeups: Math.floor(wakeups / 2),
  instructions,
  cycles: Math.floor(instructions / 2),
});

function sample(
  phase: string,
  t: number,
  hostMib: number,
  webMib: number,
  cpu: number,
  event: Sample["event"],
  energy = true,
): Sample {
  const e = (value: number) => (energy ? value : null);
  const wakeups = Math.floor(cpu / 1e6);
  const host = Math.floor(hostMib * MIB);
  const web = Math.floor(webMib * MIB);
  return {
    phase,
    tMonoNs: t,
    tMonoNsPost: t + 5e8,
    event,
    roles: { "10": "host", "11": "web_content" },
    rusage: {
      "10": counters(cpu, e(cpu * 3), wakeups, cpu * 2),
      "11": counters(cpu * 2, e(cpu), wakeups, cpu * 3),
    },
    rusagePost: {
      "10": counters(cpu + 1e6, e(cpu * 3 + 5), wakeups + 1, cpu * 2 + 9),
      "11": counters(cpu * 2 + 1e6, e(cpu + 7), wakeups + 1, cpu * 3 + 9),
    },
    windowServerCpuNs: Math.floor(t / 100),
    windowServerCpuNsPost: Math.floor(t / 100) + 1e6,
    footprint: {
      "total footprint": host + web,
      processes: [
        { pid: 10, name: "renderer-lab", footprint: host },
        { pid: 11, name: "com.apple.WebKit.WebContent", footprint: web },
      ],
    },
    footprintByRole: { host, web_content: web },
    footprintTotal: host + web,
    loadAverage: [1.5, 1.0, 0.5],
  };
}

function occlusionReport(): Report {
  const pool = (reused: number) => ({
    canvases: {
      created: 1,
      reused,
      reconfigured: 0,
      destroyed: 0,
      backingStoreResizes: 2,
    },
  });
  return {
    config: {
      workload: "occlusion",
      label: "demo",
      panes: 1,
      occlusionMode: "orderout",
      cycles: 2,
      hiddenMs: 3000,
      visibleMs: 2000,
      forceGc: "none",
      controlNoReclaim: false,
    },
    sourceRevision: "0123456789abcdef",
    sourceDiffSha256: null,
    qualification: { qualified: true, failures: [] },
    warnings: [],
    scope: "test",
    environment: {
      chip: "M",
      loadAverageStart: [1.25, 2, 0.5],
      loadAverageEnd: [3, 2.5, 1],
    },
    samples: [
      sample("baseline", 100 * S, 50, 50.25, 1e10, {
        phase: "baseline",
        cycle: 0,
        canvases: { contextCreated: 1, contextFinalized: 0, domCanvases: 1 },
      }),
      sample("cycle-1-hidden", 104 * S, 50, 40, 2e10, {
        phase: "cycle-1-hidden",
        cycle: 1,
        step: "hidden",
        hide: { ok: true, occluded: true },
        reclaimedThisCycle: 1,
      }),
      sample("cycle-1-visible", 107 * S, 51, 60.75, 3e10, {
        phase: "cycle-1-visible",
        cycle: 1,
        step: "visible",
        canvases: { contextCreated: 2, contextFinalized: 1, domCanvases: 2 },
        presentation: { reclamations: 1, transitions: 2 },
        gpu: pool(1),
      }),
      sample("cycle-2-hidden", 111 * S, 52, 41, 4e10, {
        phase: "cycle-2-hidden",
        cycle: 2,
        step: "hidden",
        hide: { ok: true, occluded: false },
        reclaimedThisCycle: 0,
      }),
      sample("cycle-2-visible", 114 * S, 52.5, 70.125, 5e10, {
        phase: "cycle-2-visible",
        cycle: 2,
        step: "visible",
        canvases: { contextCreated: 3, contextFinalized: 1, domCanvases: 1 },
        presentation: { reclamations: 1, transitions: 4 },
        gpu: pool(2),
      }),
      sample("end+30s", 150 * S, 52.5, 65, 6e10, {
        phase: "end+30s",
        canvases: { contextCreated: 3, contextFinalized: 3, domCanvases: 1 },
        presentation: { reclamations: 1, transitions: 4 },
        gpu: pool(2),
      }),
      { phase: "done", tMonoNs: 151 * S, event: { phase: "done" } },
    ],
  };
}

function agentsReport(): Report {
  return {
    config: {
      workload: "agents",
      panes: 1,
      hidden: 8,
      duration: 60,
      warmup: 5,
      blink: 1,
    },
    sourceRevision: "fedcba9876543210",
    qualification: {
      qualified: false,
      failures: [
        {
          phase: "measure-end",
          reasons: ["window is occluded", "application is not active"],
        },
      ],
    },
    warnings: ["gpu pid not reported"],
    scope: "test",
    environment: { chip: "M", loadAverageStart: [1, 1, 1] },
    samples: [
      sample("measure-start", 200 * S, 40, 80, 1e10, {
        phase: "measure-start",
        driver: {
          renders: 10,
          bytes: 4096,
          writeMs: 2.5,
          lagSamples: 4,
          lagSumMs: 2,
          lagMaxMs: 1.5,
        },
        surfaces: [{ visible: true, frames: 10, uploadedBytes: 1024 }],
        renderTiming: [{ milliseconds: 5 }],
        gpu: {
          submittedFrames: 10,
          atlasUploads: 1,
          animationFrames: 100,
          timerWakeups: 10,
          workDoneWaits: 5,
          idleAnimationFrames: 0,
        },
      }),
      sample(
        "measure-end",
        260 * S,
        41,
        81,
        2e10,
        {
          phase: "measure-end",
          driver: {
            renders: 610,
            bytes: 4096 + 61440 * 60,
            writeMs: 32.5,
            lagSamples: 64,
            lagSumMs: 32,
            lagMaxMs: 4.25,
          },
          surfaces: [
            { visible: true, frames: 1810, uploadedBytes: 1024 + 1024 * 600 },
          ],
          renderTiming: [{ milliseconds: 125 }],
          gpu: {
            submittedFrames: 1810,
            atlasUploads: 3,
            animationFrames: 3700,
            timerWakeups: 70,
            workDoneWaits: 1805,
            idleAnimationFrames: 60,
          },
          heartbeats: [
            { hasFocus: true, visibility: "visible" },
            { hasFocus: false, visibility: "visible" },
          ],
        },
        false,
      ),
    ],
  };
}

describe("interval", () => {
  it("measures between the end of one sample and the start of the next", () => {
    const report = occlusionReport();
    const value = interval(report.samples[0], report.samples[1]);
    expect(value?.seconds).toBe(3.5);
    expect(value?.complete).toBe(true);
    expect(value?.cpu_ns).toEqual({
      host: 1e10 - 1e6,
      web_content: 2e10 - 1e6,
    });
    expect(value?.energy_j).toEqual({
      host: 29.999999995,
      web_content: 9.999999993,
    });
    expect(value?.window_server_cpu_pct).toBeCloseTo(1.1143, 4);
  });

  it("skips processes that restarted and reports the interval as incomplete", () => {
    const report = occlusionReport();
    const start = report.samples[0];
    const end = structuredClone(report.samples[1]);
    (end.rusage as Record<string, { start_abstime?: number }>)[
      "11"
    ].start_abstime = 8;
    const value = interval(start, end);
    expect(value?.complete).toBe(false);
    expect(Object.keys(value?.cpu_pct ?? {})).toEqual(["host"]);
  });

  it("returns null without counters or when time did not advance", () => {
    const report = occlusionReport();
    expect(interval(report.samples[1], report.samples[0])).toBeNull();
    expect(interval({ tMonoNs: 1 }, { tMonoNs: 2 })).toBeNull();
  });
});

describe("computeMetrics", () => {
  it("derives the occlusion metrics like the Python lab", () => {
    const metrics = roundMetrics(computeMetrics(occlusionReport()));
    expect(metrics).toMatchObject({
      "footprint.baseline.total_mib": 100.25,
      "footprint.mean_visible_mib": 117.1875,
      "footprint.growth_mib_per_cycle": 10.875,
      "footprint.growth_total_mib": 22.375,
      "footprint.mean_hidden_mib": 91.5,
      "footprint.settle_delta_vs_baseline_mib": 17.25,
      "js.domCanvases_max": 2,
      "cycles.occluded": 1,
      "cycles.reclaimed": 1,
      "hidden.seconds": 7,
      "hidden.cpu_pct.host": 285.6857,
      "hidden.cpu_pct.total": 857.0857,
      "hidden.power_mw.total": 11428.5714,
      "visible.cpu_pct.total": 1199.92,
      "visible.instructions_g_per_s": 20,
    });
    expect(Object.keys(metrics)).toHaveLength(57);
  });

  it("derives the agents metrics and leaves energy out when it is unknown", () => {
    const metrics = roundMetrics(computeMetrics(agentsReport()));
    expect(metrics).toMatchObject({
      "window.seconds": 59.5,
      "window.cpu_pct.total": 50.4168,
      "window.wakeups_per_s.total": 504.1681,
      "driver.kib_per_s": 60.5042,
      "renderer.page_wakeups_per_s": 91.7647,
      "renderer.panes_per_submission": 1,
      "qualification.heartbeats_unfocused": 1,
    });
    expect("window.energy_j_per_min.total" in metrics).toBe(false);
  });
});

describe("summarize", () => {
  it("prints the occlusion summary with Python's half-even rounding", () => {
    expect(summarize(occlusionReport())).toBe(
      [
        "== renderer lab: occlusion == [demo]",
        "  source 0123456789abcdef  diff None  qualified: True",
        "  mode orderout; panes/tab 1; cycles 2; hidden 3000 ms; visible 2000 ms",
        "",
        "Footprint after each cycle (MiB; hidden = total sampled at the end of the hidden hold;",
        "ctx/tex = WebGPU canvas contexts and swapchain textures created/finalized by JS GC; DOM = canvases in the document;",
        "gfx = vmmap 'owned unmapped (graphics)' of WebContent/GPU, MiB, when recorded):",
        "  phase            host  WebContent  TOTAL MiB  delta  gfx WC/GPU  hidden  ctx new/gc  tex new/gc  DOM  reclaims",
        "  ---------------  ----  ----------  ---------  -----  ----------  ------  ----------  ----------  ---  --------",
        "  baseline         50.0        50.2      100.2                                                                  ",
        "  cycle 1 visible  51.0        60.8      111.8  +11.5           -    90.0         2/1         -/-    2         1",
        "  cycle 2 visible  52.5        70.1      122.6  +10.9           -    93.0         3/1         -/-    1         1",
        "  end+30s          52.5        65.0      117.5   -5.1           -       -         3/3         -/-    1         -",
        "",
        "Cycles occluded / reclaimed by the presentation policy: 1 / 1 of 2",
        "Visible-footprint trend: +10.88 MiB/cycle; first->last visible +22.4 MiB",
        "Renderer canvas pool: created 1, reused 2, reconfigured 0, destroyed 0; backing-store resizes 2",
        "",
        "CPU / energy, time-weighted over all cycles:",
        "  interval  sec  cpu% host  cpu% WebContent  cpu% sum  cpu% WS  J/min host  J/min WebContent  J/min sum",
        "  --------  ---  ---------  ---------------  --------  -------  ----------  ----------------  ---------",
        "  hidden    7.0     285.69           571.40    857.09     1.11      514.29            171.43     685.71",
        "  visible   5.0     399.96           799.96   1199.92     1.16      720.00            240.00     960.00",
        "",
        "  host M; load average at start [1.25, 2.0, 0.5]; end [3.0, 2.5, 1.0]",
        "  scope: test",
      ].join("\n"),
    );
  });

  it("prints the measured window, failures and warnings of an agents run", () => {
    const text = summarize(agentsReport());
    expect(text).toContain(
      "  visible panes 1; hidden models 8; measured 60 s after 5 s warm-up; cursor blink 1",
    );
    expect(text).toContain(
      "  measured window  59.5      16.81            33.61     50.42     1.01           -                 -          -",
    );
    expect(text).toContain("  renderer.page_wakeups_per_s: 91.76");
    expect(text).toContain(
      "QUALIFICATION FAILURES (results are not valid evidence):\n  - measure-end: window is occluded; application is not active\n  warning: gpu pid not reported",
    );
    expect(
      text.endsWith(
        "load average at start [1.0, 1.0, 1.0]; end None\n  scope: test",
      ),
    ).toBe(true);
  });
});

describe("compare", () => {
  it("warns about differing configuration and failed qualification", () => {
    const candidate = agentsReport();
    candidate.config = { ...candidate.config, panes: 4 };
    candidate.sourceRevision = null;
    const lines = compare(agentsReport(), candidate).split("\n");
    expect(lines.slice(0, 6)).toEqual([
      "== comparison: agents (baseline fedcba9876 x1 -> candidate None x1; medians when repeated) ==",
      "  warning: config panes differs (1 vs 4)",
      "  warning: 1 of 1 baseline reports failed qualification",
      "  warning: 1 of 1 candidate reports failed qualification",
      "  metric                                baseline  candidate  delta      %",
      "  ------------------------------------  --------  ---------  -----  -----",
    ]);
  });

  it("groups thousands and leaves the percentage empty for a zero baseline", () => {
    const text = compare([occlusionReport()], occlusionReport());
    expect(text).toContain(
      "  hidden.power_mw.total                     11,428.57  11,428.57  +0.00  +0.0%",
    );
    expect(text).toContain(
      "  pool.reconfigured                              0.00       0.00  +0.00       ",
    );
  });
});

describe("report files", () => {
  it("dumps samples one per line and the summary as lines, and loads it back", () => {
    const report = occlusionReport();
    report.humanSummary = "a\nb";
    const text = dump(report);
    expect(text).toContain(' "humanSummary": [\n  "a",\n  "b"\n ]');
    expect(text).toContain(' "samples": [\n  {"phase":"baseline",');
    const directory = mkdtempSync(join(tmpdir(), "lab-report-"));
    try {
      const path = join(directory, "report.json");
      writeFileSync(path, text);
      const loaded = load(path);
      expect(loaded.humanSummary).toBe("a\nb");
      expect(loaded.samples).toHaveLength(7);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("escapes non-ASCII text like Python's json module", () => {
    expect(dump({ scope: "a \u00b7 b" })).toBe(
      '{\n "scope": "a \\u00b7 b"\n}\n',
    );
  });

  it("pads the first column left and the others right", () => {
    expect(
      table(
        ["name", "value"],
        [
          ["a", "1"],
          ["long", "1,000"],
        ],
      ),
    ).toBe("  name  value\n  ----  -----\n  a         1\n  long  1,000");
  });
});
