// Exit and failure semantics shared by the developer scripts: a `SystemExit` ends the script with
// a message on stderr (status 1) or a bare status, an interrupt or SIGTERM unwinds through the
// script's cleanup before the process exits, and `errorRepr` renders a failure the way the lab
// reports have always recorded it (`RuntimeError('...')`).

import { constants as osConstants } from "node:os";
import { pyRepr } from "./format.ts";

/** Ends the script: a string is printed to stderr with status 1, a number is the exit status. */
export class SystemExit extends Error {
  constructor(readonly status: number | string) {
    super(typeof status === "string" ? status : `exit ${status}`);
    this.name = "SystemExit";
  }
}

/** A failure carrying arbitrary detail (a page event, a list of reasons) like Python's exceptions. */
export class RuntimeError extends Error {
  readonly detail: unknown;
  constructor(detail: unknown) {
    super(typeof detail === "string" ? detail : pyRepr(detail));
    this.name = "RuntimeError";
    this.detail = detail;
  }
}

/** Ctrl-C or SIGTERM: unwinds through the cleanup, then the process exits with status 130. */
export class KeyboardInterrupt extends Error {
  constructor(message = "") {
    super(message);
    this.name = "KeyboardInterrupt";
  }
}

/** A checked subprocess exited with a non-zero status. */
export class CalledProcessError extends Error {
  constructor(
    readonly returncode: number,
    readonly command: readonly string[],
  ) {
    super(
      `Command '${pyRepr([...command])}' returned non-zero exit status ${returncode}.`,
    );
    this.name = "CalledProcessError";
  }
}

/** `repr(error)` as the reports store it, e.g. `RuntimeError('Timed out after 120s')`. */
export function errorRepr(error: unknown): string {
  if (error instanceof RuntimeError)
    return `RuntimeError(${pyRepr(error.detail)})`;
  if (error instanceof CalledProcessError)
    return `CalledProcessError(${error.returncode}, ${pyRepr([...error.command])})`;
  if (error instanceof KeyboardInterrupt)
    return `KeyboardInterrupt(${error.message ? pyRepr(error.message) : ""})`;
  if (error instanceof Error) return `${error.name}(${pyRepr(error.message)})`;
  return `Exception(${pyRepr(String(error))})`;
}

/**
 * Runs a script's main function and maps its outcome to the exit status: the returned status,
 * a `SystemExit`, 130 after an interrupt, 1 (with the error) for anything else.
 */
export async function runMain(main: () => Promise<unknown>): Promise<never> {
  let status: number;
  try {
    const result = await main();
    status = typeof result === "number" ? result : 0;
  } catch (error) {
    if (error instanceof SystemExit) {
      if (typeof error.status === "string") {
        console.error(error.status);
        status = 1;
      } else status = error.status;
    } else if (error instanceof KeyboardInterrupt) {
      console.error(
        error.message
          ? `KeyboardInterrupt: ${error.message}`
          : "KeyboardInterrupt",
      );
      status = 130;
    } else {
      console.error(
        error instanceof Error ? (error.stack ?? String(error)) : error,
      );
      status = 1;
    }
  }
  process.exit(status);
}

/**
 * Turns the given signals into a `KeyboardInterrupt` for every operation passed through `guard`,
 * so a script's cleanup runs (Python raised it wherever the main thread was). SIGINT carries no
 * message, other signals "signal N" like the labs' SIGTERM handler.
 */
export function interruption(signals: readonly NodeJS.Signals[] = ["SIGINT"]) {
  let fail: (error: KeyboardInterrupt) => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    fail = reject;
  });
  interrupted.catch(() => {});
  const handlers = signals.map((signal) => {
    const handler = () =>
      fail(
        new KeyboardInterrupt(
          signal === "SIGINT" ? "" : `signal ${osConstants.signals[signal]}`,
        ),
      );
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  return {
    guard<T>(work: Promise<T>): Promise<T> {
      return Promise.race([work, interrupted]);
    },
    dispose(): void {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    },
  };
}
