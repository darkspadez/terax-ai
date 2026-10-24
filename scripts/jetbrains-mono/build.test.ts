import { describe, expect, it } from "vitest";
import { assign, excluded, SEGMENTS } from "./build.ts";

// One code point from every segment, so `assign` accepts the set.
const SAMPLE = [0x41, 0x0151, 0x03bb, 0x2500, 0x2192, 0x1d538];

describe("JetBrains Mono segments", () => {
  it("gives each code point to the first segment naming it, the rest to other", () => {
    const assigned = assign([...SAMPLE, 0x2014, 0x20ac, 0x20a9, 0x2122]);
    expect(assigned.get("latin")).toEqual([0x41, 0x2014, 0x20ac, 0x2122]);
    expect(assigned.get("latin-ext")).toEqual([0x0151, 0x20a9]);
    expect(assigned.get("greek-cyrillic")).toEqual([0x03bb]);
    expect(assigned.get("box")).toEqual([0x2500]);
    expect(assigned.get("symbols")).toEqual([0x2192]);
    expect(assigned.get("other")).toEqual([0x1d538]);
  });

  it("leaves icons to Oarlock Symbols and emoji selectors to the system", () => {
    for (const codepoint of [0xe0a0, 0xf8ff, 0xf0001, 0xfe0e, 0xfe0f])
      expect(excluded(codepoint), codepoint.toString(16)).toBe(true);
    for (const codepoint of [0x20, 0x2192, 0xfeff, 0xfffd])
      expect(excluded(codepoint), codepoint.toString(16)).toBe(false);
    const assigned = assign([...SAMPLE, 0xe0a0, 0xfe0f]);
    expect([...assigned.values()].flat()).not.toContain(0xe0a0);
    expect([...assigned.values()].flat()).not.toContain(0xfe0f);
  });

  it("refuses a font that leaves a segment empty", () => {
    expect(() => assign([0x41])).toThrow(/has no glyphs/);
    expect(SEGMENTS.at(-1)?.[0]).toBe("other");
  });
});
