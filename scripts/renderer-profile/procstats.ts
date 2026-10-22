// Per-process resource accounting for the renderer lab (macOS only, no root required).
//
// Uses proc_pid_rusage() with RUSAGE_INFO_V6 (falls back to V4) for processes owned by the
// current user, which covers the lab host and its WebKit helpers. WindowServer belongs to another
// user, so proc_pid_rusage is refused (EPERM); its cumulative CPU time comes from `ps` instead
// (10 ms resolution) and it has no energy counter without root.

import { readFileSync, unlinkSync } from "node:fs";
import { basename } from "node:path";
import { CalledProcessError, RuntimeError } from "../lib/errors.ts";
import {
  parseFloat10,
  parseInt10,
  roundHalfEven,
  splitLines,
  truthy,
} from "../lib/format.ts";
import { capture, check, sh } from "../lib/process.ts";
import { machTimebase, procPidRusage, type RusageField } from "./libproc.ts";

let timebaseCache: { numer: number; denom: number } | undefined;

export function timebase(): { numer: number; denom: number } {
  timebaseCache ??= machTimebase();
  return timebaseCache;
}

/** Convert mach absolute time units (what rusage reports) to nanoseconds. */
export function ticksToNs(ticks: bigint): number {
  const { numer, denom } = timebase();
  return Number((ticks * BigInt(numer)) / BigInt(denom));
}

export type Rusage = {
  flavor: 4 | 6;
  user_ns: number;
  system_ns: number;
  cpu_ns: number;
  energy_nj: number | null;
  penergy_nj: number | null;
  billed_energy: number;
  serviced_energy: number;
  instructions: number;
  cycles: number;
  interrupt_wakeups: number;
  idle_wakeups: number;
  runnable_ns: number;
  phys_footprint: number;
  lifetime_max_phys_footprint: number;
  resident: number;
  diskio_read: number;
  diskio_written: number;
  logical_writes: number;
  start_abstime: number;
  pcpu_ns?: number;
};

/**
 * Cumulative counters for `pid`, or null if it is gone or inaccessible. Counters are exact below
 * 2^53. A V6 refusal for another user's process (EPERM) is refused for V4 too, so trying V4 after
 * any V6 failure gives the same answer as stopping on EPERM.
 */
export function rusage(pid: number): Rusage | null {
  for (const flavor of [6, 4] as const) {
    const value = procPidRusage(pid, flavor);
    if (!value) continue;
    const field = (name: RusageField) => value.get(name) ?? 0n;
    const count = (name: RusageField) => Number(field(name));
    const optional = (name: RusageField) =>
      value.has(name) ? Number(field(name)) : null;
    const user = ticksToNs(field("ri_user_time"));
    const system = ticksToNs(field("ri_system_time"));
    const result: Rusage = {
      flavor,
      user_ns: user,
      system_ns: system,
      cpu_ns: user + system,
      energy_nj: optional("ri_energy_nj"),
      penergy_nj: optional("ri_penergy_nj"),
      billed_energy: count("ri_billed_energy"),
      serviced_energy: count("ri_serviced_energy"),
      instructions: count("ri_instructions"),
      cycles: count("ri_cycles"),
      interrupt_wakeups: count("ri_interrupt_wkups"),
      idle_wakeups: count("ri_pkg_idle_wkups"),
      runnable_ns: ticksToNs(field("ri_runnable_time")),
      phys_footprint: count("ri_phys_footprint"),
      lifetime_max_phys_footprint: count("ri_lifetime_max_phys_footprint"),
      resident: count("ri_resident_size"),
      diskio_read: count("ri_diskio_bytesread"),
      diskio_written: count("ri_diskio_byteswritten"),
      logical_writes: count("ri_logical_writes"),
      start_abstime: count("ri_proc_start_abstime"),
    };
    if (flavor === 6)
      result.pcpu_ns = ticksToNs(
        field("ri_user_ptime") + field("ri_system_ptime"),
      );
    return result;
  }
  return null;
}

