import type { Theme } from "../types";
import { validateTheme } from "../validateTheme";
import { parseAlacrittyToml, parseAlacrittyYaml } from "./alacritty";
import { parseGhosttyTheme } from "./ghostty";
import { parseItermColors } from "./iterm";
import { type ParsedScheme, SchemeError, schemeToTheme } from "./scheme";
import { parseJsonc, parseWindowsTerminalSchemes } from "./windowsTerminal";

export type SourceFormat =
  | "json"
  | "iterm2"
  | "alacritty-toml"
  | "alacritty-yaml"
  | "ghostty";

export type ThemeImportResult =
  | { ok: true; themes: Theme[] }
  | { ok: false; error: string };

export type ThemeImportOptions = {
  /** Picks the format by extension and names schemes that carry no name. */
  fileName?: string;
  /** Name for a nameless scheme without a file name, such as pasted text. */
  fallbackName?: string;
  /** Ids already in use; imported schemes never take one of these. */
  takenIds?: Iterable<string>;
};

/** Larger than any colour scheme; a guard against dropping the wrong file. */
export const MAX_THEME_SOURCE_BYTES = 1024 * 1024;

const MAX_NAME_LENGTH = 64;

const SUPPORTED_FORMATS_LABEL =
  "Terax .terax-theme, Ghostty themes, iTerm2 .itermcolors, Alacritty .toml or .yml, Windows Terminal .json";

const EXTENSION_FORMAT = new Map<string, SourceFormat>([
  ["terax-theme", "json"],
  ["json", "json"],
  ["itermcolors", "iterm2"],
  ["toml", "alacritty-toml"],
  ["yml", "alacritty-yaml"],
  ["yaml", "alacritty-yaml"],
]);

const STRIPPED_EXTENSIONS = new Set([
  ...EXTENSION_FORMAT.keys(),
  "conf",
  "config",
  "ghostty",
  "theme",
  "txt",
]);

const DESCRIPTION: Record<Exclude<SourceFormat, "json">, string> = {
  ghostty: "Imported Ghostty theme.",
  iterm2: "Imported iTerm2 colour scheme.",
  "alacritty-toml": "Imported Alacritty colour scheme.",
  "alacritty-yaml": "Imported Alacritty colour scheme.",
};

const TOML_HEADER_RE =
  /^[ \t]*\[\[?[ \t]*[\w"'.-][\w"' .-]*\]\]?[ \t]*(#.*)?$/m;
const TOML_COLORS_KEY_RE = /^[ \t]*colors\.[\w.-]+[ \t]*=/m;
const YAML_COLORS_KEY_RE = /^colors[ \t]*:/m;
const KEY_VALUE_RE = /^[ \t]*[A-Za-z][\w.-]*[ \t]*=/m;

function extensionOf(fileName: string | undefined): string | null {
  if (!fileName) return null;
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : null;
}

/**
 * Trusts a known extension, then sniffs: XML is an iTerm2 plist, an object is
 * JSON, TOML tables or dotted `colors.` keys are Alacritty TOML, a top-level
 * `colors:` is Alacritty YAML, and anything else is read as Ghostty.
 */
export function detectSourceFormat(
  text: string,
  fileName?: string,
): SourceFormat {
  const known = EXTENSION_FORMAT.get(extensionOf(fileName) ?? "");
  if (known) return known;
  const start = text.trimStart();
  if (start.startsWith("<")) return "iterm2";
  if (start.startsWith("{")) return "json";
  if (TOML_HEADER_RE.test(text) || TOML_COLORS_KEY_RE.test(text)) {
    return "alacritty-toml";
  }
  if (start.startsWith("[")) return "json";
  if (YAML_COLORS_KEY_RE.test(text)) return "alacritty-yaml";
  return "ghostty";
}

/** "rose-pine-moon.toml" reads as "Rose Pine Moon"; spaced names stay as written. */
export function schemeNameFromFileName(fileName: string): string | null {
  let base = (fileName.split(/[\\/]/).pop() ?? "").trim();
  const ext = extensionOf(base);
  if (ext && STRIPPED_EXTENSIONS.has(ext))
    base = base.slice(0, -(ext.length + 1));
  base = base.trim();
  if (/\s/.test(base)) return base;
  const words = base
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1));
  return words.length > 0 ? words.join(" ") : null;
}

export function themeIdFromName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug.length >= 2 ? slug : "imported-scheme";
}

