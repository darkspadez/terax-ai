import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// `tauri build` refuses to package when an installed @tauri-apps package and
// its Rust crate are on different major.minor releases, so both lockfiles
// must move together.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function majorMinor(version: string): string {
  return version.split(".").slice(0, 2).join(".");
}

function lockedJsPackages(): Map<string, string> {
  const lock = readFileSync(`${ROOT}bun.lock`, "utf8");
  const out = new Map<string, string>();
  for (const m of lock.matchAll(
    /^ {4}"@tauri-apps\/(api|plugin-[a-z-]+)": \["@tauri-apps\/\1@(\d+\.\d+\.\d+)"/gm,
  ))
    out.set(m[1] === "api" ? "tauri" : `tauri-${m[1]}`, m[2]);
  return out;
}

function lockedCrates(): Map<string, string> {
  const lock = readFileSync(`${ROOT}src-tauri/Cargo.lock`, "utf8");
  const out = new Map<string, string>();
  for (const m of lock.matchAll(
    /^name = "(tauri(?:-plugin-[a-z-]+)?)"\r?\nversion = "(\d+\.\d+\.\d+)"/gm,
  ))
    out.set(m[1], m[2]);
  return out;
}

it("locks each @tauri-apps package to its crate's major.minor", () => {
  const js = lockedJsPackages();
  const crates = lockedCrates();
  expect(js.get("tauri")).toBeDefined();
  expect(crates.get("tauri")).toBeDefined();

  const mismatched: string[] = [];
  for (const [crate, version] of js) {
    const native = crates.get(crate);
    if (native && majorMinor(native) !== majorMinor(version))
      mismatched.push(`${crate}: npm ${version}, crate ${native}`);
  }
  expect(mismatched).toEqual([]);
});
