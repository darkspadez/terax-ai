// The help text below (DESCRIPTION) is this module's documentation.

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ArgumentParser } from "../lib/cli.ts";
import {
  CalledProcessError,
  errorRepr,
  interruption,
  RuntimeError,
  runMain,
  SystemExit,
} from "../lib/errors.ts";
import {
  fixed,
  maxOf,
  parseFloat10,
  parseInt10,
  pyDumps,
  pyRepr,
  roundTo,
  sum,
} from "../lib/format.ts";
import { cors, type Listening, listen, readBody } from "../lib/http.ts";
import {
  capture,
  check,
  exitedWithin,
  launched,
  loadAverage,
  realResolve,
  returncode,
  running,
  sh,
  sleep,
  which,
} from "../lib/process.ts";
import type { Dict } from "../renderer-profile/lab_report.ts";
import { lockExclusive } from "../renderer-profile/libproc.ts";
import {
  findPid,
  footprintOf,
  monotonicNs,
  Poller,
  type ProcessTable,
  platformName,
  processTable,
  psCpuNs,
  ROLE_BY_NAME,
  resolveMembers,
  rusage,
  sessionLocked,
  vmmapSummary,
} from "../renderer-profile/procstats.ts";
import {
  type AppEvent,
  type AppReport,
  compactFootprint,
  compactRusage,
  compactVmmap,
  compare,
  computeMetrics,
  dump,
  load,
  qualify,
  roundMetrics,
  SCENARIOS,
  slimEvent,
  summarize,
  vmmapIOSurfaces,
} from "./app_report.ts";

const DESCRIPTION = `App lab: ground-truth resource benchmark of the REAL Terax application (macOS).

Unlike scripts/renderer-profile (a synthetic renderer in a bare WKWebView) this builds the real
app, with the full React shell, real PTYs, real tabs/splits and the real window, from a source
tree compiled with the \`bench\` cargo feature and \`TERAX_BENCH=1\`. A scenario driver compiled into
that build (src/bench) runs inside the UI using the app's own tab actions and reports phase events
to this orchestrator over a local HTTP server (the scripts/pty-smoke pattern). For every event the
orchestrator samples exactly the app's own processes (host, WebContent, GPU, Networking: the pids
come from the webview itself, see src-tauri/src/modules/bench.rs), with per-category \`footprint\`,
\`vmmap\`, rusage V6 CPU/energy/wakeups, and the in-app diagnostics the driver attached.

Scenarios (\`--scenario\`):
  tabs           shell tab + agent tab (\`--variant 4\`: shell, agent, split agent+agent, shell);
                 switch tabs \`--cycles\` times with \`--dwell-ms\` dwell, sample after each switch
  resize         window drag-resize cycles with live-resize semantics (shrink/grow in steps)
  split-drag     pane divider dragged back and forth with real mouse events (shell|agent split)
  occlusion      order the window out/front \`--cycles\` times
  agents-steady  1 visible + \`--hidden-agents\` hidden agent tabs for \`--duration\` s (CPU/energy)
  idle           one idle shell for \`--duration\` s
  input          native key events / input-method calls into a PTY reader (pass/fail in page.log)

The app runs from an isolated bundle (identifier app.crynta.terax.app-lab, its own HOME), never
the user's profile; the bench build refuses to start under the product identifier. Build once
(\`--build-only\`, release with the feature, a separate cargo target dir) and reuse with
\`--reuse-build\`. To measure a pristine revision rather than the working tree use
\`scripts/app-lab/export-tree.sh DEST [REV]\` and pass \`--source DEST\`.

Every run writes one JSON report (raw samples, a 1 Hz counter timeline, derived metrics and a
human summary); \`--compare A.json [B.json ...]\` prints deltas (medians when repeated).`;

const HERE = import.meta.dirname;
const REPO = join(HERE, "../..");
const IDENTIFIER: string = "app.crynta.terax.app-lab";
const PRODUCT_NAME = "Terax App Lab";
const MAX_ATTEMPTS = 3;
const LOCK_PATH = join(tmpdir(), "terax-app-lab.lock");
const SCOPE =
  "The real Terax application (bench build: full React shell, real PTYs and tabs, real window) " +
  "in an isolated profile, driven by an in-app scenario driver; process pids come from the " +
  "webview itself. A synthetic coding-agent program runs in the PTYs. Single machine, " +
  "single display; not packaged-app signing, other users' fonts/shell config or cross-platform.";
/** The app's host process is the `terax` binary of the bench bundle. */
const APP_ROLE_BY_NAME = { ...ROLE_BY_NAME, terax: "host" };

