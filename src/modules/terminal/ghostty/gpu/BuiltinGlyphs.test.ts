import { describe, expect, it } from "vitest";
import {
  BuiltinGlyphRenderer,
  builtinGlyphSpec,
  builtinLineThickness,
  isBuiltinGlyph,
} from "./BuiltinGlyphs";
import { deriveFontMetrics } from "./terminalVisuals";

/** Cell sizes (odd and even widths and heights) with plausible line weights. */
const CELLS: ReadonlyArray<readonly [number, number, number]> = [
  [7, 15, 1],
  [8, 16, 1],
  [8, 16, 2],
  [9, 19, 1],
  [9, 19, 2],
  [10, 21, 2],
  [17, 37, 2],
  [17, 37, 3],
  [20, 42, 2],
  [20, 42, 3],
];

type Glyph = {
  readonly w: number;
  readonly h: number;
  readonly t: number;
  readonly data: Uint8Array;
  at(x: number, y: number): number;
  column(x: number): number[];
  row(y: number): number[];
  ink(): number;
};

function glyph(cp: number | string, w: number, h: number, t: number): Glyph {
  const codepoint = typeof cp === "string" ? (cp.codePointAt(0) ?? 0) : cp;
  const renderer = new BuiltinGlyphRenderer({
    width: w,
    height: h,
    thickness: t,
  });
  const mask = renderer.render(codepoint);
  if (!mask) throw new Error(`U+${codepoint.toString(16)} is not builtin`);
  const data = mask.slice();
  return {
    w,
    h,
    t,
    data,
    at: (x, y) => data[y * w + x],
    column: (x) => Array.from({ length: h }, (_, y) => data[y * w + x]),
    row: (y) => Array.from(data.subarray(y * w, (y + 1) * w)),
    ink: () => data.reduce((sum, value) => sum + value, 0),
  };
}

/** One character per pixel: `.` empty, `#` full, 1/2/3 the shades, else `?`. */
function art(g: Glyph): string[] {
  const shades: Record<number, string> = {
    0: ".",
    255: "#",
    64: "1",
    128: "2",
    192: "3",
  };
  return Array.from({ length: g.h }, (_, y) =>
    g
      .row(y)
      .map((value) => shades[value] ?? "?")
      .join(""),
  );
}

/**
 * Every range Ghostty's sprite font draws (`src/font/sprite/Face.zig`: the
 * `draw<MIN>_<MAX>` functions of `draw/*.zig`), cursor and decoration sprites
 * aside.
 */
const GHOSTTY_SPRITE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x2500, 0x257f],
  [0x2580, 0x259f],
  [0x25e2, 0x25e5],
  [0x25f8, 0x25fa],
  [0x25ff, 0x25ff],
  [0x2800, 0x28ff],
  [0xe0b0, 0xe0bf],
  [0xe0d2, 0xe0d2],
  [0xe0d4, 0xe0d4],
  [0xf5d0, 0xf60d],
  [0x1cc1b, 0x1cc1e],
  [0x1cc21, 0x1cc2f],
  [0x1cc30, 0x1cc3f],
  [0x1cd00, 0x1cde5],
  [0x1ce00, 0x1ce01],
  [0x1ce0b, 0x1ce0c],
  [0x1ce16, 0x1ce19],
  [0x1ce51, 0x1ce8f],
  [0x1ce90, 0x1ceaf],
  [0x1fb00, 0x1fb3b],
  [0x1fb3c, 0x1fb67],
  [0x1fb68, 0x1fb6f],
  [0x1fb70, 0x1fb75],
  [0x1fb76, 0x1fb7b],
  [0x1fb7c, 0x1fb97],
  [0x1fb98, 0x1fb99],
  [0x1fb9a, 0x1fb9f],
  [0x1fba0, 0x1fbae],
  [0x1fbaf, 0x1fbaf],
  [0x1fbbd, 0x1fbbf],
  [0x1fbce, 0x1fbcf],
  [0x1fbd0, 0x1fbdf],
  [0x1fbe0, 0x1fbef],
];

function inGhosttySprites(cp: number): boolean {
  return GHOSTTY_SPRITE_RANGES.some(([start, end]) => cp >= start && cp <= end);
}

describe("isBuiltinGlyph", () => {
  it("covers the Ghostty sprite ranges and nothing else nearby", () => {
    for (const cp of [
      0x2500, 0x257f, 0x2580, 0x259f, 0x2800, 0x28ff, 0xe0b0, 0xe0b7, 0xe0b8,
      0xe0bf, 0x25e2, 0x1fb00, 0x1fb3b, 0x1fb3c, 0x1fb70, 0x1fbef, 0x1cd00,
      0xf5d0, 0xf60d, 0x1cc1b, 0x1cc3f, 0x1ce00, 0x1ce51, 0x1ceaf,
    ]) {
      expect(isBuiltinGlyph(cp), cp.toString(16)).toBe(true);
    }
    for (const cp of [
      0x41, 0x20, 0x24ff, 0x25a0, 0x25e1, 0x25e6, 0x27ff, 0x2900, 0xe0af,
      0xe0c0, 0x1fbb0, 0x1fbf0, 0x1cdf0, 0xf5cf, 0xf60e, 0x1cc1a, 0x1cc1f,
      0x1cc20, 0x1cc40, 0x1cde6, 0x1ce02, 0x1ce0a, 0x1ce0d, 0x1ce15, 0x1ce1a,
      0x1ce50, 0x1ceb0,
    ]) {
      expect(isBuiltinGlyph(cp), cp.toString(16)).toBe(false);
    }
  });

  it("routes exactly the code points Ghostty's sprite font draws", () => {
    for (const [first, last] of [
      [0x2400, 0x2aff],
      [0xe000, 0xe0ff],
      [0xf500, 0xf6ff],
      [0x1cc00, 0x1cfff],
      [0x1fb00, 0x1fbff],
    ]) {
      for (let cp = first; cp <= last; cp += 1) {
        expect(isBuiltinGlyph(cp), `U+${cp.toString(16)}`).toBe(
          inGhosttySprites(cp),
        );
      }
    }
  });

  it("renders null for code points the font draws", () => {
    const renderer = new BuiltinGlyphRenderer({
      width: 8,
      height: 16,
      thickness: 1,
    });
    expect(renderer.render(0x41)).toBeNull();
    expect(renderer.render(0x25a0)).toBeNull();
  });
});

