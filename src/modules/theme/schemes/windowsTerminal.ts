import {
  ANSI_NAMES,
  emptyPalette,
  hasAnyColor,
  type ParsedScheme,
  requireColor,
  SchemeError,
  type SchemePalette,
} from "./scheme";

type Json = Record<string, unknown>;

/** Index just past the JSON string literal that opens at `start`. */
function skipString(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
  return i + 1;
}

function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const end = skipString(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (text.startsWith("//", i)) {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += text[i++];
    }
  }
  return out;
}

function stripTrailingCommas(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const end = skipString(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (text[i] === ",") {
      let next = i + 1;
      while (next < text.length && /\s/.test(text[next])) next++;
      if (text[next] === "}" || text[next] === "]") {
        i++;
        continue;
      }
    }
    out += text[i++];
  }
  return out;
}

/**
 * Windows Terminal's settings.json is JSON with comments and trailing commas;
 * both are removed outside strings before `JSON.parse`.
 */
export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(stripTrailingCommas(stripComments(text)));
  } catch (e) {
    throw new SchemeError(
      `Invalid JSON: ${e instanceof Error ? e.message : "could not parse"}`,
    );
  }
}

type ColorField = Exclude<keyof SchemePalette, "ansi" | "mode">;

const FIELDS: Record<string, ColorField> = {
  background: "background",
  foreground: "foreground",
  cursorColor: "cursor",
  selectionBackground: "selectionBackground",
};

function isJsonObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function capitalize(word: string): string {
  return word[0].toUpperCase() + word.slice(1);
}

/** Windows Terminal names magenta "purple"; some exporters write "magenta". */
function ansiKeys(name: string, bright: boolean): string[] {
  const names = name === "magenta" ? ["purple", "magenta"] : [name];
  return bright ? names.map((n) => `bright${capitalize(n)}`) : names;
}

function readScheme(raw: Json, label: string): ParsedScheme {
  const palette = emptyPalette();
  const read = (key: string) => {
    const value = raw[key];
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string") {
      throw new SchemeError(`${label}: "${key}" must be a colour string`);
    }
    return requireColor(value, `${label}: "${key}"`);
  };
  for (const [key, field] of Object.entries(FIELDS)) {
    palette[field] = read(key);
  }
  ANSI_NAMES.forEach((name, i) => {
    for (const bright of [false, true]) {
      const key = ansiKeys(name, bright).find((k) => raw[k] !== undefined);
      if (key) palette.ansi[bright ? i + 8 : i] = read(key);
    }
  });
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  return name ? { name, palettes: [palette] } : { palettes: [palette] };
}

/**
 * Accepts one scheme object, an array of them, or a whole settings.json (its
 * `schemes` array). Entries without any terminal colour are skipped; a colour
 * that does not parse is an error naming its scheme.
 */
export function parseWindowsTerminalSchemes(doc: unknown): ParsedScheme[] {
  const candidates = Array.isArray(doc)
    ? doc
    : isJsonObject(doc) && Array.isArray(doc.schemes)
      ? doc.schemes
      : [doc];
  const schemes: ParsedScheme[] = [];
  candidates.forEach((candidate: unknown, index) => {
    if (!isJsonObject(candidate)) return;
    const label =
      typeof candidate.name === "string" && candidate.name.trim() !== ""
        ? `Scheme "${candidate.name.trim().slice(0, 48)}"`
        : `Scheme ${index + 1}`;
    const scheme = readScheme(candidate, label);
    if (hasAnyColor(scheme.palettes[0])) schemes.push(scheme);
  });
  if (schemes.length === 0) {
    throw new SchemeError(
      "No Windows Terminal colour scheme found (expected keys like background, foreground, black, brightWhite)",
    );
  }
  return schemes;
}
