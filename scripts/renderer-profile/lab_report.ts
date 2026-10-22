// Metrics, human summaries and baseline comparison for renderer lab reports.
//
// Everything here is derived from the raw samples stored in a report, so a report written by an
// older lab revision (footprint samples only) can still be compared where metrics overlap.

import { readFileSync } from "node:fs";
import {
  asciiJson,
  fixed,
  floatRepr,
  head,
  maxOf,
  median,
  pyEqual,
  pyStr,
  splitLines,
  sum,
  truthy,
} from "../lib/format.ts";
import { ROLE_LABEL, ROLE_ORDER } from "./procstats.ts";

export const MIB = 1048576.0;

// ---------------------------------------------------------------------------------------------
// Report shapes (what the lab writes; every field a reader may meet is optional)
// ---------------------------------------------------------------------------------------------

export type Dict = Record<string, unknown>;

export type RusageCounters = {
  start_abstime?: number;
  cpu_ns: number;
  pcpu_ns?: number;
  energy_nj: number | null;
  interrupt_wakeups: number;
  idle_wakeups: number;
  instructions: number;
  cycles: number;
  phys_footprint?: number;
  [key: string]: unknown;
};

export type VmmapRow = {
  virtual: number;
  resident: number;
  dirty: number;
  swapped: number;
  count?: number;
};

export type VmmapTable = {
  physicalFootprint?: number | null;
  regions?: Record<string, VmmapRow> | null;
};

export type Surface = {
  visible?: boolean;
  documentSuspended?: boolean;
  frames?: number;
  uploadedBytes?: number;
  backingStoreResizes?: number;
  [key: string]: unknown;
};

export type LabEvent = {
  phase?: string;
  step?: string;
  cycle?: number;
  native?: Dict | string | null;
  hide?: Dict | null;
  show?: Dict | null;
  gpu?: Dict | null;
  surfaces?: Surface[] | null;
  canvases?: Dict | null;
  presentation?: Dict | null;
  driver?: Dict | null;
  renderTiming?: { milliseconds: number }[] | null;
  heartbeats?: Dict[] | null;
  reclaimedThisCycle?: number;
  [key: string]: unknown;
};

/** The counters `interval` reads; shared by the renderer and app labs. */
export type CounterSample = {
  tMonoNs: number;
  tMonoNsPost?: number;
  roles?: Record<string, string> | null;
  rusage?: Record<string, RusageCounters | null> | null;
  rusagePost?: Record<string, RusageCounters | null> | null;
  windowServerCpuNs?: number | null;
  windowServerCpuNsPost?: number | null;
};

export type Sample = CounterSample & {
  phase?: string;
  event: LabEvent;
  footprint?: {
    "total footprint": number;
    processes: { pid: number; name: string; footprint: number }[];
    [key: string]: unknown;
  };
  footprintByRole?: Record<string, number>;
  footprintTotal?: number;
  vmmap?: Record<string, VmmapTable | null> | null;
  loadAverage?: number[];
  [key: string]: unknown;
};

export type Qualification = {
  qualified?: boolean;
  failures?: { phase: string; reasons: string[] }[];
  advisories?: string[];
  [key: string]: unknown;
};

export type Report = {
  config?: Dict | null;
  sourceRevision?: string | null;
  sourceDiffSha256?: string | null;
  qualification?: Qualification | null;
  warnings?: string[] | null;
  environment?: Dict | null;
  scope?: string;
  samples: Sample[];
  humanSummary?: string | string[];
  [key: string]: unknown;
};

export type Metrics = Record<string, number>;

/** `obj.get(key, fallback)`: the stored value even when it is null, `fallback` only when absent. */
export function get(
  obj: unknown,
  key: string,
  fallback: unknown = null,
): unknown {
  return obj !== null && typeof obj === "object" && key in obj
    ? (obj as Dict)[key]
    : fallback;
}

/** `value or {}` for a dict-valued field. */
export function dict(value: unknown): Dict {
  return truthy(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Dict)
    : {};
}

const num = (value: unknown) => Number(value);

// ---------------------------------------------------------------------------------------------
// Sample accessors
// ---------------------------------------------------------------------------------------------

export function phaseOf(sample: {
  phase?: string;
  event?: LabEvent | null;
}): string {
  return sample.phase || (sample.event?.phase as string);
}

/** Drop bookkeeping samples (e.g. the final 'done' event) that carry no measurements. */
export function usable<R extends { samples: Dict[] }>(report: R): R {
  return { ...report, samples: report.samples.filter((s) => "footprint" in s) };
}

export function workloadOf(report: Report): string {
  return get(dict(report.config), "workload", "default") as string;
}

export function totalBytes(sample: Sample): number {
  const fallback = (sample.footprint as Dict)["total footprint"];
  return num("footprintTotal" in sample ? sample.footprintTotal : fallback);
}

export function footprintByRole(sample: Sample): Record<string, number> {
  if ("footprintByRole" in sample)
    return sample.footprintByRole as Record<string, number>;
  // Legacy samples: roles come from the footprint process names.
  const names: Record<string, string> = {
    "renderer-lab": "host",
    "com.apple.WebKit.WebContent": "web_content",
    "com.apple.WebKit.GPU": "gpu",
    "com.apple.WebKit.Networking": "networking",
  };
  const result: Record<string, number> = {};
  for (const process of sample.footprint?.processes ?? []) {
    const role = Object.hasOwn(names, process.name)
      ? names[process.name]
      : process.name;
    result[role] = (result[role] ?? 0) + process.footprint;
  }
  return result;
}

/** Graphics memory a process owns without mapping it (IOSurface/canvas backing), from vmmap. */
export function graphicsMib(sample: Sample, role: string): number | null {
  const summary = get(dict(sample.vmmap), role);
  const row = get(
    dict(get(dict(summary), "regions")),
    "owned unmapped (graphics)",
  );
  if (row === null) return null;
  const { resident, dirty, swapped } = row as VmmapRow;
  // Pages compressed or swapped out still count toward physical footprint, so a process whose
  // graphics memory is mostly compressed would look small by resident size alone.
  return Math.max(resident, dirty + swapped) / MIB;
}

/** WebGPU canvas pool counters of a page event (empty for renderers that predate them). */
export function poolOf(event: LabEvent): Dict {
  return dict(dict(event.gpu).canvases);
}

function poolMetrics(metrics: Metrics, event: LabEvent): void {
  const pool = poolOf(event);
  for (const key of ["created", "reused", "reconfigured", "destroyed"])
    if (key in pool) metrics[`pool.${key}`] = pool[key] as number;
  const surfaces = event.surfaces || [];
  if ("backingStoreResizes" in pool) {
    // One shared window canvas: the runtime counts the swapchain allocations.
    metrics["renderer.backing_store_resizes"] =
      pool.backingStoreResizes as number;
  } else if (surfaces.length && "backingStoreResizes" in surfaces[0]) {
    metrics["renderer.backing_store_resizes"] = sum(
      surfaces.map((s) => num(get(s, "backingStoreResizes", 0))),
    );
  }
}

