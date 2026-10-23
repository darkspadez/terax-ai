import { parseMinimalToml } from "./minimalToml";
import { parseMinimalYaml } from "./minimalYaml";
import {
  ANSI_NAMES,
  emptyPalette,
  hasAnyColor,
  type ParsedScheme,
  requireColor,
  SchemeError,
  type SchemePalette,
} from "./scheme";

type Node = string | null | { [key: string]: Node };
type Table = { [key: string]: Node };

// Alacritty's cursor and selection may follow the cell under them; Oarlock has no
// equivalent, so those fall back like an unset key.
const CELL_REFERENCES = new Set(["cellforeground", "cellbackground"]);

function isTable(node: Node | undefined): node is Table {
  return typeof node === "object" && node !== null;
}

// Both parsers build prototype-free tables, so indexing reads own keys only.
function child(table: Table | undefined, key: string): Node | undefined {
  return table?.[key];
}

function readColor(table: Table | undefined, key: string, path: string) {
  const value = child(table, key);
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new SchemeError(`colors.${path}.${key} must be a colour string`);
  }
  if (CELL_REFERENCES.has(value.trim().toLowerCase())) return undefined;
  return requireColor(value, `colors.${path}.${key}`);
}

function section(colors: Table, key: string): Table | undefined {
  const value = child(colors, key);
  return isTable(value) ? value : undefined;
}

/**
 * Reads `[colors.primary]`, `[colors.normal]`, `[colors.bright]`,
 * `[colors.cursor]` and `[colors.selection]`; dim colours, hints, search and
 * the rest of the config are ignored.
 */
function paletteFromDocument(doc: Table): ParsedScheme {
  const colors = child(doc, "colors");
  if (!isTable(colors)) {
    throw new SchemeError("No Alacritty colors section found");
  }
  const palette: SchemePalette = emptyPalette();
  const primary = section(colors, "primary");
  palette.background = readColor(primary, "background", "primary");
  palette.foreground = readColor(primary, "foreground", "primary");
  const cursor = section(colors, "cursor");
  palette.cursor = readColor(cursor, "cursor", "cursor");
  palette.cursorText = readColor(cursor, "text", "cursor");
  const selection = section(colors, "selection");
  palette.selectionBackground = readColor(selection, "background", "selection");
  palette.selectionForeground = readColor(selection, "text", "selection");
  const normal = section(colors, "normal");
  const bright = section(colors, "bright");
  ANSI_NAMES.forEach((name, i) => {
    palette.ansi[i] = readColor(normal, name, "normal");
    palette.ansi[i + 8] = readColor(bright, name, "bright");
  });
  if (!hasAnyColor(palette)) {
    throw new SchemeError(
      "No terminal colours found in the Alacritty colors section",
    );
  }
  return { palettes: [palette] };
}

export function parseAlacrittyToml(text: string): ParsedScheme {
  return paletteFromDocument(parseMinimalToml(text));
}

/** Alacritty's YAML config, used before 0.13 and still common in theme repos. */
export function parseAlacrittyYaml(text: string): ParsedScheme {
  return paletteFromDocument(parseMinimalYaml(text));
}
