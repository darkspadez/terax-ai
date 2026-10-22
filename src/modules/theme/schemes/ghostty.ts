import {
  ANSI_SLOTS,
  emptyPalette,
  hasAnyColor,
  type ParsedScheme,
  requireColor,
  SchemeError,
  type SchemePalette,
} from "./scheme";

type ColorField = Exclude<keyof SchemePalette, "ansi" | "mode">;

const FIELDS = new Map<string, ColorField>([
  ["background", "background"],
  ["foreground", "foreground"],
  ["cursor-color", "cursor"],
  ["cursor-text", "cursorText"],
  ["selection-background", "selectionBackground"],
  ["selection-foreground", "selectionForeground"],
]);

// Ghostty 1.2 lets these follow the cell under them; Terax has no equivalent,
// so they fall back like an unset key.
const CELL_REFERENCES = new Set(["cell-foreground", "cell-background"]);

const PALETTE_ENTRY_RE = /^(\d{1,3})\s*=\s*(.*)$/;
const MAX_PALETTE_INDEX = 255;

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1).trim()
    : value;
}

/**
 * Ghostty theme files and configs: `key = value` lines, whole-line `#`
 * comments, later lines overriding earlier ones and an empty value resetting a
 * key. Keys that are not colours (fonts, keybinds, `theme`) are ignored so a
 * full config imports too.
 */
export function parseGhosttyTheme(text: string): ParsedScheme {
  const palette = emptyPalette();
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) continue;
    const where = `Line ${i + 1}`;
    const eq = line.indexOf("=");
    if (eq <= 0) throw new SchemeError(`${where}: expected "key = value"`);
    const key = line.slice(0, eq).trim();
    const value = unquote(line.slice(eq + 1).trim());
    if (key === "palette") {
      if (value === "") continue;
      const entry = PALETTE_ENTRY_RE.exec(value);
      const index = entry ? Number(entry[1]) : Number.NaN;
      if (!entry || index > MAX_PALETTE_INDEX) {
        throw new SchemeError(
          `${where}: palette entries look like "palette = 0=#1d1f21"`,
        );
      }
      if (index < ANSI_SLOTS) {
        palette.ansi[index] = requireColor(
          entry[2],
          `${where} (palette ${index})`,
        );
      }
      continue;
    }
    const field = FIELDS.get(key);
    if (!field) continue;
    palette[field] =
      value === "" || CELL_REFERENCES.has(value)
        ? undefined
        : requireColor(value, `${where} (${key})`);
  }
  if (!hasAnyColor(palette)) {
    throw new SchemeError("No terminal colours found");
  }
  return { palettes: [palette] };
}