function surfaceTotal(sample: Sample | undefined, key: string): number | null {
  const event = dict(sample?.event) as LabEvent;
  if (key === "backingStoreResizes" && "backingStoreResizes" in poolOf(event))
    return num(poolOf(event).backingStoreResizes);
  const surfaces = event.surfaces || [];
  if (!surfaces.length || !(key in surfaces[0])) return null;
  return sum(surfaces.map((s) => num(get(s, key, 0))));
}

/** Per-drag counters and the peak WebContent / total footprint of the shrink-N and grow-N phases. */
function resizeMetrics(
  metrics: Metrics,
  byPhase: Map<string, Sample>,
  named: Sample[],
): void {
  const gestures = named.filter(
    (s) => phaseOf(s).startsWith("shrink-") || phaseOf(s).startsWith("grow-"),
  );
  if (!gestures.length) return;
  metrics["resize.gestures"] = gestures.length;
  metrics["resize.peak_total_mib"] = maxOf(gestures.map(totalBytes)) / MIB;
  metrics["resize.peak_web_content_mib"] =
    maxOf(gestures.map((s) => footprintByRole(s).web_content ?? 0)) / MIB;
  for (const [key, name] of [
    ["backingStoreResizes", "backing_store_resizes"],
    ["gridResizes", "grid_resizes"],
    ["deferredGridResizes", "deferred_grid_resizes"],
  ]) {
    let previous = surfaceTotal(byPhase.get("baseline"), key);
    const counts: number[] = [];
    for (const sample of gestures) {
      const current = surfaceTotal(sample, key);
      if (previous !== null && current !== null)
        counts.push(current - previous);
      previous = current;
    }
    if (counts.length) {
      metrics[`resize.${name}_per_gesture.max`] = maxOf(counts);
      metrics[`resize.${name}_per_gesture.mean`] = sum(counts) / counts.length;
    }
  }
}

export function rolesPresent(samples: Sample[]): string[] {
  const seen = new Set(
    samples.flatMap((sample) => Object.keys(footprintByRole(sample))),
  );
  const ordered = ROLE_ORDER.filter((role) => seen.has(role));
  return [
    ...ordered,
    ...[...seen].filter((role) => !ordered.includes(role)).sort(),
  ];
}

export function label(
  role: string,
  labels: Readonly<Record<string, string>> = ROLE_LABEL,
): string {
  return Object.hasOwn(labels, role) ? labels[role] : role;
}

export function sampleByPhase<
  S extends { phase?: string; event?: LabEvent | null },
>(report: { samples: S[] }): Map<string, S> {
  return new Map(report.samples.map((sample) => [phaseOf(sample), sample]));
}

export function slope(xs: number[], ys: number[]): number | null {
  if (xs.length < 2) return null;
  const meanX = sum(xs) / xs.length;
  const meanY = sum(ys) / ys.length;
  const denominator = sum(xs.map((x) => (x - meanX) * (x - meanX)));
  if (denominator === 0) return null;
  const count = Math.min(xs.length, ys.length);
  const products: number[] = [];
  for (let index = 0; index < count; index++)
    products.push((xs[index] - meanX) * (ys[index] - meanY));
  return sum(products) / denominator;
}

// ---------------------------------------------------------------------------------------------
// Intervals: CPU and energy between two samples
// ---------------------------------------------------------------------------------------------

export type Interval = {
  seconds: number;
  complete: boolean;
  cpu_pct: Record<string, number>;
  energy_j: Record<string, number>;
  wakeups_per_s: Record<string, number>;
  cpu_ns: Record<string, number>;
  pcpu_ns: number;
  instructions: number;
  cycles: number;
  cpu_pct_total: number;
  energy_j_total: number | null;
  energy_j_per_min: Record<string, number>;
  energy_j_per_min_total: number | null;
  power_mw_total: number | null;
  wakeups_per_s_total?: number;
  window_server_cpu_pct?: number;
};

/** Counters at the start of sampling ('pre') or when sampling finished ('post'). */
function counters(
  sample: CounterSample,
  edge: "pre" | "post",
): [Record<string, RusageCounters | null>, number, number | null] {
  if (edge === "post" && truthy(sample.rusagePost))
    return [
      sample.rusagePost as Record<string, RusageCounters | null>,
      sample.tMonoNsPost as number,
      (get(sample, "windowServerCpuNsPost") as number | null) ?? null,
    ];
  return [
    truthy(sample.rusage)
      ? (sample.rusage as Record<string, RusageCounters | null>)
      : {},
    sample.tMonoNs,
    (get(sample, "windowServerCpuNs") as number | null) ?? null,
  ];
}

const valuesOf = (record: Record<string, number>) => Object.values(record);

/**
 * Resource use between the end of `start`'s sampling and the beginning of `end`'s.
 *
 * Returns null for samples without rusage (reports from the older lab).
 */
export function interval(
  start: CounterSample,
  end: CounterSample,
): Interval | null {
  const [before, t0, ws0] = counters(start, "post");
  const [after, t1, ws1] = counters(end, "pre");
  if (!truthy(before) || !truthy(after) || t1 <= t0) return null;
  const seconds = (t1 - t0) / 1e9;
  const roles = new Map<
    string,
    {
      cpu_ns: number;
      pcpu_ns: number;
      energy_nj: number;
      energy_known: boolean;
      wakeups: number;
      instructions: number;
      cycles: number;
    }
  >();
  let complete = true;
  for (const [pid, role] of Object.entries(
    dict(end.roles) as Record<string, string>,
  )) {
    const a = get(before, pid) as RusageCounters | null;
    const b = get(after, pid) as RusageCounters | null;
    if (
      !truthy(a) ||
      !truthy(b) ||
      !pyEqual(get(a, "start_abstime"), get(b, "start_abstime"))
    ) {
      complete = false;
      continue;
    }
    const x = a as RusageCounters;
    const y = b as RusageCounters;
    let entry = roles.get(role);
    if (!entry) {
      entry = {
        cpu_ns: 0,
        pcpu_ns: 0,
        energy_nj: 0,
        energy_known: true,
        wakeups: 0,
        instructions: 0,
        cycles: 0,
      };
      roles.set(role, entry);
    }
    entry.cpu_ns += y.cpu_ns - x.cpu_ns;
    entry.pcpu_ns += num(get(y, "pcpu_ns", 0)) - num(get(x, "pcpu_ns", 0));
    entry.wakeups +=
      y.interrupt_wakeups -
      x.interrupt_wakeups +
      (y.idle_wakeups - x.idle_wakeups);
    entry.instructions += y.instructions - x.instructions;
    entry.cycles += y.cycles - x.cycles;
    if (
      x.energy_nj === null ||
      x.energy_nj === undefined ||
      y.energy_nj === null ||
      y.energy_nj === undefined
    )
      entry.energy_known = false;
    else entry.energy_nj += y.energy_nj - x.energy_nj;
  }
  const byRole = <T>(
    pick: (value: NonNullable<ReturnType<typeof roles.get>>) => T,
    keep = (_: NonNullable<ReturnType<typeof roles.get>>) => true,
  ) =>
    Object.fromEntries(
      [...roles].filter(([, v]) => keep(v)).map(([role, v]) => [role, pick(v)]),
    );
  const cpuPct: Record<string, number> = byRole(
    (v) => (100.0 * v.cpu_ns) / (seconds * 1e9),
  );
  const energyJ: Record<string, number> = byRole(
    (v) => v.energy_nj / 1e9,
    (v) => v.energy_known,
  );
  const wakeups: Record<string, number> = byRole((v) => v.wakeups / seconds);
  const energyTotal = Object.keys(energyJ).length
    ? sum(valuesOf(energyJ))
    : null;
  const result: Interval = {
    seconds,
    complete,
    cpu_pct: cpuPct,
    energy_j: energyJ,
    wakeups_per_s: wakeups,
    cpu_ns: byRole((v) => v.cpu_ns),
    pcpu_ns: sum([...roles.values()].map((v) => v.pcpu_ns)),
    instructions: sum([...roles.values()].map((v) => v.instructions)),
    cycles: sum([...roles.values()].map((v) => v.cycles)),
    cpu_pct_total: sum(valuesOf(cpuPct)),
    energy_j_total: energyTotal,
    energy_j_per_min: Object.fromEntries(
      Object.entries(energyJ).map(([role, v]) => [role, (v / seconds) * 60]),
    ),
    energy_j_per_min_total:
      energyTotal !== null ? (energyTotal / seconds) * 60 : null,
    power_mw_total:
      energyTotal !== null ? (energyTotal / seconds) * 1000 : null,
    wakeups_per_s_total: sum(valuesOf(wakeups)),
  };
  if (ws0 !== null && ws1 !== null)
    result.window_server_cpu_pct = (100.0 * (ws1 - ws0)) / (seconds * 1e9);
  return result;
}