const parser = new ArgumentParser(
  {
    scenario: { flag: "--scenario", choices: SCENARIOS },
    variant: {
      flag: "--variant",
      default: null,
      help: "tabs: 2 (default) or 4",
    },
    source: {
      flag: "--source",
      help: "source tree to build (default: this checkout; see export-tree.sh)",
    },
    revision: {
      flag: "--revision",
      help: "label for a source tree without Git metadata",
    },
    targetDir: {
      flag: "--target-dir",
      help: "cargo target dir (default: app-lab-target-<profile> next to --output); use a private one so the shared src-tauri/target lock is not contended",
    },
    profile: {
      flag: "--profile",
      choices: ["release", "debug"],
      default: "release",
      help: "release (default): what users run, with the bench feature",
    },
    buildOnly: { flag: "--build-only", action: "store_true" },
    reuseBuild: {
      flag: "--reuse-build",
      action: "store_true",
      help: "reuse the frontend and app already built for this source/profile",
    },
    app: {
      flag: "--app",
      help: "run this prebuilt bench .app instead of building",
    },
    output: {
      flag: "--output",
      help: "scratch directory (default: a temp directory)",
    },
    report: {
      flag: "--report",
      help: "JSON report path (default: <output>/report.json)",
    },
    label: { flag: "--label", help: "free-form label stored in the report" },
    toggle: {
      flag: "--toggle",
      action: "append",
      metavar: "NAME=VALUE",
      help: "experiment toggle: localStorage terax:bench:NAME (repeatable)",
    },
    localStorage: {
      flag: "--local-storage",
      action: "append",
      metavar: "KEY=VALUE",
      help: "raw localStorage entry (VALUE 'null' removes), e.g. terax:terminal-canvas-park-ms=off",
    },
    window: {
      flag: "--window",
      default: "1280x820",
      help: "window size in points, WxH",
    },
    instrument: {
      flag: "--instrument",
      action: "store_true",
      help: "patch WebGPU/DOM prototypes with lifecycle counters (calls, wrappers created/finalized, canvas re-parenting); compare with an uninstrumented run",
    },
    gc: {
      flag: "--gc",
      nargs: "?",
      const: "private",
      choices: ["private", "alloc"],
      help: "after the idle tail, request a full garbage collection and sample +2 s/+10 s: 'private' (default) is WebKit's testing SPI, 'alloc' is allocation pressure from the page (what an in-app valve could do)",
    },
    tick: {
      flag: "--tick",
      type: "float",
      help: "idle, fs-churn: take a full sample (with the layer tree and the page event log) every this many seconds (fs-churn default 30)",
    },
    unfocused: {
      flag: "--unfocused",
      action: "store_true",
      help: "fs-churn: after measure-start move Finder to the front, so the window stays visible but is not key (an app left behind another one)",
    },
    noChurn: {
      flag: "--no-churn",
      action: "store_true",
      help: "fs-churn: do not start the file-system churn (dev server and explorer only)",
    },
    churnArgs: {
      flag: "--churn-args",
      default: "",
      help: "fs-churn: extra arguments for scripts/app-lab/fs-churn.mjs run (--build-every S, --build-files N, --build-seconds S, --seed N)",
    },
    holdTab: {
      flag: "--hold-tab",
      type: "int",
      help: "tabs: index of the tab shown at baseline (and for the whole run with --no-switch), in creation order",
    },
    valve: {
      flag: "--valve",
      metavar: "EVERY_S:CHUNKS:MB",
      help: "mitigation probe: every EVERY_S seconds the page allocates CHUNKS zero-filled ArrayBuffers of MB MiB to push JavaScriptCore into a full GC (tabs scenario)",
    },
    probe: {
      flag: "--probe",
      choices: [
        "blur",
        "readonly",
        "caret-transparent",
        "caret-animation-manual",
        "zero-size",
        "clip",
        "display-contents",
        "selection",
        "selection-nofocus-div",
      ],
      help: "idle: remove one suspected source of idle display refreshes before measuring",
    },
    noSwitch: {
      flag: "--no-switch",
      action: "store_true",
      help: "tabs control: same loop, timing, samples and workload, but never switch tabs",
    },
    vibrancy: {
      flag: "--vibrancy",
      choices: ["on", "off"],
      help: "set the window vibrancy preference through the app's own store before the scenario (default: the app default, off)",
    },
    cwdShell: {
      flag: "--cwd-shell",
      help: "working directory of shell tabs; the app is launched in it, so the first tab and the file explorer start there (default: the isolated HOME)",
    },
    cwdAgent: {
      flag: "--cwd-agent",
      help: "working directory of agent tabs (different directories make the explorer and git panel follow each tab switch)",
    },
    agentArgs: {
      flag: "--agent-args",
      default: "",
      help: "extra arguments for scripts/app-lab/agent-sim.mjs",
    },
    cycles: { flag: "--cycles", type: "int" },
    dwellMs: { flag: "--dwell-ms", type: "int", default: 3000 },
    hiddenMs: { flag: "--hidden-ms", type: "int", default: 3000 },
    visibleMs: { flag: "--visible-ms", type: "int", default: 2000 },
    duration: {
      flag: "--duration",
      type: "float",
      help: "measured seconds (agents-steady default 60, idle default 30)",
    },
    warmup: { flag: "--warmup", type: "float", default: 5 },
    hiddenAgents: { flag: "--hidden-agents", type: "int", default: 6 },
    steps: { flag: "--steps", type: "int", default: 120 },
    stepPoints: { flag: "--step-points", type: "float", default: 4 },
    stepIntervalMs: { flag: "--step-interval-ms", type: "float", default: 16 },
    dragSeconds: {
      flag: "--drag-seconds",
      type: "float",
      help: "split-drag: seconds of divider motion per drag (default 6)",
    },
    dragAmplitude: {
      flag: "--drag-amplitude",
      type: "float",
      help: "split-drag: sweep amplitude as a share of the split axis (default 0.2)",
    },
    mouseHz: {
      flag: "--mouse-hz",
      type: "float",
      help: "split-drag: mouse sample rate (default 125)",
    },
    growFirst: {
      flag: "--grow-first",
      action: "store_true",
      help: "resize: grow the window before shrinking it (past the size the canvas was allocated for)",
    },
    resizeMode: {
      flag: "--resize-mode",
      choices: ["live", "plain"],
      default: "live",
    },
    vmmap: {
      flag: "--vmmap",
      action: "boolean_optional",
      default: null,
      help: "`vmmap -summary` of WebContent and GPU per sample (default: on for tabs/resize/occlusion; it briefly suspends the target)",
    },
    iosurfaces: {
      flag: "--iosurfaces",
      action: "store_true",
      help: "list the IOSurface regions of WebContent and GPU (`vmmap -v`: count, sizes, volatile) in every full sample",
    },
    categories: {
      flag: "--categories",
      action: "boolean_optional",
      default: true,
      help: "keep footprint's per-category breakdown (default on)",
    },
    pollInterval: {
      flag: "--poll-interval",
      type: "float",
      default: 1.0,
      help: "seconds between timeline counter samples (phys_footprint, CPU, energy per process)",
    },
    sampling: {
      flag: "--sampling",
      choices: ["full", "light"],
      default: "full",
      help: "full: footprint+vmmap after every event (they briefly suspend the target and perturb it); light: only every --full-every-th cycle and the non-cycle phases are sampled with them, the rest rely on the cheap timeline (use a small --poll-interval)",
    },
    lightPhases: {
      flag: "--light-phases",
      default: String.raw`^(switch-\d+|cycle-\d+-(hidden|visible)|shrink-\d+|grow-\d+|drag-\d+)$`,
      help: "light sampling: regular expression of the phases that get only the cheap counters (every other phase, setup, the tail and GC samples, is sampled in full)",
    },
    fullEvery: {
      flag: "--full-every",
      type: "int",
      default: 10,
      help: "light sampling: still take a full sample every N cycles",
    },
    waitUnlocked: {
      flag: "--wait-unlocked",
      type: "float",
      default: 0,
      metavar: "SECONDS",
    },
    waitExclusive: {
      flag: "--wait-exclusive",
      type: "float",
      default: 1800,
      metavar: "SECONDS",
      help: "wait this long while another benchmark window (renderer-lab, app-lab) is running",
    },
    maxConsecutiveFailures: {
      flag: "--max-consecutive-failures",
      type: "int",
      default: 3,
    },
    timeout: {
      flag: "--timeout",
      type: "float",
      help: "hard lifetime of the app in seconds (default derived)",
    },
    compare: { flag: "--compare", nargs: "+", metavar: "BASELINE.json" },
    candidate: {
      flag: "--candidate",
      nargs: "+",
      metavar: "CANDIDATE.json",
      help: "with --compare: compare existing reports without running",
    },
    recompute: {
      flag: "--recompute",
      nargs: "+",
      metavar: "REPORT.json",
      help: "recompute metrics and summary of existing reports",
    },
  } as const,
  { description: DESCRIPTION, allowAbbrev: false },
);