describe("builtinLineThickness", () => {
  it("is the bundled font's 5% underline weight rounded up, at least one pixel", () => {
    expect(builtinLineThickness(10)).toBe(1);
    expect(builtinLineThickness(14)).toBe(1);
    expect(builtinLineThickness(20)).toBe(1);
    expect(builtinLineThickness(21)).toBe(2);
    expect(builtinLineThickness(26)).toBe(2);
    expect(builtinLineThickness(28)).toBe(2);
    expect(builtinLineThickness(41)).toBe(3);
    expect(builtinLineThickness(0.5)).toBe(1);
  });

  it("derives the cell from whole-pixel font metrics at the device ratio", () => {
    const metrics = deriveFontMetrics(
      {
        family: "m",
        size: 14,
        lineHeight: 1.2,
        letterSpacing: 0,
        weight: "400",
      },
      2,
      { advance: 16.8, ascent: 26, descent: 8 },
    );
    expect(builtinGlyphSpec(metrics)).toEqual({
      width: 17,
      height: metrics.deviceCellHeight,
      thickness: 2,
    });
  });
});

describe("light, heavy and double lines", () => {
  it.each(CELLS)("─ and │ reach both cell edges at %ix%i +%i", (w, h, t) => {
    const horizontal = glyph("─", w, h, t);
    const top = (h - t) >> 1;
    for (let y = 0; y < h; y += 1) {
      const covered = y >= top && y < top + t;
      expect(
        horizontal.row(y).every((value) => value === (covered ? 255 : 0)),
      ).toBe(true);
    }
    const vertical = glyph("│", w, h, t);
    const left = (w - t) >> 1;
    for (let x = 0; x < w; x += 1) {
      const covered = x >= left && x < left + t;
      expect(
        vertical.column(x).every((value) => value === (covered ? 255 : 0)),
      ).toBe(true);
    }
  });

  it.each(CELLS)(
    "heavy lines are exactly twice as thick at %ix%i +%i",
    (w, h, t) => {
      const light = glyph("─", w, h, t).column(0).filter(Boolean).length;
      const heavy = glyph("━", w, h, t).column(0).filter(Boolean).length;
      expect(light).toBe(t);
      expect(heavy).toBe(2 * t);
      expect(glyph("│", w, h, t).row(0).filter(Boolean).length).toBe(t);
      expect(glyph("┃", w, h, t).row(0).filter(Boolean).length).toBe(2 * t);
    },
  );

  it.each(CELLS)(
    "═ is two light lines separated by one light gap at %ix%i +%i",
    (w, h, t) => {
      const column = glyph("═", w, h, t).column(w >> 1);
      const bands: number[] = [];
      let run = 0;
      for (const value of [...column, 0]) {
        if (value) run += 1;
        else if (run) {
          bands.push(run);
          run = 0;
        }
      }
      expect(bands).toEqual([t, t]);
      const first = column.indexOf(255);
      expect(
        column.slice(first + t, first + 2 * t).every((value) => value === 0),
      ).toBe(true);
    },
  );

  it("matches Ghostty's reference pixels for junctions at 9x17 with 1px lines", () => {
    expect(art(glyph("┼", 9, 17, 1))).toEqual([
      "....#....",
      "....#....",
      "....#....",
      "....#....",
      "....#....",
      "....#....",
      "....#....",
      "....#....",
      "#########",
      "....#....",
      "....#....",
      "....#....",
      "....#....",
      "....#....",
      "....#....",
      "....#....",
      "....#....",
    ]);
    expect(art(glyph("╬", 9, 17, 1))).toEqual([
      "...#.#...",
      "...#.#...",
      "...#.#...",
      "...#.#...",
      "...#.#...",
      "...#.#...",
      "...#.#...",
      "####.####",
      ".........",
      "####.####",
      "...#.#...",
      "...#.#...",
      "...#.#...",
      "...#.#...",
      "...#.#...",
      "...#.#...",
      "...#.#...",
    ]);
  });

  it("matches Ghostty's reference pixels for a heavy corner and dashes at 11x21 with 2px lines", () => {
    expect(art(glyph("┏", 11, 21, 2)).slice(7, 13)).toEqual([
      "...........",
      "...########",
      "...########",
      "...########",
      "...########",
      "...####....",
    ]);
    expect(art(glyph("┄", 11, 21, 2))[9]).toBe("###.###.##.");
    expect(
      art(glyph("╎", 11, 21, 2)).map((row) => row.indexOf("#") >= 0),
    ).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  // Arms of each junction, in the order up, right, down, left: space for none,
  // l light, h heavy, d double.
  const ARMS: Record<string, string> = {
    "─": " l l",
    "━": " h h",
    "│": "l l ",
    "┃": "h h ",
    "┌": " ll ",
    "┍": " hl ",
    "┎": " lh ",
    "┏": " hh ",
    "┐": "  ll",
    "┑": "  lh",
    "┒": "  hl",
    "┓": "  hh",
    "└": "ll  ",
    "┕": "lh  ",
    "┖": "hl  ",
    "┗": "hh  ",
    "┘": "l  l",
    "┙": "l  h",
    "┚": "h  l",
    "┛": "h  h",
    "├": "lll ",
    "┝": "lhl ",
    "┠": "hlh ",
    "┣": "hhh ",
    "┤": "l ll",
    "┥": "l lh",
    "┨": "h hl",
    "┫": "h hh",
    "┬": " lll",
    "┯": " hlh",
    "┰": " lhl",
    "┳": " hhh",
    "┴": "ll l",
    "┷": "lh h",
    "┸": "hl l",
    "┻": "hh h",
    "┼": "llll",
    "┿": "lhlh",
    "╂": "hlhl",
    "╋": "hhhh",
    "╀": "hlll",
    "╁": "llhl",
    "╃": "hllh",
    "╄": "hhll",
    "╅": "llhh",
    "╆": "lhhl",
    "╇": "hhlh",
    "╈": "lhhh",
    "╉": "hlhh",
    "╊": "hhhl",
    "═": " d d",
    "║": "d d ",
    "╒": " dl ",
    "╓": " ld ",
    "╔": " dd ",
    "╕": "  ld",
    "╖": "  dl",
    "╗": "  dd",
    "╘": "ld  ",
    "╙": "dl  ",
    "╚": "dd  ",
    "╛": "l  d",
    "╜": "d  l",
    "╝": "d  d",
    "╞": "ldl ",
    "╟": "dld ",
    "╠": "ddd ",
    "╡": "l ld",
    "╢": "d dl",
    "╣": "d dd",
    "╤": " dld",
    "╥": " ldl",
    "╦": " ddd",
    "╧": "ld d",
    "╨": "dl l",
    "╩": "dd d",
    "╪": "ldld",
    "╫": "dldl",
    "╬": "dddd",
    "╴": "   l",
    "╵": "l   ",
    "╶": " l  ",
    "╷": "  l ",
    "╸": "   h",
    "╹": "h   ",
    "╺": " h  ",
    "╻": "  h ",
    "╼": " h l",
    "╽": "l h ",
    "╾": " l h",
    "╿": "h l ",
  };
  const chars = Object.keys(ARMS);

  it.each(CELLS)(
    "every junction meets its neighbours pixel for pixel at %ix%i +%i",
    (w, h, t) => {
      const glyphs = new Map(chars.map((c) => [c, glyph(c, w, h, t)]));
      // Neighbouring cells with the same arm style agree on the shared edge;
      // an absent arm leaves the edge empty (only when the cell is roomy).
      const roomy = w - 3 * t >= 2 && h - 3 * t >= 2;
      for (const a of chars) {
        const ga = glyphs.get(a) as Glyph;
        const [up, right, down, left] = ARMS[a];
        if (roomy) {
          if (right === " ")
            expect(ga.column(w - 1).some(Boolean), `${a} right`).toBe(false);
          if (left === " ")
            expect(ga.column(0).some(Boolean), `${a} left`).toBe(false);
          if (up === " ")
            expect(ga.row(0).some(Boolean), `${a} up`).toBe(false);
          if (down === " ")
            expect(ga.row(h - 1).some(Boolean), `${a} down`).toBe(false);
        }
        for (const b of chars) {
          const gb = glyphs.get(b) as Glyph;
          const other = ARMS[b];
          if (right !== " " && right === other[3]) {
            expect(ga.column(w - 1), `${a}|${b}`).toEqual(gb.column(0));
          }
          if (down !== " " && down === other[0]) {
            expect(ga.row(h - 1), `${a}/${b}`).toEqual(gb.row(0));
          }
        }
      }
    },
  );

  it.each([
    [9, 19, 2],
    [10, 21, 2],
    [17, 37, 3],
  ])(
    "tiles a bordered table with unbroken lines and no stray ink at %ix%i +%i",
    (w, h, t) => {
      const rows = ["┌─┬─┐", "│ │ │", "├─┼─┤", "│ │ │", "└─┴─┘"];
      const width = w * 5;
      const height = h * 5;
      const canvas = new Uint8Array(width * height);
      rows.forEach((line, row) => {
        [...line].forEach((char, column) => {
          if (char === " ") return;
          const g = glyph(char, w, h, t);
          for (let y = 0; y < h; y += 1) {
            for (let x = 0; x < w; x += 1) {
              canvas[(row * h + y) * width + column * w + x] = g.at(x, y);
            }
          }
        });
      });
      const lineTop = (h - t) >> 1;
      const lineLeft = (w - t) >> 1;
      for (const row of [0, 2, 4]) {
        for (let y = row * h + lineTop; y < row * h + lineTop + t; y += 1) {
          for (let x = lineLeft; x < 4 * w + lineLeft + t; x += 1) {
            expect(canvas[y * width + x], `h ${x},${y}`).toBe(255);
          }
        }
      }
      for (const column of [0, 2, 4]) {
        for (
          let x = column * w + lineLeft;
          x < column * w + lineLeft + t;
          x += 1
        ) {
          for (let y = lineTop; y < 4 * h + lineTop + t; y += 1) {
            expect(canvas[y * width + x], `v ${x},${y}`).toBe(255);
          }
        }
      }
      // Three horizontal and three vertical lines, crossing nine times.
      const expected = 3 * (4 * w + t) * t + 3 * (4 * h + t) * t - 9 * t * t;
      expect(canvas.reduce((sum, value) => sum + (value ? 1 : 0), 0)).toBe(
        expected,
      );
    },
  );

  it("matches the 1px-wide dash layout at 7x15", () => {
    expect(art(glyph("╌", 7, 15, 1))[7]).toBe("###.##.");
    expect(art(glyph("┆", 7, 15, 1)).map((row) => row[3])).toEqual([
      "#",
      "#",
      "#",
      ".",
      ".",
      "#",
      "#",
      "#",
      ".",
      ".",
      "#",
      "#",
      "#",
      ".",
      ".",
    ]);
  });
});

describe("diagonals and arcs", () => {
  it.each(CELLS)(
    "╲ runs corner to corner and ╱ mirrors it at %ix%i +%i",
    (w, h, t) => {
      const down = glyph("╲", w, h, t);
      const up = glyph("╱", w, h, t);
      expect(down.at(0, 0)).toBeGreaterThan(60);
      expect(down.at(w - 1, h - 1)).toBeGreaterThan(60);
      expect(up.at(w - 1, 0)).toBeGreaterThan(60);
      expect(up.at(0, h - 1)).toBeGreaterThan(60);
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          expect(up.at(w - 1 - x, y)).toBe(down.at(x, y));
        }
      }
      const cross = glyph("╳", w, h, t);
      for (let index = 0; index < cross.data.length; index += 1) {
        expect(cross.data[index]).toBeGreaterThanOrEqual(
          Math.max(down.data[index], up.data[index]),
        );
      }
    },
  );

  it.each(CELLS)(
    "rounded corners join the straight lines at %ix%i +%i",
    (w, h, t) => {
      const horizontal = glyph("─", w, h, t);
      const vertical = glyph("│", w, h, t);
      const corners: Array<[string, boolean, boolean]> = [
        ["╭", true, true],
        ["╮", false, true],
        ["╯", false, false],
        ["╰", true, false],
      ];
      for (const [char, right, bottom] of corners) {
        const arc = glyph(char, w, h, t);
        // The open ends sit on exactly the same pixels as ─ and │.
        expect(arc.column(right ? w - 1 : 0), char).toEqual(
          horizontal.column(0),
        );
        expect(arc.row(bottom ? h - 1 : 0), char).toEqual(vertical.row(0));
        // The opposite edges stay clear and the corner is cut round.
        expect(arc.column(right ? 0 : w - 1).some(Boolean), char).toBe(false);
        expect(arc.row(bottom ? 0 : h - 1).some(Boolean), char).toBe(false);
        // Cutting the elbow takes ink away from the square corner it replaces.
        const sharp = glyph(
          right ? (bottom ? "┌" : "└") : bottom ? "┐" : "┘",
          w,
          h,
          t,
        );
        expect(arc.ink(), char).toBeLessThan(sharp.ink());
      }
    },
  );
});