/** Time-weighted combination of several intervals (e.g. every hidden hold of a run). */
export function aggregate(all: (Interval | null)[]): Interval | null {
  const intervals = all.filter((i): i is Interval => truthy(i));
  if (!intervals.length) return null;
  const seconds = sum(intervals.map((i) => i.seconds));
  const roles = [...new Set(intervals.flatMap((i) => Object.keys(i.cpu_ns)))];
  const cpuNs = Object.fromEntries(
    roles.map((role) => [role, sum(intervals.map((i) => i.cpu_ns[role] ?? 0))]),
  );
  const energyRoles = [
    ...new Set(intervals.flatMap((i) => Object.keys(i.energy_j))),
  ];
  const energy = Object.fromEntries(
    energyRoles.map((role) => [
      role,
      sum(intervals.map((i) => i.energy_j[role] ?? 0)),
    ]),
  );
  const cpuPct = Object.fromEntries(
    Object.entries(cpuNs).map(([role, v]) => [
      role,
      (100.0 * v) / (seconds * 1e9),
    ]),
  );
  const known = energyRoles.length > 0;
  const energyTotal = known ? sum(valuesOf(energy)) : null;
  const result: Interval = {
    seconds,
    complete: intervals.every((i) => i.complete),
    pcpu_ns: sum(intervals.map((i) => num(get(i, "pcpu_ns", 0)))),
    instructions: sum(intervals.map((i) => num(get(i, "instructions", 0)))),
    cycles: sum(intervals.map((i) => num(get(i, "cycles", 0)))),
    cpu_ns: cpuNs,
    cpu_pct: cpuPct,
    energy_j: energy,
    energy_j_per_min: Object.fromEntries(
      Object.entries(energy).map(([role, v]) => [role, (v / seconds) * 60]),
    ),
    wakeups_per_s: {},
    cpu_pct_total: sum(valuesOf(cpuPct)),
    energy_j_total: energyTotal,
    energy_j_per_min_total:
      energyTotal !== null ? (energyTotal / seconds) * 60 : null,
    power_mw_total:
      energyTotal !== null ? (energyTotal / seconds) * 1000 : null,
  };
  const ws = intervals.filter((i) => "window_server_cpu_pct" in i);
  if (ws.length)
    result.window_server_cpu_pct =
      sum(ws.map((i) => (i.window_server_cpu_pct as number) * i.seconds)) /
      sum(ws.map((i) => i.seconds));
  return result;
}

// ---------------------------------------------------------------------------------------------
// Metrics (flat, comparable between reports)
// ---------------------------------------------------------------------------------------------

function cycleSamples(report: Report, step: string): [number, Sample][] {
  const found: [number, Sample][] = [];
  for (const sample of report.samples) {
    const event = sample.event;
    if (get(event, "step") === step && "cycle" in event)
      found.push([event.cycle as number, sample]);
  }
  return found.sort((a, b) => a[0] - b[0]);
}

const byKey = <T>(entries: [string, T][]) =>
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

function addIntervalMetrics(
  metrics: Metrics,
  prefix: string,
  value: Interval | null,
): void {
  if (!truthy(value) || !value) return;
  metrics[`${prefix}.seconds`] = value.seconds;
  for (const [role, pct] of byKey(Object.entries(value.cpu_pct)))
    metrics[`${prefix}.cpu_pct.${role}`] = pct;
  metrics[`${prefix}.cpu_pct.total`] = value.cpu_pct_total;
  if (
    value.window_server_cpu_pct !== undefined &&
    value.window_server_cpu_pct !== null
  )
    metrics[`${prefix}.cpu_pct.window_server`] = value.window_server_cpu_pct;
  for (const [role, joules] of byKey(Object.entries(value.energy_j_per_min)))
    metrics[`${prefix}.energy_j_per_min.${role}`] = joules;
  if (
    value.energy_j_per_min_total !== null &&
    value.energy_j_per_min_total !== undefined
  ) {
    metrics[`${prefix}.energy_j_per_min.total`] = value.energy_j_per_min_total;
    metrics[`${prefix}.power_mw.total`] = value.power_mw_total as number;
  }
  if (value.wakeups_per_s_total)
    metrics[`${prefix}.wakeups_per_s.total`] = value.wakeups_per_s_total;
  const totalCpu = sum(valuesOf(value.cpu_ns));
  if (totalCpu && value.pcpu_ns !== null && value.pcpu_ns !== undefined)
    metrics[`${prefix}.p_core_share_pct`] = (100.0 * value.pcpu_ns) / totalCpu;
  if (value.instructions) {
    // Work done, independent of core type and frequency: the stable CPU comparison metric.
    metrics[`${prefix}.instructions_g_per_s`] =
      value.instructions / value.seconds / 1e9;
    metrics[`${prefix}.cycles_g_per_s`] = value.cycles / value.seconds / 1e9;
  }
}

function footprintMetrics(
  metrics: Metrics,
  name: string,
  sample: Sample,
): void {
  metrics[`footprint.${name}.total_mib`] = totalBytes(sample) / MIB;
  for (const [role, value] of Object.entries(footprintByRole(sample)))
    metrics[`footprint.${name}.${role}_mib`] = value / MIB;
  for (const role of ["web_content", "gpu"]) {
    const value = graphicsMib(sample, role);
    if (value !== null) metrics[`graphics.${name}.${role}_mib`] = value;
  }
}

