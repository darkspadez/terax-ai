import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./symbols.css", import.meta.url), "utf8");
const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(
  ([, body]) => ({
    family: /font-family:\s*'([^']+)'/.exec(body)?.[1],
    file: /url\('([^']+)'\)/.exec(body)?.[1] ?? "",
    ranges: (/unicode-range:\s*([^;]+);/.exec(body)?.[1] ?? "")
      .split(",")
      .map((range) => {
        const [start, end = start] = range.trim().slice(2).split("-");
        return [Number.parseInt(start, 16), Number.parseInt(end, 16)] as const;
      }),
  }),
);

const privateUse = (codepoint: number) =>
  (codepoint >= 0xe000 && codepoint <= 0xf8ff) ||
  (codepoint >= 0xf0000 && codepoint <= 0x10fffd);

// Bundled with the app; each segment loads on its own, so keep them small.
const SEGMENT_BYTES = 220 * 1024;
const TOTAL_BYTES = 1_100 * 1024;

describe("Terax Symbols font faces", () => {
  it("declares every icon set under the one internal family", () => {
    expect(faces.length).toBeGreaterThanOrEqual(10);
    for (const face of faces) expect(face.family).toBe("Terax Symbols");
  });

  // Anything outside the Private Use Area would replace the system fallback
  // for ordinary text (Starship's ❯ is U+276F) and download a segment for it.
  it("covers only Private Use Area codepoints, each in one segment", () => {
    const seen: Array<readonly [number, number]> = [];
    for (const face of faces) {
      for (const [start, end] of face.ranges) {
        expect(Number.isNaN(start) || Number.isNaN(end), face.file).toBe(false);
        expect(privateUse(start) && privateUse(end), face.file).toBe(true);
        expect(start <= end, face.file).toBe(true);
        for (const [otherStart, otherEnd] of seen) {
          expect(end < otherStart || start > otherEnd, face.file).toBe(true);
        }
        seen.push([start, end]);
      }
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
