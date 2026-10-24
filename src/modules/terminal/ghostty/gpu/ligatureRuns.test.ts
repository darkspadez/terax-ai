import { describe, expect, it } from "vitest";
import { isBuiltinGlyph } from "./BuiltinGlyphs";
import {
  findLigatureRuns,
  isLigatureCodepoint,
  isLigatureRun,
  LIGATURE_MAX_CELLS,
  LIGATURE_NONE,
  ligatureKey,
  ligatureRunIndex,
  ligatureRunLength,
  ligaturesApply,
} from "./ligatureRuns";

const PUNCTUATION = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const WHITE = 0xffffff;

/** Keys for a row of plain narrow cells in one colour. */
function keysOf(text: string, foreground = WHITE): number[] {
  return Array.from(text, (character) =>
    ligatureKey(
      character.codePointAt(0) ?? 0,
      true,
      false,
      false,
      foreground,
      0,
    ),
  );
}

/** `[length, index]` per cell, `null` outside runs. */
function runsOf(keys: readonly number[]) {
  const runs = new Uint16Array(keys.length);
  const total = findLigatureRuns(keys, keys.length, runs);
  return {
    total,
    cells: Array.from(runs, (run) =>
      run === 0 ? null : [ligatureRunLength(run), ligatureRunIndex(run)],
    ),
  };
}

describe("ligature code points", () => {
  it("are exactly ASCII punctuation and symbols", () => {
    const accepted: string[] = [];
    for (let codepoint = 0; codepoint < 0x110000; codepoint += 1) {
      if (isLigatureCodepoint(codepoint)) {
        accepted.push(String.fromCodePoint(codepoint));
      }
    }
    expect(accepted.join("")).toBe(PUNCTUATION);
  });

  it("are never procedural glyphs, which must fill their own cell", () => {
    for (const character of PUNCTUATION) {
      expect(isBuiltinGlyph(character.codePointAt(0) ?? 0)).toBe(false);
    }
  });
});

describe("ligatureKey", () => {
  it("rejects cells that cannot join a run", () => {
    const dash = 0x2d;
    expect(ligatureKey(dash, false, false, false, WHITE, 0)).toBe(
      LIGATURE_NONE,
    );
    expect(ligatureKey(dash, true, true, false, WHITE, 0)).toBe(LIGATURE_NONE);
    expect(ligatureKey(dash, true, false, true, WHITE, 0)).toBe(LIGATURE_NONE);
    for (const codepoint of [0, 0x20, 0x41, 0x61, 0x30, 0x7f, 0x2192]) {
      expect(ligatureKey(codepoint, true, false, false, WHITE, 0)).toBe(
        LIGATURE_NONE,
      );
    }
  });

  it("is equal exactly when colour and look are", () => {
    const key = (foreground: number, look: number) =>
      ligatureKey(0x3d, true, false, false, foreground, look);
    expect(key(WHITE, 0)).toBe(ligatureKey(0x3e, true, false, false, WHITE, 0));
    expect(key(WHITE, 0)).not.toBe(key(0xfffffe, 0));
    expect(key(WHITE, 0)).not.toBe(key(WHITE, 1));
    expect(key(0, 0xc3)).not.toBe(key(WHITE, 0xc2));
    expect(key(0, 0xc3)).toBeGreaterThan(0);
  });
});

describe("findLigatureRuns", () => {
  it("marks two or more adjacent punctuation cells with their length and index", () => {
    expect(runsOf(keysOf("a->b != c===d ."))).toEqual({
      total: 7,
      cells: [
        null,
        [2, 0],
        [2, 1],
        null,
        null,
        [2, 0],
        [2, 1],
        null,
        null,
        [3, 0],
        [3, 1],
        [3, 2],
        null,
        null,
        null,
      ],
    });
  });

  it("splits where the look changes and at cells that cannot join", () => {
    const keys = [
      ...keysOf("->"),
      ...keysOf("=>", 0xff0000),
      LIGATURE_NONE,
      ...keysOf("::"),
    ];
    // Two colours meet: both pairs are runs of their own.
    expect(runsOf(keys).cells).toEqual([
      [2, 0],
      [2, 1],
      [2, 0],
      [2, 1],
      null,
      [2, 0],
      [2, 1],
    ]);
    expect(runsOf([...keysOf("-"), ...keysOf(">", 1)]).total).toBe(0);
  });

  it("cuts runs into chunks of at most 16 cells, the last one alone when single", () => {
    expect(LIGATURE_MAX_CELLS).toBe(16);
    const chunks = (length: number) => {
      const { cells } = runsOf(keysOf("=".repeat(length)));
      return cells.map((cell) => cell?.[0] ?? 1);
    };
    expect(chunks(16)).toEqual(Array(16).fill(16));
    expect(chunks(17)).toEqual([...Array(16).fill(16), 1]);
    expect(chunks(20)).toEqual([...Array(16).fill(16), 4, 4, 4, 4]);
    expect(chunks(33)).toEqual([...Array(32).fill(16), 1]);
    const { cells } = runsOf(keysOf("=".repeat(18)));
    expect(cells.slice(15, 18)).toEqual([
      [16, 15],
      [2, 0],
      [2, 1],
    ]);
  });

  it("ends runs at the row's end and handles empty and single rows", () => {
    expect(runsOf(keysOf("ab->")).cells.slice(2)).toEqual([
      [2, 0],
      [2, 1],
    ]);
    expect(runsOf([])).toEqual({ total: 0, cells: [] });
    expect(runsOf(keysOf("-"))).toEqual({ total: 0, cells: [null] });
  });

  it("breaks runs at the cursor, whose cell is drawn alone", () => {
    const keys = keysOf("a===b");
    const at = (breakAt: number) => {
      const runs = new Uint16Array(keys.length);
      findLigatureRuns(keys, keys.length, runs, breakAt);
      return Array.from(runs, (run) =>
        run === 0 ? null : [ligatureRunLength(run), ligatureRunIndex(run)],
      );
    };
    expect(at(1)).toEqual([null, null, [2, 0], [2, 1], null]);
    expect(at(2)).toEqual([null, null, null, null, null]);
    expect(at(3)).toEqual([null, [2, 0], [2, 1], null, null]);
    // A break elsewhere changes nothing.
    expect(at(0)).toEqual(runsOf(keys).cells);
    expect(at(-1)).toEqual(runsOf(keys).cells);
  });

  it("only considers the first `cols` keys and clears stale cells", () => {
    const runs = new Uint16Array(4).fill(0xffff);
    expect(findLigatureRuns(keysOf("a->--"), 3, runs)).toBe(2);
    expect(Array.from(runs)).toEqual([0, 32, 33, 0xffff]);
  });
});

describe("ligature run text", () => {
  it("accepts 2 to 16 ligature code points only", () => {
    expect(isLigatureRun("->")).toBe(true);
    expect(isLigatureRun("=".repeat(16))).toBe(true);
    expect(isLigatureRun("=".repeat(17))).toBe(false);
    expect(isLigatureRun("-")).toBe(false);
    expect(isLigatureRun("-a")).toBe(false);
    expect(isLigatureRun("-→")).toBe(false);
  });

  it("is drawn only without letter spacing", () => {
    expect(ligaturesApply(true, 0)).toBe(true);
    expect(ligaturesApply(true, 1)).toBe(false);
    expect(ligaturesApply(true, -1)).toBe(false);
    expect(ligaturesApply(false, 0)).toBe(false);
  });
});
