// Font tooling shared by the bundled-font builds (scripts/symbols-font,
// scripts/jetbrains-mono): reading a font's cmap, unicode-range text, verified
// downloads and HarfBuzz subsetting (harfbuzzjs, WebAssembly).

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { SystemExit } from "./errors.ts";

export function runs(codepoints: Iterable<number>): [number, number][] {
  const out: [number, number][] = [];
  for (const codepoint of [...codepoints].sort((a, b) => a - b)) {
    const last = out.at(-1);
    if (last && codepoint === last[1] + 1) last[1] = codepoint;
    else out.push([codepoint, codepoint]);
  }
  return out;
}

export const hex = (value: number) => value.toString(16).toUpperCase();

export function unicodeRange(codepoints: Iterable<number>): string {
  return runs(codepoints)
    .map(([start, end]) =>
      start === end ? `U+${hex(start)}` : `U+${hex(start)}-${hex(end)}`,
    )
    .join(", ");
}

/** Fetches `url` and refuses anything whose SHA-256 is not `sha256`. */
export async function fetchVerified(
  url: string,
  sha256: string,
): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok)
    throw new SystemExit(
      `${url}: HTTP ${response.status} ${response.statusText}`,
    );
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== sha256)
    throw new SystemExit(`${url}: sha256 ${digest}, expected ${sha256}`);
  return bytes;
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
// Subsetting (hb-subset)
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
  hb_set_invert(set: number): void;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(input: number): void;
  hb_subset_input_get_flags(input: number): number;
  hb_subset_input_set_flags(input: number, flags: number): void;
  hb_subset_input_set(input: number, which: number): number;
  hb_subset_input_unicode_set(input: number): number;
  hb_subset_or_fail(face: number, input: number): number;
};

export const tableTag = (text: string) =>
  [...text].reduce((value, char) => (value << 8) | char.charCodeAt(0), 0) >>> 0;

export async function loadHarfBuzz(): Promise<HarfBuzzSubset> {
  const require = createRequire(import.meta.url);
  const wasm = await readFile(
    require.resolve("harfbuzzjs/dist/harfbuzz-subset.wasm"),
  );
  const { instance } = await WebAssembly.instantiate(wasm);
  const hb = instance.exports as unknown as HarfBuzzSubset;
  hb._initialize();
  return hb;
}

export type SubsetOptions = {
  /** Keep TrueType instructions. */
  readonly hinting: boolean;
  /** "all" keeps every OpenType feature; "none" drops GSUB/GPOS features. */
  readonly layoutFeatures: "all" | "none";
  /**
   * `name` records kept. HarfBuzz also keeps the ones the font's own tables
   * reference (variation instance and axis names, stylistic set names).
   */
  readonly nameIds: readonly number[];
  readonly dropTables?: readonly string[];
};

/**
 * A face over a copy of the source font in WebAssembly memory, reused for
 * every segment; `subset` returns a TrueType subset. Variation tables are kept,
 * so a variable font stays variable.
 */
export function subsetter(
  hb: HarfBuzzSubset,
  source: Uint8Array,
  options: SubsetOptions,
) {
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
        if (!options.hinting) {
          hb.hb_subset_input_set_flags(
            input,
            hb.hb_subset_input_get_flags(input) | HB_SUBSET_FLAGS_NO_HINTING,
          );
        }
        const features = hb.hb_subset_input_set(
          input,
          HB_SUBSET_SETS_LAYOUT_FEATURE_TAG,
        );
        hb.hb_set_clear(features);
        if (options.layoutFeatures === "all") hb.hb_set_invert(features);
        const names = hb.hb_subset_input_set(input, HB_SUBSET_SETS_NAME_ID);
        hb.hb_set_clear(names);
        for (const id of options.nameIds) hb.hb_set_add(names, id);
        const drop = hb.hb_subset_input_set(
          input,
          HB_SUBSET_SETS_DROP_TABLE_TAG,
        );
        for (const table of options.dropTables ?? [])
          hb.hb_set_add(drop, tableTag(table));
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
