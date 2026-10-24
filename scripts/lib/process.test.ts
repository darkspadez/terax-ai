import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { capture, lines, realResolve, returncode } from "./process.ts";

async function collect(chunks: string[]): Promise<string[]> {
  const out: string[] = [];
  for await (const line of lines(
    (async function* () {
      yield* chunks.map((chunk) => Buffer.from(chunk));
    })(),
  ))
    out.push(line);
  return out;
}

describe("lines", () => {
  it("reads universal newlines across chunk boundaries", async () => {
    expect(await collect(["a\r", "\nb\rc", "\n", "tail"])).toEqual([
      "a\n",
      "b\n",
      "c\n",
      "tail",
    ]);
    expect(await collect(["x\r"])).toEqual(["x\n"]);
  });
});

describe("realResolve", () => {
  it("resolves symbolic links as far as the path exists", () => {
    const root = mkdtempSync(join(tmpdir(), "process-test-"));
    try {
      mkdirSync(join(root, "real"));
      symlinkSync(join(root, "real"), join(root, "link"));
      const real = realResolve(join(root, "real"));
      expect(realResolve(join(root, "link", "missing", "file"))).toBe(
        join(real, "missing", "file"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("capture", () => {
  it("reports the status like Python's returncode", async () => {
    const result = await capture(["sh", "-c", "printf out; exit 3"]);
    expect(result).toMatchObject({ status: 3, stdout: "out", timedOut: false });
    const slow = await capture(["sleep", "5"], { timeoutSeconds: 0.05 });
    expect(slow.timedOut).toBe(true);
    expect(returncode(null, "SIGKILL")).toBe(-9);
  });
});
