import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporary = await mkdtemp(join(tmpdir(), "oarlock-core-profile-"));
const directories = [resolve("packages/ghostty-core/adapted")];
if (process.env.OARLOCK_PROFILE_BASELINE)
  directories.unshift(resolve(process.env.OARLOCK_PROFILE_BASELINE));
if (process.env.OARLOCK_PROFILE_REVERSE === "1") directories.reverse();
let report;
const results = [];
try {
  for (const directory of directories) {
    for (const artifact of ["ghostty-vt.wasm", "ghostty-vt-scalar.wasm"]) {
      const path = join(temporary, "sample.json");
      const child = spawnSync(
        "bun",
        [
          "run",
          "vitest",
          "run",
          "--config",
          "scripts/ghostty-profile.config.ts",
        ],
        {
          stdio: "inherit",
          timeout: 240_000,
          shell: process.platform === "win32",
          env: {
            ...process.env,
            OARLOCK_PROFILE_CORE_DIR: directory,
            OARLOCK_PROFILE_ARTIFACT: artifact,
            OARLOCK_PROFILE_REPORT: path,
          },
        },
      );
      if (child.error) throw child.error;
      if (child.status !== 0)
        throw new Error(
          `Core profiling failed for ${artifact}: ${child.status}`,
        );
      report = JSON.parse(await readFile(path, "utf8"));
      results.push(...report.results);
    }
  }
  report = {
    ...report,
    isolation: "Fresh Bun process per artifact and revision",
    results,
  };
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.OARLOCK_PROFILE_REPORT)
    await writeFile(process.env.OARLOCK_PROFILE_REPORT, output);
  else console.info(output);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