const JS_COUNTERS = [
  "canvasCreated",
  "canvasFinalized",
  "contextCreated",
  "contextFinalized",
  "configure",
  "unconfigure",
  "textureAcquired",
  "textureFinalized",
];

/** Python's `/`, which raises on a zero divisor instead of returning Infinity. */
function divide(numerator: number, denominator: number): number {
  if (denominator === 0) throw new RangeError("float division by zero");
  return numerator / denominator;
}

export function computeMetrics(full: Report): Metrics {
  const report = usable(full);
  const workload = workloadOf(report);
  const samples = report.samples;
  const byPhase = sampleByPhase(report);
  const metrics: Metrics = {};
  if (workload === "default") {
    for (const sample of samples)
      metrics[`footprint.${phaseOf(sample)}.total_mib`] =
        totalBytes(sample) / MIB;
    const repainted = byPhase.get("repainted");
    if (repainted) poolMetrics(metrics, repainted.event);
    return metrics;
  }

  if (
    workload === "occlusion" ||
    workload === "canvas" ||
    workload === "tabs"
  ) {
    const hidden = cycleSamples(report, "hidden");
    const visible = cycleSamples(report, "visible");
    const base = byPhase.get("baseline");
    if (base) footprintMetrics(metrics, "baseline", base);
    if (visible.length) {
      footprintMetrics(metrics, "cycle1_visible", visible[0][1]);
      footprintMetrics(metrics, "last_visible", visible[visible.length - 1][1]);
      const totals = visible.map(([, s]) => totalBytes(s) / MIB);
      metrics["footprint.max_visible_mib"] = maxOf(totals);
      metrics["footprint.mean_visible_mib"] = sum(totals) / totals.length;
      const fit = slope(
        visible.map(([c]) => c),
        totals,
      );
      if (fit !== null) metrics["footprint.growth_mib_per_cycle"] = fit;
      if (base) {
        metrics["footprint.growth_total_mib"] =
          totals[totals.length - 1] - totalBytes(base) / MIB;
        for (const role of rolesPresent(samples)) {
          const first = footprintByRole(base)[role] ?? 0;
          const last =
            footprintByRole(visible[visible.length - 1][1])[role] ?? 0;
          metrics[`footprint.growth.${role}_mib`] = (last - first) / MIB;
        }
      }
    }
    if (hidden.length) {
      const totals = hidden.map(([, s]) => totalBytes(s) / MIB);
      metrics["footprint.max_hidden_mib"] = maxOf(totals);
      metrics["footprint.mean_hidden_mib"] = sum(totals) / totals.length;
    }
    for (const name of [
      "end+10s",
      "end+30s",
      "post-gc+2s",
      "post-gc+10s",
      "post-gc+30s",
    ]) {
      const sample = byPhase.get(name);
      if (sample) footprintMetrics(metrics, name, sample);
    }
    const at = (name: string) => totalBytes(byPhase.get(name) as Sample);
    if (byPhase.has("baseline") && byPhase.has("end+30s"))
      metrics["footprint.settle_delta_vs_baseline_mib"] =
        (at("end+30s") - at("baseline")) / MIB;
    if (byPhase.has("end+30s") && byPhase.has("post-gc+30s"))
      metrics["footprint.gc_recovered_mib"] =
        (at("end+30s") - at("post-gc+30s")) / MIB;
    else if (byPhase.has("end+30s") && byPhase.has("post-gc+10s"))
      metrics["footprint.gc_recovered_mib"] =
        (at("end+30s") - at("post-gc+10s")) / MIB;
    const last: LabEvent = samples.length
      ? samples[samples.length - 1].event
      : {};
    const canvases = dict(last.canvases);
    for (const key of JS_COUNTERS)
      if (key in canvases) metrics[`js.${key}`] = canvases[key] as number;
    metrics["js.domCanvases_max"] = maxOf(
      samples.map((s) => num(get(dict(s.event.canvases), "domCanvases", 0))),
    );
    const presentation = dict(last.presentation);
    metrics["js.reclamations"] = get(presentation, "reclamations", 0) as number;
    metrics["js.presentation_transitions"] = get(
      presentation,
      "transitions",
      0,
    ) as number;
    poolMetrics(metrics, last);
    // cycle -> (occluded, reclaimed); control runs carry these on the visible sample
    const perCycle = new Map<number, [boolean, boolean]>();
    for (const [, s] of [...hidden, ...visible]) {
      const event = s.event;
      if (!("hide" in event) && !("reclaimedThisCycle" in event)) continue;
      const [occluded, reclaimed] = perCycle.get(event.cycle as number) ?? [
        false,
        false,
      ];
      const hide = dict(event.hide);
      perCycle.set(event.cycle as number, [
        occluded || (truthy(hide.occluded) && truthy(hide.ok)),
        reclaimed || num(get(event, "reclaimedThisCycle", 0)) > 0,
      ]);
    }
    metrics["cycles.occluded"] = [...perCycle.values()].filter(
      ([o]) => o,
    ).length;
    metrics["cycles.reclaimed"] = [...perCycle.values()].filter(
      ([, r]) => r,
    ).length;
    // CPU/energy while hidden vs while visible, time-weighted over every cycle.
    const hiddenIntervals: (Interval | null)[] = [];
    const visibleIntervals: (Interval | null)[] = [];
    let previous: Sample | undefined = base;
    for (
      let index = 0;
      index < Math.min(hidden.length, visible.length);
      index++
    ) {
      const h = hidden[index][1];
      const v = visible[index][1];
      if (previous) hiddenIntervals.push(interval(previous, h));
      visibleIntervals.push(interval(h, v));
      previous = v;
    }
    if (hidden.length) {
      addIntervalMetrics(metrics, "hidden", aggregate(hiddenIntervals));
      addIntervalMetrics(metrics, "visible", aggregate(visibleIntervals));
    } else if (base && visible.length) {
      // control runs take no hidden sample: report the whole loop
      addIntervalMetrics(
        metrics,
        "cycles",
        interval(base, visible[visible.length - 1][1]),
      );
    }
    return metrics;
  }

  if (workload === "move" || workload === "resize") {
    const named = samples.filter(
      (s) => !["blank", "done"].includes(phaseOf(s)),
    );
    for (const sample of named)
      footprintMetrics(metrics, phaseOf(sample), sample);
    const totals = named.map((s) => totalBytes(s) / MIB);
    metrics["footprint.max_mib"] = maxOf(totals);
    if (workload === "resize") resizeMetrics(metrics, byPhase, named);
    if (byPhase.has("baseline") && byPhase.has("settle+30s"))
      metrics["footprint.growth_total_mib"] =
        (totalBytes(byPhase.get("settle+30s") as Sample) -
          totalBytes(byPhase.get("baseline") as Sample)) /
        MIB;
    const last = samples[samples.length - 1].event;
    const canvases = dict(last.canvases);
    for (const key of JS_COUNTERS)
      if (key in canvases) metrics[`js.${key}`] = canvases[key] as number;
    metrics["js.reclamations"] = get(
      dict(last.presentation),
      "reclamations",
      0,
    ) as number;
    poolMetrics(metrics, last);
    for (const [key, value] of Object.entries(dict(dict(last.native).counters)))
      metrics[`native.${key}`] = value as number;
    const steps = samples.filter(
      (s) => phaseOf(s).startsWith("steps-") && phaseOf(s) !== "steps-settled",
    );
    const jumps = samples.filter(
      (s) => phaseOf(s).startsWith("jumps-") && phaseOf(s) !== "jumps-settled",
    );
    if (byPhase.has("baseline") && steps.length)
      addIntervalMetrics(
        metrics,
        "steps",
        interval(byPhase.get("baseline") as Sample, steps[steps.length - 1]),
      );
    if (byPhase.has("steps-settled") && jumps.length)
      addIntervalMetrics(
        metrics,
        "jumps",
        interval(
          byPhase.get("steps-settled") as Sample,
          jumps[jumps.length - 1],
        ),
      );
    return metrics;
  }

  // agents / idle
  const start = byPhase.get("measure-start");
  const end = byPhase.get("measure-end");
  if (!start || !end) return metrics;
  footprintMetrics(metrics, "start", start);
  footprintMetrics(metrics, "end", end);
  metrics["footprint.delta_mib"] = (totalBytes(end) - totalBytes(start)) / MIB;
  const window = interval(start, end);
  addIntervalMetrics(metrics, "window", window);
  if (window)
    for (const [role, value] of byKey(Object.entries(window.wakeups_per_s)))
      metrics[`window.wakeups_per_s.${role}`] = value;
  const a = start.event;
  const b = end.event;
  const seconds = window ? window.seconds : (end.tMonoNs - start.tMonoNs) / 1e9;
  const driverA = dict(a.driver);
  const driverB = dict(b.driver);
  const renders =
    num(get(driverB, "renders", 0)) - num(get(driverA, "renders", 0));
  if (renders) {
    metrics["driver.renders_per_s"] = divide(renders, seconds);
    metrics["driver.kib_per_s"] = divide(
      (num(driverB.bytes) - num(driverA.bytes)) / 1024,
      seconds,
    );
    metrics["driver.model_write_ms_per_s"] = divide(
      num(driverB.writeMs) - num(driverA.writeMs),
      seconds,
    );
    const samplesLag = num(driverB.lagSamples) - num(driverA.lagSamples);
    if (samplesLag)
      metrics["driver.timer_lag_mean_ms"] =
        (num(driverB.lagSumMs) - num(driverA.lagSumMs)) / samplesLag;
    metrics["driver.timer_lag_max_ms"] = driverB.lagMaxMs as number;
  }
  const surfacesA = a.surfaces || [];
  const surfacesB = b.surfaces || [];
  const pairs = Math.min(surfacesA.length, surfacesB.length);
  const frameDeltas: number[] = [];
  const uploadDeltas: number[] = [];
  for (let index = 0; index < pairs; index++) {
    const s1 = surfacesA[index];
    const s2 = surfacesB[index];
    if (truthy(get(s2, "visible")))
      frameDeltas.push(num(s2.frames) - num(s1.frames));
    uploadDeltas.push(num(s2.uploadedBytes) - num(s1.uploadedBytes));
  }
  const visibleFrames = sum(frameDeltas);
  metrics["renderer.visible_frames_per_s"] = divide(visibleFrames, seconds);
  metrics["renderer.uploaded_kib_per_s"] = divide(
    sum(uploadDeltas) / 1024,
    seconds,
  );
  const timingA = a.renderTiming || [];
  const timingB = b.renderTiming || [];
  const timing: number[] = [];
  for (let index = 0; index < Math.min(timingA.length, timingB.length); index++)
    timing.push(timingB[index].milliseconds - timingA[index].milliseconds);
  metrics["renderer.render_callback_ms_per_s"] = divide(sum(timing), seconds);
  const gpuA = dict(a.gpu);
  const gpuB = dict(b.gpu);
  if (truthy(gpuA) && truthy(gpuB)) {
    metrics["renderer.gpu_submissions_per_s"] = divide(
      num(gpuB.submittedFrames) - num(gpuA.submittedFrames),
      seconds,
    );
    metrics["renderer.atlas_uploads"] =
      num(gpuB.atlasUploads) - num(gpuA.atlasUploads);
    // Wakeup accounting (renderers that predate these counters leave the metrics out).
    for (const [key, name] of [
      ["animationFrames", "animation_frames"],
      ["idleAnimationFrames", "idle_animation_frames"],
      ["timerWakeups", "timer_wakeups"],
      ["workDoneWaits", "work_done_waits"],
    ])
      if (key in gpuA && key in gpuB)
        metrics[`renderer.${name}_per_s`] = divide(
          num(gpuB[key]) - num(gpuA[key]),
          seconds,
        );
    if ("animationFrames" in gpuA && "animationFrames" in gpuB) {
      const rate = (name: string) => {
        if (!(name in metrics)) throw new RangeError(`missing metric ${name}`);
        return metrics[name];
      };
      metrics["renderer.page_wakeups_per_s"] =
        rate("renderer.animation_frames_per_s") +
        rate("renderer.timer_wakeups_per_s") +
        rate("renderer.work_done_waits_per_s");
    }
    if ("stalledFrameRequests" in gpuA && "stalledFrameRequests" in gpuB)
      metrics["renderer.stalled_frame_requests_per_s"] = divide(
        num(gpuB.stalledFrameRequests) - num(gpuA.stalledFrameRequests),
        seconds,
      );

    const meanDelta = (path: string[], name: string) => {
      const pick = (gpu: Dict): Dict | null => {
        let node: unknown = gpu;
        for (const key of path) node = get(dict(node), key);
        return node as Dict | null;
      };
      const before = pick(gpuA);
      const after = pick(gpuB);
      if (
        truthy(before) &&
        truthy(after) &&
        num(after?.count) > num(before?.count)
      ) {
        metrics[`renderer.${name}_mean_ms`] =
          (num(after?.sumMs) - num(before?.sumMs)) /
          (num(after?.count) - num(before?.count));
        metrics[`renderer.${name}_max_ms`] = after?.maxMs as number;
      }
    };
    meanDelta(["workDoneLatency"], "workdone_latency");
    meanDelta(["frameLatency", "focused"], "frame_latency_focused");
    meanDelta(["frameLatency", "background"], "frame_latency_background");
    const submissions = num(gpuB.submittedFrames) - num(gpuA.submittedFrames);
    if (submissions)
      metrics["renderer.panes_per_submission"] = visibleFrames / submissions;
  }
  const beats = (b.heartbeats || []) as Dict[];
  metrics["qualification.heartbeats_unfocused"] = beats.filter(
    (h) => !truthy(get(h, "hasFocus")) || get(h, "visibility") !== "visible",
  ).length;
  return metrics;
}

