import { describe, expect, it } from "vitest";
import {
  type AppReport,
  type AppSample,
  type CompactFootprint,
  categoriesOf,
  compactFootprint,
  compactRusage,
  computeMetrics,
  experimentRow,
  qualify,
  roundMetrics,
  slimEvent,
  summarize,
} from "./app_report.ts";

// Expected values were produced by the earlier Python implementation of this module from the
// same report.

const MIB = 1048576;

const counters = (cpu: number) => ({
  start_abstime: 1,
  cpu_ns: cpu,
  energy_nj: null,
  interrupt_wakeups: Math.floor(cpu / 1e7),
  idle_wakeups: 0,
  instructions: cpu,
  cycles: cpu,
});

function footprint(
  host: number,
  web: number,
  malloc: number,
  iosurf: number,
  reclaimable: number,
): CompactFootprint {
  return {
    total: host + web,
    byRole: { host, web_content: web },
    processes: [
      {
        pid: 10,
        role: "host",
        name: "terax",
        footprint: host,
        peak: null,
        categories: { "WebKit malloc": [MIB, 0, 0, 0, 0, 1] },
      },
      {
        pid: 11,
        role: "web_content",
        name: "com.apple.WebKit.WebContent",
        footprint: web,
        peak: null,
        categories: {
          "WebKit malloc": [malloc, MIB / 2, 0, 0, 0, 3],
          IOSurface: [iosurf, 0, 0, reclaimable, 0, 2],
        },
      },
    ],
    shared: [
      {
        pids: [10, 11],
        specific: 11,
        categories: { IOSurface: [MIB, 0, 0, MIB / 4, 0, 1] },
      },
      {
        pids: [10, 11],
        specific: null,
        categories: { IOSurface: [8 * MIB, 0, 0, 0, 0, 1] },
      },
    ],
  };
}

function sample(
  phase: string,
  t: number,
  cycle: number | null,
  sizes: [
    host: number,
    web: number,
    malloc: number,
    iosurf: number,
    reclaimable: number,
  ],
  cpu: number,
  extra: Record<string, unknown> = {},
): AppSample {
  const fp = footprint(...(sizes.map((mib) => mib * MIB) as typeof sizes));
  return {
    phase,
    tMonoNs: t * 1e9,
    tMonoNsPost: t * 1e9 + 1e8,
    tWall: t,
    event: {
      phase,
      tWall: t * 1000,
      diag: {
        dom: { canvases: 1, elements: 900 },
        ghosttyCore: { wasmInstanceCount: 2, wasmMemoryBytes: 32 * MIB },
        ghosttyWebGpu: {
          canvases: { created: 1, reused: cycle, destroyed: 0 },
        },
      },
      ...(cycle === null ? {} : { cycle }),
      ...extra,
    },
    roles: { "10": "host", "11": "web_content", "12": "workload" },
    rusage: {
      "10": counters(cpu),
      "11": counters(2 * cpu),
      "12": counters(cpu / 2),
    },
    rusagePost: {
      "10": counters(cpu + 1e6),
      "11": counters(2 * cpu + 1e6),
      "12": counters(cpu / 2),
    },
    windowServerCpuNs: null,
    windowServerCpuNsPost: null,
    footprint: fp,
    footprintByRole: fp.byRole,
    footprintTotal: fp.total,
    loadAverage: [1, 1, 1],
  };
}

function tabsReport(): AppReport {
  return {
    config: {
      scenario: "tabs",
      label: "demo",
      profile: "release",
      scenarioJson: {
        name: "tabs",
        dwellMs: 3000,
        warmupS: 5.5,
        window: { width: 1280.5, height: 820.25 },
        live: true,
        localStorage: { "terax:bench:keep": "1" },
        cwds: { shell: "/tmp/x" },
        cycles: 3,
      },
    },
    sourceRevision: "abcdef0123456789abcdef",
    qualification: { qualified: true, failures: [] },
    scope: "test",
    environment: {
      chip: "M",
      loadAverageStart: [2.5, 1, 0.75],
      loadAverageEnd: [1.5, 2, 3],
    },
    samples: [
      sample("setup", 10, null, [50, 100, 20, 4, 0], 1e9, {
        order: ["shell", "agent"],
      }),
      sample("baseline", 20, 0, [50, 100, 20, 4, 0], 2e9),
      sample("switch-1", 25, 1, [51, 110.25, 25, 6, 0.5], 3e9, {
        switchedAt: 23500,
      }),
      sample("switch-2", 30, 2, [51, 112.5, 26, 6, 1], 4e9),
      sample("switch-3", 35, 3, [52, 121, 30, 8, 1], 5e9),
      sample("cycles-complete", 36, null, [52, 120, 30, 8, 1], 6e9),
      sample("end+30s", 66, null, [52, 118, 29, 7, 1], 7e9),
      {
        phase: "done",
        tMonoNs: 67e9,
        event: { phase: "done", diag: { ghosttySessions: [] } },
      },
    ],
    series: Array.from({ length: 15 }, (_, i) => ({
      tWall: 21 + i,
      processes: {
        "10": { role: "host", phys_footprint: (50 + (i % 3)) * MIB },
        "11": { role: "web_content", phys_footprint: (100 + 3 * i) * MIB },
        "12": { role: "workload", phys_footprint: MIB },
      },
    })),
  };
}

