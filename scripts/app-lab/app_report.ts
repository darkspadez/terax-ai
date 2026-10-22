// Samples, metrics, human summaries and baseline comparison for app-lab reports.
//
// CPU/energy intervals, tables and report (de)serialization are shared with the renderer lab
// (`scripts/renderer-profile/lab_report.ts`); everything else here is specific to the real
// application: per-category footprint (WebKit malloc, IOSurface owned/shared/reclaimable, graphics)
// per process, `vmmap` regions and the in-app diagnostics the scenario driver attached to each event.
//
// Run directly, it prints one comparable line per report (WebContent MiB):
//
//   bun scripts/app-lab/app_report.ts REPORT.json [...]

import { basename, extname } from "node:path";
import { runMain, SystemExit } from "../lib/errors.ts";
import {
  fixed,
  fmean,
  head,
  maxOf,
  median,
  minOf,
  pyEqual,
  pyStr,
  roundHalfEven,
  splitLines,
  sum,
  truthy,
} from "../lib/format.ts";
import { capture } from "../lib/process.ts";
import {
  type CounterSample,
  type Dict,
  dict,
  get,
  type Interval,
  type IntervalRow,
  interval,
  intervalTable,
  dump as labDump,
  load as labLoad,
  roundMetrics as labRoundMetrics,
  loadAverageText,
  type Metrics,
  MIB,
  type Qualification,
  slope,
  table,
} from "../renderer-profile/lab_report.ts";
import {
  ROLE_LABEL,
  type Rusage,
  type VmmapSummary,
} from "../renderer-profile/procstats.ts";

export const SCENARIOS = [
  "tabs",
  "resize",
  "split-drag",
  "occlusion",
  "agents-steady",
  "idle",
  "fs-churn",
  "input",
] as const;
export const ROLES = ["host", "web_content", "gpu", "networking"];
export const ROLE_LABELS: Readonly<Record<string, string>> = {
  host: "host",
  web_content: "WebContent",
  gpu: "GPU",
  networking: "Network",
  workload: "PTY-procs",
  web_content_prewarmed: "WC-prewarm",
};
/** Interval table headers: the renderer lab's labels plus the PTY processes. */
const INTERVAL_LABELS: Readonly<Record<string, string>> = {
  ...ROLE_LABEL,
  workload: "PTY-procs",
};
// Footprint categories worth a column; everything else is rolled into the process total.
export const KEY_CATEGORIES = [
  "WebKit malloc",
  "IOSurface",
  "Owned physical footprint (unmapped) (graphics)",
  "IOAccelerator",
  "IOAccelerator (graphics)",
  "CoreAnimation",
  "JS VM Gigacage",
  "JS JIT generated code",
  "untagged (VM_ALLOCATE)",
  "MALLOC_SMALL",
  "MALLOC_LARGE",
  "MALLOC_TINY",
  "Accelerate image backing stores",
];
export const SHORT: Readonly<Record<string, string>> = {
  "WebKit malloc": "malloc",
  IOSurface: "iosurf",
  "Owned physical footprint (unmapped) (graphics)": "gfx-unmapped",
  IOAccelerator: "ioaccel",
  "IOAccelerator (graphics)": "ioaccel-gfx",
  CoreAnimation: "coreanim",
  "JS VM Gigacage": "gigacage",
  "JS JIT generated code": "jit",
  "untagged (VM_ALLOCATE)": "vm_alloc",
  MALLOC_SMALL: "m_small",
  MALLOC_LARGE: "m_large",
  MALLOC_TINY: "m_tiny",
  "Accelerate image backing stores": "accel-img",
};

// ---------------------------------------------------------------------------------------------
// Report shapes
// ---------------------------------------------------------------------------------------------

/** [dirty, swapped, clean, reclaimable, wired, regions] */
export type CategoryRow = number[];

export type CompactFootprint = {
  total: number;
  byRole: Record<string, number>;
  processes: {
    pid: number;
    role: string;
    name: string;
    footprint: number;
    peak: number | null;
    categories: Record<string, CategoryRow>;
  }[];
  shared: {
    pids: number[] | null;
    specific: number | null;
    categories: Record<string, CategoryRow>;
  }[];
};

export type AppEvent = {
  phase?: string;
  step?: string;
  cycle?: number;
  diag?: Dict | null;
  native?: Dict | null;
  hide?: Dict | null;
  show?: Dict | null;
  smooth?: unknown;
  tWall?: number;
  switchedAt?: number | null;
  attempt?: number;
  unfocused?: boolean;
  [key: string]: unknown;
};

export type AppSample = CounterSample & {
  phase?: string;
  light?: boolean;
  tWall?: number;
  event: AppEvent;
  footprint?: CompactFootprint;
  footprintByRole?: Record<string, number>;
  footprintTotal?: number;
  vmmap?: Record<string, ReturnType<typeof compactVmmap>> | null;
  [key: string]: unknown;
};

export type AppReport = {
  config?: Dict | null;
  sourceRevision?: string | null;
  qualification?: Qualification | null;
  environment?: Dict | null;
  scope?: string;
  samples: AppSample[];
  series?: { tWall: number; processes: Record<string, Dict> }[] | null;
  metrics?: Metrics | null;
  humanSummary?: string | string[];
  [key: string]: unknown;
};

const num = (value: unknown) => Number(value);
const isNumeric = (value: unknown): value is number | boolean =>
  typeof value === "number" || typeof value === "boolean";

// ---------------------------------------------------------------------------------------------
// Compaction of raw tool output (kept small: reports are committed as evidence)
// ---------------------------------------------------------------------------------------------

const CATEGORY_KEYS = [
  "dirty",
  "swapped",
  "clean",
  "reclaimable",
  "wired",
  "regions",
];

function categoryRow(entry: Dict): CategoryRow {
  return CATEGORY_KEYS.map((key) => get(entry, key, 0) as number);
}

function nonzeroCategories(categories: unknown): Record<string, CategoryRow> {
  const result: Record<string, CategoryRow> = {};
  for (const [name, entry] of Object.entries(dict(categories))) {
    const row = categoryRow(entry as Dict);
    if (row.slice(0, 5).some(truthy)) result[name] = row;
  }
  return result;
}

/** footprint -j, reduced to non-zero categories. Rows are [dirty, swapped, clean, reclaimable, wired, regions]. */
export function compactFootprint(
  raw: Dict,
  members: ReadonlyMap<number, string>,
): CompactFootprint {
  const processes: CompactFootprint["processes"] = [];
  const byRole: Record<string, number> = {};
  for (const process of raw.processes as Dict[]) {
    const pid = process.pid as number;
    const role = members.has(pid)
      ? (members.get(pid) as string)
      : (process.name as string);
    byRole[role] = (byRole[role] ?? 0) + (process.footprint as number);
    processes.push({
      pid,
      role,
      name: process.name as string,
      footprint: process.footprint as number,
      peak: get(dict(process.auxiliary), "phys_footprint_peak") as
        | number
        | null,
      categories: nonzeroCategories(process.categories),
    });
  }
  const shared: CompactFootprint["shared"] = [];
  for (const group of (raw.shared || []) as Dict[]) {
    const categories = nonzeroCategories(group.categories);
    if (truthy(categories))
      shared.push({
        pids: get(group, "pids") as number[] | null,
        specific: get(group, "specific_to_pid") as number | null,
        categories,
      });
  }
  return { total: raw["total footprint"] as number, byRole, processes, shared };
}

const RUSAGE_KEYS = [
  "start_abstime",
  "cpu_ns",
  "pcpu_ns",
  "energy_nj",
  "interrupt_wakeups",
  "idle_wakeups",
  "instructions",
  "cycles",
  "phys_footprint",
] as const;