export type ProcessTable = Map<number, [ppid: number, command: string]>;

/** Parses `ps -axo pid=,ppid=,comm=` output (the command may contain spaces). */
export function parseProcessTable(text: string): ProcessTable {
  const table: ProcessTable = new Map();
  for (const line of text.split("\n")) {
    const parts = /^(\S+)\s+(\S+)\s+(.+)$/.exec(line.trim());
    if (!parts) continue;
    const pid = parseInt10(parts[1]);
    const ppid = parseInt10(parts[2]);
    if (pid === undefined || ppid === undefined)
      throw new RuntimeError(`unexpected ps line: ${line}`);
    table.set(pid, [ppid, parts[3]]);
  }
  return table;
}

/** pid -> (ppid, command path) for every process. */
export async function processTable(): Promise<ProcessTable> {
  const command = ["ps", "-axo", "pid=,ppid=,comm="];
  const result = await capture(command);
  if (result.status !== 0) throw new CalledProcessError(result.status, command);
  return parseProcessTable(result.stdout);
}

export type Role = string;

export const ROLE_BY_NAME: Readonly<Record<string, Role>> = {
  "renderer-lab": "host",
  "com.apple.WebKit.WebContent": "web_content",
  "com.apple.WebKit.GPU": "gpu",
  "com.apple.WebKit.Networking": "networking",
};
export const ROLE_ORDER: readonly Role[] = [
  "host",
  "web_content",
  "web_content_prewarmed",
  "gpu",
  "networking",
];
export const ROLE_LABEL: Readonly<Record<Role, string>> = {
  host: "host",
  web_content: "WebContent",
  web_content_prewarmed: "WC-prewarm",
  gpu: "GPU",
  networking: "Network",
};

export function roleOf(
  command: string,
  prewarmed = false,
  roleByName: Readonly<Record<string, Role>> = ROLE_BY_NAME,
): Role | null {
  const name = basename(command);
  const role = Object.hasOwn(roleByName, name) ? roleByName[name] : null;
  if (role === "web_content" && prewarmed) return "web_content_prewarmed";
  return role;
}

export type NativePids = {
  hostPid?: number | null;
  webContentPid?: number | null;
  gpuPid?: number | null;
  networkingPid?: number | null;
  prewarmedPids?: number[] | null;
};

/**
 * Map pid -> role from the pids the native host reported for its own WKWebView, checked against
 * `table`.
 *
 * The host asks WebKit for the exact web, GPU and networking process identifiers, so
 * attribution is exact even when other applications share the launching process's
 * coalition (which makes coalition-based discovery ambiguous).
 */
export function membersFrom(
  native: NativePids,
  table: ProcessTable,
  roleByName: Readonly<Record<string, Role>> = ROLE_BY_NAME,
): [members: Map<number, Role>, warnings: string[]] {
  const members = new Map<number, Role>();
  const warnings: string[] = [];
  const wanted: [pid: number | null | undefined, Role, boolean][] = [
    [native.hostPid, "host", false],
    [native.webContentPid, "web_content", false],
    [native.gpuPid, "gpu", false],
    [native.networkingPid, "networking", false],
    ...(native.prewarmedPids ?? []).map((pid): [number, Role, boolean] => [
      pid,
      "web_content",
      true,
    ]),
  ];
  for (const [pid, expected, prewarmed] of wanted) {
    if (!pid || pid <= 0) {
      warnings.push(`${expected} pid not reported`);
      continue;
    }
    const entry = table.get(pid);
    const role = entry ? roleOf(entry[1], prewarmed, roleByName) : null;
    if (role === null || role.split("_prewarmed")[0] !== expected) {
      warnings.push(`pid ${pid} is not the expected ${expected} process`);
      continue;
    }
    members.set(pid, role);
  }
  return [members, warnings];
}

/** `membersFrom` against the current process table. */
export async function resolveMembers(
  native: NativePids,
  roleByName: Readonly<Record<string, Role>> = ROLE_BY_NAME,
): Promise<[members: Map<number, Role>, warnings: string[]]> {
  return membersFrom(native, await processTable(), roleByName);
}

