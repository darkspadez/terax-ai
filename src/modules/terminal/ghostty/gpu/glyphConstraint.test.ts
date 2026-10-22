import { describe, expect, it } from "vitest";
import {
  type ConstraintMetrics,
  cellConstraintMetrics,
  constrainGlyph,
  constraintCells,
  EMOJI_CONSTRAINT,
  type GlyphBox,
  glyphConstraint,
  isEmojiPresentation,
  isSymbol,
  makeConstraint,
  SYMBOL_CONSTRAINT,
} from "./glyphConstraint";
import { nerdFontConstraint } from "./nerdFontConstraints";

/**
 * Ghostty's `Constraints` test metrics (JetBrains Mono at 12pt, 96 DPI), so
 * the vectors below are Ghostty's own expectations.
 */
const GHOSTTY: ConstraintMetrics = {
  cellWidth: 10,
  cellHeight: 22,
  faceWidth: 9.6,
  faceHeight: 21.12,
  faceY: 0.2,
  iconHeight: 21.12,
  iconHeightSingle: 44.48 / 3,
};

function expectBox(actual: GlyphBox, expected: GlyphBox, digits = 9): void {
  expect(actual.width).toBeCloseTo(expected.width, digits);
  expect(actual.height).toBeCloseTo(expected.height, digits);
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
}

function requireNerd(codepoint: number) {
  const constraint = nerdFontConstraint(codepoint);
  if (!constraint) throw new Error(`U+${codepoint.toString(16)} has no rule`);
  return constraint;
}

describe("constrainGlyph (Ghostty's vectors)", () => {
  it("leaves text without a constraint untouched", () => {
    const x: GlyphBox = { width: 6.784, height: 15.28, x: 1.408, y: 4.84 };
    for (const cells of [1, 2]) {
      expect(constrainGlyph(makeConstraint({}), x, GHOSTTY, cells)).toEqual(x);
    }
  });

  it("shrinks a symbol to fit one cell and leaves it when two are free", () => {
    // ■ from Iosevka, drawn to span two cells.
    const square: GlyphBox = {
      width: 10.272,
      height: 10.272,
      x: 2.864,
      y: 5.304,
    };
    expectBox(constrainGlyph(SYMBOL_CONSTRAINT, square, GHOSTTY, 1), {
      width: 9.6,
      height: 9.6,
      x: 0,
      y: 5.64,
    });
    expectBox(constrainGlyph(SYMBOL_CONSTRAINT, square, GHOSTTY, 2), square);
  });

  it("scales emoji to cover two cells with side padding, centred", () => {
    // 🥸 from Apple Color Emoji.
    const emoji: GlyphBox = { width: 20, height: 20, x: 0.46, y: 1 };
    expectBox(constrainGlyph(EMOJI_CONSTRAINT, emoji, GHOSTTY, 2), {
      width: 18.72,
      height: 18.72,
      x: 0.44,
      y: 1.4,
    });
  });

  it("scales a grouped Nerd Font icon to one cell and keeps its size in two", () => {
    // nf-cod-lightbulb from Symbols Only; its scale group is larger.
    const constraint = requireNerd(0xea61);
    expect(constraint).toMatchObject({
      size: "fitCover1",
      height: "icon",
      alignX: "center1",
      alignY: "center1",
    });
    const bulb: GlyphBox = {
      width: 9.015625,
      height: 13.015625,
      x: 3.015625,
      y: 3.76525,
    };
    // The generated table rounds group bounds to 1/10000: within 1/1000 px.
    expectBox(
      constrainGlyph(constraint, bulb, GHOSTTY, 1),
      { width: 7.2125, height: 10.4125, x: 0.8125, y: 5.950695224719102 },
      3,
    );
    expectBox(
      constrainGlyph(constraint, bulb, GHOSTTY, 2),
      { width: 9.015625, height: 13.015625, x: 1.015625, y: 4.74836903 },
      3,
    );
  });

  it("stretches a powerline flame to exactly one or two cells", () => {
    const constraint = requireNerd(0xe0c0);
    expect(constraint).toMatchObject({
      size: "stretch",
      height: "cell",
      alignX: "start",
      alignY: "center1",
    });
    const flame: GlyphBox = {
      width: 16.796875,
      height: 16.46875,
      x: -0.796875,
      y: 1.7109375,
    };
    expectBox(constrainGlyph(constraint, flame, GHOSTTY, 1), {
      width: 10,
      height: 22,
      x: 0,
      y: 0,
    });
    expectBox(constrainGlyph(constraint, flame, GHOSTTY, 2), {
      width: 20,
      height: 22,
      x: 0,
      y: 0,
    });
  });
});

