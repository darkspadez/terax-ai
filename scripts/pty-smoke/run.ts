// Run the real PTY transport inside the real Tauri webview (macOS debug build).

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ArgumentParser } from "../lib/cli.ts";
import {
  CalledProcessError,
  RuntimeError,
  runMain,
  SystemExit,
} from "../lib/errors.ts";
import { asciiJson, fixed, pyRepr } from "../lib/format.ts";
import { cors, listen, pathOf, readBody } from "../lib/http.ts";
import {
  capture,
  check,
  exitedWithin,
  launched,
  realResolve,
  sleep,
  stop,
} from "../lib/process.ts";

const parser = new ArgumentParser({
  output: { flag: "--output" },
  idleMs: { flag: "--idle-ms", type: "int", default: 35000 },
  spinSeconds: { flag: "--spin-seconds", type: "int", default: 5 },
  skipBuild: { flag: "--skip-build", action: "store_true" },
  fast: {
    flag: "--fast",
    action: "store_true",
    help: "skip the per-byte exactness scan so throughput is not bounded by the harness",
  },
  dev: {
    flag: "--dev",
    action: "store_true",
    help: "load the page from a Vite dev server (http origin) like `tauri dev`, using a separate cargo target dir",
  },
  only: {
    flag: "--only",
    default: "",
    help: "comma list of scenarios: latency,spinners,flood,idle (default: all)",
  },
  driver: {
    flag: "--driver",
    default: "driver-new.ts",
    help: "driver-new.ts (multiplexed stream) or driver-old.ts (channels)",
  },
  repo: {
    flag: "--repo",
    help: "tree to build and run (default: this checkout)",
  },
} as const);

type Gate = {
  foreignOrigin: {
    anyReadable: boolean;
    hubUntouched: boolean;
    attempts: number;
  };
  positiveControl: number;
  wrongToken: number[];
  oversized: number;
  malformed: number;
  wrongMethod: number;
  hubUntouchedByPageRefusals: boolean;
};

/** The stream scheme's refusals, measured in the real webview (multiplexed driver only). */
function checkGate(gate: Gate | null | undefined): void {
  if (gate === null || gate === undefined) return;
  const foreign = gate.foreignOrigin;
  const expected: Record<string, boolean> = {
    "a valid request from the page succeeds": gate.positiveControl === 200,
    "a wrong token is 403":
      Array.isArray(gate.wrongToken) &&
      gate.wrongToken.length === 1 &&
      gate.wrongToken[0] === 403,
    "an oversized body is 413": gate.oversized === 413,
    "a malformed body is 400": gate.malformed === 400,
    "a wrong method is 405": gate.wrongMethod === 405,
    "refusals from the page never reach the hub": Boolean(
      gate.hubUntouchedByPageRefusals,
    ),
    "a foreign origin holding a valid token gets no readable response":
      !foreign.anyReadable,
    "a foreign origin never reaches the hub": Boolean(foreign.hubUntouched),
    "every foreign attempt was made": foreign.attempts === 10,
  };
  const failed = Object.entries(expected)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  if (failed.length)
    throw new RuntimeError(
      `oarlock-pty admission checks failed: ${pyRepr(failed)}\n${asciiJson(JSON.stringify(gate, null, 2))}`,
    );
  console.log("oarlock-pty admission checks passed");
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

function accepts(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: "localhost", port, timeout: 200 });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      done(false);
    });
    socket.once("error", () => done(false));
  });
}

