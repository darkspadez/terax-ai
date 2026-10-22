import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  hexToRgb,
  isDarkColor,
  mixHex,
  parseHexColor,
  rgbaCss,
  rgbToHex,
} from "./color";

describe("parseHexColor", () => {
  it("normalises every hex spelling terminal configs use", () => {
    expect(parseHexColor("#ABCDEF")).toBe("#abcdef");
    expect(parseHexColor("abcdef")).toBe("#abcdef");
    expect(parseHexColor("0x1E1E2E")).toBe("#1e1e2e");
    expect(parseHexColor("#fA0")).toBe("#ffaa00");
    expect(parseHexColor("  #000000  ")).toBe("#000000");
  });

  it("rejects names, alpha and malformed values", () => {
    const invalid = [
      "black",
      "#12345",
      "#1234567",
      "#abcdefff",
      "",
      "#",
      "rgb(0,0,0)",
      "0x12",
    ];
    for (const raw of invalid) expect(parseHexColor(raw)).toBeNull();
  });
});

describe("colour math", () => {
  it("round-trips hex and clamps out-of-range channels", () => {
    expect(rgbToHex(hexToRgb("#0d1117"))).toBe("#0d1117");
    expect(rgbToHex([300, -4, 127.6])).toBe("#ff0080");
  });

  it("matches WCAG contrast for black on white", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrastRatio([18, 52, 86], [18, 52, 86])).toBe(1);
  });

  it("mixes in sRGB space", () => {
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixHex("#102030", "#ffffff", 0)).toBe("#102030");
  });

  it("classifies backgrounds by which text colour reads better", () => {
    expect(isDarkColor("#282c34")).toBe(true);
    expect(isDarkColor("#fdf6e3")).toBe(false);
    expect(isDarkColor("#808080")).toBe(false);
  });

  it("formats rgba with a clamped, two-decimal alpha", () => {
    expect(rgbaCss([1, 2, 3], 0.256)).toBe("rgba(1,2,3,0.26)");
    expect(rgbaCss([1, 2, 3], 4)).toBe("rgba(1,2,3,1)");
  });
});
