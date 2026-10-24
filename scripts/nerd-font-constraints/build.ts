// Generates src/modules/terminal/ghostty/gpu/nerdFontConstraints.ts, the
// per-icon sizing and alignment rules for Nerd Font glyphs, from Ghostty's
// `src/font/nerd_font_tables.zig` (MIT) at the commit the terminal core pins
// (packages/ghostty-core/adapted/wasm/build.zig.zon):
//
//   bun scripts/nerd-font-constraints/build.ts [path/to/nerd_font_tables.zig]
//
// Without a path the file is fetched from GitHub at the pinned commit. The
// output is formatted with Biome; rerun after moving the Ghostty pin.

import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { runMain, SystemExit } from "../lib/errors.ts";
import { fixed, roundTo } from "../lib/format.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const OUT = join(
  ROOT,
  "src/modules/terminal/ghostty/gpu/nerdFontConstraints.ts",
);
const ZON = join(ROOT, "packages/ghostty-core/adapted/wasm/build.zig.zon");

type Literal = Readonly<Record<string, string>>;

export type NerdFontTables = {
  /** Constraint literals by stage3 index; index 0 (and any `null`) is none. */
  readonly constraints: readonly (Literal | null)[];
  /** [first, last, constraint index], ascending, merged where adjacent. */
  readonly runs: readonly (readonly [number, number, number])[];
};

function numbers(source: string, name: string): number[] {
  const match = new RegExp(`${name}: \\[\\d+\\]u16 = \\.\\{([^}]*)\\}`).exec(
    source,
  );
  if (!match) throw new SystemExit(`${name} not found`);
  return match[1].split(",").map((value) => Number.parseInt(value.trim(), 10));
}

/** Reads Ghostty's three-stage lookup (the layout of src/unicode/lut.zig). */
export function parseNerdFontTables(source: string): NerdFontTables {
  const stage1 = numbers(source, "stage1");
  const stage2 = numbers(source, "stage2");
  const body = /stage3: \[(\d+)\]Elem = \.\{\n([\s\S]*)\n {8}\};/.exec(
    source,
  )?.[2];
  if (body === undefined) throw new SystemExit("stage3 not found");
  const constraints = [...body.matchAll(/null|\.\{[\s\S]*?\n {12}\}/g)].map(
    ([literal]): Literal | null => {
      if (literal === "null") return null;
      const fields: Record<string, string> = {};
      for (const [, key, value] of literal.matchAll(/\.(\w+) = ([^,]+),/g))
        fields[key] = value.trim();
      return fields;
    },
  );
  const runs: [number, number, number][] = [];
  for (let page = 0; page < stage1.length; page++) {
    const offset = stage1[page];
    if (offset === 0) continue;
    for (let low = 0; low < 256; low++) {
      const index = stage2[offset + low];
      if (!index) continue;
      const codepoint = page * 256 + low;
      const last = runs.at(-1);
      if (last && last[1] === codepoint - 1 && last[2] === index)
        last[1] = codepoint;
      else runs.push([codepoint, codepoint, index]);
    }
  }
  return { constraints, runs };
}

const SIZE: Readonly<Record<string, string>> = {
  ".fit": "fit",
  ".cover": "cover",
  ".fit_cover1": "fitCover1",
  ".stretch": "stretch",
};
const ALIGN: Readonly<Record<string, string>> = {
  ".start": "start",
  ".end": "end",
  ".center": "center",
  ".center1": "center1",
};
const CONSTANTS = [
  Math.E,
  Math.LN10,
  Math.LN2,
  Math.LOG10E,
  Math.LOG2E,
  Math.PI,
  Math.SQRT1_2,
  Math.SQRT2,
].map(String);

/** `value` to `digits` decimals, without trailing zeros. */
export function decimal(value: string | number, digits = 4): string {
  let text = fixed(roundTo(Number(value), digits), digits)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
  if (text === "-0" || text === "") text = "0";
  // Biome reads a literal that is a prefix of a Math constant as a sloppy
  // copy of it; one more digit says otherwise.
  const fraction = text.split(".").at(-1) ?? "";
  if (
    fraction.length >= 3 &&
    CONSTANTS.some((constant) => constant.startsWith(text.replace(/^-/, "")))
  )
    return decimal(value, digits + 1);
  return text;
}

