// The help text below (DESCRIPTION) is this module's documentation.

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ArgumentParser } from "../lib/cli.ts";
import {
  errorRepr,
  interruption,
  RuntimeError,
  runMain,
  SystemExit,
} from "../lib/errors.ts";
import {
  fixed,
  maxOf,
  parseInt10,
  pyDumps,
  pyRepr,
  pyStr,
  roundTo,
  truthy,
} from "../lib/format.ts";
import { listen, staticFiles } from "../lib/http.ts";
import {
  capture,
  check,
  exited,
  exitedWithin,
  launched,
  lines,
  loadAverage,
  realResolve,
  running,
  sh,
  sleep,
  stop,
} from "../lib/process.ts";
import {
  compare,
  computeMetrics,
  type Dict,
  dict,
  dump,
  get,
  type LabEvent,
  load,
  roundMetrics,
  type Sample,
  summarize,
} from "./lab_report.ts";
import {
  findPid,
  footprintOf,
  monotonicNs,
  Poller,
  platformName,
  psCpuNs,
  resolveMembers,
  rusage,
  sessionLocked,
  timebase,
  vmmapSummary,
} from "./procstats.ts";

const DESCRIPTION = `Opt-in, isolated macOS WKWebView renderer lab. Never opens the user's Oarlock profile.

Builds the real Oarlock WebGPU renderer and the real Ghostty WASM models into a native WKWebView
host, drives a synthetic workload through the model write API (no PTY), and samples physical
footprint, CPU time and energy of the host plus its WebKit helpers.

Workloads (\`--workload\`):
  default    the original tab-switch / resize / repaint workload (footprint only)
  occlusion  repeated window occlusion (order out, cover window or miniaturize) with a longer
             hold than the 2 s reclaim delay; optional forced-GC probes
  canvas     the same occlusion cycles on a raw WebGPU canvas (no Oarlock renderer) to compare
             canvas teardown strategies with --variant
  move       small-step and jump window moves while terminals trickle output
  tabs       alternate between a one-pane and a four-pane tab, dwelling longer than the old
             two second idle-canvas deadline on each (tab-switch footprint trend)
  agents     Ink-like redraw + token streaming into K visible panes and H hidden models
  idle       the same panes with no output

Every run writes one JSON report (raw samples, a 1 Hz counter timeline and derived metrics)
and prints a human summary. \`--compare baseline.json\` prints deltas against an earlier report.`;

export const LEGACY_PHASES = new Set([
  "blank",
  "two-blank",
  "streamed",
  "switched",
  "resized",
  "repaint-start",
  "repainted",
  "hidden",
  "disposed",
  "done",
]);
const SCOPE =
  "Synthetic renderer in an isolated native WKWebView fed through the Ghostty model write API; " +
  "not full Oarlock, a real PTY, React, AI streaming, IPC, packaged-app behaviour, or " +
  "cross-platform qualification. WindowServer CPU is whole-system (all windows), from ps, without energy.";