describe("block elements", () => {
  it("fills the whole cell for █ and shades ░ ▒ ▓ at Ghostty's levels", () => {
    for (const [w, h] of [
      [7, 15],
      [20, 42],
    ]) {
      expect(glyph("█", w, h, 1).data.every((value) => value === 255)).toBe(
        true,
      );
      expect(glyph("░", w, h, 1).data.every((value) => value === 0x40)).toBe(
        true,
      );
      expect(glyph("▒", w, h, 1).data.every((value) => value === 0x80)).toBe(
        true,
      );
      expect(glyph("▓", w, h, 1).data.every((value) => value === 0xc0)).toBe(
        true,
      );
    }
  });

  it.each(CELLS)(
    "half blocks split at round(size / 2) and cover the cell together at %ix%i",
    (w, h, t) => {
      const half = (n: number) => Math.round(n / 2);
      const upper = glyph("▀", w, h, t);
      const lower = glyph("▄", w, h, t);
      const left = glyph("▌", w, h, t);
      const right = glyph("▐", w, h, t);
      expect(upper.column(0).filter(Boolean).length).toBe(half(h));
      expect(upper.column(0)[half(h) - 1]).toBe(255);
      expect(lower.column(0).filter(Boolean).length).toBe(half(h));
      expect(lower.column(0)[h - half(h)]).toBe(255);
      expect(left.row(0).filter(Boolean).length).toBe(half(w));
      expect(right.row(0).filter(Boolean).length).toBe(half(w));
      for (let index = 0; index < w * h; index += 1) {
        expect(Math.max(upper.data[index], lower.data[index])).toBe(255);
        expect(Math.max(left.data[index], right.data[index])).toBe(255);
      }
      // Odd sizes share the middle pixel line instead of leaving a seam.
      expect(upper.ink() + lower.ink()).toBe(2 * half(h) * w * 255);
    },
  );

  it.each(CELLS)(
    "eighth blocks are round(size * n / 8) pixels at %ix%i",
    (w, h, t) => {
      const lower = ["▁", "▂", "▃", "▄", "▅", "▆", "▇"];
      lower.forEach((char, index) => {
        const g = glyph(char, w, h, t);
        expect(g.column(0).filter(Boolean).length, char).toBe(
          Math.round(((index + 1) * h) / 8),
        );
        expect(g.at(0, h - 1), char).toBe(255);
      });
      const left = ["▏", "▎", "▍", "▌", "▋", "▊", "▉"];
      left.forEach((char, index) => {
        const g = glyph(char, w, h, t);
        expect(g.row(0).filter(Boolean).length, char).toBe(
          Math.round(((index + 1) * w) / 8),
        );
        expect(g.at(0, 0), char).toBe(255);
      });
      expect(glyph("▔", w, h, t).column(0).filter(Boolean).length).toBe(
        Math.round(h / 8),
      );
      expect(glyph("▕", w, h, t).row(0).filter(Boolean).length).toBe(
        Math.round(w / 8),
      );
    },
  );

  it.each(CELLS)("quadrants tile the cell at %ix%i", (w, h, t) => {
    const union = new Uint8Array(w * h);
    for (const char of ["▘", "▝", "▖", "▗"]) {
      glyph(char, w, h, t).data.forEach((value, index) => {
        union[index] = Math.max(union[index], value);
      });
    }
    expect(union.every((value) => value === 255)).toBe(true);
    const diagonal = glyph("▚", w, h, t);
    const parts = [glyph("▘", w, h, t), glyph("▗", w, h, t)];
    diagonal.data.forEach((value, index) => {
      expect(value).toBe(Math.max(parts[0].data[index], parts[1].data[index]));
    });
    const three = glyph("▙", w, h, t);
    const sum = [glyph("▘", w, h, t), glyph("▖", w, h, t), glyph("▗", w, h, t)];
    three.data.forEach((value, index) => {
      expect(value).toBe(Math.max(...sum.map((part) => part.data[index])));
    });
  });

  it("matches Ghostty's reference pixels for ▙ at 9x17", () => {
    expect(art(glyph("▙", 9, 17, 1))).toEqual([
      "#####....",
      "#####....",
      "#####....",
      "#####....",
      "#####....",
      "#####....",
      "#####....",
      "#####....",
      "#########",
      "#########",
      "#########",
      "#########",
      "#########",
      "#########",
      "#########",
      "#########",
      "#########",
    ]);
  });
});

