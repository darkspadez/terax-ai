/**
 * OpenType features for the terminal font, written as Ghostty's `font-feature`
 * takes them (HarfBuzz's syntax): `zero`, `+ss01`, `-calt`, `cv01=2`,
 * `liga off`, separated by commas.
 *
 * Canvas text has no `font-feature-settings`, so features ride on the font
 * faces themselves: every family of the font stack declared by an `@font-face`
 * rule (the bundled JetBrains Mono and Terax Symbols) is declared again under a
 * derived name through the `FontFace` API with `featureSettings`, and the stack
 * names the derived family instead. Installed fonts cannot be declared again
 * reliably (`local()` matches face names, which differ per platform), so they
 * draw without features.
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

/**
 * `stack` with every `@font-face` family declared again with `settings`
 * (a `parseFontFeatures` value) under a derived name, which it names
 * instead. `"normal"` returns the stack as it is.
 */
export function withFontFeatures(stack: string, settings: string): string {
  if (settings === "normal" || typeof FontFace === "undefined") return stack;
  let changed = false;
  const families = splitStack(stack).map((part) => {
    const name = fontStackFamilies(part)[0];
    if (!name) return part;
    const derivedName = deriveFamily(name, settings);
    if (!derivedName) return part;
    changed = true;
    return `"${derivedName}"`;
  });
  return changed ? families.join(", ") : stack;
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
  const name = `${family} (Terax features ${derived.size + 1})`;
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
    Array.from(derived.values()).includes(name),
  );
  await Promise.allSettled(
    names.flatMap((name) => [
      document.fonts.load(`400 14px "${name}"`),
      document.fonts.load(`italic 400 14px "${name}"`),
    ]),
  );
}