const parser = new ArgumentParser(
  {
    workload: {
      flag: "--workload",
      choices: [
        "default",
        "occlusion",
        "canvas",
        "tabs",
        "move",
        "resize",
        "agents",
        "idle",
      ],
      default: "default",
    },
    output: {
      flag: "--output",
      help: "Scratch directory for build products (default: a temp directory)",
    },
    report: {
      flag: "--report",
      help: "Where to write the JSON report (default: <output>/report.json)",
    },
    source: {
      flag: "--source",
      help: "Optional baseline checkout; its node_modules must be installed",
    },
    revision: {
      flag: "--revision",
      help: "Commit label for a source archive without Git metadata",
    },
    label: { flag: "--label", help: "Free-form label stored in the report" },
    reuseBuild: {
      flag: "--reuse-build",
      action: "store_true",
      help: "Reuse dist/ and the app in --output when present",
    },
    inspect: {
      flag: "--inspect",
      action: "store_true",
      help: "Keep the final frame visible for three minutes (default workload only)",
    },
    panes: {
      flag: "--panes",
      choices: [1, 4],
      type: "int",
      default: 1,
      help: "Visible panes per tab (agents/idle: visible panes)",
    },
    compare: {
      flag: "--compare",
      nargs: "+",
      metavar: "BASELINE.json",
      help: "Print deltas against this report (several repeated reports: per-metric medians)",
    },
    recompute: {
      flag: "--recompute",
      nargs: "+",
      metavar: "REPORT.json",
      help: "Recompute metrics and the human summary of existing reports from their raw samples, rewrite them and exit",
    },
    candidate: {
      flag: "--candidate",
      nargs: "+",
      metavar: "CANDIDATE.json",
      help: "With --compare: compare existing reports without running",
    },
    // occlusion
    occlusionMode: {
      flag: "--occlusion-mode",
      choices: ["orderout", "cover", "miniaturize", "none"],
      default: "orderout",
      help: "How the window is occluded (none: canvas workload only, leaves the window visible)",
    },
    cycles: { flag: "--cycles", type: "int", default: 40 },
    dwellMs: {
      flag: "--dwell-ms",
      type: "int",
      default: 3000,
      help: "tabs workload: time spent on each tab per switch",
    },
    order: {
      flag: "--order",
      choices: ["hide-first", "show-first"],
      default: "hide-first",
      help: "tabs workload: whether the outgoing tab releases its canvases before the incoming tab asks for them",
    },
    parkMs: {
      flag: "--park-ms",
      help: "Renderer tuning: idle WebGPU canvas parking delay in ms, or 'off' (renderers without the knob ignore it)",
    },
    variant: {
      flag: "--variant",
      default: "destroy",
      help: "canvas workload: destroy, destroy-texture, remove-only, unconfigure-only, shrink-keep, unconfigure-keep, hide-keep, detach-keep (out of the DOM, still configured), resize-live (backing-store resizes with frames running), reconfigure (same canvas, new GPU device), webgl-destroy / webgl-keep (raw WebGL2 canvas)",
    },
    resizeSteps: {
      flag: "--resize-steps",
      type: "int",
      default: 8,
      help: "canvas workload, variant resize-live: backing-store resizes per cycle",
    },
    hiddenMs: {
      flag: "--hidden-ms",
      type: "int",
      help: "Hold while occluded (default 3000; must exceed the 2 s reclaim delay)",
    },
    controlNoReclaim: {
      flag: "--control-no-reclaim",
      action: "store_true",
      help: "Control experiment: hold only 1200 ms so the policy never reclaims, then expect no reclaim",
    },
    visibleMs: {
      flag: "--visible-ms",
      type: "int",
      default: 2000,
      help: "Visible streaming time per cycle",
    },
    forceGc: {
      flag: "--force-gc",
      choices: ["none", "alloc", "private", "both"],
      default: "none",
      help: "Lab-only JS GC probe: allocation pressure, WebKit's private full-GC request, or both",
    },
    gcWhen: {
      flag: "--gc-when",
      choices: ["end", "cycle", "both"],
      default: "end",
      help: "When to run the GC probe: after the final idle samples, in every hidden hold, or both",
    },
    // move
    steps: { flag: "--steps", type: "int", default: 200 },
    jumps: { flag: "--jumps", type: "int", default: 50 },
    resizeMode: {
      flag: "--resize-mode",
      choices: ["live", "plain"],
      default: "live",
      help: "resize workload: wrap each drag in NSView live-resize notifications like a user drag, or plain setFrame",
    },
    nativeSignal: {
      flag: "--native-signal",
      action: "store_true",
      help: "resize workload: also tell the page when each drag starts and ends, like the NSWindow live-resize notifications the app forwards (renderers without the hook ignore it)",
    },
    noGpu: {
      flag: "--no-gpu",
      action: "store_true",
      help: "resize workload: control run that drags the window with an empty page (no terminals, no WebGPU) to show what WebKit's live resize costs by itself",
    },
    idleAfter: {
      flag: "--idle-after",
      action: "store_true",
      help: "resize workload: stop all output when the last drag ends (idle terminals present no frames)",
    },
    scrollbackLines: {
      flag: "--scrollback-lines",
      type: "int",
      default: 3000,
      help: "resize workload: lines written into each model before dragging (reflow cost)",
    },
    stepPoints: { flag: "--step-points", type: "float", default: 3 },
    // agents / idle
    hidden: {
      flag: "--hidden",
      type: "int",
      default: 8,
      help: "Hidden models (agents/idle)",
    },
    duration: {
      flag: "--duration",
      type: "float",
      help: "Measured seconds (agents default 60, idle default 30)",
    },
    warmup: {
      flag: "--warmup",
      type: "float",
      default: 5,
      help: "Warm-up seconds before the measured window",
    },
    tick: {
      flag: "--tick",
      type: "float",
      default: 0,
      help: "Optional footprint sample interval inside the measured window (0 = start/end only)",
    },
    blink: {
      flag: "--blink",
      type: "int",
      choices: [0, 1],
      default: 1,
      help: "Terminal cursor blink (affects idle wakeups)",
    },
    vmmap: {
      flag: "--vmmap",
      action: "boolean_optional",
      default: null,
      help: "Record `vmmap -summary` of the WebContent and GPU processes in every sample (default: on for occlusion and move)",
    },
    categories: {
      flag: "--categories",
      action: "store_true",
      help: "Keep footprint's per-VM-category breakdown in every sample (slower; for diagnosis)",
    },
    instrument: {
      flag: "--instrument",
      type: "int",
      choices: [0, 1],
      help: "Lab-only canvas/texture lifecycle counters (default: on for occlusion, canvas and move; off for CPU workloads)",
    },
    pollInterval: {
      flag: "--poll-interval",
      type: "float",
      default: 1.0,
      help: "Seconds between timeline counter samples",
    },
    waitUnlocked: {
      flag: "--wait-unlocked",
      type: "float",
      default: 0,
      metavar: "SECONDS",
      help: "If the login session is locked, poll this long for it to be unlocked before starting",
    },
    maxConsecutiveFailures: {
      flag: "--max-consecutive-failures",
      type: "int",
      default: 3,
      help: "Abort a non-default workload after this many consecutive unqualified samples",
    },
    timeout: {
      flag: "--timeout",
      type: "float",
      help: "Hard host lifetime in seconds (default derived from the workload)",
    },
  } as const,
  { description: DESCRIPTION, allowAbbrev: false },
);