describe("constrainGlyph rules", () => {
  const cell = cellConstraintMetrics(12, 26, 15);

  it("uses the cell as the face, with Nerd Fonts' one-cell icon height", () => {
    expect(cell).toEqual({
      cellWidth: 12,
      cellHeight: 26,
      faceWidth: 12,
      faceHeight: 26,
      faceY: 0,
      iconHeight: 26,
      iconHeightSingle: (2 * 15 + 26) / 3,
    });
  });

  it("grows a small icon to cover its cell but never because a second is free", () => {
    const constraint = requireNerd(0xf013);
    const small: GlyphBox = { width: 6, height: 6, x: 1, y: 8 };
    const one = constrainGlyph(constraint, small, cell, 1);
    expect(one.width).toBeCloseTo(12, 9);
    expect(one.x).toBeCloseTo(0, 9);
    const two = constrainGlyph(constraint, small, cell, 2);
    expect(two.width).toBeCloseTo(one.width, 9);
    // Centred on the first cell, and vertically in the face.
    expect(two.x).toBeCloseTo(0, 9);
    expect(two.y + two.height / 2).toBeCloseTo(13, 9);
  });

  it("lets a wide icon keep its size across two cells, left aligned", () => {
    const constraint = requireNerd(0xf013);
    const wide: GlyphBox = { width: 20, height: 16, x: 0, y: 5 };
    const one = constrainGlyph(constraint, wide, cell, 1);
    expect(one.width).toBeCloseTo(12, 9);
    expect(one.height).toBeCloseTo(9.6, 9);
    const two = constrainGlyph(constraint, wide, cell, 2);
    // Fits the icon height for two cells (26) and 24 pixels: no change.
    expect(two.width).toBeCloseTo(20, 9);
    expect(two.x).toBeCloseTo(0, 9);
    expect(two.x + two.width).toBeLessThanOrEqual(24);
  });

  it("keeps an icon limited to one cell in one cell", () => {
    // ☰ is `cover` with at most one cell and 5% padding.
    const constraint = requireNerd(0x2630);
    expect(constraint.maxCells).toBe(1);
    const box = constrainGlyph(
      constraint,
      { width: 30, height: 30, x: 0, y: 0 },
      cell,
      2,
    );
    expect(box.width).toBeCloseTo(12 * 0.9, 9);
    expect(box.x).toBeCloseTo(12 * 0.05, 9);
  });

  it("caps a stretched glyph's aspect ratio", () => {
    // U+E0C4 stretches to at most 0.86 wide per unit of height.
    const constraint = requireNerd(0xe0c4);
    expect(constraint.maxAspect).toBeCloseTo(0.86, 9);
    const box = constrainGlyph(
      constraint,
      { width: 10, height: 10, x: 0, y: 0 },
      cell,
      2,
    );
    expect(box.width / box.height).toBeCloseTo(0.86, 9);
  });

  it("keeps a fitting symbol where it is and pulls an overhang into the cell", () => {
    const arrow: GlyphBox = { width: 8, height: 8, x: 2, y: 9 };
    expect(constrainGlyph(SYMBOL_CONSTRAINT, arrow, cell, 1)).toEqual(arrow);
    const overhang = constrainGlyph(
      SYMBOL_CONSTRAINT,
      { width: 8, height: 30, x: 7, y: -3 },
      cell,
      1,
    );
    expect(overhang.height).toBeCloseTo(26, 9);
    expect(overhang.x).toBeGreaterThanOrEqual(0);
    expect(overhang.x + overhang.width).toBeLessThanOrEqual(12 + 1e-9);
    expect(overhang.y).toBeCloseTo(0, 9);
  });
});

describe("nerdFontConstraint", () => {
  it("covers the Nerd Font ranges Ghostty constrains, and nothing else", () => {
    expect(nerdFontConstraint(0x41)).toBeNull();
    expect(nerdFontConstraint(0x30a2)).toBeNull();
    expect(nerdFontConstraint(0xff66)).toBeNull();
    expect(nerdFontConstraint(0x2630)).not.toBeNull();
    expect(nerdFontConstraint(0x110000)).toBeNull();
    // Ghostty's table (Nerd Fonts 3.4.0) rule by rule.
    const sizes = new Map<string, number>();
    const aligns = new Map<string, number>();
    let constrained = 0;
    let singleCell = 0;
    let grouped = 0;
    let capped = 0;
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      const constraint = nerdFontConstraint(cp);
      if (!constraint) continue;
      constrained += 1;
      sizes.set(constraint.size, (sizes.get(constraint.size) ?? 0) + 1);
      aligns.set(constraint.alignX, (aligns.get(constraint.alignX) ?? 0) + 1);
      if (constraint.maxCells === 1) singleCell += 1;
      if (constraint.relativeHeight !== 1 || constraint.relativeY !== 0) {
        grouped += 1;
      }
      if (constraint.maxAspect > 0) capped += 1;
    }
    expect(constrained).toBe(10_410);
    expect(Object.fromEntries(sizes)).toEqual({
      fitCover1: 10_359,
      stretch: 38,
      cover: 13,
    });
    expect(Object.fromEntries(aligns)).toEqual({
      center1: 10_371,
      start: 22,
      end: 17,
    });
    expect(singleCell).toBe(39);
    // Ghostty groups 304; two fill their group to within the table's 1/10000
    // rounding and become plain icons.
    expect(grouped).toBe(302);
    expect(capped).toBe(18);
  });

  it("shares one object per rule", () => {
    expect(nerdFontConstraint(0xf013)).toBe(nerdFontConstraint(0xf013));
    expect(nerdFontConstraint(0xe0a0)).toMatchObject({
      size: "fitCover1",
      height: "cell",
    });
  });
});