/** The rusage fields CPU/energy intervals need (the rest of the V6 struct is noise in a report). */
export function compactRusage(value: Rusage | Dict | null): Dict | null {
  if (!truthy(value) || !value) return value as Dict | null;
  const source = value as Dict;
  return Object.fromEntries(
    RUSAGE_KEYS.filter((key) => key in source).map((key) => [key, source[key]]),
  );
}

export function compactVmmap(summary: VmmapSummary | null): {
  physicalFootprint: number | null;
  regions: Record<string, VmmapSummary["regions"][string]>;
} | null {
  if (!summary || !truthy(summary)) return null;
  const regions = Object.fromEntries(
    Object.entries(summary.regions || {}).filter(
      ([, row]) =>
        row.virtual >= 1 << 20 || truthy(row.resident) || truthy(row.swapped),
    ),
  );
  return {
    physicalFootprint: get(summary, "physicalFootprint") as number | null,
    regions,
  };
}

const VMMAP_V_ROW =
  /^(?<name>\S.*?)\s+(?<start>[0-9a-f]{6,})-(?<end>[0-9a-f]{6,})\s+\[\s*(?<vsize>[\d.]+[KMGT]?)\s+(?<resident>[\d.]+[KMGT]?)\s+(?<dirty>[\d.]+[KMGT]?)\s+(?<swapped>[\d.]+[KMGT]?)\](?<rest>.*)$/;
const UNITS: Record<string, number> = {
  "": 1,
  K: 1 << 10,
  M: 1 << 20,
  G: 1 << 30,
  T: 2 ** 40,
};

function size(text: string): number {
  const unit = text[text.length - 1];
  const scaled = unit in UNITS && unit !== "";
  return roundHalfEven(
    Number(scaled ? text.slice(0, -1) : text) * UNITS[scaled ? unit : ""],
  );
}

export type IOSurfaceRegion = {
  bytes: number;
  resident: number;
  dirty: number;
  swapped: number;
  volatile: boolean;
  rest: string;
};

/** IOSurface regions of `vmmap -v` output: count, bytes by state, size histogram. */
export function parseIOSurfaces(text: string) {
  const regions: IOSurfaceRegion[] = [];
  for (const line of splitLines(text)) {
    const groups = VMMAP_V_ROW.exec(line)?.groups;
    if (groups && groups.name.trim() === "IOSurface")
      regions.push({
        bytes: Number(BigInt(`0x${groups.end}`) - BigInt(`0x${groups.start}`)),
        resident: size(groups.resident),
        dirty: size(groups.dirty),
        swapped: size(groups.swapped),
        volatile:
          groups.rest.includes("PURGE=V") ||
          groups.rest.toLowerCase().includes("purgeable"),
        rest: head(groups.rest.trim(), 60),
      });
  }
  const histogram: Record<string, number> = {};
  for (const region of regions) {
    const key = `${fixed(region.bytes / MIB, 2)}M`;
    histogram[key] = (histogram[key] ?? 0) + 1;
  }
  return {
    count: regions.length,
    bytes: sum(regions.map((r) => r.bytes)),
    resident: sum(regions.map((r) => r.resident)),
    dirty: sum(regions.map((r) => r.dirty)),
    volatile: sum(regions.filter((r) => r.volatile).map((r) => r.bytes)),
    histogram,
    sample: regions.slice(0, 3),
  };
}

/** IOSurface regions of a process from `vmmap -v`: count, bytes by state, size histogram. */
export async function vmmapIOSurfaces(
  pid: number,
): Promise<ReturnType<typeof parseIOSurfaces> | null> {
  const result = await capture(["vmmap", "-v", String(pid)], {
    timeoutSeconds: 60,
  });
  if (result.timedOut || result.status !== 0) return null;
  return parseIOSurfaces(result.stdout);
}

/** Numbers, booleans and short strings of a diagnostics object, `depth` levels deep. */
function prune(value: unknown, depth: number): unknown {
  if (Array.isArray(value))
    return depth > 0
      ? value.slice(0, 64).map((v) => prune(v, depth - 1))
      : null;
  if (value !== null && typeof value === "object") {
    if (depth <= 0) return null;
    const out: Dict = {};
    for (const [key, item] of Object.entries(value)) {
      const pruned = prune(item, depth - 1);
      if (pruned !== null && pruned !== undefined) out[key] = pruned;
    }
    return out;
  }
  if (typeof value === "string") return head(value, 80);
  return value ?? null;
}

/** The page event without the per-session diagnostics detail (kept: counts and sizes). */
export function slimEvent(event: AppEvent): AppEvent {
  const diag: Dict = { ...dict(event.diag) };
  diag.ghosttySessions = ((diag.ghosttySessions || []) as Dict[]).map(
    (session) => ({
      leafId: get(session, "leafId"),
      pty: get(session, "pty"),
      visible: get(session, "visible"),
      focused: get(session, "focused"),
      model: prune(get(session, "model"), 2),
      surface: prune(get(session, "surface"), 2),
    }),
  );
  return { ...event, diag };
}

// ---------------------------------------------------------------------------------------------
// Qualification
// ---------------------------------------------------------------------------------------------

/** Reasons this sample is not valid evidence for the phase it claims to measure. */
export function qualify(
  scenario: string,
  phase: string,
  event: AppEvent,
): string[] {
  if (["blank", "setup", "done", "error"].includes(phase)) return [];
  const native = dict(event.native);
  const diag = dict(event.diag);
  const reasons: string[] = [];
  if (scenario === "occlusion" && get(event, "step") === "hidden") {
    const hide = dict(event.hide);
    if (!truthy(hide.ok) || !truthy(hide.occluded))
      reasons.push(`window was not occluded by '${pyStr(get(hide, "mode"))}'`);
    if (truthy(native.occlusionVisible))
      reasons.push("AppKit still reports the window visible during the hold");
    if (get(diag, "visibility") !== "hidden")
      reasons.push(
        `document.visibilityState=${pyStr(get(diag, "visibility"))} during the hold`,
      );
    return reasons;
  }
  // `unfocused` scenarios move another application to the front on purpose (a window that stays
  // visible but is not key, like an app left behind another one); occlusion still disqualifies.
  const unfocused = truthy(event.unfocused);
  if (!truthy(native.appActive) && !unfocused)
    reasons.push("application is not active");
  if (!truthy(native.key) && !unfocused)
    reasons.push("benchmark window is not key");
  if (!truthy(native.occlusionVisible)) reasons.push("window is occluded");
  if (get(diag, "visibility") !== "visible")
    reasons.push(`document.visibilityState=${pyStr(get(diag, "visibility"))}`);
  const gpu = dict(diag.ghosttyWebGpu);
  if (truthy(gpu) && !truthy(gpu.windowFocused) && !unfocused)
    reasons.push("renderer reports the window unfocused");
  const show = get(event, "show");
  if (show !== null && !truthy(get(show, "ok")))
    reasons.push("window did not return to visible+key after show");
  return reasons;
}

// ---------------------------------------------------------------------------------------------
// Sample accessors
// ---------------------------------------------------------------------------------------------

export function usable(report: AppReport): AppReport {
  return { ...report, samples: report.samples.filter((s) => "footprint" in s) };
}

export function phaseOf(sample: AppSample): string {
  return sample.phase || (sample.event.phase as string);
}

export function sampleByPhase(report: {
  samples: AppSample[];
}): Map<string, AppSample> {
  return new Map(report.samples.map((s) => [phaseOf(s), s]));
}

export function scenarioOf(report: AppReport): string {
  return get(dict(report.config), "scenario", "tabs") as string;
}

