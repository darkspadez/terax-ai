import { describe, expect, it } from "vitest";
import {
  contrastedColor,
  contrastRatio,
  relativeLuminance,
} from "./minimumContrast";

describe("minimum contrast", () => {
  it("measures WCAG 2 contrast", () => {
    expect(relativeLuminance(0xffffff)).toBeCloseTo(1, 6);
    expect(relativeLuminance(0x000000)).toBe(0);
    expect(contrastRatio(0xffffff, 0x000000)).toBeCloseTo(21, 6);
    expect(contrastRatio(0x000000, 0xffffff)).toBeCloseTo(21, 6);
    // WCAG's own example pair: #777 on white is just under 4.5.
    expect(contrastRatio(0x777777, 0xffffff)).toBeCloseTo(4.48, 2);
  });

  it("keeps readable text and replaces unreadable text with white or black", () => {
    const darkGrey = 0x333333;
    const navy = 0x1a1a40;
    // Readable already: unchanged.
    expect(contrastedColor(4.5, 0xffffff, darkGrey)).toBe(0xffffff);
    // Dark blue on navy: white contrasts more than black there.
    expect(contrastedColor(4.5, 0x2a2a60, navy)).toBe(0xffffff);
    // Light yellow on a pale background: black.
    expect(contrastedColor(3, 0xfff8c0, 0xffffe0)).toBe(0x000000);
  });

  it("does nothing at 1, the off value", () => {
    expect(contrastedColor(1, 0x101010, 0x101010)).toBe(0x101010);
  });
});