/** Parse ps TIME ([[dd-]hh:]mm:ss[.cc]) to nanoseconds. */
export function parseCpuTime(text: string): number | null {
  let rest = text.trim();
  if (!rest) return null;
  let days = 0;
  if (rest.includes("-")) {
    const dash = rest.indexOf("-");
    const day = parseInt10(rest.slice(0, dash));
    if (day === undefined) throw new RuntimeError(`invalid ps time: ${text}`);
    days = day;
    rest = rest.slice(dash + 1);
  }
  const fields = rest.split(":");
  const seconds = parseFloat10(fields[fields.length - 1]);
  const minutes = fields.length > 1 ? parseInt10(fields[fields.length - 2]) : 0;
  const hours = fields.length > 2 ? parseInt10(fields[fields.length - 3]) : 0;
  if (seconds === undefined || minutes === undefined || hours === undefined)
    return null;
  return roundHalfEven(
    ((days * 24 + hours) * 3600 + minutes * 60 + seconds) * 1e9,
  );
}

export async function psCpuNs(pid: number): Promise<number | null> {
  const result = await capture(["ps", "-o", "time=", "-p", String(pid)]);
  return result.status === 0 ? parseCpuTime(result.stdout) : null;
}

const SIZE_UNITS: Record<string, number> = {
  "": 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
};
const VMMAP_ROW = new RegExp(
  `^(?<name>\\S.*?)\\s{2,}${[
    "virtual",
    "resident",
    "dirty",
    "swapped",
    "volatile",
    "nonvol",
    "empty",
  ]
    .map((key) => `(?<${key}>[\\d.]+[KMG]?)`)
    .join("\\s+")}\\s+(?<count>\\d+)`,
);

export function vmmapBytes(text: string): number {
  const match = /^([\d.]+)([KMG]?)$/.exec(text);
  if (!match) return 0;
  const value = parseFloat10(match[1]);
  if (value === undefined)
    throw new RuntimeError(`could not convert string to float: '${match[1]}'`);
  return roundHalfEven(value * SIZE_UNITS[match[2]]);
}

export type VmmapRegion = {
  virtual: number;
  resident: number;
  dirty: number;
  swapped: number;
  count: number;
};
export type VmmapSummary = {
  physicalFootprint: number | null;
  regions: Record<string, VmmapRegion>;
};

/** The region table of `vmmap -summary` output. */
export function parseVmmapSummary(text: string): VmmapSummary {
  let physical: number | null = null;
  const regions: Record<string, VmmapRegion> = {};
  for (const line of splitLines(text)) {
    if (line.startsWith("Physical footprint:")) {
      const words = line.trim().split(/\s+/);
      physical = vmmapBytes(words[words.length - 1]);
    } else if (line.startsWith("MALLOC ZONE")) {
      break; // the second table has a different layout
    } else {
      const groups = VMMAP_ROW.exec(line)?.groups;
      if (groups && groups.name !== "VIRTUAL") {
        regions[groups.name.trim()] = {
          virtual: vmmapBytes(groups.virtual),
          resident: vmmapBytes(groups.resident),
          dirty: vmmapBytes(groups.dirty),
          swapped: vmmapBytes(groups.swapped),
          count: Number(groups.count),
        };
      }
    }
  }
  return { physicalFootprint: physical, regions };
}

/**
 * `vmmap -summary` region table. Unlike `footprint`, it names graphics memory the process
 * owns without mapping ("owned unmapped (graphics)": IOSurface/canvas backing stores).
 */
export async function vmmapSummary(pid: number): Promise<VmmapSummary | null> {
  const result = await capture(["vmmap", "-summary", String(pid)], {
    timeoutSeconds: 30,
  });
  if (result.timedOut || result.status !== 0) return null;
  return parseVmmapSummary(result.stdout);
}