export function totalMib(sample: AppSample): number {
  return (sample.footprintTotal as number) / MIB;
}

export function roleMib(sample: AppSample, role: string): number {
  return num(get(sample.footprintByRole, role, 0)) / MIB;
}

type CategoryEntry = Record<string, number>;

/**
 * Category -> {dirty, swapped, clean, reclaimable, wired, shared_*} in MiB for a role.
 *
 * `own` rows come from the process; rows from shared groups where the process is named in
 * `specific_to_pid` are added (memory only that process holds in a shared group); group-wide
 * shared rows are reported under shared_* and not added.
 */
export function categoriesOf(
  sample: AppSample,
  role: string,
): Record<string, CategoryEntry> {
  const fp = sample.footprint as CompactFootprint;
  const result: Record<string, CategoryEntry> = {};
  const pid = fp.processes.find((p) => p.role === role)?.pid;
  if (pid === undefined) return result;

  const add = (name: string, row: CategoryRow, prefix = "") => {
    result[name] ??= {};
    const entry = result[name];
    const keys = ["dirty", "swapped", "clean", "reclaimable", "wired"];
    for (let index = 0; index < Math.min(keys.length, row.length); index++)
      entry[prefix + keys[index]] =
        (entry[prefix + keys[index]] ?? 0.0) + row[index] / MIB;
  };

  for (const process of fp.processes)
    if (process.pid === pid)
      for (const [name, row] of Object.entries(process.categories))
        add(name, row);
  for (const group of fp.shared) {
    if (!(group.pids || []).includes(pid)) continue;
    const specific = get(group, "specific");
    if (pyEqual(specific, pid)) {
      for (const [name, row] of Object.entries(group.categories))
        add(name, row);
    } else if (specific === null) {
      for (const [name, row] of Object.entries(group.categories))
        add(name, row, "shared_");
    }
  }
  return result;
}

export function categoryDirty(
  sample: AppSample,
  role: string,
  name: string,
): number {
  return num(get(get(categoriesOf(sample, role), name, {}), "dirty", 0.0));
}

export function categoryReclaimable(
  sample: AppSample,
  role: string,
  name: string,
): number {
  return num(
    get(get(categoriesOf(sample, role), name, {}), "reclaimable", 0.0),
  );
}

export function vmmapGraphics(sample: AppSample, role: string): number | null {
  const region = get(
    dict(get(dict(get(dict(sample.vmmap), role)), "regions")),
    "owned unmapped (graphics)",
  );
  if (region === null) return null;
  const { resident, dirty, swapped } = region as {
    resident: number;
    dirty: number;
    swapped: number;
  };
  return Math.max(resident, dirty + swapped) / MIB;
}

export function rolesIn(samples: AppSample[]): string[] {
  const seen = new Set(
    samples.flatMap((s) =>
      Object.keys(s.footprintByRole as Record<string, number>),
    ),
  );
  return [
    ...ROLES.filter((r) => seen.has(r)),
    ...[...seen].filter((r) => !ROLES.includes(r)).sort(),
  ];
}

export function diagOf(sample: AppSample): Dict {
  return dict(sample.event.diag);
}

export function poolOf(sample: AppSample): Dict {
  return dict(get(dict(diagOf(sample).ghosttyWebGpu), "canvases"));
}

// ---------------------------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------------------------

export const roundMetrics = labRoundMetrics;

function footprintMetrics(
  metrics: Metrics,
  name: string,
  sample: AppSample,
): void {
  metrics[`footprint.${name}.total_mib`] = totalMib(sample);
  for (const [role, value] of Object.entries(
    sample.footprintByRole as Record<string, number>,
  ))
    metrics[`footprint.${name}.${role}_mib`] = value / MIB;
  for (const role of ["web_content", "gpu", "host"]) {
    const cats = categoriesOf(sample, role);
    for (const category of [
      ...KEY_CATEGORIES.slice(0, 3),
      "JS VM Gigacage",
      "untagged (VM_ALLOCATE)",
      "IOAccelerator (graphics)",
    ]) {
      const entry = get(cats, category) as CategoryEntry | null;
      if (
        truthy(entry) &&
        entry &&
        (truthy(get(entry, "dirty")) || truthy(get(entry, "reclaimable")))
      ) {
        metrics[`cat.${name}.${role}.${SHORT[category]}_mib`] = num(
          get(entry, "dirty", 0.0),
        );
        if (truthy(get(entry, "reclaimable")))
          metrics[`cat.${name}.${role}.${SHORT[category]}_reclaimable_mib`] =
            entry.reclaimable;
      }
    }
    const graphics = vmmapGraphics(sample, role);
    if (graphics !== null)
      metrics[`vmmap.${name}.${role}.owned_unmapped_gfx_mib`] = graphics;
  }
}

const byKey = <T>(entries: [string, T][]) =>
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

function intervalMetrics(
  metrics: Metrics,
  prefix: string,
  value: Interval | null,
): void {
  if (!value || !truthy(value)) return;
  metrics[`${prefix}.seconds`] = value.seconds;
  for (const [role, pct] of byKey(Object.entries(value.cpu_pct)))
    metrics[`${prefix}.cpu_pct.${role}`] = pct;
  metrics[`${prefix}.cpu_pct.total`] = value.cpu_pct_total;
  metrics[`${prefix}.cpu_pct.app_total`] = sum(
    Object.entries(value.cpu_pct)
      .filter(([role]) => role !== "workload")
      .map(([, pct]) => pct),
  );
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
  for (const [role, wakeups] of byKey(Object.entries(value.wakeups_per_s)))
    metrics[`${prefix}.wakeups_per_s.${role}`] = wakeups;
  if (!("wakeups_per_s_total" in value))
    throw new RangeError("wakeups_per_s_total");
  metrics[`${prefix}.wakeups_per_s.total`] =
    value.wakeups_per_s_total as number;
  if (value.instructions) {
    metrics[`${prefix}.instructions_g_per_s`] =
      value.instructions / value.seconds / 1e9;
    metrics[`${prefix}.cycles_g_per_s`] = value.cycles / value.seconds / 1e9;
  }
}

/** Growth of the total, the per-role footprint and the key categories over cycles. */
function seriesMetrics(
  metrics: Metrics,
  name: string,
  samples: [number, AppSample][],
  base: AppSample | undefined,
): void {
  if (!samples.length) return;
  const xs = samples.map(([c]) => c);
  const totals = samples.map(([, s]) => totalMib(s));
  const last = samples[samples.length - 1][1];
  metrics[`${name}.max_mib`] = maxOf(totals);
  metrics[`${name}.mean_mib`] = fmean(totals);
  let fit = slope(xs, totals);
  if (fit !== null) metrics[`${name}.growth_mib_per_cycle`] = fit;
  if (base) {
    metrics[`${name}.growth_first_to_last_mib`] =
      totals[totals.length - 1] - totalMib(base);
    for (const role of rolesIn([base, ...samples.map(([, s]) => s)]))
      metrics[`${name}.growth.${role}_mib`] =
        roleMib(last, role) - roleMib(base, role);
    for (const role of ["web_content", "gpu", "host"]) {
      for (const category of [
        "WebKit malloc",
        "IOSurface",
        "untagged (VM_ALLOCATE)",
        "IOAccelerator (graphics)",
      ]) {
        const growth =
          categoryDirty(last, role, category) -
          categoryDirty(base, role, category);
        if (Math.abs(growth) >= 0.05)
          metrics[`${name}.growth.${role}.${SHORT[category]}_mib`] = growth;
      }
      const growth =
        categoryReclaimable(last, role, "IOSurface") -
        categoryReclaimable(base, role, "IOSurface");
      if (Math.abs(growth) >= 0.05)
        metrics[`${name}.growth.${role}.iosurf_reclaimable_mib`] = growth;
    }
  }
  for (const role of rolesIn(samples.map(([, s]) => s))) {
    fit = slope(
      xs,
      samples.map(([, s]) => roleMib(s, role)),
    );
    if (fit !== null) metrics[`${name}.growth_mib_per_cycle.${role}`] = fit;
  }
  for (const role of ["web_content", "gpu", "host"]) {
    for (const category of [
      "WebKit malloc",
      "IOSurface",
      "untagged (VM_ALLOCATE)",
    ]) {
      fit = slope(
        xs,
        samples.map(([, s]) => categoryDirty(s, role, category)),
      );
      if (fit !== null && Math.abs(fit) >= 0.005)
        metrics[`${name}.growth_mib_per_cycle.${role}.${SHORT[category]}`] =
          fit;
    }
    fit = slope(
      xs,
      samples.map(([, s]) => categoryReclaimable(s, role, "IOSurface")),
    );
    if (fit !== null && Math.abs(fit) >= 0.005)
      metrics[`${name}.growth_mib_per_cycle.${role}.iosurf_reclaimable`] = fit;
  }
}