describe("isSymbol", () => {
  it("is Ghostty's symbol-like blocks and the Private Use Areas", () => {
    for (const cp of [
      0x2190, 0x21ff, 0x2460, 0x24ff, 0x2600, 0x26a1, 0x2700, 0x27bf, 0xe000,
      0xf013, 0xf8ff, 0x1f100, 0x1f1ff, 0x1f300, 0x1f600, 0x1f64f, 0x1f680,
      0x1f6ff, 0xf0000, 0xffffd, 0x100000, 0x10fffd,
    ]) {
      expect(isSymbol(cp), cp.toString(16)).toBe(true);
    }
    for (const cp of [
      0x41, 0x218f, 0x2200, 0x245f, 0x2500, 0x25a0, 0x27c0, 0x2b58, 0x4e00,
      0xdfff, 0xf900, 0x1f0ff, 0x1f200, 0x1f650, 0x1f700, 0x1f900, 0xffffe,
      0x10fffe,
    ]) {
      expect(isSymbol(cp), cp.toString(16)).toBe(false);
    }
  });
});

describe("constraintCells (Ghostty's cell rule)", () => {
  const icon = 0xe0a0;
  const powerline = 0xe0b0;
  const space = 0x20;
  const z = 0x7a;

  it("gives a symbol a second cell only when the next one is blank", () => {
    expect(constraintCells(icon, 1, 0, 0)).toBe(2);
    expect(constraintCells(icon, 1, 0, z)).toBe(1);
    expect(constraintCells(icon, 1, 0, space)).toBe(2);
    expect(constraintCells(icon, 1, 0, 0x2002)).toBe(2);
    expect(constraintCells(icon, 1, 0, 0xa0)).toBe(1);
    expect(constraintCells(icon, 1, 0, null)).toBe(1);
    expect(constraintCells(icon, 1, z, 0)).toBe(2);
  });

  it("keeps runs of symbols to one cell each, but not after graphics", () => {
    expect(constraintCells(icon, 1, 0, icon)).toBe(1);
    expect(constraintCells(icon, 1, icon, 0)).toBe(1);
    expect(constraintCells(icon, 1, 0, powerline)).toBe(1);
    expect(constraintCells(icon, 1, powerline, 0)).toBe(2);
    expect(constraintCells(icon, 1, 0x2500, space)).toBe(2);
  });

  it("gives wide characters two cells and text its own width", () => {
    expect(constraintCells(0x1f600, 2, icon, z)).toBe(2);
    expect(constraintCells(0x4e00, 2, 0, null)).toBe(2);
    expect(constraintCells(z, 1, 0, 0)).toBe(1);
  });
});

describe("isEmojiPresentation", () => {
  it("follows the default presentation and variation selectors", () => {
    for (const text of [
      "😀",
      "⚡",
      "🇺🇸",
      "👍🏽",
      "👨\u200d👩\u200d👧",
      "❤\ufe0f",
      "☺\ufe0f",
      "#\ufe0f\u20e3",
    ]) {
      expect(isEmojiPresentation(text), text).toBe(true);
    }
    for (const text of [
      "A",
      "→",
      "❤",
      "☺",
      "☺\ufe0e",
      "😀\ufe0e",
      "#",
      "水",
      "\uf013",
    ]) {
      expect(isEmojiPresentation(text), text).toBe(false);
    }
  });
});

describe("glyphConstraint", () => {
  it("picks the emoji, Nerd Font or symbol rule, and none for text", () => {
    expect(glyphConstraint(0x1f600, true)).toBe(EMOJI_CONSTRAINT);
    // A colour emoji keeps the emoji rule even over a Nerd Font one.
    expect(glyphConstraint(0x2630, true)).toBe(EMOJI_CONSTRAINT);
    expect(glyphConstraint(0x2630, false)).toBe(nerdFontConstraint(0x2630));
    // U+2B58 is not in a symbol block but Nerd Fonts patch it.
    expect(glyphConstraint(0x2b58, false)).toBe(nerdFontConstraint(0x2b58));
    expect(glyphConstraint(0x2192, false)).toBe(SYMBOL_CONSTRAINT);
    expect(glyphConstraint(0x1f600, false)).toBe(SYMBOL_CONSTRAINT);
    // Private Use Area outside the Nerd Font sets.
    expect(glyphConstraint(0xe100, false)).toBe(SYMBOL_CONSTRAINT);
    expect(glyphConstraint(0x41, false)).toBeNull();
    expect(glyphConstraint(0x4e00, false)).toBeNull();
    expect(glyphConstraint(0x1f9d0, false)).toBeNull();
  });
});
