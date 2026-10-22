import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { IS_MAC } from "@/lib/platform";

/**
 * OpenType features for the terminal font, written as Ghostty's `font-feature`
 * takes them (HarfBuzz's syntax): `zero`, `+ss01`, `-calt`, `cv01=2`,
 * `liga off`, separated by commas.
 *
 * Canvas text has no `font-feature-settings`, so features ride on the font
 * faces themselves: each family of the font stack is declared again under a
 * derived name through the `FontFace` API with `featureSettings`, and the stack
 * names the derived family instead. A family an `@font-face` rule declares
 * (the bundled JetBrains Mono, Terax Symbols) is copied from its rules; an
 * installed one (a Nerd Font) from its face files, which the native side finds
 * (`system_fonts.rs`) and the asset protocol serves when a face is first drawn
 * (`local()` cannot name faces reliably). Installed families are looked up
 * only ahead of the first declared one, the fonts the user chose, so the
 * fallbacks behind the bundled font are left alone.
 *
 * On macOS installed families take the same path with no features: WKWebView's
 * canvas does not see fonts the user installed and draws a fallback instead,
 * so a configured Nerd Font reaches the grid only through `FontFace`. Its own
 * fonts (under /System) it draws by name.
 */

const MAX_FONT_FEATURES = 32;

const TAG = /^[\x20-\x7e]{4}$/;

/**
 * The CSS `font-feature-settings` value for a feature list, or the reason it
 * is invalid. An empty list is `"normal"`.
 */
export function parseFontFeatures(
  input: string,
):
  | { readonly settings: string; readonly error: null }
  | { readonly settings: null; readonly error: string } {
  const entries = input
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) return { settings: "normal", error: null };
  if (entries.length > MAX_FONT_FEATURES) {
    return {
      settings: null,
      error: `At most ${MAX_FONT_FEATURES} features`,
    };
  }
  const settings = new Map<string, number>();
  for (const entry of entries) {
    const feature = parseFeature(entry);
    if (!feature) return { settings: null, error: `Not a feature: ${entry}` };
    // A later setting of the same feature wins, as in HarfBuzz.
    settings.delete(feature.tag);
    settings.set(feature.tag, feature.value);
  }
  return {
    settings: Array.from(
      settings,
      ([tag, value]) => `"${tag}" ${value}`,
    ).join(", "),
    error: null,
  };
}

function parseFeature(
  entry: string,
): { tag: string; value: number } | null {
  // `+tag`, `-tag`, `tag`, `tag=N`, `tag N`, `tag on|off`.
  const match = /^([+-]?)([^\s=]+)\s*(?:=\s*|\s+)?(\S*)$/.exec(entry);
  if (!match) return null;
  const [, sign, tag, rawValue] = match;
  if (!TAG.test(tag) || tag.includes('"') || tag.includes("\\")) return null;
  let value = sign === "-" ? 0 : 1;
  if (rawValue) {
    if (sign) return null;
    if (rawValue === "on") value = 1;
    else if (rawValue === "off") value = 0;
    else if (/^\d{1,5}$/.test(rawValue) && Number(rawValue) <= 0xffff)
      value = Number(rawValue);
    else return null;
  }
  return { tag, value };
}