function eventSamples(report: AppReport, step: string): [number, AppSample][] {
  const found: [number, AppSample][] = report.samples
    .filter((s) => get(s.event, "step") === step && "cycle" in s.event)
    .map((s) => [s.event.cycle as number, s]);
  return found.sort((a, b) => a[0] - b[0]);
}

/** [(wall time, role -> phys_footprint MiB)] from the cheap timeline. */
function seriesByRole(report: AppReport): [number, Record<string, number>][] {
  const result: [number, Record<string, number>][] = [];
  for (const entry of report.series || []) {
    const roles: Record<string, number> = {};
    for (const value of Object.values(entry.processes)) {
      const role = value.role as string;
      if (ROLES.includes(role))
        roles[role] = (roles[role] ?? 0.0) + num(value.phys_footprint) / MIB;
    }
    if (truthy(roles)) {
      roles.total = sum(
        Object.entries(roles)
          .filter(([key]) => key !== "total")
          .map(([, v]) => v),
      );
      result.push([entry.tWall, roles]);
    }
  }
  return result;
}

/** (cycle, start, end) wall-clock windows, one per switch/cycle/drag, from the page events. */
export function timelineWindows(report: AppReport): [number, number, number][] {
  const scenario = scenarioOf(report);
  const windows: [number, number, number][] = [];
  let previous: number | null = null;
  for (const sample of report.samples) {
    const event = sample.event;
    const end =
      "tWall" in sample
        ? (sample.tWall as number)
        : num(get(event, "tWall", 0)) / 1000;
    if (
      "cycle" in event &&
      num(get(event, "cycle", 0)) > 0 &&
      (scenario !== "occlusion" || get(event, "step") === "visible")
    ) {
      const switched = get(event, "switchedAt");
      const start = truthy(switched)
        ? num(switched) / 1000
        : previous !== null
          ? previous
          : end - 5;
      windows.push([event.cycle as number, start, end]);
    }
    previous = end;
  }
  return windows;
}

function timelineMetrics(metrics: Metrics, report: AppReport): void {
  const series = seriesByRole(report);
  const windows = timelineWindows(report);
  if (!series.length || !windows.length) return;
  for (const role of ["total", "web_content", "gpu", "host"]) {
    const floors: [number, number][] = [];
    const peaks: [number, number][] = [];
    const lasts: [number, number][] = [];
    for (const [cycle, start, end] of windows) {
      const values = series
        .filter(([t, roles]) => start <= t && t <= end && role in roles)
        .map(([, roles]) => roles[role]);
      if (values.length) {
        floors.push([cycle, minOf(values)]);
        peaks.push([cycle, maxOf(values)]);
        lasts.push([cycle, values[values.length - 1]]);
      }
    }
    if (floors.length >= 2) {
      for (const [name, group] of [
        ["floor", floors],
        ["peak", peaks],
        ["last", lasts],
      ] as const) {
        const fit = slope(
          group.map(([c]) => c),
          group.map(([, v]) => v),
        );
        if (fit !== null)
          metrics[`timeline.${name}_growth_mib_per_cycle.${role}`] = fit;
        metrics[`timeline.${name}.first.${role}_mib`] = group[0][1];
        metrics[`timeline.${name}.last.${role}_mib`] =
          group[group.length - 1][1];
        metrics[`timeline.${name}.max.${role}_mib`] = maxOf(
          group.map(([, v]) => v),
        );
      }
    }
  }
  const totals = series.map(([, roles]) => roles.total);
  metrics["timeline.total.max_mib"] = maxOf(totals);
  metrics["timeline.total.min_mib"] = minOf(totals);
  metrics["timeline.samples"] = series.length;
}

/** Per-cycle rates of the optional WebGPU/DOM lifecycle counters (--instrument). */
function counterMetrics(
  metrics: Metrics,
  byPhase: Map<string, AppSample>,
  samples: AppSample[],
): void {
  const base = byPhase.get("baseline");
  const cycles = samples.filter(
    (s) => "cycle" in s.event && num(s.event.cycle) > 0,
  );
  if (!base || !cycles.length) return;
  const first = dict(get(diagOf(base), "counters"));
  const last = dict(get(diagOf(cycles[cycles.length - 1]), "counters"));
  const count = num(cycles[cycles.length - 1].event.cycle);
  if (!truthy(first) || !truthy(last) || !count) return;
  for (const [key, value] of Object.entries(last)) {
    if (key === "instrumented" || !isNumeric(value)) continue;
    const delta = num(value) - num(get(first, key, 0));
    metrics[`counters.${key}_per_cycle`] = delta / count;
  }
  // IPC: report the busiest commands by calls per cycle.
  const ipc = Object.entries(last).filter(
    ([k]) => k.startsWith("ipc.") && k !== "ipc.bytes",
  );
  const deltaOf = (key: string, value: unknown) =>
    num(value) - num(get(first, key, 0));
  const busiest = ipc
    .map(([key, value]) => [key, -deltaOf(key, value)] as const)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 12);
  for (const [key] of busiest)
    metrics[`ipc.${key.slice(4)}_per_cycle`] = deltaOf(key, last[key]) / count;
  const kinds = [
    ...new Set(
      Object.keys(last)
        .filter((k) => k.endsWith(".created"))
        .map((k) => k.slice(0, k.lastIndexOf("."))),
    ),
  ];
  for (const kind of kinds) {
    const created = get(last, `${kind}.created`, 0);
    const finalized = get(last, `${kind}.finalized`, 0);
    metrics[`counters.${kind}.alive`] = num(created) - num(finalized);
  }
}