export type QualifyOptions = {
  workload: string;
  occlusionMode: string;
  expectReclaim: boolean;
};

/** Reasons this sample is not valid evidence for the phase it claims to measure. */
export function qualify(
  phase: string,
  event: LabEvent,
  options: QualifyOptions,
): string[] {
  if (phase === "blank" || phase === "done") return [];
  const native = dict(event.native);
  const reasons: string[] = [];
  if (get(event, "step") === "hidden" && options.occlusionMode !== "none") {
    const hide = dict(event.hide);
    if (!truthy(hide.ok) || !truthy(hide.occluded))
      reasons.push(`window was not occluded by '${pyStr(get(hide, "mode"))}'`);
    if (truthy(native.occlusionVisible))
      reasons.push("AppKit still reports the window visible during the hold");
    if (get(event, "visibility") !== "hidden")
      reasons.push(
        `document.visibilityState=${pyStr(get(event, "visibility"))} during the hold`,
      );
    const reclaimed = Number(get(event, "reclaimedThisCycle", 0));
    if (options.workload === "canvas") return reasons;
    if (options.expectReclaim && reclaimed < 1)
      reasons.push(
        "presentation policy did not publish reclaim during the hold",
      );
    if (!options.expectReclaim && reclaimed > 0)
      reasons.push(
        "presentation policy reclaimed during a control hold that must not reclaim",
      );
    return reasons;
  }
  if (
    options.workload === "occlusion" &&
    get(event, "step") === "visible" &&
    "hiddenDiag" in event
  ) {
    // Control run: the hold was not sampled, so reclaim is judged over the whole cycle.
    const hide = dict(event.hide);
    if (!truthy(hide.ok) || !truthy(hide.occluded))
      reasons.push(`window was not occluded by '${pyStr(get(hide, "mode"))}'`);
    if (
      !options.expectReclaim &&
      Number(get(event, "reclaimedThisCycle", 0)) > 0
    )
      reasons.push(
        "presentation policy reclaimed during a control cycle that must not reclaim",
      );
  }
  if (!truthy(native.appActive)) reasons.push("application is not active");
  if (!truthy(native.key)) reasons.push("benchmark window is not key");
  if (!truthy(native.occlusionVisible)) reasons.push("window is occluded");
  if (get(event, "visibility") !== "visible")
    reasons.push(`document.visibilityState=${pyStr(get(event, "visibility"))}`);
  const gpu = dict(event.gpu);
  if (truthy(gpu) && !truthy(gpu.windowFocused))
    reasons.push("renderer reports the window unfocused");
  if (
    (event.surfaces || []).some(
      (s) => truthy(get(s, "visible")) && truthy(get(s, "documentSuspended")),
    )
  )
    reasons.push("a visible surface is suspended");
  const show = get(event, "show");
  if (show !== null && !truthy(get(show, "ok")))
    reasons.push("window did not return to visible+key after show");
  return reasons;
}

