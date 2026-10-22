// Number and value formatting for the lab reports and their human summaries.
//
// The report format (tables, deltas, metric rounding, "None"/"True" in summary lines) was defined
// by the original Python labs, and reports written by either implementation are compared with each
// other, so these helpers reproduce Python's semantics exactly: format specs round half to even on
// the exact binary value, `round()` does the same, `sum()` is compensated (Neumaier), `fsum()` and
// `statistics.fmean()` are exactly rounded, and `str()` of None, booleans, floats, lists and dicts
// prints what Python printed.

const BIG_10 = 10n;

/** The double as sign, integer mantissa and binary exponent (value = mantissa * 2^exponent). */
function decompose(value: number): {
  negative: boolean;
  mantissa: bigint;
  exponent: number;
} {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const high = view.getUint32(0);
  const low = view.getUint32(4);
  const negative = high >>> 31 === 1;
  const biased = (high >>> 20) & 0x7ff;
  const fraction = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
  if (biased === 0) return { negative, mantissa: fraction, exponent: -1074 };
  return {
    negative,
    mantissa: fraction | (1n << 52n),
    exponent: biased - 1075,
  };
}

/** round(|value| * 10^digits) to an integer, ties to even, on the exact binary value. */
function scaledHalfEven(value: number, digits: number): bigint {
  const { mantissa, exponent } = decompose(value);
  const scale = BIG_10 ** BigInt(digits);
  if (exponent >= 0) return (mantissa << BigInt(exponent)) * scale;
  const numerator = mantissa * scale;
  const denominator = 1n << BigInt(-exponent);
  const quotient = numerator / denominator;
  const twice = (numerator % denominator) * 2n;
  if (twice > denominator) return quotient + 1n;
  if (twice < denominator) return quotient;
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export type FixedOptions = { sign?: boolean; group?: boolean };

/**
 * Python's `format(value, "[+][,].<digits>f")`. Booleans format as 1 and 0 like Python's;
 * anything else that is not a number throws (Python raised TypeError).
 */
export function fixed(
  value: unknown,
  digits: number,
  options: FixedOptions = {},
): string {
  if (typeof value === "boolean") value = value ? 1 : 0;
  if (typeof value !== "number")
    throw new TypeError(
      `unsupported format string passed to ${pyTypeName(value)}.__format__`,
    );
  const plus = options.sign ? "+" : "";
  if (Number.isNaN(value)) return `${plus}nan`;
  if (!Number.isFinite(value)) return value < 0 ? "-inf" : `${plus}inf`;
  const scaled = scaledHalfEven(value, digits)
    .toString()
    .padStart(digits + 1, "0");
  const whole = scaled.slice(0, scaled.length - digits);
  const fraction = scaled.slice(scaled.length - digits);
  const negative = value < 0 || Object.is(value, -0);
  const body =
    (options.group ? group(whole) : whole) + (digits ? `.${fraction}` : "");
  return (negative ? "-" : plus) + body;
}

/** Python's `round(value)`: nearest integer, ties to even. */
export function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const rest = value - floor;
  if (rest > 0.5) return floor + 1;
  if (rest < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Python's `round(value, digits)` for a float: the double nearest the correctly rounded decimal. */
export function roundTo(value: number, digits: number): number {
  if (!Number.isFinite(value)) return value;
  return Number(fixed(value, digits));
}

/** Python's `repr(float)`: shortest round-trip digits, exponent outside 1e-4 <= |x| < 1e16. */
export function floatRepr(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value < 0 ? "-inf" : "inf";
  const sign = value < 0 || Object.is(value, -0) ? "-" : "";
  const [mantissa, exponentText] = Math.abs(value).toExponential().split("e");
  const digits = mantissa.replace(".", "");
  const exponent = Number(exponentText);
  if (exponent < -4 || exponent >= 16) {
    const head = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const power = String(Math.abs(exponent)).padStart(2, "0");
    return `${sign}${head}e${exponent < 0 ? "-" : "+"}${power}`;
  }
  if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
  const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, "0");
  return `${sign}${whole}.${digits.slice(exponent + 1) || "0"}`;
}

function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  if (typeof value === "string") return "str";
  if (typeof value === "boolean") return "bool";
  if (Array.isArray(value)) return "list";
  return typeof value === "object" ? "dict" : typeof value;
}

function reprString(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === quote || char === "\\") out += `\\${char}`;
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (code < 0x20 || (code >= 0x7f && code <= 0xa0) || code === 0xad)
      out += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (code === 0x2028 || code === 0x2029)
      out += `\\u${code.toString(16)}`;
    else out += char;
  }
  return out + quote;
}

/**
 * Python's `str()` of a JSON value. JSON numbers carry no int/float distinction, so an integral
 * number prints like an int (`60`, where Python printed a float as `60.0`); use `floatRepr` for
 * values that are always floats.
 */
export function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") {
    if (!Number.isInteger(value)) return floatRepr(value);
    return Math.abs(value) < 1e21 ? String(value) : BigInt(value).toString();
  }
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (typeof value === "object")
    return `{${Object.entries(value)
      .map(([key, item]) => `${reprString(key)}: ${pyRepr(item)}`)
      .join(", ")}}`;
  return String(value);
}

/** Python's `repr()` of a JSON value. */
export function pyRepr(value: unknown): string {
  return typeof value === "string" ? reprString(value) : pyStr(value);
}

/** Python's `bool()` of a JSON value: empty strings, lists and dicts, zero and None are false. */
export function truthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "boolean") return value;
  if (typeof value === "string" || Array.isArray(value))
    return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Python's `str[:count]` (code points, not UTF-16 units). */
export function head(text: string, count: number): string {
  if (text.length <= count) return text;
  return Array.from(text).slice(0, count).join("");
}

