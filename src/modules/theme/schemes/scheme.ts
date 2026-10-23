import type {
  TerminalPalette,
  Theme,
  ThemeColors,
  ThemeMode,
  ThemeVariant,
} from "../types";
import {
  contrastRatio,
  hexToRgb,
  isDarkColor,
  mixHex,
  mixRgb,
  parseHexColor,
  rgbaCss,
} from "./color";

/**
 * One terminal palette as a source file spells it. Every colour is a
 * normalised `#rrggbb`; a key the file leaves out stays undefined and is filled
 * in by `completePalette`.
 */
export type SchemePalette = {
  mode?: ThemeMode;
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorText?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  /** Sixteen slots: normal 0-7, bright 8-15. */
  ansi: (string | undefined)[];
};

/** A scheme holds one palette, or two when the source declares light and dark. */
export type ParsedScheme = {
  name?: string;
  palettes: SchemePalette[];
};

export type CompletePalette = {
  background: string;
  foreground: string;
  cursor: string;
  cursorText: string;
  selection: string;
  ansi: NonNullable<TerminalPalette["ansi"]>;
};

/** A parse or validation failure with a message fit to show the user. */
export class SchemeError extends Error {
  override name = "SchemeError";
}

export const ANSI_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
] as const;

export const ANSI_SLOTS = 16;

/** Ghostty's defaults (`src/terminal/color.zig`, `src/config/Config.zig`). */
export const GHOSTTY_BACKGROUND = "#282c34";
const GHOSTTY_FOREGROUND = "#ffffff";
export const GHOSTTY_PALETTE: readonly string[] = [
  "#1d1f21",
  "#cc6666",
  "#b5bd68",
  "#f0c674",
  "#81a2be",
  "#b294bb",
  "#8abeb7",
  "#c5c8c6",
  "#666666",
  "#d54e53",
  "#b9ca4a",
  "#e7c547",
  "#7aa6da",
  "#c397d8",
  "#70c0b1",
  "#eaeaea",
];

const MIN_SELECTION_CONTRAST = 3;
const TRANSLUCENT_SELECTION_CONTRAST = 4.5;
const MIN_SELECTION_ALPHA = 0.2;
const DEFAULT_SELECTION_ALPHA = 0.25;
const MIN_ACCENT_CONTRAST = 3;
const MIN_MUTED_TEXT_CONTRAST = 4.5;

export function emptyPalette(mode?: ThemeMode): SchemePalette {
  const palette: SchemePalette = {
    ansi: new Array(ANSI_SLOTS).fill(undefined),
  };
  if (mode) palette.mode = mode;
  return palette;
}

export function hasAnyColor(palette: SchemePalette): boolean {
  return (
    palette.background !== undefined ||
    palette.foreground !== undefined ||
    palette.cursor !== undefined ||
    palette.cursorText !== undefined ||
    palette.selectionBackground !== undefined ||
    palette.selectionForeground !== undefined ||
    palette.ansi.some((c) => c !== undefined)
  );
}

/** Parses a colour value or throws a SchemeError naming where it came from. */
export function requireColor(raw: string, where: string): string {
  const color = parseHexColor(raw);
  if (color) return color;
  const shown = raw.length > 32 ? `${raw.slice(0, 32)}...` : raw;
  throw new SchemeError(`${where}: "${shown}" is not a hex colour`);
}

/**
 * Fills every key a scheme left out. A missing bright colour repeats its normal
 * colour and the other way round (partial schemes usually declare one half);
 * with neither, Ghostty's default palette entry applies. A missing foreground
 * is Ghostty's white, or black on a light background, so it stays readable.
 */
export function completePalette(palette: SchemePalette): CompletePalette {
  const ansi = Array.from({ length: ANSI_SLOTS }, (_, i) => {
    const partner = i < 8 ? i + 8 : i - 8;
    return palette.ansi[i] ?? palette.ansi[partner] ?? GHOSTTY_PALETTE[i];
  }) as unknown as CompletePalette["ansi"];
  const background = palette.background ?? GHOSTTY_BACKGROUND;
  const foreground =
    palette.foreground ??
    (isDarkColor(background) ? GHOSTTY_FOREGROUND : "#000000");
  return {
    background,
    foreground,
    cursor: palette.cursor ?? foreground,
    cursorText: palette.cursorText ?? background,
    selection: selectionColor(
      palette.selectionBackground,
      background,
      foreground,
    ),
    ansi,
  };
}

/**
 * Oarlock paints a selection over the cells and keeps each cell's own text
 * colour; it has no selection foreground. A scheme that relies on one (GitHub
 * Dark selects with its foreground colour and inverts the text) would hide the
 * selected text. A selection that default text stays readable on is kept;
 * otherwise it turns translucent, as opaque as AA contrast for default text
 * allows.
 */