export const SMOOTH_FIELDS: readonly [
  field: string,
  name: string,
  sub: string | null,
][] = [
  ["fps", "fps", null],
  ["frameIntervalMs", "frame_interval_p95_ms", "p95"],
  ["busyIntervalMs", "busy_interval_p50_ms", "p50"],
  ["busyIntervalMs", "busy_interval_p95_ms", "p95"],
  ["busyIntervalMs", "busy_interval_max_ms", "max"],
  ["rafIntervalMs", "raf_interval_p95_ms", "p95"],
  ["refreshMs", "refresh_ms", null],
  ["frameCostMs", "frame_cost_p95_ms", "p95"],
  ["frameCostMs", "frame_cost_max_ms", "max"],
  ["contentAgeMs", "content_age_p50_ms", "p50"],
  ["contentAgeMs", "content_age_p95_ms", "p95"],
  ["contentAgeMs", "content_age_max_ms", "max"],
  ["reflowIntervalMs", "reflow_interval_p50_ms", "p50"],
  ["reflowIntervalMs", "reflow_interval_p95_ms", "p95"],
  ["reflowIntervalMs", "reflow_interval_max_ms", "max"],
  ["rectLagMs", "rect_lag_p95_ms", "p95"],
  ["rectLagMs", "rect_lag_max_ms", "max"],
  ["gridStalenessMs", "staleness_p50_ms", "p50"],
  ["gridStalenessMs", "staleness_p95_ms", "p95"],
  ["gridStalenessMs", "staleness_max_ms", "max"],
  ["staleShare", "stale_share", null],
  ["gridResizesPerS", "grid_resizes_per_s", null],
  ["settleMs", "settle_ms", null],
  ["gridResizesMaxPane", "sigwinch_per_pane_max", null],
  ["cursorClipped", "cursor_clipped_frames", null],
  ["cursorFrames", "cursor_frames", null],
  ["resizeCostMs", "resize_cost_p95_ms", "p95"],
  ["frozenMs", "frozen_ms", null],
  ["frozenMaxMs", "frozen_max_ms", null],
  ["frozenOverFrame", "frozen_over_frame", null],
  ["frozenShare", "frozen_share", null],
  ["blankFrames", "blank_frames", null],
  ["erasedPrompts", "erased_prompts", null],
  ["redrawMs", "redraw_p50_ms", "p50"],
  ["redrawMs", "redraw_p95_ms", "p95"],
  ["slowFrames", "slow_frames", null],
  ["stalledFrames", "stalled_frames", null],
  ["frames", "frames", null],
];

const isDict = (value: unknown): value is Dict =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Per-gesture smoothness (page-side probe), reduced over the gestures: median and worst. */
function smoothMetrics(metrics: Metrics, steps: AppSample[]): void {
  const smooths = steps
    .map((s) => get(dict(get(s, "event")), "smooth"))
    .filter(isDict);
  if (!smooths.length) return;
  metrics["smooth.gestures"] = smooths.length;
  for (const [field, name, sub] of SMOOTH_FIELDS) {
    const values: number[] = [];
    for (const smooth of smooths) {
      let value = get(smooth, field);
      if (sub !== null && isDict(value)) value = get(value, sub);
      if (isNumeric(value)) values.push(Number(value));
    }
    if (values.length) {
      metrics[`smooth.${name}.median`] = median(values);
      metrics[`smooth.${name}.worst`] =
        name !== "fps" && name !== "frames" ? maxOf(values) : minOf(values);
    }
  }
  const reallocs = smooths.flatMap(
    (smooth) => (smooth.reallocs || []) as Dict[],
  );
  metrics["smooth.reallocs"] = reallocs.length;
  if (reallocs.length)
    metrics["smooth.realloc_cost_max_ms"] = maxOf(
      reallocs.map((r) => num(r.costMs)),
    );
}

/** Python's `/`, which raises on a zero divisor instead of returning Infinity. */
function divide(numerator: number, denominator: number): number {
  if (denominator === 0) throw new RangeError("float division by zero");
  return numerator / denominator;
}

const isStep = (sample: AppSample) =>
  ["shrink", "grow", "drag"].includes(phaseOf(sample).split("-")[0]);

export function computeMetrics(full: AppReport): Metrics {
  const report = usable(full);
  const scenario = scenarioOf(report);
  const samples = report.samples;
  const byPhase = sampleByPhase(report);
  const metrics: Metrics = {};
  for (const sample of samples) {
    const phase = phaseOf(sample);
    if (
      [
        "setup",
        "baseline",
        "cycles-complete",
        "end+10s",
        "end+30s",
        "post-gc+2s",
        "post-gc+10s",
        "resize-settled",
        "measure-start",
        "measure-end",
        "setup-complete",
      ].includes(phase)
    )
      footprintMetrics(metrics, phase, sample);
  }
  const lastEvent: AppEvent = samples.length
    ? samples[samples.length - 1].event
    : {};
  const diag = dict(lastEvent.diag);
  const pool = dict(get(dict(diag.ghosttyWebGpu), "canvases"));
  for (const key of [
    "created",
    "reused",
    "reconfigured",
    "destroyed",
    "idle",
    "leased",
    "parked",
    "backingStoreResizes",
    "windowFrames",
  ])
    if (key in pool && isNumeric(pool[key]))
      metrics[`pool.${key}`] = pool[key] as number;
  const mirror = dict(get(dict(diag.ghosttyWebGpu), "gcMirror"));
  for (const key of ["frames", "allocations", "allocatedBytes"])
    if (key in mirror) metrics[`gc_mirror.${key}`] = mirror[key] as number;
  metrics["dom.max_canvases"] = maxOf(
    samples.map((s) => num(get(dict(diagOf(s).dom), "canvases", 0))),
  );
  const core = dict(diag.ghosttyCore);
  if (truthy(core)) {
    metrics["wasm.instances"] = get(core, "wasmInstanceCount", 0) as number;
    metrics["wasm.memory_mib"] = num(get(core, "wasmMemoryBytes", 0)) / MIB;
  }
  metrics["wasm.max_memory_mib"] = samples.length
    ? maxOf(
        samples.map(
          (s) =>
            num(get(dict(diagOf(s).ghosttyCore), "wasmMemoryBytes", 0)) / MIB,
        ),
      )
    : 0;
  metrics["dom.elements"] = get(dict(diag.dom), "elements", 0) as number;
  timelineMetrics(metrics, full);
  counterMetrics(metrics, byPhase, samples);

  if (["tabs", "occlusion", "resize", "split-drag"].includes(scenario)) {
    const base = byPhase.get("baseline");
    let visible: [number, AppSample][];
    if (scenario === "tabs") {
      const switches: [number, AppSample][] = samples
        .filter((s) => phaseOf(s).startsWith("switch-"))
        .map((s): [number, AppSample] => [s.event.cycle as number, s])
        .sort((a, b) => a[0] - b[0]);
      seriesMetrics(metrics, "tabs.switch", switches, base);
      // Tab roles: odd switches land on the agent tab, even ones on the shell tab.
      const setup = byPhase.has("setup") ? byPhase.get("setup") : {};
      const order = get(dict(get(setup, "event")), "order");
      const tabs = truthy(order) ? (order as unknown[]) : [];
      if (tabs.length && tabs.length <= 2) {
        for (const [parity, label] of [
          [1, "agent"],
          [0, "shell"],
        ] as const) {
          const group = switches.filter(([c]) => ((c % 2) + 2) % 2 === parity);
          if (group.length)
            metrics[`tabs.on_${label}.mean_mib`] = fmean(
              group.map(([, s]) => totalMib(s)),
            );
        }
      }
      visible = switches;
    } else if (scenario === "occlusion") {
      visible = eventSamples(report, "visible");
      const hidden = eventSamples(report, "hidden");
      seriesMetrics(metrics, "occlusion.visible", visible, base);
      if (hidden.length) {
        const totals = hidden.map(([, s]) => totalMib(s));
        metrics["occlusion.hidden.max_mib"] = maxOf(totals);
        metrics["occlusion.hidden.mean_mib"] = fmean(totals);
      }
      const per = new Map<number, boolean>();
      for (const [cycle, s] of hidden) {
        const hide = dict(s.event.hide);
        per.set(cycle, truthy(hide.ok) && truthy(hide.occluded));
      }
      metrics["cycles.occluded"] = [...per.values()].filter(Boolean).length;
    } else {
      const steps = samples.filter(isStep);
      visible = steps.map((s, i) => [i + 1, s]);
      seriesMetrics(metrics, "resize.drags", visible, base);
      for (const sample of steps)
        metrics[`footprint.${phaseOf(sample)}.total_mib`] = totalMib(sample);
      if (steps.length) {
        metrics["resize.peak_total_mib"] = maxOf(steps.map(totalMib));
        metrics["resize.peak_web_content_mib"] = maxOf(
          steps.map((s) => roleMib(s, "web_content")),
        );
        metrics["resize.peak_over_baseline_mib"] =
          metrics["resize.peak_total_mib"] - (base ? totalMib(base) : 0);
      }
      if (base && steps.length)
        intervalMetrics(
          metrics,
          "resize.drag",
          interval(base, steps[steps.length - 1]),
        );
      smoothMetrics(metrics, steps);
    }
    const end30 = byPhase.get("end+30s");
    const gc10 = byPhase.get("post-gc+10s");
    if (end30 && gc10) {
      metrics["footprint.gc_recovered_mib"] = totalMib(end30) - totalMib(gc10);
      metrics["footprint.gc_recovered.web_content_mib"] =
        roleMib(end30, "web_content") - roleMib(gc10, "web_content");
      metrics["footprint.gc_recovered.web_content.malloc_mib"] =
        categoryDirty(end30, "web_content", "WebKit malloc") -
        categoryDirty(gc10, "web_content", "WebKit malloc");
    }
    if (base && end30) {
      metrics["footprint.settle_delta_vs_baseline_mib"] =
        totalMib(end30) - totalMib(base);
      for (const role of rolesIn(samples))
        metrics[`footprint.settle_delta.${role}_mib`] =
          roleMib(end30, role) - roleMib(base, role);
    }
    if (base && visible.length)
      metrics["footprint.max_after_baseline_mib"] =
        maxOf(visible.map(([, s]) => totalMib(s))) - totalMib(base);
    // CPU/energy over the loop and over the idle tail.
    if (base && visible.length)
      intervalMetrics(
        metrics,
        "loop",
        interval(base, visible[visible.length - 1][1]),
      );
    const complete = byPhase.get("cycles-complete");
    if (complete && end30)
      intervalMetrics(metrics, "tail", interval(complete, end30));
    return metrics;
  }

  // agents-steady / idle
  const start = byPhase.get("measure-start");
  const end = byPhase.get("measure-end");
  if (!start || !end) return metrics;
  metrics["footprint.delta_mib"] = totalMib(end) - totalMib(start);
  const window = interval(start, end);
  intervalMetrics(metrics, "window", window);
  const seconds = window ? window.seconds : (end.tMonoNs - start.tMonoNs) / 1e9;
  const countersA = dict(get(diagOf(start), "counters"));
  const countersB = dict(get(diagOf(end), "counters"));
  if (truthy(countersA) && truthy(countersB) && seconds) {
    for (const [key, value] of Object.entries(countersB))
      if (
        key !== "instrumented" &&
        isNumeric(value) &&
        num(value) - num(get(countersA, key, 0))
      )
        metrics[`counters.${key}_per_s`] =
          (num(value) - num(get(countersA, key, 0))) / seconds;
  }
  const animations = get(diagOf(end), "animations");
  metrics["page.css_animations"] = truthy(animations)
    ? (animations as number)
    : 0;
  const gpuA = dict(diagOf(start).ghosttyWebGpu);
  const gpuB = dict(diagOf(end).ghosttyWebGpu);
  if (truthy(gpuA) && truthy(gpuB)) {
    metrics["renderer.gpu_submissions_per_s"] = divide(
      num(gpuB.submittedFrames) - num(gpuA.submittedFrames),
      seconds,
    );
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
  }
  const hubA = dict(get(dict(diagOf(start).ptyTransport), "hub"));
  const hubB = dict(get(dict(diagOf(end).ptyTransport), "hub"));
  for (const key of ["polls", "bytes", "frames"])
    if (isNumeric(get(hubA, key)) && isNumeric(get(hubB, key)))
      metrics[`pty.hub_${key}_per_s`] = divide(
        num(hubB[key]) - num(hubA[key]),
        seconds,
      );
  return metrics;
}