/** Python's built-in `sum()` of floats (3.12+): Neumaier-compensated. */
export function sum(values: Iterable<number | boolean>): number {
  let total = 0;
  let compensation = 0;
  for (const item of values) {
    const value = Number(item);
    const next = total + value;
    if (Math.abs(total) >= Math.abs(value))
      compensation += total - next + value;
    else compensation += value - next + total;
    total = next;
  }
  if (compensation && Number.isFinite(compensation)) total += compensation;
  return total;
}

/** Python's `math.fsum()`: the exactly rounded sum (Shewchuk partials, CPython's final rounding). */
export function fsum(values: Iterable<number>): number {
  const partials: number[] = [];
  let special = 0;
  let infinite = 0;
  for (const original of values) {
    let x = original;
    let kept = 0;
    for (let index = 0; index < partials.length; index++) {
      let y = partials[index];
      if (Math.abs(x) < Math.abs(y)) [x, y] = [y, x];
      const high = x + y;
      const low = y - (high - x);
      if (low !== 0) partials[kept++] = low;
      x = high;
    }
    partials.length = kept;
    if (x === 0) continue;
    if (!Number.isFinite(x)) {
      if (Number.isFinite(original))
        throw new RangeError("intermediate overflow in fsum");
      if (!Number.isNaN(original) && !Number.isFinite(original))
        infinite += original;
      special += original;
      partials.length = 0;
    } else partials.push(x);
  }
  if (special !== 0) {
    if (Number.isNaN(infinite)) throw new RangeError("-inf + inf in fsum");
    return special;
  }
  let count = partials.length;
  if (count === 0) return 0;
  let high = partials[--count];
  let low = 0;
  while (count > 0) {
    const x = high;
    const y = partials[--count];
    high = x + y;
    low = y - (high - x);
    if (low !== 0) break;
  }
  if (
    count > 0 &&
    ((low < 0 && partials[count - 1] < 0) ||
      (low > 0 && partials[count - 1] > 0))
  ) {
    const y = low * 2;
    const x = high + y;
    if (y === x - high) high = x;
  }
  return high;
}

/** `statistics.fmean()`. */
export function fmean(values: Iterable<number>): number {
  const list = [...values];
  if (!list.length)
    throw new RangeError("fmean requires at least one data point");
  return fsum(list) / list.length;
}

/** `statistics.median()`. */
export function median(values: Iterable<number>): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) throw new RangeError("no median for empty data");
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Python's `max()`: the first largest item; an empty sequence throws like Python's ValueError. */
export function maxOf(values: Iterable<number>): number {
  let best: number | undefined;
  for (const value of values)
    if (best === undefined || value > best) best = value;
  if (best === undefined)
    throw new RangeError("max() arg is an empty sequence");
  return best;
}

/** Python's `min()`. */
export function minOf(values: Iterable<number>): number {
  let best: number | undefined;
  for (const value of values)
    if (best === undefined || value < best) best = value;
  if (best === undefined)
    throw new RangeError("min() arg is an empty sequence");
  return best;
}

/** Python's `str.splitlines()`. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Escapes non-ASCII characters like Python's `json.dumps` (`ensure_ascii`). */
export function asciiJson(json: string): string {
  return json.replace(
    /[\u0080-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Python's `json.dumps(value)` with its default separators, for console lines. */
export function pyDumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (!Number.isFinite(value)) return value < 0 ? "-Infinity" : "Infinity";
    return Number.isInteger(value) ? pyStr(value) : floatRepr(value);
  }
  if (typeof value === "boolean" || typeof value === "string")
    return asciiJson(JSON.stringify(value));
  if (Array.isArray(value)) return `[${value.map(pyDumps).join(", ")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${asciiJson(JSON.stringify(key))}: ${pyDumps(item)}`)
    .join(", ")}}`;
}

const INT = /^[+-]?\d+(?:_\d+)*$/;
const FLOAT =
  /^[+-]?(?:(?:\d+(?:_\d+)*)?\.?\d+(?:_\d+)*(?:[eE][+-]?\d+(?:_\d+)*)?|\d+(?:_\d+)*\.|inf|infinity|nan)$/i;

/** Python's `int(text)`, or undefined where Python raised ValueError. */
export function parseInt10(text: string): number | undefined {
  const trimmed = text.trim();
  return INT.test(trimmed) ? Number(trimmed.replaceAll("_", "")) : undefined;
}

/** Python's `float(text)`, or undefined where Python raised ValueError. */
export function parseFloat10(text: string): number | undefined {
  const trimmed = text.trim();
  if (!FLOAT.test(trimmed)) return undefined;
  const lower = trimmed.toLowerCase().replaceAll("_", "");
  if (lower.endsWith("nan")) return Number.NaN;
  if (lower.endsWith("inf") || lower.endsWith("infinity"))
    return lower.startsWith("-")
      ? Number.NEGATIVE_INFINITY
      : Number.POSITIVE_INFINITY;
  return Number(lower);
}

/** Deep equality of JSON values with Python's `==` (1 == 1.0, True == 1, dicts ignore order). */
export function pyEqual(a: unknown, b: unknown): boolean {
  const numeric = (value: unknown) =>
    typeof value === "boolean" ? Number(value) : value;
  a = numeric(a);
  b = numeric(b);
  if (a === b) return true;
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  )
    return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b))
    return (
      a.length === b.length && a.every((item, index) => pyEqual(item, b[index]))
    );
  const left = Object.entries(a);
  const right = b as Record<string, unknown>;
  return (
    left.length === Object.keys(right).length &&
    left.every(([key, value]) => key in right && pyEqual(value, right[key]))
  );
}
