import { describe, expect, it } from "vitest";
import {
  assign,
  cmapCodepoints,
  privateUse,
  runs,
  unicodeRange,
} from "./build.ts";

const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
const u32 = (value: number) => [...u16(value >>> 16), ...u16(value & 0xffff)];

/** A bare sfnt with one `cmap` table holding the given subtables. */
function font(
  subtables: { platform: number; encoding: number; data: number[] }[],
): Uint8Array {
  let offset = 4 + 8 * subtables.length;
  const records: number[] = [];
  const bodies: number[] = [];
  for (const { platform, encoding, data } of subtables) {
    records.push(...u16(platform), ...u16(encoding), ...u32(offset));
    bodies.push(...data);
    offset += data.length;
  }
  const cmap = [...u16(0), ...u16(subtables.length), ...records, ...bodies];
  const header = [...u32(0x00010000), ...u16(1), 0, 0, 0, 0, 0, 0];
  const record = [..."cmap"].map((c) => c.charCodeAt(0));
  const directory = [
    ...record,
    ...u32(0),
    ...u32(12 + 16),
    ...u32(cmap.length),
  ];
  return new Uint8Array([...header, ...directory, ...cmap]);
}

/** cmap format 12 with [start, end, firstGlyph] groups. */
const format12 = (groups: [number, number, number][]) => [
  ...u16(12),
  ...u16(0),
  ...u32(16 + 12 * groups.length),
  ...u32(0),
  ...u32(groups.length),
  ...groups.flatMap(([start, end, glyph]) => [
    ...u32(start),
    ...u32(end),
    ...u32(glyph),
  ]),
];

/** cmap format 4 with one delta segment for [start, end] plus the 0xFFFF terminator. */
function format4(start: number, end: number, delta: number): number[] {
  const segments = 2;
  return [
    ...u16(4),
    ...u16(16 + 8 * segments),
    ...u16(0),
    ...u16(segments * 2),
    ...u16(4),
    ...u16(1),
    ...u16(0),
    ...u16(end),
    ...u16(0xffff),
    ...u16(0),
    ...u16(start),
    ...u16(0xffff),
    ...u16(delta),
    ...u16(1),
    ...u16(0),
    ...u16(0),
  ];
}

describe("unicode ranges", () => {
  it("collapses consecutive codepoints into runs", () => {
    expect(runs([0xe0a3, 0xe0a0, 0xe0a1, 0xe0a2, 0xe0b0, 0xe0ca])).toEqual([
      [0xe0a0, 0xe0a3],
      [0xe0b0, 0xe0b0],
      [0xe0ca, 0xe0ca],
    ]);
    expect(unicodeRange([0xe000, 0xe001, 0xe0ca, 0xf0001, 0xf0002])).toBe(
      "U+E000-E001, U+E0CA, U+F0001-F0002",
    );
  });

  it("knows the Private Use Areas", () => {
    expect(
      [0xdfff, 0xe000, 0xf8ff, 0xf900, 0xf0000, 0x10fffd, 0x10fffe].map(
        privateUse,
      ),
    ).toEqual([false, true, true, false, true, true, false]);
  });
});

describe("assign", () => {
  it("puts every Private Use codepoint into exactly one segment and skips the rest", () => {
    const segments = [
      0xe000, 0xe200, 0xe300, 0xe500, 0xe700, 0xea00, 0xed00, 0xf300, 0xf400,
      0xf0000, 0xf0900, 0xf1200,
    ];
    const assigned = assign([0x41, ...segments]);
    expect([...assigned.values()].map((list) => list.length)).toEqual(
      new Array(12).fill(1),
    );
    expect(assigned.get("material-design-2")).toEqual([0xf0900]);
  });

  it("refuses codepoints outside the table and empty segments", () => {
    expect(() => assign([0xe100])).toThrow("U+E100 belongs to no segment");
    expect(() => assign([0xe000])).toThrow(
      /^segments without glyphs: \['font-awesome-extension', /,
    );
  });
});

describe("cmapCodepoints", () => {
  it("prefers the full-repertoire subtable", () => {
    const data = font([
      { platform: 3, encoding: 1, data: format4(0x41, 0x43, 1) },
      {
        platform: 3,
        encoding: 10,
        data: format12([
          [0xe000, 0xe002, 1],
          [0xf0000, 0xf0000, 4],
        ]),
      },
    ]);
    expect([...cmapCodepoints(data)]).toEqual([
      0xe000, 0xe001, 0xe002, 0xf0000,
    ]);
  });

  it("reads format 4 and skips codes mapped to the missing glyph", () => {
    const data = font([
      { platform: 3, encoding: 1, data: format4(0x41, 0x43, 0x10000 - 0x41) },
    ]);
    expect([...cmapCodepoints(data)]).toEqual([0x42, 0x43]);
  });
});