async function main(): Promise<void> {
  const args = parser.parse();
  if (process.platform !== "darwin")
    throw new SystemExit("This smoke runner currently supports macOS only.");
  const root = import.meta.dirname;
  const repo = realResolve(args.repo ?? join(root, "../.."));
  const output = realResolve(
    args.output ?? mkdtempSync(join(tmpdir(), "oarlock-pty-smoke-")),
  );
  mkdirSync(output, { recursive: true });
  let result: Record<string, unknown> = {};
  let finish: () => void = () => {};
  const finished = new Promise<void>((done) => {
    finish = done;
  });

  const server = await listen(async (request, response) => {
    const name = pathOf(request);
    if (request.method === "GET") {
      // The page the admission check loads in an iframe: another origin.
      const served: Record<string, string> = {
        "/frame.html": "text/html",
        "/frame.js": "text/javascript",
      };
      if (!Object.hasOwn(served, name)) {
        response.writeHead(404, { "Content-Length": "0" });
        response.end();
        return;
      }
      const data = readFileSync(join(root, name.slice(1)));
      response.writeHead(200, {
        "Content-Type": served[name],
        "Content-Length": String(data.length),
      });
      response.end(data);
    } else if (request.method === "OPTIONS") {
      cors(response, true);
      response.writeHead(204);
      response.end();
    } else if (request.method === "POST") {
      const body = await readBody(request);
      if (request.url === "/report")
        result = { ...result, ...JSON.parse(body.toString("utf8")) };
      cors(response);
      response.writeHead(200, { "Content-Length": "0" });
      response.end();
      if (request.url === "/report") finish();
    } else {
      response.writeHead(501, { "Content-Length": "0" });
      response.end();
    }
  });
  const identifier = `sh.oarlock.app.pty-smoke-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const real = JSON.parse(
    readFileSync(join(repo, "src-tauri/tauri.conf.json"), "utf8"),
  );
  const config = join(output, "tauri.conf.json");
  const devPort = args.dev ? await freePort() : undefined;
  const buildConfig: Record<string, string> = {
    beforeBuildCommand: "",
    frontendDist: join(output, "dist"),
  };
  if (devPort) buildConfig.devUrl = `http://localhost:${devPort}`;
  writeFileSync(
    config,
    JSON.stringify({
      productName: "Oarlock PTY Smoke",
      identifier,
      build: buildConfig,
      // The real CSP, so the custom scheme is checked against production policy.
      app: {
        security: { csp: real.app.security.csp },
        windows: [
          {
            label: "main",
            title: "Oarlock PTY Smoke",
            width: 900,
            height: 600,
            visible: true,
          },
        ],
      },
      bundle: { active: false },
    }),
  );
  const env = {
    ...process.env,
    OARLOCK_SMOKE_BASE_URL: server.url,
    OARLOCK_SMOKE_DIST: join(output, "dist"),
    OARLOCK_SMOKE_DRIVER: args.driver,
    OARLOCK_SMOKE_ONLY: args.only,
    OARLOCK_SMOKE_FAST: args.fast ? "1" : "0",
    OARLOCK_SMOKE_IDLE_MS: String(args.idleMs),
    OARLOCK_SMOKE_SPIN_SECONDS: String(args.spinSeconds),
  };
  let app: ChildProcess | undefined;
  let devServer: ChildProcess | undefined;
  try {
    const buildLog = openSync(join(output, "build.log"), "w");
    try {
      const logged = { cwd: repo, stdout: buildLog, stderr: buildLog };
      const viteConfig = join(root, "vite.config.ts");
      if (args.dev) {
        // Like `tauri dev`: no embedded assets (no custom-protocol feature),
        // the window loads http://localhost:<port> from a Vite dev server.
        const devEnv = {
          ...env,
          CARGO_TARGET_DIR: join(output, "cargo-target"),
          TAURI_CONFIG: readFileSync(config, "utf8"),
        };
        if (!args.skipBuild)
          await check(
            ["cargo", "build", "--manifest-path", "src-tauri/Cargo.toml"],
            { ...logged, env: devEnv },
          );
        devServer = spawn(
          "bun",
          [
            "run",
            "vite",
            "--config",
            viteConfig,
            "--port",
            String(devPort),
            "--strictPort",
            "--host",
            "localhost",
          ],
          { cwd: repo, env, stdio: ["inherit", buildLog, buildLog] },
        );
        await launched(devServer);
        let up = false;
        for (let attempt = 0; attempt < 100 && !up; attempt++) {
          up = await accepts(devPort as number);
          if (!up) await sleep(200);
        }
        if (!up) throw new RuntimeError("Vite dev server did not start");
      } else {
        await check(["bun", "run", "vite", "build", "--config", viteConfig], {
          ...logged,
          env,
        });
        if (!args.skipBuild)
          await check(
            [
              "bun",
              "run",
              "tauri",
              "build",
              "--debug",
              "--no-bundle",
              "--config",
              config,
            ],
            { ...logged, env },
          );
      }
    } finally {
      closeSync(buildLog);
    }
    const cargoMetadata = [
      "cargo",
      "metadata",
      "--no-deps",
      "--format-version=1",
      "--manifest-path",
      "src-tauri/Cargo.toml",
    ];
    const metadata = await capture(cargoMetadata, { cwd: repo });
    if (metadata.status !== 0)
      throw new CalledProcessError(metadata.status, cargoMetadata);
    const target = args.dev
      ? join(output, "cargo-target")
      : (JSON.parse(metadata.stdout).target_directory as string);
    const appLog = openSync(join(output, "app.log"), "w");
    try {
      app = await launched(
        spawn(join(target, "debug/oarlock"), [], {
          cwd: repo,
          stdio: ["inherit", appLog, appLog],
        }),
      );
      const budget = 240 + args.idleMs / 1000 + args.spinSeconds * 6;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const reported = await Promise.race([
        finished.then(() => true),
        new Promise<boolean>((done) => {
          timer = setTimeout(() => done(false), budget * 1000);
        }),
      ]);
      clearTimeout(timer);
      if (!reported)
        throw new RuntimeError(
          `PTY smoke timed out after ${fixed(budget, 0)}s (see ${join(output, "app.log")})`,
        );
      if ((await exitedWithin(app, 15)) === undefined)
        throw new Error(
          `Command '${join(target, "debug/oarlock")}' timed out after 15 seconds`,
        );
    } finally {
      closeSync(appLog);
    }
    if ("error" in result) throw new RuntimeError(result);
    console.log(asciiJson(JSON.stringify(result, null, 2)));
    checkGate(result.gate as Gate | undefined);
  } finally {
    await stop(app);
    await stop(devServer);
    server.close();
    writeFileSync(
      join(output, "result.json"),
      `${JSON.stringify(
        {
          scope:
            "Real Tauri debug webview and login shell, local report server, isolated profile",
          ...result,
        },
        null,
        2,
      )}\n`,
    );
    const profile = join(homedir(), "Library/Application Support", identifier);
    if (existsSync(profile)) rmSync(profile, { recursive: true });
  }
  console.log(`Saved ${join(output, "result.json")}`);
}

await runMain(main);
