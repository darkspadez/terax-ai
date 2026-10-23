import { describe, expect, it } from "vitest";
import {
  formatMatchCount,
  type MatchCount,
  sameMatchCount,
} from "./matchCount";

const count = (over: Partial<MatchCount>): MatchCount => ({
  current: 0,
  total: 0,
  capped: false,
  pending: false,
  ...over,
});

describe("formatMatchCount", () => {
  it("shows the selected match against the total", () => {
    expect(formatMatchCount(count({ current: 3, total: 12 }))).toBe("3 of 12");
    expect(formatMatchCount(count({ current: 1, total: 1 }))).toBe("1 of 1");
  });

  it("shows the total alone while no match is selected", () => {
    expect(formatMatchCount(count({ total: 12 }))).toBe("12 matches");
    expect(formatMatchCount(count({ total: 1 }))).toBe("1 match");
  });

  it("marks a total that is still growing or was capped", () => {
    expect(
      formatMatchCount(count({ current: 2, total: 40, pending: true })),
    ).toBe("2 of 40+");
    expect(formatMatchCount(count({ total: 10_000, capped: true }))).toBe(
      "10000+ matches",
    );
    expect(formatMatchCount(count({ total: 1, pending: true }))).toBe(
      "1+ matches",
    );
  });

  it("says when nothing matched, but not before counting is done", () => {
    expect(formatMatchCount(count({}))).toBe("No results");
    expect(formatMatchCount(count({ pending: true }))).toBe("");
    expect(formatMatchCount(null)).toBe("");
  });
});

describe("sameMatchCount", () => {
  it("compares by value", () => {
    expect(sameMatchCount(count({ total: 2 }), count({ total: 2 }))).toBe(true);
    expect(sameMatchCount(count({ total: 2 }), count({ total: 3 }))).toBe(
      false,
    );
    expect(sameMatchCount(null, null)).toBe(true);
    expect(sameMatchCount(null, count({}))).toBe(false);
  });
});
