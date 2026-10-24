import { SchemeError } from "./scheme";

export type TomlTable = { [key: string]: TomlValue };
type TomlValue = string | TomlTable;

/**
 * Enough TOML to read colour tables out of an Alacritty config: tables,
 * dotted and quoted keys, basic and literal strings and inline tables. Values
 * of any other type (numbers, booleans, arrays, multi-line strings) are
 * skipped, as are arrays of tables, so the rest of a full config never gets in
 * the way.
 */
export function parseMinimalToml(text: string): TomlTable {
  const root = newTable();
  let table: TomlTable | null = root;
  const lines = text.split(/\r\n|\r|\n/);
  let pendingClose: string | null = null;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const where = `Line ${i + 1}`;
    if (pendingClose) {
      if (lines[i].includes(pendingClose)) pendingClose = null;
      continue;
    }
    if (depth > 0) {
      depth += bracketBalance(stripComment(lines[i]));
      continue;
    }
    const line = stripComment(lines[i]).trim();
    if (line === "") continue;
    if (line.startsWith("[[")) {
      if (!line.endsWith("]]"))
        throw new SchemeError(`${where}: malformed table header`);
      table = null;
      continue;
    }
    if (line.startsWith("[")) {
      if (!line.endsWith("]"))
        throw new SchemeError(`${where}: malformed table header`);
      table = ensureTable(root, parseKey(line.slice(1, -1), where), where);
      continue;
    }
    const eq = indexOutsideQuotes(line, "=");
    if (eq < 0) throw new SchemeError(`${where}: expected "key = value"`);
    const key = parseKey(line.slice(0, eq), where);
    const raw = line.slice(eq + 1).trim();
    if (raw === "") throw new SchemeError(`${where}: missing value`);
    if (raw.startsWith('"""') || raw.startsWith("'''")) {
      const fence = raw.slice(0, 3);
      if (raw.indexOf(fence, 3) < 0) pendingClose = fence;
      continue;
    }
    if (raw.startsWith("[")) {
      depth = bracketBalance(raw);
      continue;
    }
    if (raw.startsWith("{") && bracketBalance(raw) !== 0) {
      throw new SchemeError(
        `${where}: inline tables must close on the same line`,
      );
    }
    const value = parseValue(raw, where);
    if (table && value !== undefined) assign(table, key, value, where);
  }
  return root;
}

// Prototype-free, so a "__proto__" key in the file is just a key.
function newTable(): TomlTable {
  return Object.create(null) as TomlTable;
}

function stripComment(line: string): string {
  const hash = indexOutsideQuotes(line, "#");
  return hash < 0 ? line : line.slice(0, hash);
}

function indexOutsideQuotes(text: string, char: string): number {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === char) {
      return i;
    }
  }
  return -1;
}

function bracketBalance(text: string): number {
  let balance = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") balance++;
    else if (c === "]" || c === "}") balance--;
  }
  return balance;
}

function splitOutsideQuotes(text: string, separator: string): string[] {
  const parts: string[] = [];
  let rest = text;
  for (;;) {
    const at = indexOutsideQuotes(rest, separator);
    if (at < 0) {
      parts.push(rest);
      return parts;
    }
    parts.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
}

function parseKey(text: string, where: string): string[] {
  return splitOutsideQuotes(text, ".").map((part) => {
    const key = part.trim();
    if (
      key.length >= 2 &&
      (key[0] === '"' || key[0] === "'") &&
      key.endsWith(key[0])
    ) {
      return key.slice(1, -1);
    }
    if (!/^[A-Za-z0-9_-]+$/.test(key)) {
      throw new SchemeError(`${where}: invalid key "${key.slice(0, 32)}"`);
    }
    return key;
  });
}

function parseValue(raw: string, where: string): TomlValue | undefined {
  if (raw.startsWith('"')) return parseBasicString(raw, where);
  if (raw.startsWith("'")) {
    const end = raw.indexOf("'", 1);
    if (end < 0) throw new SchemeError(`${where}: unterminated string`);
    return raw.slice(1, end);
  }
  if (raw.startsWith("{")) return parseInlineTable(raw, where);
  return undefined;
}

const SIMPLE_ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  '"': '"',
  "\\": "\\",
};

function parseBasicString(raw: string, where: string): string {
  let out = "";
  for (let i = 1; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') return out;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = raw[++i];
    if (next !== undefined && next in SIMPLE_ESCAPES) {
      out += SIMPLE_ESCAPES[next];
    } else if (next === "u" || next === "U") {
      const length = next === "u" ? 4 : 8;
      const code = Number.parseInt(raw.slice(i + 1, i + 1 + length), 16);
      if (!Number.isFinite(code) || code > 0x10ffff) {
        throw new SchemeError(`${where}: invalid escape`);
      }
      out += String.fromCodePoint(code);
      i += length;
    } else {
      throw new SchemeError(`${where}: invalid escape "\\${next ?? ""}"`);
    }
  }
  throw new SchemeError(`${where}: unterminated string`);
}

function parseInlineTable(raw: string, where: string): TomlTable {
  const body = raw.slice(1, raw.lastIndexOf("}")).trim();
  const table = newTable();
  if (body === "") return table;
  for (const entry of splitOutsideBraces(body)) {
    const eq = indexOutsideQuotes(entry, "=");
    if (eq < 0)
      throw new SchemeError(`${where}: expected "key = value" in inline table`);
    const value = parseValue(entry.slice(eq + 1).trim(), where);
    if (value !== undefined)
      assign(table, parseKey(entry.slice(0, eq), where), value, where);
  }
  return table;
}

function splitOutsideBraces(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let nested = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "{" || c === "[") nested++;
    else if (c === "}" || c === "]") nested--;
    else if (c === "," && nested === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.filter((p) => p.trim() !== "");
}

function ensureTable(
  root: TomlTable,
  path: string[],
  where: string,
): TomlTable {
  let table = root;
  for (const key of path) {
    const existing = table[key];
    if (existing === undefined) {
      const created = newTable();
      table[key] = created;
      table = created;
    } else if (typeof existing === "string") {
      throw new SchemeError(`${where}: "${key}" is already a value`);
    } else {
      table = existing;
    }
  }
  return table;
}

function assign(
  table: TomlTable,
  path: string[],
  value: TomlValue,
  where: string,
) {
  const parent = ensureTable(table, path.slice(0, -1), where);
  parent[path[path.length - 1]] = value;
}