// ---------------------------------------------------------------------------------------------
// Human summaries
// ---------------------------------------------------------------------------------------------

export function table(
  headers: string[],
  rows: string[][],
  indent = "  ",
): string {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) =>
    Math.max(...all.map((row) => row[i].length)),
  );
  const lines: string[] = [];
  all.forEach((row, index) => {
    const cells = row.map((cell, i) => {
      if (i >= widths.length) throw new RangeError("list index out of range");
      return i === 0 ? cell.padEnd(widths[0]) : cell.padStart(widths[i]);
    });
    lines.push(indent + cells.join("  "));
    if (index === 0)
      lines.push(indent + widths.map((w) => "-".repeat(w)).join("  "));
  });
  return lines.join("\n");
}

const mib = (value: number | null) =>
  value === null ? "-" : fixed(value, 1, { group: true });

function gfx(sample: Sample): string {
  const web = graphicsMib(sample, "web_content");
  const gpu = graphicsMib(sample, "gpu");
  return web === null && gpu === null
    ? "-"
    : `${fixed(web || 0, 0, { group: true })}/${fixed(gpu || 0, 0, { group: true })}`;
}

function footprintRow(
  sample: Sample,
  roles: string[],
  name: string | null = null,
  previous: Sample | null = null,
): string[] {
  const values = footprintByRole(sample);
  const total = totalBytes(sample) / MIB;
  const row = [
    name || phaseOf(sample),
    ...roles.map((role) => mib((values[role] ?? 0) / MIB)),
    mib(total),
  ];
  row.push(
    previous === null
      ? ""
      : fixed(total - totalBytes(previous) / MIB, 1, {
          sign: true,
          group: true,
        }),
  );
  return row;
}

