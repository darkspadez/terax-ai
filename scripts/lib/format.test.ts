import { describe, expect, it } from "vitest";
import {
  asciiJson,
  fixed,
  floatRepr,
  fmean,
  fsum,
  maxOf,
  median,
  parseFloat10,
  parseInt10,
  pyDumps,
  pyEqual,
  pyRepr,
  pyStr,
  roundHalfEven,
  roundTo,
  splitLines,
  sum,
  truthy,
} from "./format.ts";

// Expected values are what CPython 3.13 prints for the same input.

describe("fixed", () => {
  it("rounds exact ties to even like Python's format()", () => {
    expect(fixed(0.125, 2)).toBe("0.12");
    expect(fixed(0.375, 2)).toBe("0.38");
    expect(fixed(2.5, 0)).toBe("2");
    expect(fixed(3.5, 0)).toBe("4");
    expect(fixed(100.25, 1)).toBe("100.2");
    expect(fixed(2.675, 2)).toBe("2.67");
  });

  it("supports the sign and thousands flags", () => {
    expect(fixed(1234567.891, 2, { group: true })).toBe("1,234,567.89");
    expect(fixed(-1234.5, 0, { sign: true, group: true })).toBe("-1,234");
    expect(fixed(0, 1, { sign: true })).toBe("+0.0");
    expect(fixed(-0, 1)).toBe("-0.0");
    expect(fixed(-0.04, 1, { sign: true })).toBe("-0.0");
    expect(fixed(true, 2)).toBe("1.00");
  });

  it("prints nan and inf like Python", () => {
    expect(fixed(Number.NaN, 1, { sign: true })).toBe("+nan");
    expect(fixed(-Number.NaN, 1)).toBe("nan");
    expect(
      fixed(Number.NEGATIVE_INFINITY, 2, { sign: true, group: true }),
    ).toBe("-inf");
    expect(fixed(Number.POSITIVE_INFINITY, 2, { sign: true })).toBe("+inf");
  });

  it("refuses values Python could not format", () => {
    expect(() => fixed(null, 1)).toThrow(TypeError);
    expect(() => fixed("1", 1)).toThrow(TypeError);
  });
});

describe("rounding", () => {
  it("rounds half to even", () => {
    expect([0.5, 1.5, 2.5, -2.5, -0.5].map(roundHalfEven)).toEqual([
      0, 2, 2, -2, 0,
    ]);
    expect(roundTo(2.675, 2)).toBe(2.67);
    expect(roundTo(0.12345, 4)).toBe(0.1235);
    expect(roundTo(1.00005, 4)).toBe(1.0001);
  });
});

describe("floatRepr and pyStr", () => {
  it("formats floats like repr()", () => {
    expect(floatRepr(2)).toBe("2.0");
    expect(floatRepr(1e16)).toBe("1e+16");
    expect(floatRepr(1e15)).toBe("1000000000000000.0");
    expect(floatRepr(1e-5)).toBe("1e-05");
    expect(floatRepr(0.0001)).toBe("0.0001");
    expect(floatRepr(1.2345678901234568e17)).toBe("1.2345678901234568e+17");
    expect(floatRepr(-0)).toBe("-0.0");
    expect(floatRepr(0.1 + 0.2)).toBe("0.30000000000000004");
  });

  it("formats JSON values like str()", () => {
    expect(pyStr(null)).toBe("None");
    expect(pyStr(true)).toBe("True");
    expect(pyStr(60)).toBe("60");
    expect(pyStr(2.5)).toBe("2.5");
    expect(
      pyStr({
        a: null,
        b: [1.5, 2],
        c: true,
        d: "it's",
        e: 'x"y',
        f: "a\\b\n",
      }),
    ).toBe(
      `{'a': None, 'b': [1.5, 2], 'c': True, 'd': "it's", 'e': 'x"y', 'f': 'a\\\\b\\n'}`,
    );
    expect(pyRepr("\x7f\xa0\u2028\u00e9")).toBe("'\\x7f\\xa0\\u2028\u00e9'");
  });
});

describe("sums and statistics", () => {
  it("compensates like Python's sum() and fsum()", () => {
    expect(sum(new Array(10).fill(0.1))).toBe(1);
    expect(sum([0.1, 0.2, 0.3])).toBe(0.6);
    expect(fsum(new Array(10).fill(0.1))).toBe(1);
    expect(fsum([1e-16, 1, 1e16])).toBe(10000000000000002);
    expect(fmean([0.1, 0.2, 0.3])).toBe(0.19999999999999998);
  });

  it("takes the median and refuses empty input", () => {
    expect(median([3, 1, 2, 4])).toBe(2.5);
    expect(median([5, 1, 3])).toBe(3);
    expect(() => median([])).toThrow();
    expect(() => maxOf([])).toThrow();
    expect(maxOf([1, 3, 2])).toBe(3);
  });
});

describe("parsing and comparison", () => {
  it("accepts what int() and float() accept", () => {
    expect(parseInt10(" 12 ")).toBe(12);
    expect(parseInt10("1_000")).toBe(1000);
    expect(parseInt10("1.5")).toBeUndefined();
    expect(parseFloat10("1.")).toBe(1);
    expect(parseFloat10(".5")).toBe(0.5);
    expect(parseFloat10("1e3")).toBe(1000);
    expect(parseFloat10("-inf")).toBe(Number.NEGATIVE_INFINITY);
    expect(parseFloat10("")).toBeUndefined();
    expect(parseFloat10("0x10")).toBeUndefined();
  });

  it("compares like ==", () => {
    expect(pyEqual({ a: 1, b: [true] }, { b: [1], a: 1 })).toBe(true);
    expect(pyEqual(null, undefined)).toBe(true);
    expect(pyEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(truthy({})).toBe(false);
    expect(truthy([0])).toBe(true);
    expect(truthy(0)).toBe(false);
  });

  it("splits lines and writes JSON like Python", () => {
    expect(splitLines("a\r\nb\rc\n")).toEqual(["a", "b", "c"]);
    expect(splitLines("")).toEqual([]);
    expect(asciiJson(JSON.stringify("\u00b7\ud83d\ude00"))).toBe(
      '"\\u00b7\\ud83d\\ude00"',
    );
    expect(
      pyDumps({ phase: "x", footprintMiB: 12.5, unqualified: ["a"] }),
    ).toBe('{"phase": "x", "footprintMiB": 12.5, "unqualified": ["a"]}');
  });
});