/** `plistlib.dump` of a flat dictionary of strings and booleans (keys sorted, XML format). */
export function plist(entries: Record<string, string | boolean>): string {
  const xml = (text: string) =>
    text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  const body = Object.keys(entries)
    .sort()
    .map((key) => {
      const value = entries[key];
      const element =
        typeof value === "boolean"
          ? `<${value}/>`
          : `<string>${xml(value)}</string>`;
      return `\t<key>${xml(key)}</key>\n\t${element}\n`;
    })
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n<dict>\n' +
    body +
    "</dict>\n</plist>\n"
  );
}

/** Files under `directory`, relative and sorted component by component (like `Path` ordering). */
function filesUnder(directory: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(directory, prefix), {
    withFileTypes: true,
  })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...filesUnder(directory, relative));
    else if (entry.isFile()) found.push(relative);
  }
  const parts = (path: string) => path.split("/");
  return found.sort((a, b) => {
    const left = parts(a);
    const right = parts(b);
    for (let index = 0; index < Math.min(left.length, right.length); index++)
      if (left[index] !== right[index])
        return left[index] < right[index] ? -1 : 1;
    return left.length - right.length;
  });
}

const sha256 = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const monotonic = () => monotonicNs() / 1e9;

async function main(): Promise<number> {
  const args = parser.parse();

  if (args.recompute) {
    for (const path of args.recompute) {
      const stored: Dict = load(path);
      const report = stored as ReturnType<typeof load>;
      stored.metrics = roundMetrics(computeMetrics(report));
      stored.humanSummary = summarize(report);
      delete stored.metricsError;
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
      "This profile requires macOS, Xcode command line tools, and footprint.",
    );
  const hiddenMs = args.hiddenMs ?? (args.controlNoReclaim ? 1200 : 3000);
  const expectReclaim = !args.controlNoReclaim;
  if (args.occlusionMode === "none" && args.workload !== "canvas")
    throw new SystemExit(
      "--occlusion-mode none is only meaningful for the canvas workload",
    );
  if (args.workload === "occlusion" && expectReclaim && hiddenMs <= 2000)
    throw new SystemExit(
      "--hidden-ms must exceed the 2000 ms presentation reclaim delay (or use --control-no-reclaim)",
    );
  if (args.workload === "occlusion" && !expectReclaim && hiddenMs >= 1900)
    throw new SystemExit(
      "--control-no-reclaim requires --hidden-ms below the 2000 ms reclaim delay",
    );

  const root = import.meta.dirname;
  const repo = join(root, "../..");
  const output = realResolve(
    args.output ?? mkdtempSync(join(tmpdir(), "oarlock-renderer-profile-")),
  );
  mkdirSync(output, { recursive: true });
  const source = realResolve(args.source ?? repo);
  const dist = join(output, "dist");
  const bundle = join(output, "Oarlock Renderer Lab.app");
  const executable = join(bundle, "Contents/MacOS/renderer-lab");
  mkdirSync(dirname(executable), { recursive: true });
  const vmmapEnabled =
    args.vmmap ??
    ["occlusion", "canvas", "move", "resize", "tabs"].includes(args.workload);
  const cycling = ["occlusion", "canvas", "tabs"].includes(args.workload);
  const reportPath = realResolve(args.report ?? join(output, "report.json"));
  mkdirSync(dirname(reportPath), { recursive: true });

  const duration = args.duration ?? (args.workload === "idle" ? 30 : 60);
  let hostTimeout: number;
  if (args.timeout !== undefined) hostTimeout = args.timeout;
  else if (args.workload === "default") hostTimeout = args.inspect ? 600 : 120;
  else if (args.workload === "tabs")
    hostTimeout = (args.cycles * (2 * args.dwellMs + 4000)) / 1000 + 240;
  else if (cycling)
    hostTimeout =
      (args.cycles * (hiddenMs + args.visibleMs + 4000)) / 1000 +
      240 +
      (args.forceGc !== "none" ? 240 : 0);
  else if (args.workload === "move" || args.workload === "resize")
    hostTimeout = 420;
  else hostTimeout = duration + args.warmup + 120;

  if (await sessionLocked()) {
    const deadline = monotonic() + args.waitUnlocked;
    if (args.waitUnlocked)
      console.log(
        "The login session is locked; waiting for it to be unlocked...",
      );
    while ((await sessionLocked()) && monotonic() < deadline)
      await sleep(10_000);
    if (await sessionLocked())
      throw new SystemExit(
        "The login session is locked, so the benchmark window cannot be visible. Unlock the screen and rerun (or pass --wait-unlocked SECONDS).",
      );
  }

  // -------------------------------------------------------------------------------------------
  // Build
  // -------------------------------------------------------------------------------------------

  const env = {
    ...process.env,
    OARLOCK_PROFILE_SOURCE_ROOT: source,
    OARLOCK_RENDERER_DIST: dist,
  };
  if (
    args.reuseBuild &&
    existsSync(join(dist, "index.html")) &&
    existsSync(executable)
  ) {
    console.log(
      `Reusing the build in ${output} (artifact hashes are recorded in the report)`,
    );
  } else {
    const log = openSync(join(output, "build.log"), "w");
    try {
      await check(
        [
          "bun",
          "run",
          "vite",
          "build",
          "--config",
          join(root, "vite.config.ts"),
        ],
        {
          cwd: repo,
          env,
          stdout: log,
          stderr: log,
        },
      );
      await check(
        [
          "swiftc",
          "-module-cache-path",
          join(output, "swift-cache"),
          join(root, "Lab.swift"),
          "-o",
          executable,
        ],
        { stdout: log, stderr: log },
      );
    } finally {
      closeSync(log);
    }
  }

  const server = await listen(staticFiles(dist));

  const revision = await capture(["git", "-C", source, "rev-parse", "HEAD"]);
  const diff = await capture(["git", "-C", source, "diff", "HEAD"]);
  const gitDir = existsSync(join(source, ".git"));
  if ((revision.status !== 0 || !gitDir) && !args.revision) {
    server.close();
    throw new SystemExit(
      "Source archives require --revision to identify the baseline",
    );
  }
  const hasGit = revision.status === 0 && gitDir;

  const batt = await sh("pmset", "-g", "batt");
  const { numer, denom } = timebase();
  const environment: Dict = {
    chip: await sh("sysctl", "-n", "machdep.cpu.brand_string"),
    logicalCpus: await sh("sysctl", "-n", "hw.ncpu"),
    memoryBytes: await sh("sysctl", "-n", "hw.memsize"),
    macOS: await sh("sw_vers", "-productVersion"),
    build: await sh("sw_vers", "-buildVersion"),
    power: batt ? batt.split(/\r?\n/)[0] : "",
    thermal: await sh("pmset", "-g", "therm"),
    rusageFlavor: "RUSAGE_INFO_V6 (V4 fallback)",
    machTimebase: `${numer}/${denom}`,
    loadAverageStart: loadAverage(),
  };

  const workload = args.workload;
  const occlusionLike = workload === "occlusion" || workload === "canvas";
  const agentsLike = workload === "agents" || workload === "idle";
  const config = {
    workload,
    label: args.label ?? null,
    panes: args.panes,
    occlusionMode: occlusionLike ? args.occlusionMode : null,
    variant: workload === "canvas" ? args.variant : null,
    cycles: cycling ? args.cycles : null,
    hiddenMs: occlusionLike ? hiddenMs : null,
    dwellMs: workload === "tabs" ? args.dwellMs : null,
    order: workload === "tabs" ? args.order : null,
    parkMs: args.parkMs ?? null,
    controlNoReclaim: workload === "occlusion" ? args.controlNoReclaim : null,
    visibleMs: occlusionLike ? args.visibleMs : null,
    forceGc: cycling ? args.forceGc : null,
    gcWhen: cycling && args.forceGc !== "none" ? args.gcWhen : null,
    steps: workload === "move" ? args.steps : null,
    jumps: workload === "move" ? args.jumps : null,
    stepPoints: workload === "move" ? args.stepPoints : null,
    hidden: agentsLike ? args.hidden : null,
    duration: agentsLike ? duration : null,
    warmup: agentsLike ? args.warmup : null,
    tick: agentsLike ? args.tick : null,
    blink: args.blink,
    categories: args.categories,
    vmmap: vmmapEnabled,
    instrument: args.instrument ?? null,
    pollIntervalS: args.pollInterval,
    hostTimeoutS: hostTimeout,
  };
  const qualification: {
    qualified: boolean;
    failures: Dict[];
    advisories?: string[];
  } = {
    qualified: true,
    failures: [],
  };
  const samples: Dict[] = [];
  const nativeEvents: Dict[] = [];
  const manifest: Dict = {
    schema: "oarlock-renderer-lab/2",
    scope: SCOPE,
    config,
    sourceRevision: hasGit ? revision.stdout.trim() : (args.revision ?? null),
    revisionEvidence: hasGit
      ? "Git checkout"
      : "Caller-labelled source archive",
    sourceDiffSha256:
      hasGit && diff.status === 0 ? sha256(diff.stdoutBytes) : null,
    platform: await platformName(),
    inspectionEnabled: args.inspect,
    panesPerTab: args.panes,
    environment,
    artifacts: Object.fromEntries(
      filesUnder(dist).map((path) => [
        path,
        sha256(readFileSync(join(dist, path))),
      ]),
    ),
    qualification,
    warnings: [],
    samples,
    series: [],
    nativeEvents,
  };

  const query = new URLSearchParams({ panes: String(args.panes) });
  if (args.parkMs !== undefined) query.set("parkMs", args.parkMs);
  if (args.instrument !== undefined)
    query.set("instrument", String(args.instrument));
  if (workload !== "default") {
    const values: Record<string, string | number> = {
      workload,
      blink: args.blink,
      mode: args.occlusionMode,
      variant: args.variant,
      resizeSteps: args.resizeSteps,
      dwellMs: args.dwellMs,
      order: args.order,
      cycles: args.cycles,
      hiddenMs,
      visibleMs: args.visibleMs,
      gc: args.forceGc,
      gcWhen: args.gcWhen,
      sampleHidden: args.controlNoReclaim ? 0 : 1,
      steps: args.steps,
      jumps: args.jumps,
      stepPoints: args.stepPoints,
      resizeMode: args.resizeMode,
      idleAfter: args.idleAfter ? 1 : 0,
      nativeSignal: args.nativeSignal ? 1 : 0,
      noGpu: args.noGpu ? 1 : 0,
      scrollbackLines: args.scrollbackLines,
      hidden: args.hidden,
      duration,
      warmup: args.warmup,
      tick: args.tick,
    };
    for (const [key, value] of Object.entries(values))
      query.set(key, String(value));
  }
  const url = `${server.url}/?${query}${args.inspect ? "&inspect=1" : ""}`;
  writeFileSync(
    join(bundle, "Contents/Info.plist"),
    plist({
      CFBundleIdentifier: "sh.oarlock.app.renderer-lab",
      CFBundleExecutable: "renderer-lab",
      CFBundleName: "Oarlock Renderer Lab",
      CFBundlePackageType: "APPL",
      NSHighResolutionCapable: true,
      OarlockLabURL: url,
    }),
  );

  // -------------------------------------------------------------------------------------------
  // Sampling
  // -------------------------------------------------------------------------------------------

  const windowServer = await findPid("WindowServer");
  const poller = new Poller(args.pollInterval, windowServer);
  const started = monotonic();
  const manifestWarnings = new Set<string>();

  /** Counters first (closest to the event), then the slower footprint call, then counters again. */
  async function takeSample(event: LabEvent): Promise<Dict> {
    const phase = event.phase as string;
    const [members, warnings] = await resolveMembers(dict(event.native));
    if (![...members.values()].includes("host"))
      throw new RuntimeError(
        `Cannot identify the benchmark host process: ${pyRepr(warnings)}`,
      );
    for (const warning of warnings) manifestWarnings.add(warning);
    const ids = [...members.keys()];
    const tPre = monotonicNs();
    const wall = Date.now() / 1000;
    const pre = Object.fromEntries(
      ids.map((pid) => [String(pid), rusage(pid)]),
    );
    const wsPre = windowServer ? await psCpuNs(windowServer) : null;
    const footprint = await footprintOf(
      ids,
      join(output, "sample-footprint.json"),
      args.categories,
    );
    const vmmap: Dict = {};
    if (vmmapEnabled)
      for (const [pid, role] of members)
        if (role === "web_content" || role === "gpu")
          vmmap[role] = await vmmapSummary(pid);
    const tPost = monotonicNs();
    const post = Object.fromEntries(
      ids.map((pid) => [String(pid), rusage(pid)]),
    );
    const wsPost = windowServer ? await psCpuNs(windowServer) : null;
    const byRole: Record<string, number> = {};
    for (const process of footprint.processes) {
      const role = members.get(process.pid) ?? process.name;
      byRole[role] = (byRole[role] ?? 0) + process.footprint;
    }
    poller.setMembers(members);
    return {
      phase,
      tMonoNs: tPre,
      tMonoNsPost: tPost,
      tWall: wall,
      elapsedS: monotonic() - started,
      event,
      members: ids,
      roles: Object.fromEntries(
        [...members].map(([pid, role]) => [String(pid), role]),
      ),
      rusage: pre,
      rusagePost: post,
      windowServerCpuNs: wsPre,
      windowServerCpuNsPost: wsPost,
      footprint,
      ...(Object.keys(vmmap).length ? { vmmap } : {}),
      footprintByRole: byRole,
      footprintTotal: footprint["total footprint"],
      loadAverage: loadAverage(),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Run
  // -------------------------------------------------------------------------------------------

  // The host's stderr joins its stdout in one pipe, as one stream of lines.
  const host: ChildProcess = spawn(
    "/bin/sh",
    [
      "-c",
      'exec "$0" "$@" 2>&1',
      executable,
      url,
      ...(args.inspect ? [output] : []),
    ],
    {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        OARLOCK_LAB_CONTROL: "1",
        OARLOCK_LAB_TIMEOUT: String(hostTimeout),
      },
    },
  );
  await launched(host);
  host.stdin?.on("error", () => {});
  manifest.hostPid = host.pid;
  poller.start();
  let failed: unknown;
  let consecutiveFailures = 0;
  const interrupt = interruption(["SIGINT"]);
  const events = openSync(join(output, "events.jsonl"), "w");
  try {
    const reader = lines(
      host.stdout as NodeJS.ReadableStream & AsyncIterable<Buffer>,
    );
    for (;;) {
      const next = await interrupt.guard(reader.next());
      if (next.done) break;
      const line = next.value;
      writeSync(events, line);
      const arrival = monotonicNs();
      let event: LabEvent;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event === null || typeof event !== "object" || Array.isArray(event))
        continue;
      if ("native" in event && typeof event.native === "string") {
        nativeEvents.push({ ...event, tMonoNs: arrival });
        continue;
      }
      const phase = event.phase;
      if (!phase) continue;
      if (phase === "error") throw new RuntimeError(event);
      if (workload === "default") {
        // Legacy behaviour: strict phase list.
        if (!LEGACY_PHASES.has(phase))
          throw new RuntimeError(`Unknown benchmark phase: ${phase}`);
      } else if (phase === "done") {
        samples.push({ phase: "done", tMonoNs: arrival, event });
        continue;
      }
      const sample = await interrupt.guard(takeSample(event));
      const reasons =
        workload !== "default"
          ? qualify(phase, event, {
              workload,
              occlusionMode: args.occlusionMode,
              expectReclaim,
            })
          : [];
      if (
        workload === "default" &&
        ["streamed", "switched", "resized", "repainted"].includes(phase) &&
        (!truthy(get(dict(event.gpu), "windowFocused")) ||
          (event.surfaces || []).some((s) => s.visible && s.documentSuspended))
      )
        throw new RuntimeError(
          "Keep the renderer fixture visible and focused during measurement",
        );
      if (reasons.length) {
        qualification.qualified = false;
        qualification.failures.push({ phase, reasons });
        consecutiveFailures += 1;
        if (
          workload !== "default" &&
          consecutiveFailures >= args.maxConsecutiveFailures
        ) {
          const locked = (await sessionLocked())
            ? " (the login session is locked)"
            : "";
          throw new RuntimeError(
            `Aborting after ${consecutiveFailures} consecutive unqualified samples${locked}: ${pyRepr(reasons)}`,
          );
        }
      } else consecutiveFailures = 0;
      samples.push(sample);
      console.log(
        pyDumps({
          phase,
          footprintMiB: roundTo((sample.footprintTotal as number) / 1048576, 2),
          ...(reasons.length ? { unqualified: reasons } : {}),
        }),
      );
      if (truthy(event.sync)) {
        const acknowledged = await new Promise<boolean>((done) => {
          const stdin = host.stdin;
          if (!stdin || stdin.destroyed || !stdin.writable) return done(false);
          stdin.write(`ack ${pyStr(event.sync)}\n`, (error) => done(!error));
        });
        if (!acknowledged)
          throw new RuntimeError(
            "Benchmark host exited while a sample was pending",
          );
      }
    }
    const lastPhase = samples.length
      ? get(dict(samples[samples.length - 1].event), "phase")
      : null;
    if (
      (await interrupt.guard(exited(host))) !== 0 ||
      !samples.length ||
      lastPhase !== "done"
    )
      throw new RuntimeError("Native renderer profile did not complete");
  } catch (error) {
    failed = error;
    manifest.incomplete = true;
    manifest.error = errorRepr(error);
  } finally {
    interrupt.dispose();
    closeSync(events);
    await poller.stop();
    if (running(host)) {
      host.stdin?.end();
      if ((await exitedWithin(host, 10)) === undefined) await stop(host);
    }
    server.close();
    manifest.series = poller.series;
    environment.loadAverageEnd = loadAverage();
    manifest.warnings = [...manifestWarnings].sort();
    const measured = samples.filter((s) => "footprint" in s) as Sample[];
    const busiest = measured.length
      ? maxOf(measured.map((s) => (s.loadAverage as number[])[0]))
      : 0;
    const cpus = parseInt10(String(environment.logicalCpus || 0)) ?? 0;
    if (cpus && busiest > cpus / 2) {
      qualification.advisories ??= [];
      qualification.advisories.push(
        `system load average reached ${fixed(busiest, 1)} on ${cpus} logical CPUs; CPU, energy and timing figures may be inflated by other work on this machine`,
      );
    }
    if (measured.length) {
      try {
        const report = { ...manifest, samples: measured } as ReturnType<
          typeof load
        >;
        manifest.metrics = roundMetrics(computeMetrics(report));
        manifest.humanSummary = summarize(report);
      } catch (error) {
        // a partial report is still worth keeping
        manifest.metricsError = errorRepr(error);
      }
    }
    const ordered = Object.fromEntries(
      [
        "schema",
        "scope",
        "config",
        "sourceRevision",
        "revisionEvidence",
        "sourceDiffSha256",
        "platform",
        "inspectionEnabled",
        "panesPerTab",
        "hostPid",
        "environment",
        "qualification",
        "warnings",
        "incomplete",
        "error",
        "metrics",
        "metricsError",
        "humanSummary",
        "artifacts",
        "samples",
        "series",
        "nativeEvents",
      ]
        .filter((key) => key in manifest)
        .map((key) => [key, manifest[key]]),
    );
    writeFileSync(reportPath, dump(ordered));
  }

  if ("humanSummary" in manifest) console.log(`\n${manifest.humanSummary}`);
  if (args.compare)
    console.log(`\n${compare(args.compare.map(load), load(reportPath))}`);
  console.log(`\nSaved ${reportPath}`);
  if (failed !== undefined) throw failed;
  if (!qualification.qualified) {
    console.error(
      "Run failed qualification: keep the lab window visible/focused and rerun.",
    );
    return 2;
  }
  return 0;
}

if (import.meta.main) await runMain(main);