export type IntervalRow = {
  seconds: number;
  cpu_pct: Record<string, number>;
  cpu_pct_total: number;
  window_server_cpu_pct?: number | null;
  energy_j_per_min: Record<string, number>;
  energy_j_per_min_total?: number | null;
};

function intervalRows(
  pairs: [string, IntervalRow | null][],
  roles: string[],
): string[][] {
  const rows: string[][] = [];
  for (const [name, value] of pairs) {
    if (!value || !truthy(value)) continue;
    const row = [name, fixed(value.seconds, 1)];
    row.push(...roles.map((role) => fixed(get(value.cpu_pct, role, 0), 2)));
    row.push(fixed(value.cpu_pct_total, 2));
    row.push(
      value.window_server_cpu_pct === null ||
        value.window_server_cpu_pct === undefined
        ? "-"
        : fixed(value.window_server_cpu_pct, 2),
    );
    row.push(
      ...roles.map((role) =>
        role in value.energy_j_per_min
          ? fixed(value.energy_j_per_min[role], 2)
          : "-",
      ),
    );
    row.push(
      value.energy_j_per_min_total === null ||
        value.energy_j_per_min_total === undefined
        ? "-"
        : fixed(value.energy_j_per_min_total, 2),
    );
    rows.push(row);
  }
  return rows;
}

export function intervalTable(
  pairs: [string, IntervalRow | null][],
  roles: string[],
  labels: Readonly<Record<string, string>> = ROLE_LABEL,
): string {
  const headers = [
    "interval",
    "sec",
    ...roles.map((r) => `cpu% ${label(r, labels)}`),
    "cpu% sum",
    "cpu% WS",
    ...roles.map((r) => `J/min ${label(r, labels)}`),
    "J/min sum",
  ];
  const rows = intervalRows(pairs, roles);
  return rows.length
    ? table(headers, rows)
    : "  (no CPU/energy counters in this report)";
}

/** A load average list as Python printed it (its entries are always floats). */
export function loadAverageText(value: unknown): string {
  return Array.isArray(value) && value.every((v) => typeof v === "number")
    ? `[${value.map(floatRepr).join(", ")}]`
    : pyStr(value);
}