export type Args = ReturnType<typeof parser.parse>;

export const parseArgs = (argv: readonly string[]) => parser.parse(argv);

const monotonic = () => monotonicNs() / 1e9;

/** The account's home directory from the user database, whatever HOME says (`id -P`). */
async function passwdHome(): Promise<string> {
  const fields = (await sh("id", "-P")).split(":");
  return fields.length >= 10 && fields[8] ? fields[8] : homedir();
}

/** Benchmark windows that would steal focus or distort CPU from this one. */
async function otherBenchmarks(): Promise<string[]> {
  const found: string[] = [];
  for (const [pid, [, command]] of await processTable()) {
    const name = basename(command);
    if (
      name === "renderer-lab" ||
      (name === "terax" &&
        command.includes("Terax App Lab") &&
        pid !== process.pid)
    )
      found.push(`${name}[${pid}]`);
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------

/** Frontend with TERAX_BENCH=1, then the Tauri bundle with the `bench` feature. Returns the .app. */
async function build(
  args: Args,
  source: string,
  output: string,
  targetDir: string,
): Promise<string> {
  const dist = join(output, "dist");
  const bundleDir = join(targetDir, args.profile, "bundle/macos");
  const app = join(bundleDir, `${PRODUCT_NAME}.app`);
  if (
    args.reuseBuild &&
    existsSync(app) &&
    existsSync(join(dist, "index.html"))
  ) {
    console.log(`Reusing ${app}`);
    return app;
  }
  const config = join(output, "tauri.conf.json");
  writeFileSync(
    config,
    JSON.stringify({
      productName: PRODUCT_NAME,
      identifier: IDENTIFIER,
      build: { beforeBuildCommand: "", frontendDist: dist },
      bundle: { createUpdaterArtifacts: false },
    }),
  );
  const env = {
    ...process.env,
    TERAX_BENCH: "1",
    TERAX_BENCH_IDENTIFIER: IDENTIFIER,
    CARGO_TARGET_DIR: targetDir,
  };
  const started = monotonic();
  let frontendSeconds: number;
  const log = openSync(join(output, "build.log"), "w");
  try {
    const logged = { cwd: source, env, stdout: log, stderr: log };
    console.log("Building the frontend (TERAX_BENCH=1)...");
    await check(
      ["bun", "run", "vite", "build", "--outDir", dist, "--emptyOutDir"],
      logged,
    );
    frontendSeconds = monotonic() - started;
    console.log(`Building the app (cargo ${args.profile}, feature bench)...`);
    const command = [
      "bun",
      "run",
      "tauri",
      "build",
      "--bundles",
      "app",
      "--features",
      "bench",
      "--config",
      config,
    ];
    if (args.profile === "debug") command.push("--debug");
    await check(command, logged);
  } finally {
    closeSync(log);
  }
  console.log(
    `Built in ${fixed(monotonic() - started, 0)}s (frontend ${fixed(frontendSeconds, 0)}s)`,
  );
  writeFileSync(
    join(output, "build-seconds.json"),
    JSON.stringify({ frontend: frontendSeconds, total: monotonic() - started }),
  );
  if (!existsSync(app)) throw new RuntimeError(`build produced no ${app}`);
  return app;
}

// ---------------------------------------------------------------------------------------------
// Profile isolation
// ---------------------------------------------------------------------------------------------

/** Removes everything a previous run left for the bench identifier (never the product's). */
async function cleanProfile(home: string): Promise<void> {
  if (IDENTIFIER === "app.crynta.terax") throw new Error("AssertionError");
  rmSync(home, { recursive: true, force: true });
  // WebKit, Tauri and cfprefsd may resolve the user's real library even with HOME overridden.
  const real = await passwdHome();
  for (const base of [
    "Library/Application Support",
    "Library/WebKit",
    "Library/Caches",
    "Library/HTTPStorages",
    "Library/Saved Application State",
    "Library/Preferences",
  ])
    for (const name of [
      IDENTIFIER,
      `${IDENTIFIER}.savedState`,
      `${IDENTIFIER}.plist`,
    ]) {
      const target = join(real, base, name);
      try {
        if (statSync(target).isDirectory())
          rmSync(target, { recursive: true, force: true });
        else unlinkSync(target);
      } catch {}
    }
  mkdirSync(home, { recursive: true });
}

export function descendants(root: number, table: ProcessTable): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, [ppid]] of table) {
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const found: number[] = [];
  const stack = [root];
  while (stack.length)
    for (const child of children.get(stack.pop() as number) ?? []) {
      found.push(child);
      stack.push(child);
    }
  return found;
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

type Pending = { event: AppEvent; reply: Dict; done: () => void };

/** Receives phase events. A request is answered only once the main loop has sampled it. */
export class ReportServer {
  readonly log: string[] = [];
  private readonly queue: Pending[] = [];
  private waiter: ((pending: Pending) => void) | undefined;
  private listening: Listening | undefined;

  async start(): Promise<void> {
    this.listening = await listen((request, response) =>
      this.handle(request, response),
    );
  }

  get url(): string {
    return (this.listening as Listening).url;
  }

  close(): void {
    this.listening?.close();
  }

  /** The next event, or undefined after `seconds` without one. */
  next(seconds: number): Promise<Pending | undefined> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((done) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        done(undefined);
      }, seconds * 1000);
      this.waiter = (pending) => {
        clearTimeout(timer);
        this.waiter = undefined;
        done(pending);
      };
    });
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method === "OPTIONS") {
      cors(response, true);
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(501, { "Content-Length": "0" });
      response.end();
      return;
    }
    const body = await readBody(request);
    if (request.url === "/log") {
      // page errors and console output, no sampling handshake
      this.log.push(new TextDecoder().decode(body));
      cors(response, true);
      response.writeHead(204);
      response.end();
      return;
    }
    const reply: Dict = {};
    let release: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    let event: unknown;
    try {
      event = JSON.parse(body.toString("utf8"));
    } catch {}
    if (event !== null && typeof event === "object" && !Array.isArray(event)) {
      const pending = { event: event as AppEvent, reply, done: release };
      if (this.waiter) this.waiter(pending);
      else this.queue.push(pending);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      done,
      new Promise((resolve) => {
        timer = setTimeout(resolve, 900_000);
      }),
    ]);
    clearTimeout(timer);
    const payload = Buffer.from(JSON.stringify(reply));
    cors(response, true);
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
    });
    response.end(payload);
  }
}

