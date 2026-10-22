import { SchemeError } from "./scheme";

export type YamlMap = { [key: string]: YamlValue };
type YamlValue = string | YamlMap | null;

type Line = { number: number; indent: number; text: string };

const MAX_DEPTH = 32;

/**
 * Enough YAML to read the colour block of a legacy `alacritty.yml`: block
 * mappings, plain and quoted scalars, comments, anchors, aliases and `<<`
 * merges (old configs keep several schemes under anchors and pick one with
 * `colors: *name`). Sequences, block scalars and flow collections are skipped.
 */
export function parseMinimalYaml(text: string): YamlMap {
  const lines = toLines(text);
  const reader = new YamlReader(lines);
  const root = reader.readMap(0, lines[0]?.indent ?? 0, 0);
  if (reader.index < lines.length) {
    throw new SchemeError(
      `Line ${lines[reader.index].number}: unexpected indentation`,
    );
  }
  return root;
}

function toLines(text: string): Line[] {
  const out: Line[] = [];
  text.split(/\r\n|\r|\n/).forEach((raw, i) => {
    const body = stripComment(raw).trimEnd();
    const content = body.trimStart();
    if (
      content === "" ||
      content === "---" ||
      content === "..." ||
      content.startsWith("%")
    ) {
      return;
    }
    const lead = body.slice(0, body.length - content.length);
    if (lead.includes("\t")) {
      throw new SchemeError(
        `Line ${i + 1}: tabs are not allowed for indentation`,
      );
    }
    out.push({ number: i + 1, indent: lead.length, text: content });
  });
  return out;
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s:[{,]/.test(line[i - 1])) quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function findKeyColon(text: string): number {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if ((c === '"' || c === "'") && i === 0) {
      quote = c;
    } else if (c === ":" && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
      return i;
    }
  }
  return -1;
}

function unquoteScalar(raw: string, where: string): string {
  if (raw.startsWith("'")) {
    if (raw.length < 2 || !raw.endsWith("'"))
      throw new SchemeError(`${where}: unterminated string`);
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"'))
      throw new SchemeError(`${where}: unterminated string`);
    return raw
      .slice(1, -1)
      .replace(/\\(["\\/nt])/g, (_, c: string) =>
        c === "n" ? "\n" : c === "t" ? "\t" : c,
      );
  }
  return raw;
}

function newMap(): YamlMap {
  return Object.create(null) as YamlMap;
}

class YamlReader {
  index = 0;
  private readonly anchors = new Map<string, YamlValue>();

  constructor(private readonly lines: Line[]) {}

  readMap(start: number, indent: number, depth: number): YamlMap {
    if (depth > MAX_DEPTH) {
      throw new SchemeError(
        `Line ${this.lines[start].number}: nested too deeply`,
      );
    }
    const map = newMap();
    this.index = start;
    while (this.index < this.lines.length) {
      const line = this.lines[this.index];
      if (line.indent < indent) break;
      const where = `Line ${line.number}`;
      if (line.indent > indent)
        throw new SchemeError(`${where}: unexpected indentation`);
      if (line.text === "-" || line.text.startsWith("- ")) {
        this.skipChildren(indent, true);
        continue;
      }
      const colon = findKeyColon(line.text);
      if (colon <= 0) throw new SchemeError(`${where}: expected "key: value"`);
      const key = unquoteScalar(line.text.slice(0, colon).trim(), where);
      let rest = line.text.slice(colon + 1).trim();
      let anchor: string | null = null;
      if (rest.startsWith("&")) {
        const space = rest.search(/\s/);
        anchor = space < 0 ? rest.slice(1) : rest.slice(1, space);
        rest = space < 0 ? "" : rest.slice(space).trim();
      }
      const value = this.readValue(rest, indent, depth, where);
      if (anchor) this.anchors.set(anchor, value);
      if (key === "<<") {
        if (value && typeof value === "object") {
          for (const [k, v] of Object.entries(value)) {
            if (!(k in map)) map[k] = v;
          }
        }
      } else {
        map[key] = value;
      }
    }
    return map;
  }

  private readValue(
    rest: string,
    indent: number,
    depth: number,
    where: string,
  ): YamlValue {
    if (rest === "") {
      const next = this.lines[this.index + 1];
      if (next && next.indent > indent)
        return this.readMap(this.index + 1, next.indent, depth + 1);
      this.index++;
      if (
        next &&
        next.indent === indent &&
        (next.text === "-" || next.text.startsWith("- "))
      ) {
        this.skipChildren(indent, true);
      }
      return null;
    }
    this.index++;
    if (rest.startsWith("*")) {
      const name = rest.slice(1).trim();
      if (!this.anchors.has(name))
        throw new SchemeError(`${where}: unknown alias "*${name}"`);
      return this.anchors.get(name) ?? null;
    }
    if (
      rest[0] === "|" ||
      rest[0] === ">" ||
      rest[0] === "[" ||
      rest[0] === "{"
    ) {
      this.skipChildren(indent, false);
      return null;
    }
    return unquoteScalar(rest, where);
  }

  /** Skips lines nested under `indent`; with `items`, also sibling "- " entries. */
  private skipChildren(indent: number, items: boolean): void {
    if (items) this.index++;
    while (this.index < this.lines.length) {
      const line = this.lines[this.index];
      const sibling =
        items &&
        line.indent === indent &&
        (line.text === "-" || line.text.startsWith("- "));
      if (line.indent <= indent && !sibling) return;
      this.index++;
    }
  }
}
