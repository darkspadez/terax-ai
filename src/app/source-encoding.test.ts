import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Source files are plain UTF-8 text. A raw control byte (write `\x00`, not the
// byte) makes git and ripgrep treat the whole file as binary, so its diffs
// disappear from review, and fs_read_file shows it as a binary file. A
// byte-order mark or another encoding trips tools that expect plain UTF-8.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const TEXT_EXTENSIONS = new Set([
  ".bash",
  ".cjs",
  ".css",
  ".fish",
  ".html",
  ".js",
  ".json",
  ".lock",
  ".md",
  ".mjs",
  ".mts",
  ".nix",
  ".nsh",
  ".patch",
  ".plist",
  ".ps1",
  ".rs",
  ".sh",
  ".svg",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
  ".zig",
  ".zon",
  ".zsh",
]);

// Installs, build output and caches, not sources.
const SKIPPED_DIRS = new Set([
  "node_modules",
  "target",
  "dist",
  "dist-ssr",
  "gen",
  "binaries",
  "zig-out",
  "zig-cache",
]);

function textFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const hidden = entry.name.startsWith(".") && entry.name !== ".github";
      if (!hidden && !SKIPPED_DIRS.has(entry.name)) out.push(...textFiles(path));
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name))) {
      out.push(path);
    }
  }
  return out;
}

function isControlByte(b: number): boolean {
  return (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f;
}

const files = textFiles(ROOT).map((path) => ({
  name: relative(ROOT, path),
  bytes: readFileSync(path),
}));

describe("source encoding", () => {
  it("scans the repository's sources", () => {
    const names = files.map((f) => f.name);
    expect(names.length).toBeGreaterThan(900);
    for (const name of [
      "TERAX.md",
      join("src", "main.tsx"),
      join("src-tauri", "src", "lib.rs"),
      join("scripts", "eager-graph.mjs"),
      join(".github", "workflows", "ci.yml"),
    ])
      expect(names).toContain(name);
  });

  it("has no raw control bytes", () => {
    const offenders: string[] = [];
    for (const { name, bytes } of files) {
      let line = 1;
      for (const b of bytes) {
        if (b === 0x0a) line++;
        else if (isControlByte(b)) {
          offenders.push(
            `${name}:${line}: 0x${b.toString(16).padStart(2, "0")}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("is UTF-8 without a byte-order mark", () => {
    const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const offenders = files.flatMap(({ name, bytes }) => {
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
        return [`${name}: byte-order mark`];
      try {
        utf8.decode(bytes);
        return [];
      } catch {
        return [`${name}: not UTF-8`];
      }
    });
    expect(offenders).toEqual([]);
  });
});