describe("braille", () => {
  it.each(CELLS)(
    "keeps eight equal square dots inside the cell at %ix%i",
    (w, h, t) => {
      const all = glyph(0x28ff, w, h, t);
      // Flood fill the dots.
      const seen = new Uint8Array(w * h);
      const dots: Array<{
        x0: number;
        y0: number;
        x1: number;
        y1: number;
        n: number;
      }> = [];
      for (let start = 0; start < w * h; start += 1) {
        if (!all.data[start] || seen[start]) continue;
        const dot = { x0: w, y0: h, x1: -1, y1: -1, n: 0 };
        const stack = [start];
        seen[start] = 1;
        while (stack.length) {
          const index = stack.pop() as number;
          const x = index % w;
          const y = (index - x) / w;
          dot.x0 = Math.min(dot.x0, x);
          dot.x1 = Math.max(dot.x1, x);
          dot.y0 = Math.min(dot.y0, y);
          dot.y1 = Math.max(dot.y1, y);
          dot.n += 1;
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ]) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const next = ny * w + nx;
            if (all.data[next] && !seen[next]) {
              seen[next] = 1;
              stack.push(next);
            }
          }
        }
        dots.push(dot);
      }
      expect(dots).toHaveLength(8);
      const size = dots[0].x1 - dots[0].x0 + 1;
      for (const dot of dots) {
        expect(dot.x1 - dot.x0 + 1).toBe(size);
        expect(dot.y1 - dot.y0 + 1).toBe(size);
        expect(dot.n).toBe(size * size);
      }
      const minX = Math.min(...dots.map((dot) => dot.x0));
      const maxX = Math.max(...dots.map((dot) => dot.x1));
      const minY = Math.min(...dots.map((dot) => dot.y0));
      const maxY = Math.max(...dots.map((dot) => dot.y1));
      expect(minX).toBeGreaterThanOrEqual(0);
      expect(minY).toBeGreaterThanOrEqual(0);
      expect(maxX).toBeLessThan(w);
      expect(maxY).toBeLessThan(h);
      // Margins are balanced to within the one pixel an odd size cannot split.
      expect(Math.abs(minX - (w - 1 - maxX))).toBeLessThanOrEqual(1);
      expect(Math.abs(minY - (h - 1 - maxY))).toBeLessThanOrEqual(1);
    },
  );

  it("draws exactly the dots a pattern names", () => {
    const [w, h] = [9, 19];
    const dots = (cp: number) => {
      const g = glyph(cp, w, h, 1);
      const seen = new Set<number>();
      for (let index = 0; index < w * h; index += 1) {
        if (g.data[index]) {
          const x = index % w;
          const y = (index - x) / w;
          seen.add(
            (x < w / 2 ? 0 : 1) * 4 + Math.min(3, Math.floor((y * 4) / h)),
          );
        }
      }
      return [...seen].sort();
    };
    expect(glyph(0x2800, w, h, 1).ink()).toBe(0);
    // Left column top to bottom is dots 1, 2, 3 then 7; the right is 4, 5, 6, 8.
    expect(dots(0x2801)).toEqual([0]);
    expect(dots(0x2808)).toEqual([4]);
    expect(dots(0x2840)).toEqual([3]);
    expect(dots(0x2880)).toEqual([7]);
    expect(dots(0x28ff)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("matches Ghostty's reference pixels for ⠿ at 9x17", () => {
    expect(art(glyph("⠿", 9, 17, 1))).toEqual([
      ".........",
      ".##...##.",
      ".##...##.",
      ".........",
      ".........",
      ".##...##.",
      ".##...##.",
      ".........",
      ".........",
      ".##...##.",
      ".##...##.",
      ".........",
      ".........",
      ".........",
      ".........",
      ".........",
      ".........",
    ]);
  });
});

describe("powerline", () => {
  it.each(CELLS)(
    "separators span the full cell height and mirror at %ix%i",
    (w, h, t) => {
      const right = glyph(0xe0b0, w, h, t);
      const left = glyph(0xe0b2, w, h, t);
      // Flat edge: full coverage along the whole left column, but the corners.
      expect(right.at(0, h >> 1)).toBe(255);
      expect(right.at(w - 1, h >> 1)).toBeGreaterThan(0);
      expect(right.at(w - 1, 0)).toBe(0);
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          // Mirrored polygons agree to within float rounding of one level.
          expect(
            Math.abs(left.at(w - 1 - x, y) - right.at(x, y)),
          ).toBeLessThanOrEqual(1);
        }
      }
      // Half the cell's area, to within the anti-aliased edge.
      expect(right.ink() / 255).toBeCloseTo((w * h) / 2, 0);
      const triangle = glyph(0xe0b8, w, h, t);
      expect(triangle.ink() / 255).toBeCloseTo((w * h) / 2, 0);
      expect(triangle.at(0, h - 1)).toBe(255);
      expect(triangle.at(w - 1, h - 1)).toBeGreaterThan(150);
    },
  );

  it.each(CELLS)(
    "rounded separators are flat on the cell edge at %ix%i",
    (w, h, t) => {
      const solid = glyph(0xe0b4, w, h, t);
      const mirror = glyph(0xe0b6, w, h, t);
      for (let y = 1; y < h - 1; y += 1) {
        expect(solid.at(0, y), `row ${y}`).toBe(255);
        expect(mirror.at(w - 1, y), `row ${y}`).toBe(255);
      }
      const outline = glyph(0xe0b5, w, h, t);
      expect(outline.ink()).toBeGreaterThan(0);
      expect(outline.ink()).toBeLessThan(solid.ink());
      // The chevron's tip reaches the far edge on the middle row.
      expect(glyph(0xe0b1, w, h, t).at(w - 1, h >> 1)).toBeGreaterThan(0);
    },
  );
});