/** The families of a CSS `font-family` stack, unquoted. */
export function fontStackFamilies(stack: string): string[] {
  const families: string[] = [];
  for (const part of splitStack(stack)) {
    const quoted = /^(["'])(.*)\1$/.exec(part);
    families.push(quoted ? quoted[2] : part);
  }
  return families;
}

function splitStack(stack: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of stack) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      current += char;
      quote = char;
    } else if (char === ",") {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter(Boolean);
}

/** One `@font-face` rule's descriptors, as `FontFace` takes them. */
export type DeclaredFace = {
  readonly source: string;
  readonly descriptors: FontFaceDescriptors;
};

/**
 * The faces `@font-face` rules declare for `family` (case-insensitive), their
 * relative URLs resolved against the stylesheet that holds them.
 */
export function declaredFaces(
  family: string,
  sheets: Iterable<CSSStyleSheet> = typeof document === "undefined"
    ? []
    : Array.from(document.styleSheets),
  baseUri: string = typeof document === "undefined"
    ? "http://localhost/"
    : document.baseURI,
): DeclaredFace[] {
  const wanted = family.toLowerCase();
  const faces: DeclaredFace[] = [];
  for (const sheet of sheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // A cross-origin sheet cannot be read.
    }
    const base = sheet.href ?? baseUri;
    for (const rule of Array.from(rules)) {
      if (!isFontFaceRule(rule)) continue;
      const style = rule.style;
      const name = fontStackFamilies(style.getPropertyValue("font-family"))[0];
      if (name?.toLowerCase() !== wanted) continue;
      const source = resolveSourceUrls(style.getPropertyValue("src"), base);
      if (!source) continue;
      const descriptor = (property: string) =>
        style.getPropertyValue(property).trim() || undefined;
      faces.push({
        source,
        descriptors: {
          style: descriptor("font-style"),
          weight: descriptor("font-weight"),
          stretch: descriptor("font-stretch"),
          unicodeRange: descriptor("unicode-range"),
          display: descriptor("font-display") as FontDisplay | undefined,
        },
      });
    }
  }
  return faces;
}

function isFontFaceRule(rule: CSSRule): rule is CSSFontFaceRule {
  return /^\s*@font-face\b/i.test(rule.cssText);
}