// ---------------------------------------------------------------------------------------------
// Human summary
// ---------------------------------------------------------------------------------------------

const m = (value: number | null, digits = 1) =>
  value === null ? "-" : fixed(value, digits, { group: true });

function pairsTable(
  samples: AppSample[],
  base: AppSample | null,
  nameOf: (sample: AppSample) => string,
): string {
  const roles = rolesIn(samples);
  const headers = [
    "phase",
    ...roles.map((r) => (Object.hasOwn(ROLE_LABELS, r) ? ROLE_LABELS[r] : r)),
    "TOTAL",
    "delta",
    "WC malloc",
    "WC iosurf",
    "WC iosurf recl",
    "GPU iosurf",
    "GPU iosurf recl",
    "gfx WC/GPU",
    "pool",
  ];
  const rows: string[][] = [];
  let previous = base;
  for (const sample of samples) {
    const pool = poolOf(sample);
    const total = totalMib(sample);
    const gfxWc = vmmapGraphics(sample, "web_content");
    const gfxGpu = vmmapGraphics(sample, "gpu");
    rows.push([
      nameOf(sample),
      ...roles.map((r) => m(roleMib(sample, r))),
      m(total),
      previous === null
        ? ""
        : fixed(total - totalMib(previous), 1, { sign: true }),
      m(categoryDirty(sample, "web_content", "WebKit malloc")),
      m(categoryDirty(sample, "web_content", "IOSurface")),
      m(categoryReclaimable(sample, "web_content", "IOSurface")),
      m(categoryDirty(sample, "gpu", "IOSurface")),
      m(categoryReclaimable(sample, "gpu", "IOSurface")),
      gfxWc === null && gfxGpu === null
        ? "-"
        : `${fixed(gfxWc || 0, 0)}/${fixed(gfxGpu || 0, 0)}`,
      truthy(pool)
        ? `${pyStr(get(pool, "created", "-"))}c/${pyStr(get(pool, "reused", "-"))}r/${pyStr(get(pool, "destroyed", "-"))}d`
        : "-",
    ]);
    previous = sample;
  }
  return table(headers, rows);
}

export function smoothTable(steps: AppSample[]): string {
  const headerRow = [
    "gesture",
    "fps",
    "int p50",
    "p95",
    "max",
    "raf p95",
    "lag p95",
    "lag max",
    "age p50",
    "p95",
    "max",
    "reflow p50",
    "p95",
    "max",
    "stale%",
    "settle",
    "resz/pane",
    "crsr clip/n",
    "frozen ms",
    "max",
    ">1fr",
    "frz%",
    "blank",
    "erased",
    "redraw p50",
    "p95",
    "cost p95",
    "reallocs",
  ];
  const rows = [headerRow];
  for (const sample of steps) {
    const smooth = get(dict(get(sample, "event")), "smooth");
    if (!isDict(smooth)) continue;
    const f = (key: string, sub: string) => get(dict(get(smooth, key)), sub, 0);
    const need = (key: string) => {
      if (!(key in smooth)) throw new RangeError(`smooth has no ${key}`);
      return smooth[key];
    };
    rows.push([
      phaseOf(sample),
      fixed(need("fps"), 1),
      fixed(f("busyIntervalMs", "p50"), 1),
      fixed(f("busyIntervalMs", "p95"), 1),
      fixed(f("busyIntervalMs", "max"), 1),
      fixed(f("rafIntervalMs", "p95"), 1),
      fixed(f("rectLagMs", "p95"), 1),
      fixed(f("rectLagMs", "max"), 1),
      fixed(f("contentAgeMs", "p50"), 0),
      fixed(f("contentAgeMs", "p95"), 0),
      fixed(f("contentAgeMs", "max"), 0),
      fixed(f("reflowIntervalMs", "p50"), 0),
      fixed(f("reflowIntervalMs", "p95"), 0),
      fixed(f("reflowIntervalMs", "max"), 0),
      fixed(num(need("staleShare")) * 100, 0),
      pyStr(get(smooth, "settleMs", "-")),
      pyStr(get(smooth, "gridResizesMaxPane", "-")),
      `${pyStr(get(smooth, "cursorClipped", 0))}/${pyStr(get(smooth, "cursorFrames", 0))}`,
      pyStr(need("frozenMs")),
      pyStr(need("frozenMaxMs")),
      pyStr(need("frozenOverFrame")),
      fixed(num(need("frozenShare")) * 100, 0),
      pyStr(need("blankFrames")),
      pyStr(need("erasedPrompts")),
      fixed(f("redrawMs", "p50"), 0),
      fixed(f("redrawMs", "p95"), 0),
      fixed(f("frameCostMs", "p95"), 1),
      ((smooth.reallocs || []) as Dict[])
        .map(
          (r) => `${fixed(r.costMs, 0)}ms@${pyStr(r.width)}x${pyStr(r.height)}`,
        )
        .join(",") || "-",
    ]);
  }
  const widths = headerRow.map((_, i) =>
    Math.max(...rows.map((r) => r[i].length)),
  );
  return rows
    .map(
      (r) =>
        `  ${r
          .slice(0, widths.length)
          .map((c, i) => c.padStart(widths[i]))
          .join("  ")}`,
    )
    .join("\n");
}