export function summarize(full: Report): string {
  const report = usable(full);
  const workload = workloadOf(report);
  const samples = report.samples;
  const roles = rolesPresent(samples);
  const config = dict(report.config);
  const out = [
    `== renderer lab: ${workload} ==${truthy(config.label) ? ` [${pyStr(config.label)}]` : ""}`,
  ];
  out.push(
    `  source ${pyStr(report.sourceRevision ?? null)}  diff ${head(pyStr(report.sourceDiffSha256 ?? null), 12)}  qualified: ${pyStr(get(get(report, "qualification", {}), "qualified", "n/a"))}`,
  );
  const headers = [
    "phase",
    ...roles.map((r) => label(r)),
    "TOTAL MiB",
    "delta",
  ];
  const byPhase = sampleByPhase(report);

  if (
    workload === "occlusion" ||
    workload === "canvas" ||
    workload === "tabs"
  ) {
    const mode = get(config, "occlusionMode", "orderout");
    if (workload === "canvas")
      out.push(
        `  raw WebGPU canvas probe, variant '${pyStr(get(config, "variant"))}' (no Terax renderer)`,
      );
    if (workload === "tabs") {
      out.push(
        `  one-pane tab <-> four-pane tab; cycles ${pyStr(get(config, "cycles"))}; dwell ${pyStr(get(config, "dwellMs"))} ms on each tab per switch; ${pyStr(truthy(config.order) ? config.order : "hide-first")}${truthy(config.parkMs) ? `; park ${pyStr(config.parkMs)}` : ""}`,
      );
    } else {
      const forceGc = get(config, "forceGc");
      out.push(
        `  mode ${pyStr(mode)}; panes/tab ${pyStr(get(config, "panes"))}; cycles ${pyStr(get(config, "cycles"))}; hidden ${pyStr(get(config, "hiddenMs"))} ms; visible ${pyStr(get(config, "visibleMs"))} ms` +
          (truthy(config.controlNoReclaim)
            ? "; CONTROL (no reclaim expected)"
            : "") +
          (forceGc !== null && forceGc !== "none"
            ? `; forced GC ${pyStr(forceGc)} (${pyStr(get(config, "gcWhen"))})`
            : ""),
      );
    }
    let rows: string[][] = [];
    let previous = byPhase.get("baseline") ?? null;
    if (previous) rows.push(footprintRow(previous, roles, "baseline"));
    const hidden = new Map(cycleSamples(report, "hidden"));
    const canvasCells = (canvases: Dict) => [
      `${pyStr(get(canvases, "contextCreated", "-"))}/${pyStr(get(canvases, "contextFinalized", "-"))}`,
      `${pyStr(get(canvases, "textureAcquired", "-"))}/${pyStr(get(canvases, "textureFinalized", "-"))}`,
      pyStr(get(canvases, "domCanvases", "-")),
    ];
    for (const [cycle, sample] of cycleSamples(report, "visible")) {
      const event = sample.event;
      const canvases = dict(event.canvases);
      const row = footprintRow(
        sample,
        roles,
        `cycle ${pyStr(cycle)} visible`,
        previous,
      );
      const hs = hidden.get(cycle);
      const hiddenTotal = hs ? mib(totalBytes(hs) / MIB) : "-";
      row.push(
        gfx(sample),
        hiddenTotal,
        ...canvasCells(canvases),
        pyStr(get(dict(event.presentation), "reclamations", "-")),
      );
      rows.push(row);
      previous = sample;
    }
    for (const name of [
      "cycles-complete",
      "end+10s",
      "end+30s",
      "post-gc+2s",
      "post-gc+10s",
      "post-gc+30s",
    ]) {
      const sample = byPhase.get(name);
      if (!sample) continue;
      const canvases = dict(sample.event.canvases);
      rows.push([
        ...footprintRow(sample, roles, name, previous),
        gfx(sample),
        "-",
        ...canvasCells(canvases),
        "-",
      ]);
      previous = sample;
    }
    const width = headers.length;
    rows = rows.map((row) => [
      ...row,
      ...new Array<string>(Math.max(0, width + 6 - row.length)).fill(""),
    ]);
    out.push(
      "\nFootprint after each cycle (MiB; hidden = total sampled at the end of the hidden hold;",
    );
    out.push(
      "ctx/tex = WebGPU canvas contexts and swapchain textures created/finalized by JS GC; DOM = canvases in the document;",
    );
    out.push(
      "gfx = vmmap 'owned unmapped (graphics)' of WebContent/GPU, MiB, when recorded):",
    );
    out.push(
      table(
        [
          ...headers,
          "gfx WC/GPU",
          "hidden",
          "ctx new/gc",
          "tex new/gc",
          "DOM",
          "reclaims",
        ],
        rows,
      ),
    );
    const metrics = computeMetrics(report);
    out.push(
      `\nCycles occluded / reclaimed by the presentation policy: ${Math.trunc(num(get(metrics, "cycles.occluded", 0)))} / ${Math.trunc(num(get(metrics, "cycles.reclaimed", 0)))} of ${pyStr(get(config, "cycles"))}`,
    );
    if ("footprint.growth_mib_per_cycle" in metrics)
      out.push(
        `Visible-footprint trend: ${fixed(metrics["footprint.growth_mib_per_cycle"], 2, { sign: true })} MiB/cycle; first->last visible ${fixed(get(metrics, "footprint.growth_total_mib", Number.NaN), 1, { sign: true })} MiB`,
      );
    if ("pool.created" in metrics) out.push(poolLine(metrics));
    const pairs: [string, IntervalRow | null][] = [];
    for (const name of ["hidden", "visible", "cycles"]) {
      const seconds = get(metrics, `${name}.seconds`);
      if (seconds === null) continue;
      const energy: Record<string, number> = {};
      for (const r of roles)
        if (`${name}.energy_j_per_min.${r}` in metrics)
          energy[r] = metrics[`${name}.energy_j_per_min.${r}`];
      pairs.push([
        name,
        {
          seconds: seconds as number,
          cpu_pct: Object.fromEntries(
            roles.map((r) => [r, num(get(metrics, `${name}.cpu_pct.${r}`, 0))]),
          ),
          cpu_pct_total: num(get(metrics, `${name}.cpu_pct.total`, 0)),
          window_server_cpu_pct: get(
            metrics,
            `${name}.cpu_pct.window_server`,
          ) as number | null,
          energy_j_per_min: energy,
          energy_j_per_min_total: get(
            metrics,
            `${name}.energy_j_per_min.total`,
          ) as number | null,
        },
      ]);
    }
    out.push("\nCPU / energy, time-weighted over all cycles:");
    out.push(intervalTable(pairs, roles));
  } else if (workload === "move" || workload === "resize") {
    out.push(
      `  steps ${pyStr(get(config, "steps"))}, jumps ${pyStr(get(config, "jumps"))}`,
    );
    const rows: string[][] = [];
    let previous: Sample | null = null;
    for (const sample of samples) {
      if (["blank", "done"].includes(phaseOf(sample))) continue;
      rows.push(footprintRow(sample, roles, null, previous));
      previous = sample;
    }
    out.push("\nFootprint by phase (MiB):");
    out.push(table(headers, rows));
    const pairs: [string, IntervalRow | null][] = [];
    const steps = samples.filter(
      (s) => phaseOf(s).startsWith("steps-") && phaseOf(s) !== "steps-settled",
    );
    const jumps = samples.filter(
      (s) => phaseOf(s).startsWith("jumps-") && phaseOf(s) !== "jumps-settled",
    );
    if (byPhase.has("baseline") && steps.length)
      pairs.push([
        `${pyStr(get(config, "steps"))} steps`,
        interval(byPhase.get("baseline") as Sample, steps[steps.length - 1]),
      ]);
    if (byPhase.has("steps-settled") && jumps.length)
      pairs.push([
        `${pyStr(get(config, "jumps"))} jumps`,
        interval(
          byPhase.get("steps-settled") as Sample,
          jumps[jumps.length - 1],
        ),
      ]);
    out.push("\nCPU / energy:");
    out.push(intervalTable(pairs, roles));
    const metrics = computeMetrics(report);
    out.push(
      `\nJS: WebGPU contexts created ${pyStr(get(metrics, "js.contextCreated", "-"))} / finalized ${pyStr(get(metrics, "js.contextFinalized", "-"))}; reclamations ${pyStr(get(metrics, "js.reclamations", "-"))}; native didMove ${pyStr(get(metrics, "native.didMove", "-"))}, occlusion changes ${pyStr(get(metrics, "native.occlusionChanges", 0))}`,
    );
    if ("pool.created" in metrics) out.push(poolLine(metrics));
    if ("resize.gestures" in metrics)
      out.push(
        `Resize gestures ${pyStr(metrics["resize.gestures"])}: peak WebContent ${fixed(metrics["resize.peak_web_content_mib"], 1)} MiB, peak total ${fixed(metrics["resize.peak_total_mib"], 1)} MiB; backing-store resizes per gesture max ${pyStr(get(metrics, "resize.backing_store_resizes_per_gesture.max", "-"))} mean ${fixed(get(metrics, "resize.backing_store_resizes_per_gesture.mean", 0), 1)}${
          "resize.grid_resizes_per_gesture.mean" in metrics
            ? `; grid resizes per gesture mean ${fixed(metrics["resize.grid_resizes_per_gesture.mean"], 1)} (deferred ${fixed(get(metrics, "resize.deferred_grid_resizes_per_gesture.mean", 0), 1)})`
            : ""
        }`,
      );
  } else if (workload === "agents" || workload === "idle") {
    out.push(
      `  visible panes ${pyStr(get(config, "panes"))}; hidden models ${pyStr(get(config, "hidden"))}; measured ${pyStr(get(config, "duration"))} s after ${pyStr(get(config, "warmup"))} s warm-up; cursor blink ${pyStr(get(config, "blink"))}`,
    );
    const rows: string[][] = [];
    let previous: Sample | null = null;
    for (const sample of samples) {
      if (["blank", "done"].includes(phaseOf(sample))) continue;
      rows.push(footprintRow(sample, roles, null, previous));
      previous = sample;
    }
    out.push("\nFootprint by phase (MiB):");
    out.push(table(headers, rows));
    const start = byPhase.get("measure-start");
    const end = byPhase.get("measure-end");
    const pairs: [string, IntervalRow | null][] =
      start && end ? [["measured window", interval(start, end)]] : [];
    out.push("\nCPU% (of one core) and energy over the measured window:");
    out.push(intervalTable(pairs, roles));
    const metrics = computeMetrics(report);
    for (const key of [
      "window.power_mw.total",
      "window.wakeups_per_s.total",
      "driver.renders_per_s",
      "driver.kib_per_s",
      "driver.timer_lag_mean_ms",
      "renderer.visible_frames_per_s",
      "renderer.gpu_submissions_per_s",
      "renderer.panes_per_submission",
      "renderer.animation_frames_per_s",
      "renderer.idle_animation_frames_per_s",
      "renderer.timer_wakeups_per_s",
      "renderer.work_done_waits_per_s",
      "renderer.page_wakeups_per_s",
      "renderer.stalled_frame_requests_per_s",
      "renderer.workdone_latency_mean_ms",
      "renderer.frame_latency_focused_mean_ms",
      "renderer.frame_latency_background_mean_ms",
      "renderer.render_callback_ms_per_s",
    ])
      if (key in metrics) out.push(`  ${key}: ${fixed(metrics[key], 2)}`);
  } else {
    const rows: string[][] = [];
    let previous: Sample | null = null;
    for (const sample of samples) {
      rows.push(footprintRow(sample, roles, null, previous));
      previous = sample;
    }
    out.push(table(headers, rows));
  }
  const qualification = dict(report.qualification) as Qualification;
  for (const advisory of qualification.advisories || [])
    out.push(`\nADVISORY: ${advisory}`);
  if (truthy(qualification.failures)) {
    const failures = qualification.failures ?? [];
    out.push("\nQUALIFICATION FAILURES (results are not valid evidence):");
    for (const failure of failures.slice(0, 12))
      out.push(`  - ${failure.phase}: ${failure.reasons.join("; ")}`);
    if (failures.length > 12) out.push(`  ... ${failures.length - 12} more`);
  }
  for (const warning of (report.warnings || []).slice(0, 8))
    out.push(`  warning: ${warning}`);
  const environment = get(report, "environment", {});
  out.push(
    `\n  host ${pyStr(get(environment, "chip", "?"))}; load average at start ${loadAverageText(get(environment, "loadAverageStart"))}; end ${loadAverageText(get(environment, "loadAverageEnd"))}`,
  );
  out.push(`  scope: ${pyStr(get(report, "scope"))}`);
  return out.join("\n");
}

