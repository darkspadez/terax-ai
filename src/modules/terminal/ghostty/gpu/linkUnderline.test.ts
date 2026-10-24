import { describe, expect, it } from "vitest";
import {
  linkCellRange,
  linkRangesEqual,
} from "@/modules/terminal/ghostty/gpu/linkUnderline";

const COLS = 10;
const ROWS = 5;

describe("hovered link cells", () => {
  it("is one range for a link on one row", () => {
    expect(
      linkCellRange(
        [{ row: 2, startColumn: 3, endColumn: 6 }],
        COLS,
        ROWS,
        2,
        4,
      ),
    ).toEqual({ start: 23, end: 26 });
  });

  it("joins a link wrapped over rows into one range in reading order", () => {
    expect(
      linkCellRange(
        [
          { row: 2, startColumn: 0, endColumn: 4 },
          { row: 1, startColumn: 7, endColumn: 9 },
        ],
        COLS,
        ROWS,
        2,
        1,
      ),
    ).toEqual({ start: 17, end: 24 });
  });

  it("keeps only the span under the pointer when the spans do not follow each other", () => {
    const spans = [
      { row: 1, startColumn: 2, endColumn: 4 },
      { row: 3, startColumn: 0, endColumn: 2 },
    ];
    expect(linkCellRange(spans, COLS, ROWS, 3, 1)).toEqual({
      start: 30,
      end: 32,
    });
    expect(linkCellRange(spans, COLS, ROWS, 2, 1)).toBeNull();
  });

  it("clamps spans to the grid and drops what lies outside", () => {
    expect(
      linkCellRange(
        [
          { row: -1, startColumn: 0, endColumn: 9 },
          { row: 0, startColumn: -3, endColumn: 40 },
          { row: 9, startColumn: 0, endColumn: 2 },
        ],
        COLS,
        ROWS,
        0,
        0,
      ),
    ).toEqual({ start: 0, end: 9 });
    expect(linkCellRange([], COLS, ROWS, 0, 0)).toBeNull();
    expect(
      linkCellRange(
        [{ row: 1, startColumn: 5, endColumn: 2 }],
        COLS,
        ROWS,
        1,
        3,
      ),
    ).toBeNull();
  });

  it("compares ranges by value", () => {
    expect(linkRangesEqual(null, null)).toBe(true);
    expect(linkRangesEqual({ start: 1, end: 2 }, { start: 1, end: 2 })).toBe(
      true,
    );
    expect(linkRangesEqual({ start: 1, end: 2 }, { start: 1, end: 3 })).toBe(
      false,
    );
    expect(linkRangesEqual({ start: 1, end: 2 }, null)).toBe(false);
  });
});
