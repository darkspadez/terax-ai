export type Rgb = readonly [number, number, number];

const HEX_RE = /^(?:#|0x)?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Normalises the hex spellings terminal configs use (`#rgb`, `#rrggbb`, bare
 * `rrggbb` as Ghostty accepts, `0xrrggbb` as Alacritty writes) to lowercase
 * `#rrggbb`. Anything else, named colours included, is null.
 */
export function parseHexColor(raw: string): string | null {
  const match = HEX_RE.exec(raw.trim());
  if (!match) return null;
  const digits = match[1].toLowerCase();
  if (digits.length === 6) return `#${digits}`;
  return `#${digits[0]}${digits[0]}${digits[1]}${digits[1]}${digits[2]}${digits[2]}`;
}

export function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

export function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((c) => clampByte(c).toString(16).padStart(2, "0")).join("")}`;
}

export function rgbaCss(rgb: Rgb, alpha: number): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 100) / 100;
  return `rgba(${rgb.map(clampByte).join(",")},${a})`;
}

/** `from` blended towards `to` by `amount` (0 keeps `from`). */
export function mixRgb(from: Rgb, to: Rgb, amount: number): Rgb {
  return [
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
  ];
}

export function mixHex(from: string, to: string, amount: number): string {
  return rgbToHex(mixRgb(hexToRgb(from), hexToRgb(to), amount));
}

function channelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2 relative luminance. */
function relativeLuminance(rgb: Rgb): number {
  return (
    0.2126 * channelToLinear(rgb[0]) +
    0.7152 * channelToLinear(rgb[1]) +
    0.0722 * channelToLinear(rgb[2])
  );
}

/** WCAG 2 contrast ratio, from 1 (identical) to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** A background reads as dark when white text contrasts with it more than black. */
export function isDarkColor(hex: string): boolean {
  const rgb = hexToRgb(hex);
  return contrastRatio(rgb, [255, 255, 255]) > contrastRatio(rgb, [0, 0, 0]);
}

function clampByte(channel: number): number {
  return Math.min(255, Math.max(0, Math.round(channel)));
}
