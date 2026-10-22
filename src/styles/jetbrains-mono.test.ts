import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("./jetbrains-mono.css", import.meta.url),
  "utf8",
);
const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(
  ([, body]) => ({
    family: /font-family:\s*'([^']+)'/.exec(body)?.[1],
    style: /font-style:\s*(\w+)/.exec(body)?.[1],
    weight: /font-weight:\s*([^;]+);/.exec(body)?.[1],
    file: /url\('([^']+)'\)/.exec(body)?.[1] ?? "",
    ranges: (/unicode-range:\s*([^;]+);/.exec(body)?.[1] ?? "")
      .split(",")
      .map((range) => {
        const [start, end = start] = range.trim().slice(2).split("-");
        return [Number.parseInt(start, 16), Number.parseInt(end, 16)] as const;
      }),
  }),
);

const covers = (
  ranges: readonly (readonly [number, number])[],
  codepoint: number,
) => ranges.some(([start, end]) => start <= codepoint && codepoint <= end);

// Bundled with the app; each segment loads on its own.
const SEGMENT_BYTES = 64 * 1024;
const TOTAL_BYTES = 320 * 1024;

describe("JetBrains Mono font faces", () => {
  it("declares variable upright and italic faces over the whole weight axis", () => {
    expect(faces.length).toBeGreaterThanOrEqual(8);
    for (const face of faces) {
      expect(face.family).toBe("JetBrains Mono");
      expect(face.weight).toBe("100 800");
    }
    expect(new Set(faces.map((face) => face.style))).toEqual(
      new Set(["normal", "italic"]),
    );
  });

  // Overlapping ranges would download two segments for one character; icons
  // belong to Terax Symbols, and claiming VS16 would pull emoji into a
  // monochrome face.
  it("splits each style into disjoint ranges outside the Private Use Area and VS15/16", () => {
    for (const style of ["normal", "italic"]) {
      const seen: Array<readonly [number, number]> = [];
      for (const face of faces.filter((face) => face.style === style)) {
        for (const [start, end] of face.ranges) {
          expect(Number.isNaN(start) || Number.isNaN(end), face.file).toBe(
            false,
          );
          expect(start <= end, face.file).toBe(true);
          expect(end < 0xe000 || start > 0xf8ff, face.file).toBe(true);
          expect(end < 0xfe00 || start > 0xfe0f, face.file).toBe(true);
          expect(start < 0xf0000, face.file).toBe(true);
          for (const [otherStart, otherEnd] of seen) {
            expect(end < otherStart || start > otherEnd, face.file).toBe(true);
          }
          seen.push([start, end]);
        }
      }
    }
  });

  // ensureMonoFontsLoaded preloads one segment per style; GlyphFontGate lets
  // ASCII through without asking, so all of it must be in that segment.
  it("keeps printable ASCII in one Latin segment per style", () => {
    for (const style of ["normal", "italic"]) {
      const latin = faces.find(
        (face) => face.style === style && face.file.endsWith("-latin.woff2"),
      );
      expect(latin, style).toBeDefined();
      for (let codepoint = 0x20; codepoint <= 0x7e; codepoint += 1)
        expect(covers(latin?.ranges ?? [], codepoint), String(codepoint)).toBe(
          true,
        );
    }
  });

  it("points at bundled WOFF2 segments within the size budget", () => {
    let total = 0;
    for (const face of faces) {
      expect(face.file).toMatch(/\.woff2$/);
      const bytes = statSync(new URL(face.file, import.meta.url)).size;
      expect(bytes, face.file).toBeLessThanOrEqual(SEGMENT_BYTES);
      total += bytes;
    }
    expect(total).toBeLessThanOrEqual(TOTAL_BYTES);
  });
});