function uniqueIdentity(name: string, taken: Set<string>) {
  const base = themeIdFromName(name);
  if (!taken.has(base)) return { id: base, name };
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!taken.has(id)) return { id, name: `${name} ${n}` };
  }
}

function parseSchemes(
  text: string,
  format: Exclude<SourceFormat, "json">,
): ParsedScheme {
  switch (format) {
    case "iterm2":
      return parseItermColors(text);
    case "alacritty-toml":
      return parseAlacrittyToml(text);
    case "alacritty-yaml":
      return parseAlacrittyYaml(text);
    case "ghostty":
      if (!KEY_VALUE_RE.test(text)) {
        throw new SchemeError(
          `Not a recognised colour scheme. Supported: ${SUPPORTED_FORMATS_LABEL}.`,
        );
      }
      return parseGhosttyTheme(text);
  }
}

function convert(text: string, options: ThemeImportOptions): Theme[] {
  if (text.length > MAX_THEME_SOURCE_BYTES) {
    throw new SchemeError("The file is too large to be a colour scheme");
  }
  const source = text.replace(/^\uFEFF/, "");
  if (source.trim() === "") throw new SchemeError("The file is empty");
  if (source.includes("\u0000")) {
    throw new SchemeError("Not a colour scheme: the file is binary");
  }
  const format = detectSourceFormat(source, options.fileName);
  let schemes: ParsedScheme[];
  let description: string;
  if (format === "json") {
    const doc = parseJsonc(source);
    if (typeof doc === "object" && doc !== null && "variants" in doc) {
      const result = validateTheme(doc);
      if (!result.ok) throw new SchemeError(result.error);
      return [result.theme];
    }
    schemes = parseWindowsTerminalSchemes(doc);
    description = "Imported Windows Terminal colour scheme.";
  } else {
    schemes = [parseSchemes(source, format)];
    description = DESCRIPTION[format];
  }
  const fallbackName = (
    (options.fileName && schemeNameFromFileName(options.fileName)) ||
    options.fallbackName ||
    "Imported Scheme"
  )
    .slice(0, MAX_NAME_LENGTH)
    .trim();
  const taken = new Set(options.takenIds);
  return schemes.map((scheme) => {
    const name = scheme.name?.slice(0, MAX_NAME_LENGTH).trim() || fallbackName;
    const identity = uniqueIdentity(name, taken);
    taken.add(identity.id);
    return schemeToTheme(scheme, { ...identity, description });
  });
}

/**
 * Turns the text of a Terax theme or a terminal colour scheme into themes
 * ready to save. Terax themes keep their id (re-importing updates them);
 * schemes get a fresh id derived from their name.
 */
export function importThemeText(
  text: string,
  options: ThemeImportOptions = {},
): ThemeImportResult {
  try {
    return { ok: true, themes: convert(text, options) };
  } catch (e) {
    if (e instanceof SchemeError) return { ok: false, error: e.message };
    throw e;
  }
}

export type ThemeSourceFile = {
  readonly name: string;
  readonly size: number;
  text(): Promise<string>;
};

/** Imports every file it can; failures are reported per file. */
export async function importThemeFiles(
  files: readonly ThemeSourceFile[],
  takenIds: Iterable<string>,
): Promise<{ themes: Theme[]; errors: string[] }> {
  const taken = new Set(takenIds);
  const themes: Theme[] = [];
  const errors: string[] = [];
  for (const file of files) {
    if (file.size > MAX_THEME_SOURCE_BYTES) {
      errors.push(`${file.name}: too large to be a colour scheme`);
      continue;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      errors.push(`${file.name}: could not be read`);
      continue;
    }
    let result: ThemeImportResult;
    try {
      result = importThemeText(text, { fileName: file.name, takenIds: taken });
    } catch (e) {
      console.error("[terax] theme import failed:", e);
      errors.push(`${file.name}: could not be imported`);
      continue;
    }
    if (!result.ok) {
      errors.push(`${file.name}: ${result.error}`);
      continue;
    }
    for (const theme of result.themes) {
      taken.add(theme.id);
      themes.push(theme);
    }
  }
  return { themes, errors };
}