describe("categoriesOf", () => {
  it("adds the process's own rows and its specific shared rows, reports group rows apart", () => {
    expect(categoriesOf(tabsReport().samples[1], "web_content")).toEqual({
      "WebKit malloc": {
        dirty: 20,
        swapped: 0.5,
        clean: 0,
        reclaimable: 0,
        wired: 0,
      },
      IOSurface: {
        dirty: 5,
        swapped: 0,
        clean: 0,
        reclaimable: 0.25,
        wired: 0,
        shared_dirty: 8,
        shared_swapped: 0,
        shared_clean: 0,
        shared_reclaimable: 0,
        shared_wired: 0,
      },
    });
    expect(categoriesOf(tabsReport().samples[1], "gpu")).toEqual({});
  });
});

describe("computeMetrics", () => {
  it("derives the tab-switch series, timeline and loop metrics", () => {
    const metrics = roundMetrics(computeMetrics(tabsReport()));
    expect(metrics).toMatchObject({
      "cat.baseline.web_content.iosurf_reclaimable_mib": 0.25,
      "wasm.memory_mib": 32,
      "timeline.floor_growth_mib_per_cycle.total": 9,
      "timeline.peak.last.total_mib": 194,
      "timeline.samples": 15,
      "tabs.switch.mean_mib": 165.9167,
      "tabs.switch.growth_mib_per_cycle": 5.875,
      "tabs.switch.growth.web_content.iosurf_reclaimable_mib": 1,
      "tabs.switch.growth_mib_per_cycle.web_content.iosurf_reclaimable": 0.25,
      "tabs.on_agent.mean_mib": 167.125,
      "tabs.on_shell.mean_mib": 163.5,
      "loop.seconds": 14.9,
      "loop.cpu_pct.total": 70.4564,
      "loop.cpu_pct.app_total": 60.3893,
      "loop.wakeups_per_s.total": 70.4698,
      "tail.cpu_pct.app_total": 10.0268,
    });
    expect(Object.keys(metrics)).toHaveLength(118);
  });
});

describe("summarize", () => {
  it("prints the tabs summary", () => {
    expect(summarize(tabsReport())).toBe(
      [
        "== app lab: tabs == [demo]",
        "  source abcdef012345  profile release  qualified: True",
        "  dwellMs 3000, warmupS 5.5, cwds {'shell': '/tmp/x'}, cycles 3; window {'width': 1280.5, 'height': 820.25}",
        "  localStorage: {'terax:bench:keep': '1'}",
        "",
        "Footprint (MiB). WC = WebContent; malloc = 'WebKit malloc' dirty (incl. compressed); iosurf = IOSurface dirty;",
        "recl = IOSurface reclaimable (volatile, not in the footprint total); gfx = vmmap 'owned unmapped (graphics)'; pool = WebGPU canvases created/reused/destroyed:",
        "  phase            host  WebContent  TOTAL  delta  WC malloc  WC iosurf  WC iosurf recl  GPU iosurf  GPU iosurf recl  gfx WC/GPU         pool",
        "  ---------------  ----  ----------  -----  -----  ---------  ---------  --------------  ----------  ---------------  ----------  -----------",
        "  baseline         50.0       100.0  150.0              20.0        5.0             0.2         0.0              0.0           -     1c/0r/0d",
        "  switch-1         51.0       110.2  161.2  +11.2       25.0        7.0             0.8         0.0              0.0           -     1c/1r/0d",
        "  switch-2         51.0       112.5  163.5   +2.2       26.0        7.0             1.2         0.0              0.0           -     1c/2r/0d",
        "  switch-3         52.0       121.0  173.0   +9.5       30.0        9.0             1.2         0.0              0.0           -     1c/3r/0d",
        "  cycles-complete  52.0       120.0  172.0   -1.0       30.0        9.0             1.2         0.0              0.0           -  1c/Noner/0d",
        "  end+30s          52.0       118.0  170.0   -2.0       29.0        8.0             1.2         0.0              0.0           -  1c/Noner/0d",
        "",
        "Growth per switch (MiB/switch, least squares): total +5.875, host +0.500, web_content +5.375, web_content.malloc +2.500, web_content.iosurf +1.000, web_content.iosurf_reclaimable +0.250",
        "Baseline -> last switch: +23.0 MiB; after +30 s idle vs baseline: +20.0 MiB",
        "",
        "CPU% (of one core) and energy:",
        "  interval   sec  cpu% host  cpu% WebContent  cpu% PTY-procs  cpu% sum  cpu% WS  J/min host  J/min WebContent  J/min PTY-procs  J/min sum",
        "  --------  ----  ---------  ---------------  --------------  --------  -------  ----------  ----------------  ---------------  ---------",
        "  loop      14.9      20.13            40.26           10.07     60.39        -           -                 -                -          -",
        "  tail      29.9       3.34             6.69            1.67     10.03        -           -                 -                -          -",
        "",
        "  WASM: 2 instances, 32.0 MiB linear memory (peak 32.0); DOM elements 900",
        "",
        "  host M; load average at start [2.5, 1.0, 0.75]; end [1.5, 2.0, 3.0]",
        "  scope: test",
      ].join("\n"),
    );
  });

  it("prints one comparable experiment row", () => {
    expect(experimentRow(tabsReport())).toEqual([
      "demo",
      "3",
      "100",
      "118",
      "+18",
      "-",
      "-",
      "20",
      "29",
      "5",
      "8",
      "0",
      "+9.00",
    ]);
  });
});

