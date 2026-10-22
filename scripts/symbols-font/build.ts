// Builds the bundled Nerd Font symbol fallback ("Terax Symbols").
//
// Downloads the pinned Symbols Nerd Font release, checks its digest, splits the
// font's Private Use Area glyphs into one WOFF2 per icon set and writes:
//
//   src/assets/fonts/symbols/<segment>.woff2   unhinted subsets
//   src/assets/fonts/symbols/NOTICE.txt        licence notice (bundled with the app)
//   src/styles/symbols.css                     one @font-face per segment
//
// Each @font-face covers only the codepoints its file contains, all of them in
// the Private Use Area, so a webview fetches a segment the first time one of its
// icons is drawn and never for ordinary text. Re-run after changing the pinned
// release or the segment table:
//
//   bun scripts/symbols-font/build.ts
//
// Subsetting is HarfBuzz's hb-subset (harfbuzzjs), WOFF2 encoding Google's
// woff2 (wawoff2), both WebAssembly. The archive is unpacked with the system
// `tar` because Bun has no xz decoder.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { runMain, SystemExit } from "../lib/errors.ts";
import { pyRepr } from "../lib/format.ts";

const VERSION = "3.5.1";
const URL_ =
  "https://github.com/ryanoasis/nerd-fonts/releases/download/" +
  `v${VERSION}/NerdFontsSymbolsOnly.tar.xz`;
const SHA256 =
  "01172f37db8543edb102e5cb5c64101c9f4686630804d49b419aa07b23a69996";
const FONT = "SymbolsNerdFont-Regular.ttf";
const FAMILY = "Terax Symbols";

type Range = readonly [start: number, end: number];

// Icon sets in Nerd Fonts 3.x code point order. Material Design is split in
// three so one icon does not pull in all 400 kB of it.
export const SEGMENTS: readonly (readonly [string, readonly Range[]])[] = [
  ["powerline", [[0xe000, 0xe0ff]]], // Pomicons, Powerline, Powerline Extra
  ["font-awesome-extension", [[0xe200, 0xe2ff]]],
  ["weather", [[0xe300, 0xe3ff]]],
  ["seti", [[0xe500, 0xe6ff]]],
  ["devicons", [[0xe700, 0xe9ff]]],
  ["codicons", [[0xea00, 0xecff]]],
  ["font-awesome", [[0xed00, 0xf2ff]]],
  ["font-logos", [[0xf300, 0xf3ff]]],
  ["octicons", [[0xf400, 0xf8ff]]],
  ["material-design-1", [[0xf0000, 0xf08ff]]],
  ["material-design-2", [[0xf0900, 0xf11ff]]],
  ["material-design-3", [[0xf1200, 0xf1aff]]],
];

const ICON_SETS = `\
| Icon set               | Upstream                                              | Licence     |
|------------------------|-------------------------------------------------------|-------------|
| Codicons               | https://github.com/microsoft/vscode-codicons          | CC BY 4.0   |
| Devicons               | https://github.com/devicons/devicon                   | MIT         |
| Font Awesome           | https://github.com/FortAwesome/Font-Awesome           | CC BY 4.0   |
| Font Awesome Extension | https://github.com/AndreLZGava/font-awesome-extension | MIT         |
| Font Logos             | https://github.com/lukas-w/font-logos                 | Unlicense   |
| Material Design Icons  | https://github.com/Templarian/MaterialDesign-Font     | Apache 2.0  |
| Octicons               | https://github.com/primer/octicons                    | MIT         |
| Seti-UI and original   | https://github.com/jesseweed/seti-ui                  | MIT         |
| Pomicons               | https://github.com/gabrielelana/pomicons              | OFL 1.1 RFN |
| Powerline Extra        | https://github.com/ryanoasis/powerline-extra-symbols  | MIT         |
| Powerline Symbols      | https://github.com/powerline/powerline                | MIT         |
| Weather Icons          | https://github.com/erikflowers/weather-icons          | OFL 1.1     |
`;

const ROOT = resolve(import.meta.dirname, "../..");
const ASSETS = join(ROOT, "src/assets/fonts/symbols");
const CSS = join(ROOT, "src/styles/symbols.css");

export function privateUse(codepoint: number): boolean {
  return (
    (0xe000 <= codepoint && codepoint <= 0xf8ff) ||
    (0xf0000 <= codepoint && codepoint <= 0x10fffd)
  );
}