/** `src` with every `url(...)` made absolute against `base`. */
export function resolveSourceUrls(src: string, base: string): string {
  return src.replace(
    /url\(\s*(["']?)([^"')]+)\1\s*\)/g,
    (whole, _quote: string, url: string) => {
      try {
        return `url("${new URL(url, base).href}")`;
      } catch {
        return whole;
      }
    },
  );
}

const derived = new Map<string, string>();
/** Whether `@font-face` rules declare a family, by lowercase name. */
const declaredFamilies = new Map<string, boolean>();
/** Installed families: the derived name once declared, null when none. */
const installed = new Map<string, string | null | Promise<void>>();
/** Every derived family name, for `loadFeatureFamilies`. */
const derivedNames = new Set<string>();
let revision = 0;
const listeners = new Set<() => void>();

/** CSS generic families: never fonts of their own. */
const GENERIC = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-monospace",
  "ui-serif",
  "ui-sans-serif",
  "ui-rounded",
  "emoji",
  "math",
  "fangsong",
]);

/** One face of an installed family (`system_fonts.rs`). */
type InstalledFace = {
  readonly path: string;
  readonly weight: number;
  readonly style: "normal" | "italic" | "oblique";
  /** CSS percentage. */
  readonly stretch: number;
};

/**
 * Bumps when an installed family's derived faces are declared, so a stack
 * computed before then (`withFontFeatures`) is computed again.
 */
export function fontFeaturesRevision(): number {
  return revision;
}

export function subscribeFontFeatures(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * `stack` with the feature list `features` (the preference's text) applied,
 * computed again once an installed family's faces are declared.
 */
export function useFontFeatureStack(stack: string, features: string): string {
  useSyncExternalStore(subscribeFontFeatures, fontFeaturesRevision);
  return withFontFeatures(
    stack,
    parseFontFeatures(features).settings ?? "normal",
  );
}

/**
 * `stack` with its families declared again with `settings` (a
 * `parseFontFeatures` value) under derived names, which it names instead.
 * With `"normal"` only installed families are, and only when
 * `installedFromFiles` (macOS); otherwise the stack is returned as it is. An
 * installed family is looked up the first time it is seen and stays as named
 * until its faces are declared (`fontFeaturesRevision`).
 */
export function withFontFeatures(
  stack: string,
  settings: string,
  installedFromFiles: boolean = IS_MAC,
): string {
  const plain = settings === "normal";
  if ((plain && !installedFromFiles) || typeof FontFace === "undefined") {
    return stack;
  }
  let changed = false;
  let chosen = true;
  const families = splitStack(stack).map((part) => {
    const name = fontStackFamilies(part)[0];
    if (!name || (part === name && GENERIC.has(name.toLowerCase()))) {
      return part;
    }
    let declared: string | null = null;
    if (plain) {
      // A declared family draws as it is, and ends the installed lookups.
      if (chosen && isDeclared(name)) chosen = false;
    } else {
      declared = deriveFamily(name, settings);
      if (declared) chosen = false;
    }
    const derivedName =
      declared ?? (chosen ? installedFamily(name, settings) : null);
    if (!derivedName) return part;
    changed = true;
    return `"${derivedName}"`;
  });
  return changed ? families.join(", ") : stack;
}

function isDeclared(family: string): boolean {
  const key = family.toLowerCase();
  let known = declaredFamilies.get(key);
  if (known === undefined) {
    known = declaredFaces(family).length > 0;
    declaredFamilies.set(key, known);
  }
  return known;
}

/**
 * Whether a face is one of macOS's own fonts, which WKWebView draws by name:
 * only fonts the user installed need their files declared.
 */
function isSystemFace(path: string): boolean {
  return path.startsWith("/System/");
}

function derivedFamilyName(family: string): string {
  return `${family} (Terax features ${derivedNames.size + 1})`;
}

function installedFamily(family: string, settings: string): string | null {
  const key = `${family.toLowerCase()}\u0000${settings}`;
  const known = installed.get(key);
  if (typeof known === "string") return known;
  if (known === undefined) {
    installed.set(key, declareInstalled(family, settings, key));
  }
  return null;
}

async function declareInstalled(
  family: string,
  settings: string,
  key: string,
): Promise<void> {
  let faces: InstalledFace[] = [];
  try {
    faces = await invoke<InstalledFace[]>("system_font_faces", { family });
  } catch {
    /* not in the app, or the lookup failed: draw without features */
  }
  if (settings === "normal" && faces.every((face) => isSystemFace(face.path))) {
    faces = [];
  }
  if (faces.length === 0) {
    installed.set(key, null);
    return;
  }
  const name = derivedFamilyName(family);
  for (const face of faces) {
    // Each face loads from its file the first time it is drawn.
    document.fonts.add(
      new FontFace(name, `url("${convertFileSrc(face.path)}")`, {
        weight: String(face.weight),
        style: face.style,
        stretch: `${face.stretch}%`,
        featureSettings: settings,
      }),
    );
  }
  derivedNames.add(name);
  installed.set(key, name);
  revision += 1;
  for (const listener of listeners) listener();
}

function deriveFamily(family: string, settings: string): string | null {
  const key = `${family.toLowerCase()}\u0000${settings}`;
  const known = derived.get(key);
  if (known !== undefined) return known || null;
  const faces = declaredFaces(family);
  if (faces.length === 0) {
    derived.set(key, "");
    return null;
  }
  const name = derivedFamilyName(family);
  for (const face of faces) {
    // Loads on first use like the rule it copies (unicode-range segments).
    document.fonts.add(
      new FontFace(name, face.source, {
        ...face.descriptors,
        featureSettings: settings,
      }),
    );
  }
  derived.set(key, name);
  derivedNames.add(name);
  return name;
}

/**
 * Loads the regular and italic faces of the derived families in `stack`, as
 * `ensureMonoFontsLoaded` does for the bundled font, so cells are measured
 * with them.
 */
export async function loadFeatureFamilies(stack: string): Promise<void> {
  if (typeof document === "undefined" || !document.fonts?.load) return;
  const names = fontStackFamilies(stack).filter((name) =>
    derivedNames.has(name),
  );
  await Promise.allSettled(
    names.flatMap((name) => [
      document.fonts.load(`400 14px "${name}"`),
      document.fonts.load(`italic 400 14px "${name}"`),
    ]),
  );
}