export function scenarioJson(args: Args, bun: string): Dict {
  const size = args.window.toLowerCase().split("x").map(parseFloat10);
  if (size.length !== 2 || size.some((v) => v === undefined))
    throw new RuntimeError(`invalid --window ${pyRepr(args.window)}`);
  const [width, height] = size as number[];
  const agent =
    `exec ${bun} ${join(HERE, "agent-sim.mjs")} ${args.agentArgs}`.trim();
  const local: Record<string, string | null> = {};
  const partition = (entry: string) => {
    const at = entry.indexOf("=");
    return at < 0 ? [entry, ""] : [entry.slice(0, at), entry.slice(at + 1)];
  };
  for (const entry of args.localStorage) {
    const [key, value] = partition(entry);
    local[key] = value === "null" ? null : value;
  }
  for (const entry of args.toggle) {
    const [key, value] = partition(entry);
    local[`terax:bench:${key}`] = value || "1";
  }
  const cwds = Object.fromEntries(
    (
      [
        ["shell", args.cwdShell],
        ["agent", args.cwdAgent],
      ] as const
    )
      .filter(([, path]) => path)
      .map(([key, path]) => [key, realResolve(path as string)]),
  );
  let valve: Dict | null = null;
  if (args.valve) {
    // Like zip(), only as many parts as there are names are read.
    const parts = args.valve
      .split(":")
      .slice(0, 3)
      .map((part) => {
        const value = parseFloat10(part);
        if (value === undefined)
          throw new RuntimeError(
            `could not convert string to float: ${pyRepr(part)}`,
          );
        return value;
      });
    valve = Object.fromEntries(
      parts.map((value, index) => [
        ["everyS", "chunks", "chunkMb"][index],
        value,
      ]),
    );
  }
  const scenario: Dict = {
    name: args.scenario ?? null,
    variant: args.variant ?? null,
    agentCommand: agent,
    window: { width, height },
    dwellMs: args.dwellMs,
    hiddenMs: args.hiddenMs,
    visibleMs: args.visibleMs,
    warmupS: args.warmup,
    hiddenAgents: args.hiddenAgents,
    steps: args.steps,
    stepPoints: args.stepPoints,
    stepIntervalMs: args.stepIntervalMs,
    live: args.resizeMode === "live",
    localStorage: local,
    cwds: Object.keys(cwds).length ? cwds : null,
    gc: args.gc ?? null,
    noSwitch: args.noSwitch ? true : null,
    probe: args.probe ?? null,
    valve,
    holdTab: args.holdTab ?? null,
    growFirst: args.growFirst ? true : null,
    dragS: args.dragSeconds ?? null,
    dragAmplitude: args.dragAmplitude ?? null,
    mouseHz: args.mouseHz ?? null,
    instrument: args.instrument ? true : null,
    tickS:
      args.tick !== undefined
        ? args.tick
        : args.scenario === "fs-churn"
          ? 30
          : null,
    unfocused: args.unfocused ? true : null,
    prefs: args.vibrancy ? { windowVibrancy: args.vibrancy === "on" } : null,
  };
  const defaults: Record<string, number> = {
    tabs: 40,
    occlusion: 20,
    resize: 3,
    "split-drag": 3,
  };
  if (args.cycles !== undefined || (args.scenario && args.scenario in defaults))
    scenario.cycles = args.cycles ?? defaults[args.scenario as string];
  if (args.duration !== undefined) scenario.durationS = args.duration;
  return Object.fromEntries(
    Object.entries(scenario).filter(([, value]) => value !== null),
  );
}