export async function findPid(name: string): Promise<number | null> {
  const result = await capture(["pgrep", "-x", name]);
  const pids = result.stdout.trim().split(/\s+/).filter(Boolean);
  return pids.length ? Number(pids[0]) : null;
}

/** `footprint -j` of the given processes (per-category breakdown unless `categories` is false). */
export async function footprintOf(
  ids: readonly number[],
  path: string,
  categories: boolean,
): Promise<Record<string, unknown> & { processes: FootprintProcess[] }> {
  const command = ["footprint", "--swapped", "-j", path];
  if (!categories) command.splice(1, 0, "--noCategories");
  for (const pid of ids) command.push("-p", String(pid));
  await check(command, { stdout: "ignore" });
  const footprint = JSON.parse(readFileSync(path, "utf8"));
  try {
    unlinkSync(path);
  } catch {}
  if (truthy(footprint.errors)) throw new RuntimeError(footprint.errors);
  return footprint;
}

export type FootprintProcess = {
  pid: number;
  name: string;
  footprint: number;
  auxiliary?: { phys_footprint_peak?: number } | null;
  categories?: Record<string, Record<string, number>> | null;
};

/** True while the login session shows the lock screen (the benchmark window cannot be visible). */
export async function sessionLocked(): Promise<boolean> {
  const result = await capture(["ioreg", "-n", "Root", "-d1", "-a"]);
  // The registry is an XML property list; any dictionary may carry the key.
  return /<key>CGSSessionScreenIsLocked<\/key>\s*<true\s*\/>/.test(
    result.stdout,
  );
}

/** `platform.platform()` on macOS, e.g. "macOS-15.1-arm64-arm-64bit". */
export async function platformName(): Promise<string> {
  const [release, machine, processor] = await Promise.all([
    sh("sw_vers", "-productVersion"),
    sh("uname", "-m"),
    sh("uname", "-p"),
  ]);
  return [
    "macOS",
    release,
    machine,
    processor === machine ? "" : processor,
    "64bit",
  ]
    .filter(Boolean)
    .join("-");
}

/** `time.monotonic_ns()` (exact below 2^53 ns, about 104 days of uptime). */
export const monotonicNs = () => Number(process.hrtime.bigint());

export type SeriesEntry = {
  tMonoNs: number;
  tWall: number;
  processes: Record<
    string,
    {
      role: Role;
      cpu_ns: number;
      energy_nj: number | null;
      phys_footprint: number;
    }
  >;
  windowServerCpuNs?: number | null;
};

/** Lightweight 1 Hz timeline of cumulative CPU/energy/footprint counters. */
export class Poller {
  private members = new Map<number, Role>();
  readonly series: SeriesEntry[] = [];
  private halted = false;
  private wake: (() => void) | undefined;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly interval = 1.0,
    private readonly windowServerPid: number | null = null,
  ) {}

  setMembers(members: ReadonlyMap<number, Role>): void {
    this.members = new Map(members);
  }

  start(): void {
    this.loop ??= this.run();
  }

  /** Stops sampling; resolves once a sample in progress has been recorded. */
  async stop(): Promise<void> {
    this.halted = true;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (!this.halted) {
      await new Promise<void>((done) => {
        const timer = setTimeout(done, this.interval * 1000);
        this.wake = () => {
          clearTimeout(timer);
          done();
        };
      });
      if (this.halted) return;
      const members = new Map(this.members);
      if (!members.size) continue;
      const entry: SeriesEntry = {
        tMonoNs: monotonicNs(),
        tWall: Date.now() / 1000,
        processes: {},
      };
      for (const [pid, role] of members) {
        const value = rusage(pid);
        if (value)
          entry.processes[String(pid)] = {
            role,
            cpu_ns: value.cpu_ns,
            energy_nj: value.energy_nj,
            phys_footprint: value.phys_footprint,
          };
      }
      if (this.windowServerPid)
        entry.windowServerCpuNs = await psCpuNs(this.windowServerPid);
      this.series.push(entry);
    }
  }
}
