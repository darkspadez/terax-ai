// Subprocess, path and timing helpers shared by the developer scripts (Node built-ins only, so
// they behave the same under Bun and in tests).

import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { loadavg, constants as osConstants } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { CalledProcessError } from "./errors.ts";
import { roundTo } from "./format.ts";

export const sleep = (milliseconds: number) =>
  new Promise<void>((done) => setTimeout(done, milliseconds));

/** Exit status like Python's `returncode`: the code, or minus the signal that ended the process. */
export function returncode(
  code: number | null,
  signal: NodeJS.Signals | null,
): number {
  if (code !== null) return code;
  return signal ? -(osConstants.signals[signal] ?? 0) : 0;
}

/** Resolves with the child's `returncode` once it has exited (immediately if it already has). */
export function exited(child: ChildProcess): Promise<number> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(returncode(child.exitCode, child.signalCode));
  return new Promise((done, fail) => {
    child.once("exit", (code, signal) => done(returncode(code, signal)));
    child.once("error", fail);
  });
}

/** Like `exited`, but gives up after `seconds` (resolving undefined) instead of waiting forever. */
export async function exitedWithin(
  child: ChildProcess,
  seconds: number,
): Promise<number | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited(child),
      new Promise<undefined>((done) => {
        timer = setTimeout(() => done(undefined), seconds * 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** True until the child has exited (Python's `poll() is None`). */
export const running = (child: ChildProcess) =>
  child.exitCode === null && child.signalCode === null;

type Stdio = "inherit" | "ignore" | number;

export type CheckOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: Stdio;
  stderr?: Stdio;
};

/** `subprocess.run(command, check=True)`: waits, and throws `CalledProcessError` on failure. */
export async function check(
  command: readonly string[],
  options: CheckOptions = {},
): Promise<void> {
  const child = spawn(command[0], command.slice(1), {
    cwd: options.cwd,
    env: options.env,
    stdio: [
      "inherit",
      options.stdout ?? "inherit",
      options.stderr ?? "inherit",
    ],
  });
  const status = await exited(child);
  if (status !== 0) throw new CalledProcessError(status, command);
}

export type Captured = {
  status: number;
  stdout: string;
  stderr: string;
  /** stdout as raw bytes (Python's `capture_output` without `text=True`). */
  stdoutBytes: Buffer;
  timedOut: boolean;
};

/**
 * `subprocess.run(command, capture_output=True, text=True, timeout=...)`. On timeout the child is
 * killed and `timedOut` is set (Python raised TimeoutExpired there).
 */
export function capture(
  command: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutSeconds?: number;
  } = {},
): Promise<Captured> {
  return new Promise((done, fail) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: options.cwd,
      env: options.env,
      stdio: ["inherit", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    let timedOut = false;
    const timer =
      options.timeoutSeconds === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutSeconds * 1000);
    child.once("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const stdoutBytes = Buffer.concat(out);
      done({
        status: returncode(code, signal),
        stdout: stdoutBytes.toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        stdoutBytes,
        timedOut,
      });
    });
  });
}

/** The trimmed stdout of a command, or "" when it fails. */
export async function sh(...command: string[]): Promise<string> {
  const result = await capture(command);
  return result.status === 0 ? result.stdout.trim() : "";
}

/** `shutil.which`: the first executable called `name` on PATH. */
export function which(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

/** `Path.resolve()`: absolute, with symbolic links resolved as far as the path exists. */
export function realResolve(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute
      ? absolute
      : join(realResolve(parent), basename(absolute));
  }
}

/** `os.getloadavg()` rounded to two decimals, as the reports record it. */
export const loadAverage = () => loadavg().map((value) => roundTo(value, 2));

/**
 * The lines of a text stream with universal newlines (`\r\n` and `\r` read as `\n`), each
 * ending in "\n" except an unterminated last line.
 */
export async function* lines(
  stream: AsyncIterable<Buffer | string>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const take = function* (final: boolean): Generator<string> {
    for (;;) {
      const index = buffer.search(/[\r\n]/);
      if (index < 0) break;
      if (buffer[index] === "\r" && index === buffer.length - 1 && !final)
        break;
      const width = buffer.startsWith("\r\n", index) ? 2 : 1;
      yield `${buffer.slice(0, index)}\n`;
      buffer = buffer.slice(index + width);
    }
  };
  for await (const chunk of stream) {
    buffer +=
      typeof chunk === "string"
        ? chunk
        : decoder.decode(chunk, { stream: true });
    yield* take(false);
  }
  buffer += decoder.decode();
  yield* take(true);
  if (buffer) yield buffer;
}

/**
 * Ends a child that is still running: SIGTERM, then SIGKILL if it has not exited after `seconds`.
 * (The Python harnesses raised TimeoutExpired here and skipped the rest of their cleanup.)
 */
export async function stop(
  child: ChildProcess | undefined,
  seconds = 10,
): Promise<void> {
  if (!child || !running(child)) return;
  child.kill("SIGTERM");
  if ((await exitedWithin(child, seconds)) !== undefined) return;
  child.kill("SIGKILL");
  await exitedWithin(child, seconds);
}

/** Resolves once `child` is running and rejects with the spawn error (Python's Popen raised it). */
export function launched<T extends ChildProcess>(child: T): Promise<T> {
  return new Promise((done, fail) => {
    child.once("spawn", () => done(child));
    child.once("error", fail);
  });
}