export function hostTimeout(args: Args, scenario: Dict): number {
  if (args.timeout !== undefined) return args.timeout;
  const num = (key: string, fallback?: number) =>
    Number(key in scenario ? scenario[key] : fallback);
  const name = args.scenario;
  if (name === "tabs")
    return num("cycles") * (num("dwellMs") / 1000 + 12) + 240;
  if (name === "occlusion")
    return (
      num("cycles") * ((num("hiddenMs") + num("visibleMs")) / 1000 + 12) + 240
    );
  if (name === "resize") return num("cycles") * 40 + 300;
  if (name === "split-drag")
    return num("cycles") * (num("dragS", 6) + 30) + 360;
  return (Number(scenario.durationS) || 60) + args.warmup + 240;
}

async function run(
  args: Args,
  app: string,
  source: string,
  output: string,
): Promise<number> {
  const home = join(output, "home");
  await cleanProfile(home);
  const reportPath = realResolve(args.report ?? join(output, "report.json"));
  mkdirSync(dirname(reportPath), { recursive: true });
  const bun = which("bun");
  if (!bun) throw new SystemExit("bun is required for the synthetic agent");
  const scenario = scenarioJson(args, bun);
  const timeout = hostTimeout(args, scenario);
  const vmmapEnabled =
    args.vmmap ??
    ["tabs", "resize", "split-drag", "occlusion"].includes(
      args.scenario as string,
    );
  const info = await capture([
    "plutil",
    "-convert",
    "json",
    "-o",
    "-",
    join(app, "Contents/Info.plist"),
  ]);
  if (info.status !== 0)
    throw new RuntimeError(`cannot read ${join(app, "Contents/Info.plist")}`);
  const executable = join(
    app,
    "Contents/MacOS",
    JSON.parse(info.stdout).CFBundleExecutable,
  );

  const revision = await capture(["git", "-C", source, "rev-parse", "HEAD"]);
  const hasGit = revision.status === 0 && existsSync(join(source, ".git"));
  let buildSeconds: unknown = {};
  if (existsSync(join(output, "build-seconds.json")))
    buildSeconds = JSON.parse(
      readFileSync(join(output, "build-seconds.json"), "utf8"),
    );
  const batt = await sh("pmset", "-g", "batt");
  const environment: Dict = {
    chip: await sh("sysctl", "-n", "machdep.cpu.brand_string"),
    logicalCpus: await sh("sysctl", "-n", "hw.ncpu"),
    memoryBytes: await sh("sysctl", "-n", "hw.memsize"),
    macOS: await sh("sw_vers", "-productVersion"),
    build: await sh("sw_vers", "-buildVersion"),
    power: batt.split(/\r?\n/)[0] ?? "",
    thermal: await sh("pmset", "-g", "therm"),
    displays:
      (await sh("system_profiler", "SPDisplaysDataType")).split("Resolution:")
        .length - 1,
    loadAverageStart: loadAverage(),
  };
  const qualification: {
    qualified: boolean;
    failures: Dict[];
    retried?: Dict[];
    advisories?: string[];
  } = { qualified: true, failures: [] };
  const samples: Dict[] = [];
  const manifest: Dict = {
    schema: "terax-app-lab/1",
    scope: SCOPE,
    config: {
      scenario: args.scenario ?? null,
      label: args.label ?? null,
      profile: args.profile,
      vmmap: vmmapEnabled,
      categories: args.categories,
      pollIntervalS: args.pollInterval,
      hostTimeoutS: timeout,
      scenarioJson: Object.fromEntries(
        Object.entries(scenario).filter(([key]) => key !== "agentCommand"),
      ),
      agentArgs: args.agentArgs,
      buildSeconds,
    },
    sourceRevision: hasGit ? revision.stdout.trim() : (args.revision ?? null),
    sourceTree: source,
    platform: await platformName(),
    environment,
    appBinarySha256: createHash("sha256")
      .update(readFileSync(executable))
      .digest("hex"),
    qualification,
    warnings: [],
    samples,
    series: [],
  };

  const server = new ReportServer();
  await server.start();
  const windowServer = await findPid("WindowServer");
  const poller = new Poller(args.pollInterval, windowServer);
  const started = monotonic();
  const warnings = new Set<string>();
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !["TAURI_", "VITE_", "CARGO_"].some((prefix) => key.startsWith(prefix)),
    ),
  );
  Object.assign(env, {
    HOME: home,
    TERAX_BENCH_ISOLATED: "1",
    TERAX_BENCH_SCENARIO: JSON.stringify(scenario),
    TERAX_BENCH_REPORT_URL: server.url,
    SHELL: process.env.SHELL ?? "/bin/zsh",
  });
  delete env.ZDOTDIR;
  const log = openSync(join(output, "app.log"), "w");
  let churn: ChildProcess | undefined;
  let cwdShell = args.cwdShell;
  if (args.scenario === "fs-churn") {
    if (!cwdShell) {
      cwdShell = join(output, "workspace");
      await check([bun, join(HERE, "fs-churn.mjs"), "prepare", cwdShell, REPO]);
    }
    scenario.cwds = { shell: realResolve(cwdShell) };
    env.TERAX_BENCH_SCENARIO = JSON.stringify(scenario);
  }
  const launchArgs = cwdShell ? [realResolve(cwdShell)] : [];
  const lightPhases = new RegExp(args.lightPhases, "y");
  const host = await launched(
    spawn(executable, launchArgs, {
      cwd: home,
      env,
      stdio: ["inherit", log, log],
      detached: true,
    }),
  );
  manifest.hostPid = host.pid;
  // Hold the display awake (like the lab host's process assertion) so the idle timer cannot lock
  // the screen and occlude the window mid-run; -w ends it with the app.
  const awake = await launched(
    spawn("/usr/bin/caffeinate", ["-d", "-i", "-u", "-w", String(host.pid)], {
      stdio: "inherit",
    }),
  );
  poller.start();
  let failed: unknown;
  let consecutiveFailures = 0;

  /** Ends the churn's process group (SIGKILL if it outlives SIGTERM by 10 s). */
  const stopChurn = async () => {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (!churn || !running(churn)) break;
      try {
        process.kill(-(churn.pid as number), signal);
      } catch {
        break;
      }
      await exitedWithin(churn, 10);
    }
    churn = undefined;
  };

  /** Scenario side effects that must start right after a phase was sampled. */
  const afterSample = async (phase: string) => {
    if (args.scenario !== "fs-churn") return;
    if (phase === "measure-start" && churn === undefined && !args.noChurn) {
      const churnLog = openSync(join(output, "churn.log"), "w");
      try {
        churn = await launched(
          spawn(
            bun,
            [
              join(HERE, "fs-churn.mjs"),
              "run",
              realResolve(cwdShell as string),
              ...args.churnArgs.split(/\s+/).filter(Boolean),
            ],
            { stdio: ["inherit", churnLog, churnLog], detached: true },
          ),
        );
      } finally {
        closeSync(churnLog);
      }
    }
    if (phase === "measure-start" && args.unfocused)
      await check(["open", "-a", "Finder"]).catch((error: unknown) => {
        if (!(error instanceof CalledProcessError)) throw error;
      });
    if (phase === "measure-end" && churn !== undefined) await stopChurn();
  };

  const takeSample = async (event: AppEvent): Promise<Dict> => {
    const native = (event.native || {}) as Dict;
    const [members, memberWarnings] = await resolveMembers(
      native,
      APP_ROLE_BY_NAME,
    );
    if (![...members.values()].includes("host"))
      throw new RuntimeError(
        `Cannot identify the app's host process: ${pyRepr(memberWarnings)}`,
      );
    for (const warning of memberWarnings) warnings.add(warning);
    const table = await processTable();
    const kids = descendants(host.pid as number, table).filter(
      (pid) => !members.has(pid),
    );
    const ids = [...members.keys()];
    const everyone = [...ids, ...kids];
    const tPre = monotonicNs();
    const wall = Date.now() / 1000;
    const pre = Object.fromEntries(
      everyone.map((pid) => [String(pid), compactRusage(rusage(pid))]),
    );
    const wsPre = windowServer ? await psCpuNs(windowServer) : null;
    const cycle = Number(event.cycle || 0);
    lightPhases.lastIndex = 0;
    const light =
      args.sampling === "light" &&
      lightPhases.test(String(event.phase)) &&
      !(
        args.fullEvery &&
        ((cycle % args.fullEvery) + args.fullEvery) % args.fullEvery === 0
      );
    const roles: Record<string, string> = Object.fromEntries(
      [...members].map(([pid, role]) => [String(pid), role]),
    );
    for (const pid of kids) roles[String(pid)] = "workload";
    if (light) {
      // Counters only: no tool touches the target, so the timeline shows its own behaviour.
      const byRole: Record<string, number> = {};
      for (const pid of ids)
        byRole[members.get(pid) as string] = Number(
          (pre[String(pid)] as Dict | null)?.phys_footprint ?? 0,
        );
      poller.setMembers(members);
      return {
        phase: event.phase,
        light: true,
        tMonoNs: tPre,
        tMonoNsPost: tPre,
        tWall: wall,
        elapsedS: monotonic() - started,
        event: slimEvent(event),
        members: ids,
        roles,
        rusage: pre,
        rusagePost: pre,
        windowServerCpuNs: wsPre,
        windowServerCpuNsPost: wsPre,
        footprintByRole: byRole,
        footprintTotal: sum(Object.values(byRole)),
        loadAverage: loadAverage(),
      };
    }
    const raw = await footprintOf(
      ids,
      join(output, "sample-footprint.json"),
      args.categories,
    );
    const vmmap: Dict = {};
    if (vmmapEnabled)
      for (const [pid, role] of members)
        if (role === "web_content" || role === "gpu")
          vmmap[role] = compactVmmap(await vmmapSummary(pid));
    const surfaces: Dict = {};
    if (args.iosurfaces)
      for (const [pid, role] of members)
        if (role === "web_content" || role === "gpu" || role === "host")
          surfaces[role] = await vmmapIOSurfaces(pid);
    const tPost = monotonicNs();
    const post = Object.fromEntries(
      everyone.map((pid) => [String(pid), compactRusage(rusage(pid))]),
    );
    const wsPost = windowServer ? await psCpuNs(windowServer) : null;
    const compact = compactFootprint(raw, members);
    poller.setMembers(members);
    return {
      phase: event.phase,
      tMonoNs: tPre,
      tMonoNsPost: tPost,
      tWall: wall,
      elapsedS: monotonic() - started,
      event: slimEvent(event),
      members: ids,
      roles,
      rusage: pre,
      rusagePost: post,
      windowServerCpuNs: wsPre,
      windowServerCpuNsPost: wsPost,
      footprint: compact,
      footprintByRole: compact.byRole,
      footprintTotal: compact.total,
      ...(Object.keys(vmmap).length ? { vmmap } : {}),
      ...(Object.keys(surfaces).length ? { iosurfaces: surfaces } : {}),
      loadAverage: loadAverage(),
    };
  };

  const interrupt = interruption(["SIGINT", "SIGTERM"]);
  try {
    const deadline = monotonic() + timeout;
    const firstEventBy = monotonic() + 120;
    for (;;) {
      const pending = await interrupt.guard(server.next(1));
      if (!pending) {
        if (!running(host))
          throw new RuntimeError(
            `The app exited (${returncode(host.exitCode, host.signalCode)}) before finishing; see ${join(output, "app.log")}`,
          );
        if (monotonic() > deadline)
          throw new RuntimeError(`Timed out after ${fixed(timeout, 0)}s`);
        if (!samples.length && monotonic() > firstEventBy)
          throw new RuntimeError(
            `The scenario driver never reported (page log: ${pyRepr(server.log.slice(-3))}); see ${join(output, "app.log")}`,
          );
        continue;
      }
      const { event, reply, done } = pending;
      const phase = event.phase as string;
      try {
        if (phase === "error") throw new RuntimeError(event);
        if (phase === "done") {
          samples.push({
            phase: "done",
            tMonoNs: monotonicNs(),
            event: slimEvent(event),
          });
          break;
        }
        const reasons = qualify(args.scenario as string, phase, event);
        const attempt = "attempt" in event ? Number(event.attempt) : 1;
        if (
          reasons.length &&
          attempt < MAX_ATTEMPTS &&
          phase !== "setup" &&
          phase !== "blank"
        ) {
          // Focus was taken by something else just before the event: have the page bring
          // the window back and report the same phase again instead of keeping bad evidence.
          reply.retry = true;
          qualification.retried ??= [];
          qualification.retried.push({ phase, reasons });
          console.log(pyDumps({ phase, retry: reasons }));
          continue;
        }
        const sample = await interrupt.guard(takeSample(event));
        if (reasons.length) {
          qualification.qualified = false;
          qualification.failures.push({ phase, reasons });
          consecutiveFailures += 1;
          if (consecutiveFailures >= args.maxConsecutiveFailures) {
            const locked = (await sessionLocked())
              ? " (the login session is locked)"
              : "";
            throw new RuntimeError(
              `Aborting after ${consecutiveFailures} consecutive unqualified samples${locked}: ${pyRepr(reasons)}`,
            );
          }
        } else consecutiveFailures = 0;
        samples.push(sample);
        await interrupt.guard(afterSample(phase));
        console.log(
          pyDumps({
            phase,
            footprintMiB: roundTo(
              (sample.footprintTotal as number) / 1048576,
              1,
            ),
            ...(reasons.length ? { unqualified: reasons } : {}),
          }),
        );
      } finally {
        done();
      }
    }
  } catch (error) {
    // a partial report is still worth keeping
    failed = error;
    manifest.incomplete = true;
    manifest.error = errorRepr(error);
  } finally {
    interrupt.dispose();
    await stopChurn();
    await poller.stop();
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (!running(host)) break;
      try {
        process.kill(-(host.pid as number), signal);
      } catch {
        break;
      }
      await exitedWithin(host, 10);
    }
    awake.kill("SIGTERM");
    server.close();
    closeSync(log);
    if (server.log.length)
      writeFileSync(join(output, "page.log"), server.log.join("\n"));
    manifest.series = poller.series;
    environment.loadAverageEnd = loadAverage();
    manifest.warnings = [...warnings].sort();
    const measured = samples.filter((s) => "footprint" in s);
    const cpus = parseInt10(String(environment.logicalCpus || 0)) ?? 0;
    const busiest = measured.length
      ? maxOf(measured.map((s) => (s.loadAverage as number[])[0]))
      : 0;
    if (cpus && busiest > cpus / 2) {
      qualification.advisories ??= [];
      qualification.advisories.push(
        `system load average reached ${fixed(busiest, 1)} on ${cpus} logical CPUs; CPU, energy and timing figures may be inflated by other work`,
      );
    }
    if (measured.length) {
      try {
        const report = { ...manifest, samples: measured } as AppReport;
        manifest.metrics = roundMetrics(computeMetrics(report));
        manifest.humanSummary = summarize(report);
      } catch (error) {
        manifest.metricsError = errorRepr(error);
      }
    }
    writeFileSync(reportPath, dump(manifest));
    await cleanProfile(home);
    rmSync(home, { recursive: true, force: true });
  }
  if ("humanSummary" in manifest) console.log(`\n${manifest.humanSummary}`);
  if (args.compare)
    console.log(`\n${compare(args.compare.map(load), load(reportPath))}`);
  console.log(`\nSaved ${reportPath}`);
  if (failed !== undefined) throw failed;
  if (!qualification.qualified) {
    console.error(
      "Run failed qualification: keep the app window visible/focused and rerun.",
    );
    return 2;
  }
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.recompute) {
    for (const path of args.recompute) {
      const stored = load(path);
      stored.metrics = roundMetrics(computeMetrics(stored));
      stored.humanSummary = summarize(stored);
      writeFileSync(path, dump(stored));
      console.log(`Recomputed ${path}`);
    }
    return 0;
  }
  if (args.compare && args.candidate) {
    console.log(compare(args.compare.map(load), args.candidate.map(load)));
    return 0;
  }
  if (process.platform !== "darwin")
    throw new SystemExit(
      "The app lab requires macOS (footprint, vmmap, WKWebView).",
    );
  if (!args.scenario && !args.buildOnly)
    throw new SystemExit("--scenario is required");
  const source = realResolve(args.source ?? REPO);
  const output = realResolve(
    args.output ?? mkdtempSync(join(tmpdir(), "terax-app-lab-")),
  );
  mkdirSync(output, { recursive: true });
  const targetDir = realResolve(
    args.targetDir ?? join(dirname(output), `app-lab-target-${args.profile}`),
  );
  const app = args.app
    ? realResolve(args.app)
    : await build(args, source, output, targetDir);
  if (args.buildOnly) {
    console.log(`Built ${app}`);
    return 0;
  }
  // Only one benchmark window at a time (building is fine alongside a run).
  const lock = openSync(LOCK_PATH, "w");
  if (!lockExclusive(lock))
    throw new SystemExit(`Another app-lab run holds ${LOCK_PATH}`);

  if (await sessionLocked()) {
    const deadline = monotonic() + args.waitUnlocked;
    while ((await sessionLocked()) && monotonic() < deadline)
      await sleep(10_000);
    if (await sessionLocked())
      throw new SystemExit(
        "The login session is locked, so the benchmark window cannot be visible. Unlock the screen and rerun (or pass --wait-unlocked SECONDS).",
      );
  }
  const deadline = monotonic() + args.waitExclusive;
  for (
    let others = await otherBenchmarks();
    others.length;
    others = await otherBenchmarks()
  ) {
    if (monotonic() > deadline)
      throw new SystemExit(
        `Another benchmark window is running: ${pyRepr(others)}`,
      );
    console.log(`waiting for ${pyRepr(others)} to finish...`);
    await sleep(20_000);
  }
  return run(args, app, source, output);
}

if (import.meta.main) await runMain(main);