describe("symbols for legacy computing", () => {
  it.each(CELLS)("single sextants tile the cell at %ix%i", (w, h, t) => {
    const union = new Uint8Array(w * h);
    // U+1FB00 1FB01 1FB03 1FB07 1FB0F 1FB1E hold one sextant each.
    for (const cp of [0x1fb00, 0x1fb01, 0x1fb03, 0x1fb07, 0x1fb0f, 0x1fb1e]) {
      glyph(cp, w, h, t).data.forEach((value, index) => {
        union[index] = Math.max(union[index], value);
      });
    }
    expect(union.every((value) => value === 255)).toBe(true);
  });

  it.each(CELLS)(
    "eighth bars and corner triangles stay inside the cell at %ix%i",
    (w, h, t) => {
      // The second column of eight: from 1/8 to 2/8 of the width.
      const bar = glyph(0x1fb70, w, h, t).row(0);
      const start = w - Math.round((7 * w) / 8);
      const end = Math.round(w / 4);
      expect(
        bar.map((value, x) => (value ? x : -1)).filter((x) => x >= 0),
      ).toEqual(
        Array.from({ length: end - start }, (_, index) => start + index),
      );
      const triangle = glyph(0x25e2, w, h, t);
      expect(triangle.at(w - 1, h - 1)).toBe(255);
      expect(triangle.at(0, 0)).toBe(0);
      expect(triangle.ink() / 255).toBeCloseTo((w * h) / 2, 0);
    },
  );

  it("renders every builtin code point at several sizes without error", () => {
    for (const [w, h, t] of CELLS) {
      const renderer = new BuiltinGlyphRenderer({
        width: w,
        height: h,
        thickness: t,
      });
      let drawn = 0;
      for (const [start, end] of GHOSTTY_SPRITE_RANGES) {
        for (let cp = start; cp <= end; cp += 1) {
          const mask = renderer.render(cp);
          if (!mask) continue;
          drawn += 1;
          expect(mask).toHaveLength(w * h);
          // Only the empty braille and the unassigned U+1FB93 draw nothing.
          if (cp !== 0x2800 && cp !== 0x1fb93) {
            expect(
              mask.some(Boolean),
              `U+${cp.toString(16)} at ${w}x${h}`,
            ).toBe(true);
          }
        }
      }
      expect(drawn).toBe(
        GHOSTTY_SPRITE_RANGES.reduce(
          (sum, [start, end]) => sum + end - start + 1,
          0,
        ),
      );
    }
  });

  it("is deterministic and reuses its scratch mask between calls", () => {
    const renderer = new BuiltinGlyphRenderer({
      width: 10,
      height: 21,
      thickness: 2,
    });
    const first = (renderer.render(0x256d) as Uint8Array).slice();
    renderer.render(0x2573);
    expect(renderer.render(0x256d)).toEqual(first);
    expect(renderer.render(0x256d)).toBe(renderer.render(0x2573));
  });
});