export function runs(codepoints: Iterable<number>): [number, number][] {
  const out: [number, number][] = [];
  for (const codepoint of [...codepoints].sort((a, b) => a - b)) {
    const last = out.at(-1);
    if (last && codepoint === last[1] + 1) last[1] = codepoint;
    else out.push([codepoint, codepoint]);
  }
  return out;
}

const hex = (value: number) => value.toString(16).toUpperCase();

export function unicodeRange(codepoints: Iterable<number>): string {
  return runs(codepoints)
    .map(([start, end]) =>
      start === end ? `U+${hex(start)}` : `U+${hex(start)}-${hex(end)}`,
    )
    .join(", ");
}

export function assign(codepoints: Iterable<number>): Map<string, number[]> {
  const assigned = new Map<string, number[]>(
    SEGMENTS.map(([name]) => [name, []]),
  );
  for (const codepoint of [...codepoints].sort((a, b) => a - b)) {
    if (!privateUse(codepoint)) continue; // ordinary characters keep the system fallback
    const owners = SEGMENTS.filter(([, ranges]) =>
      ranges.some(([start, end]) => start <= codepoint && codepoint <= end),
    ).map(([name]) => name);
    if (owners.length !== 1)
      throw new SystemExit(
        `U+${hex(codepoint)} belongs to ${owners.length ? pyRepr(owners) : "no segment"}`,
      );
    assigned.get(owners[0])?.push(codepoint);
  }
  const empty = [...assigned]
    .filter(([, list]) => list.length === 0)
    .map(([name]) => name);
  if (empty.length)
    throw new SystemExit(`segments without glyphs: ${pyRepr(empty)}`);
  return assigned;
}

// ---------------------------------------------------------------------------
// sfnt cmap (the codepoints the font maps, like fontTools' getBestCmap)
// ---------------------------------------------------------------------------

// fontTools' getBestCmap preference: full-repertoire Unicode subtables first.
const CMAP_PREFERENCE: readonly (readonly [number, number])[] = [
  [3, 10],
  [0, 6],
  [0, 4],
  [3, 1],
  [0, 3],
  [0, 2],
  [0, 1],
  [0, 0],
];

function sfntTable(font: Uint8Array, tag: string): DataView {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const count = view.getUint16(4);
  for (let index = 0; index < count; index++) {
    const record = 12 + index * 16;
    const name = String.fromCharCode(
      ...font.subarray(record, record + 4).values(),
    );
    if (name !== tag) continue;
    const offset = view.getUint32(record + 8);
    const length = view.getUint32(record + 12);
    if (offset + length > font.byteLength)
      throw new SystemExit(`${tag} table is truncated`);
    return new DataView(font.buffer, font.byteOffset + offset, length);
  }
  throw new SystemExit(`font has no ${tag} table`);
}