function poolLine(metrics: Metrics): string {
  return `Renderer canvas pool: created ${pyStr(get(metrics, "pool.created"))}, reused ${pyStr(get(metrics, "pool.reused"))}, reconfigured ${pyStr(get(metrics, "pool.reconfigured"))}, destroyed ${pyStr(get(metrics, "pool.destroyed"))}; backing-store resizes ${pyStr(get(metrics, "renderer.backing_store_resizes", "-"))}`;
}

// ---------------------------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------------------------

export function formatMetric(value: number | null): string {
  if (value === null) return "-";
  return Math.abs(Number(value)) < 100000
    ? fixed(value, 2, { group: true })
    : fixed(value, 0, { group: true });
}

/** Per-metric median across repeated runs (a single report returns its own metrics). */
export function medianMetrics(
  reports: Report[],
  compute: (report: Report) => Metrics = computeMetrics,
): Metrics {
  const perReport = reports.map(compute);
  const names = Object.keys(perReport[0]).filter((name) =>
    perReport.every((other) => name in other),
  );
  return Object.fromEntries(
    names.map((name) => [name, median(perReport.map((m) => num(m[name])))]),
  );
}

export function compare(
  baseline: Report | Report[],
  candidate: Report | Report[],
): string {
  const baselines = Array.isArray(baseline) ? baseline : [baseline];
  const candidates = Array.isArray(candidate) ? candidate : [candidate];
  const first = baselines[0];
  const second = candidates[0];
  const baseMetrics = medianMetrics(baselines);
  const candidateMetrics = medianMetrics(candidates);
  const names = [
    ...Object.keys(baseMetrics),
    ...Object.keys(candidateMetrics).filter((name) => !(name in baseMetrics)),
  ];
  const out = [
    `== comparison: ${workloadOf(first)} (baseline ${head(pyStr(get(first, "sourceRevision")), 10)} x${baselines.length} -> candidate ${head(pyStr(get(second, "sourceRevision")), 10)} x${candidates.length}; medians when repeated) ==`,
  ];
  if (workloadOf(first) !== workloadOf(second))
    out.push("  warning: workloads differ; matching metric names only");
  for (const key of [
    "panes",
    "hidden",
    "cycles",
    "occlusionMode",
    "duration",
    "blink",
  ]) {
    const a = get(dict(first.config), key);
    const b = get(dict(second.config), key);
    if (!pyEqual(a, b))
      out.push(`  warning: config ${key} differs (${pyStr(a)} vs ${pyStr(b)})`);
  }
  for (const [name, group] of [
    ["baseline", baselines],
    ["candidate", candidates],
  ] as const) {
    const failed = group.filter(
      (report) => !truthy(get(dict(report.qualification), "qualified", true)),
    ).length;
    if (failed)
      out.push(
        `  warning: ${failed} of ${group.length} ${name} reports failed qualification`,
      );
  }
  const rows: string[][] = [];
  for (const name of names) {
    const a = name in baseMetrics ? baseMetrics[name] : null;
    const b = name in candidateMetrics ? candidateMetrics[name] : null;
    if (a === null && b === null) continue;
    const delta = a === null || b === null ? null : b - a;
    const percent =
      delta === null || a === 0 || a === null
        ? ""
        : `${fixed((100 * delta) / Math.abs(a), 1, { sign: true })}%`;
    rows.push([
      name,
      formatMetric(a),
      formatMetric(b),
      delta === null ? "-" : fixed(delta, 2, { sign: true, group: true }),
      percent,
    ]);
  }
  out.push(table(["metric", "baseline", "candidate", "delta", "%"], rows));
  return out.join("\n");
}

/** Python's `round(value, 4)` for every float metric (integers are stored as they are). */
export function roundMetrics(metrics: Metrics): Metrics {
  return Object.fromEntries(
    Object.entries(metrics).map(([name, value]) => [
      name,
      typeof value === "number" &&
      !Number.isInteger(value) &&
      Number.isFinite(value)
        ? Number(fixed(value, 4))
        : value,
    ]),
  );
}

export function load(path: string): Report {
  const report = JSON.parse(readFileSync(path, "utf8")) as Report;
  if (Array.isArray(report.humanSummary))
    report.humanSummary = report.humanSummary.join("\n");
  return report;
}

/** Readable but compact JSON: summaries and metrics pretty-printed, raw samples one per line. */
export function dump(report: Dict): string {
  const parts: string[] = [];
  for (let [key, value] of Object.entries(report)) {
    if (
      ["samples", "series", "nativeEvents"].includes(key) &&
      Array.isArray(value)
    ) {
      const body = value.map((item) => `  ${JSON.stringify(item)}`).join(",\n");
      parts.push(` ${JSON.stringify(key)}: [\n${body}\n ]`);
      continue;
    }
    if (key === "humanSummary" && typeof value === "string")
      value = splitLines(value);
    parts.push(
      ` ${JSON.stringify(key)}: ${(JSON.stringify(value, null, 1) ?? "null").replaceAll("\n", "\n ")}`,
    );
  }
  return asciiJson(`{\n${parts.join(",\n")}\n}\n`);
}
