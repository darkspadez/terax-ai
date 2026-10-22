// Exercise the real Tauri IPC transport with a local fixture and isolated profile.
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ArgumentParser } from "../lib/cli.ts";
import {
  CalledProcessError,
  RuntimeError,
  runMain,
  SystemExit,
} from "../lib/errors.ts";
import { asciiJson, pyDumps } from "../lib/format.ts";
import { cors, listen, readBody } from "../lib/http.ts";
import {
  capture,
  check,
  exitedWithin,
  launched,
  realResolve,
  sleep,
  stop,
} from "../lib/process.ts";

const parser = new ArgumentParser({ output: { flag: "--output" } } as const);

const EXPECTED = [
  "rawBody",
  "boundedConsumer",
  "smallChunks",
  "abort",
  "stored",
  "bigSession",
  "deleted",
  "slowDisconnected",
  "mainThreadResponsive",
  "grepSuperseded",
  "searchCached",
  "searchSeesNewFile",
  "watchDirectory",
  "watchFile",
  "watchQuietOutside",
  "backdropToggle",
];

async function main(): Promise<void> {
  const args = parser.parse();
  if (process.platform !== "darwin")
    throw new SystemExit("This smoke runner currently supports macOS only.");
  const root = import.meta.dirname;
  const repo = join(root, "../..");
  const output = realResolve(
    args.output ?? mkdtempSync(join(tmpdir(), "terax-ipc-profile-")),
  );
  mkdirSync(output, { recursive: true });
  const state = { slowDisconnected: false };
  let result: Record<string, unknown> = {};
  let finish: () => void = () => {};
  const finished = new Promise<void>((done) => {
    finish = done;
  });

  const server = await listen(async (request, response) => {
    if (request.method === "OPTIONS") {
      cors(response, true);
      response.writeHead(204);
      response.end();
    } else if (request.method === "POST") {
      const body = await readBody(request);
      if (request.url === "/report")
        result = { ...result, ...JSON.parse(body.toString("utf8")), ...state };
      cors(response);
      response.writeHead(200, { "Content-Length": String(body.length) });
      response.end(body);
      if (request.url === "/report") finish();
    } else if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "text/plain" });
      let gone = false;
      response.on("close", () => {
        if (!response.writableFinished) gone = true;
      });
      if (request.url === "/bulk") {
        response.write("ABCD".repeat(256 * 1024));
      } else if (request.url === "/sse") {
        for (let i = 0; i < 400 && !gone; i++) {
          response.write(`data: ${i}\n\n`);
          if (i % 20 === 0) await sleep(5);
        }
      } else if (request.url === "/slow") {
        for (let i = 0; i < 1000 && !gone; i++) {
          response.write("hello\n");
          await sleep(20);
        }
        if (gone) state.slowDisconnected = true;
      }
      response.end();
    } else {
      response.writeHead(501, { "Content-Length": "0" });
      response.end();
    }
  });
  const identifier = `app.crynta.terax.ipc-lab-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const config = join(output, "tauri.conf.json");
  writeFileSync(
    config,
    JSON.stringify({
      productName: "Terax IPC Lab",
      identifier,
      build: { beforeBuildCommand: "", frontendDist: join(output, "dist") },
      app: {
        windows: [
          {
            label: "main",
            title: "Terax IPC Lab",
            width: 800,
            height: 500,
            visible: true,
          },
        ],
      },
      bundle: { active: false },
    }),
  );
  const tree = join(output, "tree");
  for (let d = 0; d < 80; d++) {
    const folder = join(tree, `d${String(d).padStart(2, "0")}`);
    mkdirSync(folder, { recursive: true });
    for (let f = 0; f < 100; f++) {
      let text = "";
      for (let i = 0; i < 40; i++) text += `line ${i} of file ${f}\n`;
      writeFileSync(join(folder, `f${String(f).padStart(3, "0")}.txt`), text);
    }
  }
  const env = {
    ...process.env,
    TERAX_IPC_BASE_URL: server.url,
    TERAX_IPC_DIST: join(output, "dist"),
    TERAX_IPC_TREE: realResolve(tree),
  };
  let app: ChildProcess | undefined;
  try {
    const buildLog = openSync(join(output, "build.log"), "w");
    try {
      const logged = { cwd: repo, env, stdout: buildLog, stderr: buildLog };
      await check(
        [
          "bun",
          "run",
          "vite",
          "build",
          "--config",
          join(root, "vite.config.ts"),
        ],
        logged,
      );
      await check(["bun", "run", "build:cli:dev"], logged);
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
        logged,
      );
    } finally {
      closeSync(buildLog);
    }
    const cargoMetadata = [
      "cargo",
      "metadata",
      "--locked",
      "--no-deps",
      "--format-version=1",
      "--manifest-path",
      "src-tauri/Cargo.toml",
    ];
    const metadata = await capture(cargoMetadata, { cwd: repo });
    if (metadata.status !== 0)
      throw new CalledProcessError(metadata.status, cargoMetadata);
    const executable = join(
      JSON.parse(metadata.stdout).target_directory as string,
      "debug/terax",
    );
    const appLog = openSync(join(output, "app.log"), "w");
    try {
      app = await launched(
        spawn(executable, [], {
          cwd: repo,
          stdio: ["inherit", appLog, appLog],
        }),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const reported = await Promise.race([
        finished.then(() => true),
        new Promise<boolean>((done) => {
          timer = setTimeout(() => done(false), 45_000);
        }),
      ]);
      clearTimeout(timer);
      if (!reported) throw new RuntimeError("Native IPC test timed out");
      if ((await exitedWithin(app, 10)) === undefined)
        throw new Error(`Command '${executable}' timed out after 10 seconds`);
    } finally {
      closeSync(appLog);
    }
    if (EXPECTED.some((key) => result[key] !== true))
      throw new RuntimeError(result);
    console.log(pyDumps(result));
  } finally {
    await stop(app);
    server.close();
    writeFileSync(
      join(output, "result.json"),
      `${asciiJson(
        JSON.stringify(
          {
            scope:
              "Real Tauri debug webview, local synthetic HTTP, isolated conversation storage",
            ...result,
          },
          null,
          2,
        ),
      )}\n`,
    );
    const profile = join(homedir(), "Library/Application Support", identifier);
    if (existsSync(profile)) rmSync(profile, { recursive: true });
  }
  console.log(`Saved ${join(output, "result.json")}`);
}

await runMain(main);