/** Codepoints of the preferred Unicode cmap subtable (formats 4 and 12). */
export function cmapCodepoints(font: Uint8Array): Set<number> {
  const cmap = sfntTable(font, "cmap");
  const subtables = new Map<string, number>();
  const count = cmap.getUint16(2);
  for (let index = 0; index < count; index++) {
    const record = 4 + index * 8;
    const key = `${cmap.getUint16(record)}/${cmap.getUint16(record + 2)}`;
    if (!subtables.has(key)) subtables.set(key, cmap.getUint32(record + 4));
  }
  const preferred = CMAP_PREFERENCE.map(([platform, encoding]) =>
    subtables.get(`${platform}/${encoding}`),
  ).find((offset) => offset !== undefined);
  if (preferred === undefined)
    throw new SystemExit("font has no Unicode cmap subtable");
  const codepoints = new Set<number>();
  const format = cmap.getUint16(preferred);
  if (format === 12) {
    const groups = cmap.getUint32(preferred + 12);
    for (let group = 0; group < groups; group++) {
      const at = preferred + 16 + group * 12;
      const end = cmap.getUint32(at + 4);
      for (let code = cmap.getUint32(at); code <= end; code++)
        codepoints.add(code);
    }
    return codepoints;
  }
  if (format === 4) {
    const segments = cmap.getUint16(preferred + 6) / 2;
    const ends = preferred + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const rangeOffsets = deltas + segments * 2;
    for (let segment = 0; segment < segments; segment++) {
      const start = cmap.getUint16(starts + segment * 2);
      const end = cmap.getUint16(ends + segment * 2);
      const delta = cmap.getUint16(deltas + segment * 2);
      const rangeOffsetAt = rangeOffsets + segment * 2;
      const rangeOffset = cmap.getUint16(rangeOffsetAt);
      for (let code = start; code <= end && code !== 0xffff; code++) {
        let glyph: number;
        if (rangeOffset === 0) glyph = (code + delta) & 0xffff;
        else {
          const index = cmap.getUint16(
            rangeOffsetAt + rangeOffset + (code - start) * 2,
          );
          glyph = index === 0 ? 0 : (index + delta) & 0xffff;
        }
        // Like fontTools, a code mapped to the missing glyph is not mapped.
        if (glyph !== 0) codepoints.add(code);
      }
    }
    return codepoints;
  }
  throw new SystemExit(`unsupported cmap subtable format ${format}`);
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

async function download(): Promise<{ source: Uint8Array; licence: string }> {
  const response = await fetch(URL_);
  if (!response.ok)
    throw new SystemExit(
      `${URL_}: HTTP ${response.status} ${response.statusText}`,
    );
  const archive = new Uint8Array(await response.arrayBuffer());
  const digest = createHash("sha256").update(archive).digest("hex");
  if (digest !== SHA256)
    throw new SystemExit(`${URL_}: sha256 ${digest}, expected ${SHA256}`);
  const scratch = await mkdtemp(join(tmpdir(), "terax-symbols-font-"));
  try {
    const path = join(scratch, "archive.tar.xz");
    const out = join(scratch, "out");
    await writeFile(path, archive);
    await mkdir(out);
    const tar = spawnSync(
      "tar",
      ["-x", "-J", "--no-same-owner", "-f", path, "-C", out, FONT, "LICENSE"],
      { encoding: "utf8" },
    );
    if (tar.error)
      throw new SystemExit(`could not run tar: ${tar.error.message}`);
    const members = [join(out, FONT), join(out, "LICENSE")];
    const present = await Promise.all(
      members.map((member) =>
        lstat(member).then(
          (info) => info.isFile(),
          () => false,
        ),
      ),
    );
    if (tar.status !== 0 || !present.every(Boolean))
      throw new SystemExit(`${URL_}: missing ${FONT} or LICENSE`);
    const [source, licence] = await Promise.all([
      readFile(members[0]),
      readFile(members[1], "utf8"),
    ]);
    return { source: new Uint8Array(source), licence };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Subsetting (hb-subset) and WOFF2 encoding
// ---------------------------------------------------------------------------

const HB_MEMORY_MODE_READONLY = 1;
const HB_SUBSET_SETS_DROP_TABLE_TAG = 3;
const HB_SUBSET_SETS_NAME_ID = 4;
const HB_SUBSET_SETS_LAYOUT_FEATURE_TAG = 6;
const HB_SUBSET_FLAGS_NO_HINTING = 0x1;

type HarfBuzzSubset = {
  memory: WebAssembly.Memory;
  _initialize(): void;
  malloc(size: number): number;
  free(pointer: number): void;
  hb_blob_create(
    data: number,
    length: number,
    mode: number,
    userData: number,
    destroy: number,
  ): number;
  hb_blob_destroy(blob: number): void;
  hb_blob_get_data(blob: number, length: number): number;
  hb_blob_get_length(blob: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(face: number): void;
  hb_face_reference_blob(face: number): number;
  hb_set_add(set: number, value: number): void;
  hb_set_clear(set: number): void;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(input: number): void;
  hb_subset_input_get_flags(input: number): number;
  hb_subset_input_set_flags(input: number, flags: number): void;
  hb_subset_input_set(input: number, which: number): number;
  hb_subset_input_unicode_set(input: number): number;
  hb_subset_or_fail(face: number, input: number): number;
};

const tag = (text: string) =>
  [...text].reduce((value, char) => (value << 8) | char.charCodeAt(0), 0) >>> 0;

async function loadHarfBuzz(): Promise<HarfBuzzSubset> {
  const require = createRequire(import.meta.url);
  const wasm = await readFile(
    require.resolve("harfbuzzjs/dist/harfbuzz-subset.wasm"),
  );
  const { instance } = await WebAssembly.instantiate(wasm);
  const hb = instance.exports as unknown as HarfBuzzSubset;
  hb._initialize();
  return hb;
}

/**
 * A face over a copy of the source font in WebAssembly memory, reused for
 * every segment; `subset` returns an unhinted TrueType subset.
 */
function subsetter(hb: HarfBuzzSubset, source: Uint8Array) {
  const data = hb.malloc(source.byteLength);
  if (!data) throw new SystemExit("hb-subset: out of memory");
  new Uint8Array(hb.memory.buffer).set(source, data);
  const blob = hb.hb_blob_create(
    data,
    source.byteLength,
    HB_MEMORY_MODE_READONLY,
    0,
    0,
  );
  const face = hb.hb_face_create(blob, 0);
  hb.hb_blob_destroy(blob);
  return {
    subset(codepoints: readonly number[]): Uint8Array {
      const input = hb.hb_subset_input_create_or_fail();
      if (!input) throw new SystemExit("hb_subset_input_create_or_fail failed");
      try {
        hb.hb_subset_input_set_flags(
          input,
          hb.hb_subset_input_get_flags(input) | HB_SUBSET_FLAGS_NO_HINTING,
        );
        // No layout features (the fontTools build kept none either).
        hb.hb_set_clear(
          hb.hb_subset_input_set(input, HB_SUBSET_SETS_LAYOUT_FEATURE_TAG),
        );
        const names = hb.hb_subset_input_set(input, HB_SUBSET_SETS_NAME_ID);
        hb.hb_set_clear(names);
        for (let id = 0; id <= 6; id++) hb.hb_set_add(names, id);
        // FontForge private data.
        hb.hb_set_add(
          hb.hb_subset_input_set(input, HB_SUBSET_SETS_DROP_TABLE_TAG),
          tag("PfEd"),
        );
        const unicodes = hb.hb_subset_input_unicode_set(input);
        for (const codepoint of codepoints) hb.hb_set_add(unicodes, codepoint);
        const subset = hb.hb_subset_or_fail(face, input);
        if (!subset) throw new SystemExit("hb_subset_or_fail failed");
        const result = hb.hb_face_reference_blob(subset);
        try {
          const length = hb.hb_blob_get_length(result);
          if (!length) throw new SystemExit("hb-subset produced an empty font");
          const offset = hb.hb_blob_get_data(result, 0);
          // Copy out: the memory may grow (and detach views) on the next call.
          return new Uint8Array(hb.memory.buffer, offset, length).slice();
        } finally {
          hb.hb_blob_destroy(result);
          hb.hb_face_destroy(subset);
        }
      } finally {
        hb.hb_subset_input_destroy(input);
      }
    },
    dispose() {
      hb.hb_face_destroy(face);
      hb.free(data);
    },
  };
}

async function main(): Promise<void> {
  const { source, licence } = await download();
  const assigned = assign(cmapCodepoints(source));
  const { compress } = await import("wawoff2");
  const fonts = subsetter(await loadHarfBuzz(), source);

  await mkdir(ASSETS, { recursive: true });
  for (const entry of await readdir(ASSETS))
    if (entry.endsWith(".woff2")) await unlink(join(ASSETS, entry));
  const faces: string[] = [];
  try {
    for (const [name] of SEGMENTS) {
      const codepoints = assigned.get(name) ?? [];
      const path = join(ASSETS, `${name}.woff2`);
      await writeFile(path, await compress(fonts.subset(codepoints)));
      console.log(
        `${relative(ROOT, path)}: ${codepoints.length} glyphs, ${(await stat(path)).size} bytes`,
      );
      faces.push(
        "@font-face {\n" +
          `  font-family: '${FAMILY}';\n` +
          "  font-style: normal;\n" +
          "  font-weight: 100 900;\n" +
          "  font-display: block;\n" +
          `  src: url('../assets/fonts/symbols/${name}.woff2') format('woff2');\n` +
          `  unicode-range: ${unicodeRange(codepoints)};\n` +
          "}\n",
      );
    }
  } finally {
    fonts.dispose();
  }

  await writeFile(
    CSS,
    `/* Generated by scripts/symbols-font/build.ts from Symbols Nerd Font ${VERSION}; do not edit.\n` +
      " * Last-resort symbols for the terminal font stack (src/lib/fonts.ts). Private Use Area\n" +
      " * only: a segment downloads the first time one of its icons is drawn. */\n" +
      faces.join("\n"),
  );
  await writeFile(
    join(ASSETS, "NOTICE.txt"),
    `Terax Symbols is Symbols Nerd Font ${VERSION} (https://github.com/ryanoasis/nerd-fonts),\n` +
      "split into one WOFF2 file per icon set and stripped of hinting by\n" +
      "scripts/symbols-font/build.ts. Glyph outlines are unchanged.\n\n" +
      "The glyphs come from these projects, under these licences:\n\n" +
      `${ICON_SETS}\n` +
      "Nerd Fonts licence:\n\n" +
      licence,
  );
}

if (import.meta.main) await runMain(main);