describe("compaction", () => {
  it("keeps non-zero footprint categories and names processes by role", () => {
    const compact = compactFootprint(
      {
        "total footprint": 999,
        processes: [
          {
            pid: 4242,
            name: "terax",
            footprint: 100,
            auxiliary: { phys_footprint_peak: 120 },
            categories: {
              "WebKit malloc": { dirty: 5, clean: 1, regions: 3 },
              Zero: { dirty: 0, regions: 9 },
            },
          },
          { pid: 5000, name: "stranger", footprint: 50 },
        ],
        shared: [
          {
            pids: [4242],
            specific_to_pid: 4242,
            categories: { IOSurface: { dirty: 9 } },
          },
          { pids: [1], categories: { Zero: { dirty: 0 } } },
        ],
      },
      new Map([[4242, "host"]]),
    );
    expect(compact).toEqual({
      total: 999,
      byRole: { host: 100, stranger: 50 },
      processes: [
        {
          pid: 4242,
          role: "host",
          name: "terax",
          footprint: 100,
          peak: 120,
          categories: { "WebKit malloc": [5, 0, 1, 0, 0, 3] },
        },
        {
          pid: 5000,
          role: "stranger",
          name: "stranger",
          footprint: 50,
          peak: null,
          categories: {},
        },
      ],
      shared: [
        {
          pids: [4242],
          specific: 4242,
          categories: { IOSurface: [9, 0, 0, 0, 0, 0] },
        },
      ],
    });
    expect(
      compactRusage({ cpu_ns: 1, flavor: 6, energy_nj: null, user_ns: 3 }),
    ).toEqual({
      cpu_ns: 1,
      energy_nj: null,
    });
    expect(compactRusage(null)).toBeNull();
  });

  it("prunes the per-session diagnostics of an event", () => {
    const slim = slimEvent({
      phase: "p",
      diag: {
        visibility: "visible",
        ghosttySessions: [
          {
            leafId: "a",
            extra: "dropped",
            model: {
              deep: { deeper: { x: 1 } },
              s: "y".repeat(100),
              n: null,
              list: [1, [2]],
            },
          },
        ],
      },
    });
    expect(slim.diag).toEqual({
      visibility: "visible",
      ghosttySessions: [
        {
          leafId: "a",
          pty: null,
          visible: null,
          focused: null,
          model: { deep: {}, s: "y".repeat(80), list: [1, null] },
          surface: null,
        },
      ],
    });
  });
});

describe("qualify", () => {
  it("rejects samples taken while the window was not visible and key", () => {
    expect(
      qualify("tabs", "switch-1", {
        native: { appActive: true, key: false, occlusionVisible: true },
        diag: { visibility: "hidden", ghosttyWebGpu: { windowFocused: false } },
        show: { ok: false },
      }),
    ).toEqual([
      "benchmark window is not key",
      "document.visibilityState=hidden",
      "renderer reports the window unfocused",
      "window did not return to visible+key after show",
    ]);
    expect(
      qualify("tabs", "x", {
        unfocused: true,
        native: { occlusionVisible: true },
        diag: {
          visibility: "visible",
          ghosttyWebGpu: { windowFocused: false },
        },
      }),
    ).toEqual([]);
    expect(
      qualify("occlusion", "cycle-1-hidden", {
        step: "hidden",
        hide: { ok: true, occluded: false, mode: "orderout" },
        native: { occlusionVisible: true },
        diag: { visibility: "visible" },
      }),
    ).toEqual([
      "window was not occluded by 'orderout'",
      "AppKit still reports the window visible during the hold",
      "document.visibilityState=visible during the hold",
    ]);
    expect(qualify("tabs", "setup", {})).toEqual([]);
  });
});
