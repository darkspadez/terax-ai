import { afterEach, describe, expect, it, vi } from "vitest";
import { ArgumentParser } from "./cli.ts";
import { SystemExit } from "./errors.ts";

const parser = (allowAbbrev = true) =>
  new ArgumentParser(
    {
      output: { flag: "--output" },
      idleMs: { flag: "--idle-ms", type: "int", default: 35000 },
      ratio: { flag: "--ratio", type: "float" },
      panes: { flag: "--panes", type: "int", choices: [1, 4], default: 1 },
      fast: { flag: "--fast", action: "store_true", help: "skip the scan" },
      toggle: { flag: "--toggle", action: "append", metavar: "NAME=VALUE" },
      vmmap: { flag: "--vmmap", action: "boolean_optional", default: null },
      compare: { flag: "--compare", nargs: "+", metavar: "BASELINE.json" },
      gc: {
        flag: "--gc",
        nargs: "?",
        const: "private",
        choices: ["private", "alloc"],
      },
    } as const,
    { prog: "run.ts", allowAbbrev },
  );

function failure(run: () => unknown): {
  status: number | string;
  stderr: string;
} {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((line: string) => {
    lines.push(line);
  });
  try {
    run();
  } catch (error) {
    if (!(error instanceof SystemExit)) throw error;
    return { status: error.status, stderr: lines.join("\n") };
  } finally {
    spy.mockRestore();
  }
  throw new Error("expected a usage error");
}

afterEach(() => vi.restoreAllMocks());

describe("ArgumentParser", () => {
  it("applies defaults", () => {
    expect(parser().parse([])).toEqual({
      output: undefined,
      idleMs: 35000,
      ratio: undefined,
      panes: 1,
      fast: false,
      toggle: [],
      vmmap: undefined,
      compare: undefined,
      gc: undefined,
    });
  });

  it("converts values and reads every option form", () => {
    expect(
      parser().parse([
        "--output=/tmp/x",
        "--idle-ms",
        "100",
        "--ratio",
        "-2.5",
        "--panes",
        "4",
        "--fast",
        "--toggle",
        "a=1",
        "--toggle=b",
        "--no-vmmap",
        "--compare",
        "a.json",
        "b.json",
        "--gc",
      ]),
    ).toEqual({
      output: "/tmp/x",
      idleMs: 100,
      ratio: -2.5,
      panes: 4,
      fast: true,
      toggle: ["a=1", "b"],
      vmmap: false,
      compare: ["a.json", "b.json"],
      gc: "private",
    });
    expect(parser().parse(["--gc", "alloc", "--vmmap"])).toMatchObject({
      gc: "alloc",
      vmmap: true,
    });
  });

  it("accepts a unique prefix only when abbreviations are allowed", () => {
    expect(parser().parse(["--out", "x"]).output).toBe("x");
    expect(failure(() => parser(false).parse(["--out", "x"]))).toEqual({
      status: 2,
      stderr: expect.stringContaining(
        "run.ts: error: unrecognized arguments: --out",
      ),
    });
  });

  it("reports usage errors with status 2", () => {
    expect(failure(() => parser().parse(["--idle-ms", "x"])).stderr).toContain(
      "run.ts: error: argument --idle-ms: invalid int value: 'x'",
    );
    expect(failure(() => parser().parse(["--panes", "2"])).stderr).toContain(
      "argument --panes: invalid choice: 2 (choose from 1, 4)",
    );
    expect(failure(() => parser().parse(["--output"])).stderr).toContain(
      "argument --output: expected one argument",
    );
    expect(failure(() => parser().parse(["--compare"])).stderr).toContain(
      "argument --compare: expected at least one argument",
    );
    expect(failure(() => parser().parse(["stray"])).stderr).toContain(
      "unrecognized arguments: stray",
    );
  });

  it("prints argparse's help layout and exits 0", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      lines.push(line);
    });
    let status: number | string | undefined;
    try {
      parser().parse(["--help"]);
    } catch (error) {
      if (error instanceof SystemExit) status = error.status;
    }
    expect(status).toBe(0);
    expect(lines.join("\n")).toContain(
      "options:\n  -h, --help            show this help message and exit\n  --output OUTPUT\n",
    );
    expect(lines.join("\n")).toContain(
      "  --fast                skip the scan\n",
    );
    expect(lines.join("\n")).toContain("[--vmmap | --no-vmmap]");
  });
});