function metricsInterval(
  metrics: Metrics,
  prefix: string,
  roles: string[],
): IntervalRow | null {
  const seconds = get(metrics, `${prefix}.seconds`);
  if (seconds === null) return null;
  const present = [...roles, "workload"].filter(
    (r) => `${prefix}.cpu_pct.${r}` in metrics,
  );
  return {
    seconds: seconds as number,
    cpu_pct: Object.fromEntries(
      present.map((r) => [r, metrics[`${prefix}.cpu_pct.${r}`]]),
    ),
    cpu_pct_total: get(
      metrics,
      `${prefix}.cpu_pct.app_total`,
      get(metrics, `${prefix}.cpu_pct.total`, 0),
    ) as number,
    window_server_cpu_pct: get(metrics, `${prefix}.cpu_pct.window_server`) as
      | number
      | null,
    energy_j_per_min: Object.fromEntries(
      present
        .filter((r) => `${prefix}.energy_j_per_min.${r}` in metrics)
        .map((r) => [r, metrics[`${prefix}.energy_j_per_min.${r}`]]),
    ),
    energy_j_per_min_total: get(metrics, `${prefix}.energy_j_per_min.total`) as
      | number
      | null,
  };
}

export function summarize(full: AppReport): string {
  const report = usable(full);
  const scenario = scenarioOf(report);
  const samples = report.samples;
  const config = dict(report.config);
  const scn = dict(config.scenarioJson);
  const byPhase = sampleByPhase(report);
  const metrics = computeMetrics(report);
  const roles = rolesIn(samples);
  const variant = truthy(get(scn, "variant"))
    ? `/${scn.variant as string}`
    : "";
  const out = [
    `== app lab: ${scenario}${variant} ==${truthy(config.label) ? ` [${pyStr(config.label)}]` : ""}`,
  ];
  out.push(
    `  source ${head(pyStr(get(report, "sourceRevision")), 12)}  profile ${pyStr(get(config, "profile"))}  qualified: ${pyStr(get(get(report, "qualification", {}), "qualified", "n/a"))}`,
  );
  out.push(
    `  ${Object.entries(scn)
      .filter(
        ([k]) =>
          !["localStorage", "name", "variant", "window", "live"].includes(k),
      )
      .map(([k, v]) => `${k} ${pyStr(v)}`)
      .join(", ")}; window ${pyStr(get(scn, "window"))}`,
  );
  if (truthy(get(scn, "localStorage")))
    out.push(`  localStorage: ${pyStr(scn.localStorage)}`);
  const base = byPhase.get("baseline");
  if (["tabs", "occlusion", "resize", "split-drag"].includes(scenario)) {
    const rowsSamples: AppSample[] = [];
    if (base) rowsSamples.push(base);
    let body: AppSample[];
    if (scenario === "tabs")
      body = samples.filter((s) => phaseOf(s).startsWith("switch-"));
    else if (scenario === "occlusion")
      body = samples.filter((s) => phaseOf(s).startsWith("cycle-"));
    else body = samples.filter(isStep);
    // Long runs: every row for the first 3 and last 3, then every 5th.
    const shown = body.filter(
      (_, i) => i < 3 || i >= body.length - 3 || (i + 1) % 5 === 0,
    );
    const tail = [
      "cycles-complete",
      "resize-settled",
      "end+10s",
      "end+30s",
      "post-gc+2s",
      "post-gc+10s",
    ]
      .filter((n) => byPhase.has(n))
      .map((n) => byPhase.get(n) as AppSample);
    out.push(
      "\nFootprint (MiB). WC = WebContent; malloc = 'WebKit malloc' dirty (incl. compressed); iosurf = IOSurface dirty;",
    );
    out.push(
      "recl = IOSurface reclaimable (volatile, not in the footprint total); gfx = vmmap 'owned unmapped (graphics)'; pool = WebGPU canvases created/reused/destroyed:",
    );
    out.push(pairsTable([...rowsSamples, ...shown, ...tail], null, phaseOf));
    if (scenario === "tabs") {
      out.push(
        `\nGrowth per switch (MiB/switch, least squares): ${Object.entries(
          metrics,
        )
          .filter(([k]) => k.startsWith("tabs.switch.growth_mib_per_cycle"))
          .map(
            ([k, v]) =>
              `${k.includes(".growth_mib_per_cycle.") ? k.split(".growth_mib_per_cycle.")[1] : "total"} ${fixed(v, 3, { sign: true })}`,
          )
          .join(", ")}`,
      );
      if ("tabs.switch.growth_first_to_last_mib" in metrics)
        out.push(
          `Baseline -> last switch: ${fixed(metrics["tabs.switch.growth_first_to_last_mib"], 1, { sign: true })} MiB; after +30 s idle vs baseline: ${fixed(get(metrics, "footprint.settle_delta_vs_baseline_mib", Number.NaN), 1, { sign: true })} MiB`,
        );
    }
    const pairs: [string, IntervalRow | null][] = [];
    for (const name of ["loop", "tail", "resize.drag"])
      if (get(metrics, `${name}.seconds`) !== null)
        pairs.push([name, metricsInterval(metrics, name, roles)]);
    if (pairs.length) {
      out.push("\nCPU% (of one core) and energy:");
      const workload = pairs.some(
        ([, p]) => "workload" in dict(get(dict(p), "cpu_pct", {})),
      );
      out.push(
        intervalTable(
          pairs,
          workload ? [...roles, "workload"] : roles,
          INTERVAL_LABELS,
        ),
      );
    }
    if (scenario === "resize" || scenario === "split-drag") {
      out.push("\nSmoothness per gesture (page-side probe):");
      out.push(smoothTable(samples.filter(isStep)));
    }
  } else {
    const rowsSamples = samples.filter((s) =>
      ["setup-complete", "measure-start", "measure-end"].includes(phaseOf(s)),
    );
    out.push("\nFootprint (MiB):");
    out.push(pairsTable(rowsSamples, null, phaseOf));
    const window = metricsInterval(metrics, "window", roles);
    out.push("\nCPU% (of one core) and energy over the measured window:");
    out.push(
      intervalTable(
        [["measured window", window]],
        window && "workload" in window.cpu_pct ? [...roles, "workload"] : roles,
        INTERVAL_LABELS,
      ),
    );
    for (const key of [
      "window.power_mw.total",
      "window.wakeups_per_s.total",
      "window.instructions_g_per_s",
      "renderer.gpu_submissions_per_s",
      "renderer.animation_frames_per_s",
      "renderer.idle_animation_frames_per_s",
      "renderer.timer_wakeups_per_s",
      "renderer.work_done_waits_per_s",
    ])
      if (key in metrics) out.push(`  ${key}: ${fixed(metrics[key], 2)}`);
  }
  out.push(
    `\n  WASM: ${pyStr(get(metrics, "wasm.instances", "-"))} instances, ${fixed(get(metrics, "wasm.memory_mib", 0), 1)} MiB linear memory (peak ${fixed(get(metrics, "wasm.max_memory_mib", 0), 1)}); DOM elements ${pyStr(get(metrics, "dom.elements", "-"))}`,
  );
  const qualification = dict(report.qualification) as Qualification;
  for (const advisory of qualification.advisories || [])
    out.push(`\nADVISORY: ${advisory}`);
  if (truthy(qualification.failures)) {
    out.push("\nQUALIFICATION FAILURES (results are not valid evidence):");
    for (const failure of (qualification.failures ?? []).slice(0, 12))
      out.push(`  - ${failure.phase}: ${failure.reasons.join("; ")}`);
  }
  const environment = get(report, "environment", {});
  out.push(
    `\n  host ${pyStr(get(environment, "chip", "?"))}; load average at start ${loadAverageText(get(environment, "loadAverageStart"))}; end ${loadAverageText(get(environment, "loadAverageEnd"))}`,
  );
  out.push(`  scope: ${pyStr(get(report, "scope"))}`);
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Comparison / IO
// ---------------------------------------------------------------------------------------------

function formatMetric(value: number | null): string {
  if (value === null) return "-";
  return Math.abs(Number(value)) < 100000
    ? fixed(value, 2, { group: true })
    : fixed(value, 0, { group: true });
}

export function medianMetrics(reports: AppReport[]): Metrics {
  const perReport = reports.map(computeMetrics);
  const names = Object.keys(perReport[0]).filter((n) =>
    perReport.every((other) => n in other),
  );
  return Object.fromEntries(
    names.map((n) => [n, median(perReport.map((metrics) => num(metrics[n])))]),
  );
}

export function compare(
  baseline: AppReport | AppReport[],
  candidate: AppReport | AppReport[],
): string {
  const baselines = Array.isArray(baseline) ? baseline : [baseline];
  const candidates = Array.isArray(candidate) ? candidate : [candidate];
  const baseMetrics = medianMetrics(baselines);
  const candMetrics = medianMetrics(candidates);
  const names = [
    ...Object.keys(baseMetrics),
    ...Object.keys(candMetrics).filter((n) => !(n in baseMetrics)),
  ];
  const first = baselines[0];
  const second = candidates[0];
  const lines = [
    `== comparison: ${scenarioOf(first)} (baseline ${head(pyStr(get(first, "sourceRevision")), 10)} x${baselines.length} -> candidate ${head(pyStr(get(second, "sourceRevision")), 10)} x${candidates.length}; medians when repeated) ==`,
  ];
  if (scenarioOf(first) !== scenarioOf(second))
    lines.push("  warning: scenarios differ; matching metric names only");
  if (
    !pyEqual(
      get(dict(first.config), "scenarioJson"),
      get(dict(second.config), "scenarioJson"),
    )
  )
    lines.push(
      "  warning: scenario configuration differs (including localStorage toggles)",
    );
  const rows: string[][] = [];
  for (const name of names) {
    const a = name in baseMetrics ? baseMetrics[name] : null;
    const b = name in candMetrics ? candMetrics[name] : null;
    if (a === null && b === null) continue;
    const delta = a === null || b === null ? null : b - a;
    const percent =
      delta === null || !a
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
  lines.push(table(["metric", "baseline", "candidate", "delta", "%"], rows));
  return lines.join("\n");
}

export const load = labLoad as (path: string) => AppReport;
export const dump = labDump;

/** One comparable line per report: where WebContent starts, ends, and what a forced GC returns. */
export function experimentRow(report: AppReport): string[] {
  const samples = report.samples;
  const byPhase = new Map(samples.map((s) => [phaseOf(s), s]));

  const wc = (phase: string) => {
    const sample = byPhase.get(phase);
    return sample === undefined ? null : roleMib(sample, "web_content");
  };
  const malloc = (phase: string) => {
    const sample = byPhase.get(phase);
    return sample && "footprint" in sample
      ? categoryDirty(sample, "web_content", "WebKit malloc")
      : null;
  };
  const iosurface = (phase: string) => {
    const sample = byPhase.get(phase);
    return sample && "footprint" in sample
      ? categoryDirty(sample, "web_content", "IOSurface")
      : null;
  };

  const cycles = samples.length
    ? maxOf(samples.map((s) => num(get(s.event, "cycle", 0))))
    : 0;
  const start = wc("baseline");
  const end = wc("end+30s");
  const collected = wc("post-gc+10s");
  const metrics = truthy(report.metrics)
    ? (report.metrics as Metrics)
    : computeMetrics(report);
  let resizes: number | null = null;
  const last = [...samples]
    .reverse()
    .find((s) => "cycle" in s.event && num(s.event.cycle) > 0);
  if (last) {
    resizes = sum(
      ((diagOf(last).ghosttySessions || []) as Dict[]).map((x) => {
        if (!("surface" in x))
          throw new RangeError("ghostty session without surface");
        return num(get(dict(x.surface), "backingStoreResizes", 0));
      }),
    );
    // One shared window canvas: the runtime counts its swapchain allocations (including the first).
    const window = get(poolOf(last), "backingStoreResizes");
    if (window !== null) resizes = window as number;
  }

  const f = (value: number | null, signed = false) =>
    value === null
      ? "-"
      : signed
        ? fixed(value, 0, { sign: true })
        : fixed(value, 0);

  return [
    pyStr(
      truthy(get(dict(report.config), "label"))
        ? get(dict(report.config), "label")
        : "",
    ),
    pyStr(cycles),
    f(start),
    f(end),
    f(start !== null && end !== null ? end - start : null, true),
    f(collected),
    f(start !== null && collected !== null ? collected - start : null, true),
    f(malloc("baseline")),
    f(malloc("end+30s")),
    f(iosurface("baseline")),
    f(iosurface("end+30s")),
    resizes === null ? "-" : pyStr(resizes),
    fixed(
      get(
        metrics,
        "timeline.floor_growth_mib_per_cycle.web_content",
        Number.NaN,
      ),
      2,
      { sign: true },
    ),
  ];
}

export const EXPERIMENT_HEADERS = [
  "run",
  "cycles",
  "WC start",
  "WC +30s",
  "delta",
  "WC after GC",
  "delta",
  "malloc 0",
  "malloc +30s",
  "iosurf 0",
  "iosurf +30s",
  "resizes",
  "floor MiB/cycle",
];

if (import.meta.main) {
  await runMain(async () => {
    const paths = process.argv.slice(2);
    if (!paths.length)
      throw new SystemExit(
        "usage: app_report.ts REPORT.json [...]  (one comparable line per report; WebContent MiB)",
      );
    const rows: string[][] = [];
    for (const path of paths) {
      const row = experimentRow(load(path));
      const stem = basename(path, extname(path));
      row[0] = head(
        `${stem.startsWith("app-") ? stem.slice(4) : stem}: ${row[0]}`,
        90,
      );
      rows.push(row);
    }
    console.log(table(EXPERIMENT_HEADERS, rows));
  });
}