/** Source-over composition of several masks, as SpriteMask layers them. */
function composite(parts: readonly Glyph[], index: number): number {
  const clear = parts.reduce(
    (rest, part) => rest * (1 - part.data[index] / 255),
    1,
  );
  return Math.round(255 * (1 - clear));
}

describe("branch drawing", () => {
  it.each(CELLS)(
    "straight lines and arcs are the box-drawing strokes at %ix%i +%i",
    (w, h, t) => {
      for (const [branch, box] of [
        [0xf5d0, "─"],
        [0xf5d1, "│"],
        [0xf5d6, "╭"],
        [0xf5d7, "╮"],
        [0xf5d8, "╰"],
        [0xf5d9, "╯"],
      ] as const) {
        expect(glyph(branch, w, h, t).data, box).toEqual(
          glyph(box, w, h, t).data,
        );
      }
    },
  );

  it.each(CELLS)(
    "forks and merges are their lines and arcs layered at %ix%i +%i",
    (w, h, t) => {
      const pieces: ReadonlyArray<readonly [number, string]> = [
        [0xf5da, "│╰"],
        [0xf5db, "│╭"],
        [0xf5dc, "╰╭"],
        [0xf5dd, "│╯"],
        [0xf5de, "│╮"],
        [0xf5df, "╯╮"],
        [0xf5e0, "╮─"],
        [0xf5e1, "╭─"],
        [0xf5e2, "╭╮"],
        [0xf5e3, "╯─"],
        [0xf5e4, "╰─"],
        [0xf5e5, "╰╯"],
        [0xf5e6, "│╯╰"],
        [0xf5e7, "│╮╭"],
        [0xf5e8, "─╮╯"],
        [0xf5e9, "─╰╭"],
        [0xf5ea, "│╯╭"],
        [0xf5eb, "│╰╮"],
        [0xf5ec, "─╯╭"],
        [0xf5ed, "─╰╮"],
      ];
      for (const [cp, chars] of pieces) {
        const drawn = glyph(cp, w, h, t);
        const parts = Array.from(chars, (char) => glyph(char, w, h, t));
        drawn.data.forEach((value, index) => {
          expect(
            Math.abs(value - composite(parts, index)),
            `U+${cp.toString(16)} pixel ${index}`,
          ).toBeLessThanOrEqual(1);
        });
      }
    },
  );

  it("fades a light line out towards one edge, one level step per pixel", () => {
    // Ghostty's reference levels at 9x17 with 1px lines.
    const right = glyph(0xf5d2, 9, 17, 1);
    expect(right.row(8)).toEqual([255, 227, 198, 170, 142, 113, 85, 57, 28]);
    expect(right.ink()).toBe(right.row(8).reduce((sum, value) => sum + value));
    const left = glyph(0xf5d3, 9, 17, 1);
    expect(left.row(8)).toEqual([0, 28, 57, 85, 113, 142, 170, 198, 227]);
    const top = glyph(0xf5d5, 9, 17, 1);
    expect(top.column(4)).toEqual([
      0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180, 195, 210, 225,
      240,
    ]);
    const bottom = glyph(0xf5d4, 9, 17, 1);
    expect(bottom.column(4)).toEqual(top.column(4).map((value) => 255 - value));
  });

  it.each(CELLS)(
    "nodes sit on the line crossing and join the lines they name at %ix%i +%i",
    (w, h, t) => {
      const horizontal = glyph("─", w, h, t);
      const vertical = glyph("│", w, h, t);
      const left = (w - t) >> 1;
      const top = (h - t) >> 1;
      const centre = [left + (t >> 1), top + (t >> 1)] as const;
      const nodes: ReadonlyArray<readonly [number, string]> = [
        [0xf5ee, ""],
        [0xf5f0, "r"],
        [0xf5f2, "l"],
        [0xf5f4, "lr"],
        [0xf5f6, "d"],
        [0xf5f8, "u"],
        [0xf5fa, "ud"],
        [0xf5fc, "rd"],
        [0xf5fe, "ld"],
        [0xf600, "ur"],
        [0xf602, "ul"],
        [0xf604, "udr"],
        [0xf606, "udl"],
        [0xf608, "dlr"],
        [0xf60a, "ulr"],
        [0xf60c, "udlr"],
      ];
      for (const [cp, edges] of nodes) {
        const filled = glyph(cp, w, h, t);
        const hollow = glyph(cp + 1, w, h, t);
        const name = `U+${cp.toString(16)}`;
        expect(filled.at(...centre), name).toBe(255);
        expect(hollow.at(...centre), name).toBe(0);
        expect(hollow.ink(), name).toBeLessThan(filled.ink());
        // A named edge carries the light line exactly; the others stay clear
        // above and below the circle. The circle already reaches the sides,
        // where a line only squares off the band.
        const plain = [glyph(0xf5ee, w, h, t), glyph(0xf5ef, w, h, t)];
        [filled, hollow].forEach((drawn, index) => {
          expect(drawn.row(0), name).toEqual(
            edges.includes("u") ? vertical.row(0) : new Array(w).fill(0),
          );
          expect(drawn.row(h - 1), name).toEqual(
            edges.includes("d") ? vertical.row(0) : new Array(w).fill(0),
          );
          for (const [edge, x] of [
            ["l", 0],
            ["r", w - 1],
          ] as const) {
            const expected = plain[index]
              .column(x)
              .map((value, y) =>
                edges.includes(edge) && horizontal.at(x, y) === 255
                  ? 255
                  : value,
              );
            expect(drawn.column(x), `${name} ${edge}`).toEqual(expected);
          }
        });
        // Symmetric about the vertical stroke when it is centred.
        if ((w - t) % 2 === 0 && edges === "ud") {
          for (let y = 0; y < h; y += 1) {
            for (let x = 0; x < w; x += 1) {
              expect(filled.at(x, y)).toBe(filled.at(w - 1 - x, y));
            }
          }
        }
      }
    },
  );
});