function rule(constraint: Literal): string {
  const pads = ["pad_top", "pad_left", "pad_right", "pad_bottom"].map((key) =>
    decimal(constraint[key] ?? 0, 6),
  );
  const size = SIZE[constraint.size];
  if (!size) throw new SystemExit(`unknown size ${constraint.size}`);
  const align = (key: string) => {
    const value = constraint[key];
    if (value === undefined) return '"none"';
    const name = ALIGN[value];
    if (!name) throw new SystemExit(`unknown alignment ${value}`);
    return `"${name}"`;
  };
  return `[${[
    `"${size}"`,
    constraint.height === ".icon" ? '"icon"' : '"cell"',
    constraint.max_constraint_width ?? "2",
    align("align_horizontal"),
    align("align_vertical"),
    ...pads,
    decimal(constraint.max_xy_ratio ?? 0, 6),
  ].join(", ")}]`;
}

function wrap(items: readonly string[], indent = "  ", width = 80): string {
  const lines: string[] = [];
  let line = indent;
  for (const item of items) {
    const piece = `${item},`;
    if (line.length + piece.length + 1 > width && line.trim()) {
      lines.push(line.trimEnd());
      line = indent;
    }
    line += `${piece} `;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.join("\n");
}

/** The generated module (before formatting). */
export function renderConstraints(tables: NerdFontTables): string {
  const rules: string[] = [];
  const ruleIndex = new Map<string, number>();
  const variants: string[][] = [];
  const variantIndex = new Map<string, number>();
  const remap = new Map<number, number>();
  tables.constraints.forEach((constraint, index) => {
    if (!constraint) return;
    const text = rule(constraint);
    if (!ruleIndex.has(text)) {
      ruleIndex.set(text, rules.length);
      rules.push(text);
    }
    const variant = [
      String(ruleIndex.get(text)),
      decimal(constraint.relative_width ?? 1),
      decimal(constraint.relative_height ?? 1),
      decimal(constraint.relative_x ?? 0),
      decimal(constraint.relative_y ?? 0),
    ];
    const key = variant.join(",");
    if (!variantIndex.has(key)) {
      variantIndex.set(key, variants.length);
      variants.push(variant);
    }
    remap.set(index, variantIndex.get(key) as number);
  });

  // Merge runs whose variants became identical after rounding.
  const merged: [number, number, number][] = [];
  for (const [start, end, index] of tables.runs) {
    const variant = remap.get(index);
    if (variant === undefined)
      throw new SystemExit(`U+${start.toString(16)} maps to a null constraint`);
    const last = merged.at(-1);
    if (last && last[1] === start - 1 && last[2] === variant) last[1] = end;
    else merged.push([start, end, variant]);
  }
  const flatRuns: string[] = [];
  let previousEnd = -1;
  for (const [start, end, variant] of merged) {
    flatRuns.push(
      String(start - previousEnd - 1),
      String(end - start),
      String(variant),
    );
    previousEnd = end;
  }

  return [
    `/**
 * Nerd Font icon constraints: how each icon is scaled and aligned in its
 * cell, after the Nerd Fonts patcher's rules (Nerd Fonts 3.4.0, scale groups
 * measured on Symbols Nerd Font). Generated by
 * scripts/nerd-font-constraints/build.ts from Ghostty's
 * \`src/font/nerd_font_tables.zig\` (MIT); do not edit by hand. Relative
 * group bounds are rounded to 1/10000, far below a pixel at any cell size.
 */
import type {
  ConstraintAlign,
  ConstraintSize,
  GlyphConstraint,
} from "./glyphConstraint";

type Rule = readonly [
  size: ConstraintSize,
  height: "cell" | "icon",
  maxCells: 1 | 2,
  alignX: ConstraintAlign,
  alignY: ConstraintAlign,
  padTop: number,
  padLeft: number,
  padRight: number,
  padBottom: number,
  maxAspect: number,
];

/** Distinct sizing and alignment rules. */
const RULES: readonly Rule[] = [`,
    wrap(rules),
    "];",
    `
/**
 * Per constraint, five numbers: index into \`RULES\`, then the glyph's width,
 * height, x and y relative to its scale group's bounding box.
 */
const VARIANTS: readonly number[] = [`,
    wrap(variants.map((variant) => variant.join(", "))),
    "];",
    `
/**
 * Runs of code points that share a constraint, three numbers each: code
 * points skipped since the previous run, run length minus one, and the index
 * of the constraint in \`VARIANTS\`.
 */
const RUNS: readonly number[] = [`,
    wrap(flatRuns),
    "];",
    `
let runStarts: Uint32Array | null = null;
let runEnds: Uint32Array | null = null;
let runVariants: Uint16Array | null = null;
const materialized: Array<GlyphConstraint | undefined> = [];

function decodeRuns(): void {
  const count = RUNS.length / 3;
  const starts = new Uint32Array(count);
  const ends = new Uint32Array(count);
  const variants = new Uint16Array(count);
  let end = -1;
  for (let index = 0; index < count; index += 1) {
    const start = end + 1 + RUNS[index * 3];
    end = start + RUNS[index * 3 + 1];
    starts[index] = start;
    ends[index] = end;
    variants[index] = RUNS[index * 3 + 2];
  }
  runStarts = starts;
  runEnds = ends;
  runVariants = variants;
}

function variant(index: number): GlyphConstraint {
  const cached = materialized[index];
  if (cached) return cached;
  const base = index * 5;
  const rule = RULES[VARIANTS[base]];
  const constraint: GlyphConstraint = {
    size: rule[0],
    height: rule[1],
    maxCells: rule[2],
    alignX: rule[3],
    alignY: rule[4],
    padTop: rule[5],
    padLeft: rule[6],
    padRight: rule[7],
    padBottom: rule[8],
    maxAspect: rule[9],
    relativeWidth: VARIANTS[base + 1],
    relativeHeight: VARIANTS[base + 2],
    relativeX: VARIANTS[base + 3],
    relativeY: VARIANTS[base + 4],
  };
  materialized[index] = constraint;
  return constraint;
}

/** The Nerd Font constraint for \`codepoint\`, or null when it has none. */
export function nerdFontConstraint(codepoint: number): GlyphConstraint | null {
  if (codepoint < 0x${merged[0][0].toString(16)}) return null;
  if (!runStarts) decodeRuns();
  const starts = runStarts as Uint32Array;
  const ends = runEnds as Uint32Array;
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (codepoint < starts[middle]) high = middle - 1;
    else if (codepoint > ends[middle]) low = middle + 1;
    else return variant((runVariants as Uint16Array)[middle]);
  }
  return null;
}
`,
  ].join("\n");
}

async function pinnedSource(): Promise<string> {
  const zon = await readFile(ZON, "utf8");
  const commit = /ghostty\/archive\/([0-9a-f]{40})\.tar\.gz/.exec(zon)?.[1];
  if (!commit) throw new SystemExit(`no pinned Ghostty commit in ${ZON}`);
  const url = `https://raw.githubusercontent.com/ghostty-org/ghostty/${commit}/src/font/nerd_font_tables.zig`;
  const response = await fetch(url);
  if (!response.ok)
    throw new SystemExit(
      `${url}: HTTP ${response.status} ${response.statusText}`,
    );
  return response.text();
}

async function main(): Promise<void> {
  const path = process.argv[2];
  const source = path ? await readFile(path, "utf8") : await pinnedSource();
  const tables = parseNerdFontTables(source);
  await writeFile(OUT, renderConstraints(tables));
  const biome = spawnSync("bun", ["run", "biome", "format", "--write", OUT], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (biome.status !== 0) throw new SystemExit("biome format failed");
  console.log(
    `${relative(ROOT, OUT)}: ${tables.runs.length} runs over ${tables.runs.reduce((total, [start, end]) => total + end - start + 1, 0)} code points`,
  );
}

if (import.meta.main) await runMain(main);
