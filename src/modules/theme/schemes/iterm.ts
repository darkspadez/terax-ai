import type { ThemeMode } from "../types";
import { rgbToHex } from "./color";
import { type PlistValue, parsePlist } from "./plist";
import {
  ANSI_SLOTS,
  emptyPalette,
  hasAnyColor,
  type ParsedScheme,
  SchemeError,
  type SchemePalette,
} from "./scheme";

type Dict = { [key: string]: PlistValue };
type ColorField = Exclude<keyof SchemePalette, "ansi" | "mode">;

const FIELDS: Record<string, ColorField> = {
  "Background Color": "background",
  "Foreground Color": "foreground",
  "Cursor Color": "cursor",
  "Cursor Text Color": "cursorText",
  "Selection Color": "selectionBackground",
  "Selected Text Color": "selectionForeground",
};

// iTerm2 3.5 exports separate light and dark colours with these suffixes when
// "Use separate colors for light and dark mode" is on.
const MODE_SUFFIX: Record<ThemeMode, string> = {
  dark: " (Dark)",
  light: " (Light)",
};

// Display P3 to sRGB in linear light, as the converter behind Ghostty's
// bundled themes (iTerm2-Color-Schemes `tools/gen.py`) applies it.
const P3_TO_SRGB = [
  [1.22494018, -0.2246988, -0.00012973],
  [-0.04205631, 1.04203282, -0.00000601],
  [-0.01963755, -0.07862814, 1.09826365],
] as const;

function isDict(value: PlistValue | undefined): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function srgbToLinear(c: number): number {
  return c < 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(c: number): number {
  return c < 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

function p3ToSrgb(rgb: readonly number[]): number[] {
  const linear = rgb.map(srgbToLinear);
  return P3_TO_SRGB.map((row) =>
    linearToSrgb(
      Math.min(
        1,
        Math.max(
          0,
          row[0] * linear[0] + row[1] * linear[1] + row[2] * linear[2],
        ),
      ),
    ),
  );
}

function component(color: Dict, name: string, where: string): number {
  const value = color[`${name} Component`];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SchemeError(`${where}: missing ${name} Component`);
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * Components are 0-1 floats. P3 is converted to sRGB; every other colour space
 * (sRGB, Calibrated, Device, none) is taken as sRGB, matching the conversion
 * Ghostty's bundled copies of these schemes went through.
 */
function readColor(value: PlistValue, where: string): string {
  if (!isDict(value))
    throw new SchemeError(`${where} must be a colour dictionary`);
  let rgb = [
    component(value, "Red", where),
    component(value, "Green", where),
    component(value, "Blue", where),
  ];
  const space = value["Color Space"];
  if (typeof space === "string" && space.trim() === "P3") rgb = p3ToSrgb(rgb);
  return rgbToHex([rgb[0] * 255, rgb[1] * 255, rgb[2] * 255]);
}

function readPalette(
  root: Dict,
  suffix: string,
  mode?: ThemeMode,
): SchemePalette {
  const palette = emptyPalette(mode);
  for (let i = 0; i < ANSI_SLOTS; i++) {
    const key = `Ansi ${i} Color${suffix}`;
    if (root[key] !== undefined) palette.ansi[i] = readColor(root[key], key);
  }
  for (const [name, field] of Object.entries(FIELDS)) {
    const key = `${name}${suffix}`;
    if (root[key] !== undefined) palette[field] = readColor(root[key], key);
  }
  return palette;
}

function overlay(base: SchemePalette, top: SchemePalette): SchemePalette {
  const merged: SchemePalette = { ...base, ansi: [...base.ansi] };
  for (const [key, value] of Object.entries(top)) {
    if (key !== "ansi" && value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  top.ansi.forEach((color, i) => {
    if (color !== undefined) merged.ansi[i] = color;
  });
  return merged;
}

export function parseItermColors(xml: string): ParsedScheme {
  const root = parsePlist(xml);
  if (!isDict(root)) {
    throw new SchemeError(
      "Not an iTerm2 colour scheme: the root is not a dictionary",
    );
  }
  const plain = readPalette(root, "");
  const palettes: SchemePalette[] = [];
  for (const mode of ["dark", "light"] as const) {
    const specific = readPalette(root, MODE_SUFFIX[mode], mode);
    if (hasAnyColor(specific)) palettes.push(overlay(plain, specific));
  }
  if (palettes.length === 0 && hasAnyColor(plain)) palettes.push(plain);
  if (palettes.length === 0) {
    throw new SchemeError("No terminal colours found in the iTerm2 scheme");
  }
  return { palettes };
}