describe("symbols for legacy computing supplement", () => {
  it("matches Ghostty's reference pixels for separated blocks", () => {
    expect(art(glyph(0x1cc2f, 9, 17, 1))).toEqual([
      ".........",
      ".##...##.",
      ".##...##.",
      ".##...##.",
      ".##...##.",
      ".##...##.",
      ".##...##.",
      ".........",
      ".........",
      ".........",
      ".##...##.",
      ".##...##.",
      ".##...##.",
      ".##...##.",
      ".##...##.",
      ".##...##.",
      ".........",
    ]);
    expect(art(glyph(0x1cc26, 11, 21, 2))).toEqual([
      "...........",
      ".......###.",
      ".......###.",
      ".......###.",
      ".......###.",
      ".......###.",
      ".......###.",
      ".......###.",
      ".......###.",
      "...........",
      "...........",
      "...........",
      ".###.......",
      ".###.......",
      ".###.......",
      ".###.......",
      ".###.......",
      ".###.......",
      ".###.......",
      ".###.......",
      "...........",
    ]);
    expect(art(glyph(0x1ce8f, 11, 21, 2))).toEqual([
      "...........",
      ".###...###.",
      ".###...###.",
      ".###...###.",
      ".###...###.",
      ".###...###.",
      "...........",
      "...........",
      ".###...###.",
      ".###...###.",
      ".###...###.",
      ".###...###.",
      ".###...###.",
      "...........",
      "...........",
      ".###...###.",
      ".###...###.",
      ".###...###.",
      ".###...###.",
      ".###...###.",
      "...........",
    ]);
    expect(art(glyph(0x1ce6a, 9, 17, 1))).toEqual([
      ".........",
      "......##.",
      "......##.",
      "......##.",
      ".........",
      ".........",
      ".........",
      "......##.",
      "......##.",
      "......##.",
      ".........",
      ".........",
      ".........",
      ".##......",
      ".##......",
      ".##......",
      ".........",
    ]);
  });

  it("matches Ghostty's reference pixels for box-drawing corners", () => {
    expect(art(glyph(0x1cc1b, 9, 17, 1))).toEqual([
      "........#",
      "........#",
      "........#",
      "........#",
      "........#",
      "........#",
      "........#",
      "........#",
      "#########",
      ".........",
      ".........",
      ".........",
      ".........",
      ".........",
      ".........",
      ".........",
      ".........",
    ]);
    expect(art(glyph(0x1ce19, 11, 21, 2)).slice(17)).toEqual([
      "....##.....",
      "....##.....",
      "######.....",
      "######.....",
    ]);
    expect(art(glyph(0x1ce16, 9, 17, 1)).slice(0, 2)).toEqual([
      "....#####",
      "....#....",
    ]);
    expect(art(glyph(0x1cc1e, 11, 21, 2)).slice(9)).toEqual([
      "...........",
      "##.........",
      "##.........",
      "##.........",
      "##.........",
      "##.........",
      "##.........",
      "##.........",
      "##.........",
      "##.........",
      "###########",
      "###########",
    ]);
  });

  it.each(CELLS)("sixteenth blocks tile the cell at %ix%i", (w, h, t) => {
    const union = new Uint8Array(w * h);
    let ink = 0;
    for (let cp = 0x1ce90; cp <= 0x1ce9f; cp += 1) {
      const g = glyph(cp, w, h, t);
      ink += g.ink();
      g.data.forEach((value, index) => {
        union[index] = Math.max(union[index], value);
      });
    }
    expect(union.every((value) => value === 255)).toBe(true);
    // Rows and columns of quarters overlap by at most the odd pixel line.
    expect(ink / 255).toBeLessThanOrEqual((w + 3) * (h + 3));
    // A quarter bar is its four sixteenths.
    const bar = glyph(0x1ceac, w, h, t);
    const parts = [glyph(0x1ce93, w, h, t), glyph(0x1ce97, w, h, t)];
    bar.data.forEach((value, index) => {
      expect(value).toBe(Math.max(parts[0].data[index], parts[1].data[index]));
    });
    expect(art(glyph(0x1cea4, 9, 17, 1)).slice(7, 9)).toEqual([
      ".........",
      "##.......",
    ]);
  });

  it.each(CELLS)(
    "quarter circles mirror each other and twelfth pieces meet across cells at %ix%i +%i",
    (w, h, t) => {
      const upperLeft = glyph(0x1cc35, w, h, t);
      const upperRight = glyph(0x1cc36, w, h, t);
      const lowerLeft = glyph(0x1cc39, w, h, t);
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          expect(upperRight.at(x, y)).toBe(upperLeft.at(w - 1 - x, y));
          expect(lowerLeft.at(x, y)).toBe(upperLeft.at(x, h - 1 - y));
        }
      }
      // The light stroke leaves the cell square to its edge: full coverage
      // across the band, no seam against the next piece.
      expect(upperLeft.at(w - 1, t >> 1)).toBeGreaterThanOrEqual(240);
      expect(upperLeft.at(t >> 1, h - 1)).toBeGreaterThanOrEqual(240);
      const left = glyph(0x1cc31, w, h, t);
      const right = glyph(0x1cc32, w, h, t);
      expect(left.column(w - 1)).toEqual(right.column(0));
      expect(left.at(w - 1, t >> 1)).toBeGreaterThanOrEqual(240);
      expect(
        left
          .column(0)
          .slice(h >> 1)
          .some(Boolean),
      ).toBe(false);
    },
  );

  it.each(CELLS)(
    "half circles and ellipses are two outlined halves at %ix%i +%i",
    (w, h, t) => {
      const sides = glyph(0x1ce00, w, h, t);
      const parts = [glyph(0x1fbe3, w, h, t), glyph(0x1fbe1, w, h, t)];
      sides.data.forEach((value, index) => {
        expect(Math.abs(value - composite(parts, index))).toBeLessThanOrEqual(
          1,
        );
      });
      const ellipse = glyph(0x1ce0b, w, h, t);
      const mirror = glyph(0x1ce0c, w, h, t);
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          expect(mirror.at(x, y)).toBe(ellipse.at(w - 1 - x, y));
        }
      }
      // The two quarter arcs join solidly at the middle of the left edge.
      expect(ellipse.at(0, h >> 1)).toBeGreaterThanOrEqual(240);
      expect(ellipse.at(w - 1, 0)).toBeGreaterThan(200);
      expect(ellipse.at(w - 1, h >> 1)).toBe(0);
    },
  );
});