export function selectionColor(
  selection: string | undefined,
  background: string,
  foreground: string,
): string {
  const fg = hexToRgb(foreground);
  if (selection === undefined || selection === background) {
    return rgbaCss(fg, DEFAULT_SELECTION_ALPHA);
  }
  const sel = hexToRgb(selection);
  if (contrastRatio(fg, sel) >= MIN_SELECTION_CONTRAST) return selection;
  const bg = hexToRgb(background);
  for (let step = 18; step / 20 > MIN_SELECTION_ALPHA; step--) {
    const alpha = step / 20;
    const blended = mixRgb(bg, sel, alpha);
    if (contrastRatio(fg, blended) >= TRANSLUCENT_SELECTION_CONTRAST) {
      return rgbaCss(sel, alpha);
    }
  }
  return rgbaCss(sel, MIN_SELECTION_ALPHA);
}

/**
 * The first candidate that stands out from the background; failing that, the
 * first one blended towards the foreground until it does, so the hue survives.
 */
function readableAccent(
  candidates: readonly string[],
  background: string,
  foreground: string,
): string {
  const bg = hexToRgb(background);
  const readable = (c: string) =>
    contrastRatio(hexToRgb(c), bg) >= MIN_ACCENT_CONTRAST;
  const found = candidates.find(readable);
  if (found) return found;
  for (let step = 1; step < 10; step++) {
    const blended = mixHex(candidates[0], foreground, step / 10);
    if (readable(blended)) return blended;
  }
  return foreground;
}

function mostReadable(background: string, candidates: readonly string[]) {
  const bg = hexToRgb(background);
  let best = candidates[0];
  let bestRatio = -1;
  for (const c of candidates) {
    const ratio = contrastRatio(hexToRgb(c), bg);
    if (ratio > bestRatio) {
      best = c;
      bestRatio = ratio;
    }
  }
  return best;
}

/** The dimmest blend of foreground into background that still reads as text. */
function mutedText(background: string, foreground: string): string {
  const bg = hexToRgb(background);
  for (let step = 12; step < 20; step++) {
    const muted = mixHex(background, foreground, step / 20);
    if (contrastRatio(hexToRgb(muted), bg) >= MIN_MUTED_TEXT_CONTRAST) {
      return muted;
    }
  }
  return foreground;
}

/**
 * Derives the app chrome from a terminal palette, so the window around the
 * terminal matches it the way it would in Ghostty: panes share the terminal
 * background, surfaces step towards the foreground, blue is the accent and red
 * the destructive colour, each swapped for its bright twin (or nudged towards
 * the foreground) when it would not stand out from the background.
 */
export function deriveUiColors(palette: CompletePalette): ThemeColors {
  const { background, foreground, ansi } = palette;
  const fg = hexToRgb(foreground);
  const surface = mixHex(background, foreground, 0.05);
  const raised = mixHex(background, foreground, 0.1);
  const primary = readableAccent([ansi[4], ansi[12]], background, foreground);
  const primaryForeground = mostReadable(primary, [background, foreground]);
  const destructive = readableAccent(
    [ansi[1], ansi[9]],
    background,
    foreground,
  );
  const mutedForeground = mutedText(background, foreground);
  const border = rgbaCss(fg, 0.1);
  const input = rgbaCss(fg, 0.14);
  return {
    background,
    foreground,
    card: surface,
    cardForeground: foreground,
    popover: surface,
    popoverForeground: foreground,
    primary,
    primaryForeground,
    secondary: raised,
    secondaryForeground: foreground,
    muted: raised,
    mutedForeground,
    accent: raised,
    accentForeground: foreground,
    destructive,
    border,
    input,
    ring: primary,
    sidebar: surface,
    sidebarForeground: foreground,
    sidebarPrimary: primary,
    sidebarPrimaryForeground: primaryForeground,
    sidebarAccent: raised,
    sidebarAccentForeground: foreground,
    sidebarBorder: border,
    sidebarRing: primary,
  };
}

function paletteToVariant(palette: CompletePalette): ThemeVariant {
  return {
    colors: deriveUiColors(palette),
    terminal: {
      background: palette.background,
      foreground: palette.foreground,
      cursor: palette.cursor,
      cursorAccent: palette.cursorText,
      selection: palette.selection,
      ansi: palette.ansi,
    },
  };
}

/**
 * Turns a parsed scheme into an Oarlock theme. Each palette becomes the variant
 * its declared mode names, or the one its background reads as; when two
 * palettes land on the same mode the first wins.
 */
export function schemeToTheme(
  scheme: ParsedScheme,
  meta: { id: string; name: string; description?: string },
): Theme {
  const variants: Theme["variants"] = {};
  for (const palette of scheme.palettes) {
    const complete = completePalette(palette);
    const mode =
      palette.mode ?? (isDarkColor(complete.background) ? "dark" : "light");
    variants[mode] ??= paletteToVariant(complete);
  }
  if (!variants.dark && !variants.light) {
    throw new SchemeError("No terminal colours found");
  }
  const theme: Theme = { id: meta.id, name: meta.name, variants };
  if (meta.description) theme.description = meta.description;
  return theme;
}
