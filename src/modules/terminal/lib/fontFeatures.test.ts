import { afterEach, describe, expect, it, vi } from "vitest";
import {
  declaredFaces,
  fontStackFamilies,
  parseFontFeatures,
  resolveSourceUrls,
  withFontFeatures,
} from "./fontFeatures";

describe("font feature lists", () => {
  it("reads Ghostty's (HarfBuzz's) syntax into font-feature-settings", () => {
    expect(parseFontFeatures("")).toEqual({ settings: "normal", error: null });
    expect(
      parseFontFeatures("zero, +ss01, -calt, cv01=2, liga off, ss02 on, cv02 3")
        .settings,
    ).toBe(
      '"zero" 1, "ss01" 1, "calt" 0, "cv01" 2, "liga" 0, "ss02" 1, "cv02" 3',
    );
    // A later setting of a feature replaces the earlier one.
    expect(parseFontFeatures("calt, -calt").settings).toBe('"calt" 0');
    expect(parseFontFeatures(" zero \n ss01 ").settings).toBe(
      '"zero" 1, "ss01" 1',
    );
  });

  it("rejects what is not a feature", () => {
    for (const input of [
      "ze",
      "toolong",
      "-zero=1",
      "zero=x",
      "zero=70000",
      'ze"o',
      "zero maybe",
    ]) {
      expect(parseFontFeatures(input).error).not.toBeNull();
    }
    expect(parseFontFeatures(Array(33).fill("zero").join(",")).error).toBe(
      "At most 32 features",
    );
  });
});

describe("font stacks", () => {
  it("splits a stack into unquoted families", () => {
    expect(
      fontStackFamilies('"JetBrains Mono", \'A, B\', Menlo, monospace'),
    ).toEqual(["JetBrains Mono", "A, B", "Menlo", "monospace"]);
  });

  it("resolves a face's URLs against its stylesheet", () => {
    expect(
      resolveSourceUrls(
        "url('../fonts/a.woff2') format('woff2'), url(\"/b.woff2\"), local(X)",
        "https://app.test/assets/css/index.css",
      ),
    ).toBe(
      'url("https://app.test/assets/fonts/a.woff2") format(\'woff2\'), url("https://app.test/b.woff2"), local(X)',
    );
  });
});

/** A stylesheet of `@font-face` rules as the CSSOM reads them. */
function sheet(
  href: string | null,
  rules: Record<string, string>[],
): CSSStyleSheet {
  return {
    href,
    cssRules: rules.map((descriptors) => ({
      cssText: "@font-face { }",
      style: {
        getPropertyValue: (property: string) => descriptors[property] ?? "",
      },
    })),
  } as unknown as CSSStyleSheet;
}

const JETBRAINS = {
  "font-family": '"JetBrains Mono"',
  "font-style": "normal",
  "font-weight": "100 800",
  "font-display": "swap",
  src: 'url("../fonts/latin.woff2") format("woff2")',
  "unicode-range": "U+20-7E",
};

describe("declared faces", () => {
  it("collects a family's @font-face rules with their descriptors", () => {
    const faces = declaredFaces(
      "jetbrains mono",
      [
        sheet("https://app.test/assets/index.css", [
          JETBRAINS,
          { ...JETBRAINS, "font-family": "Other", src: "url(o.woff2)" },
        ]),
        // A sheet the page may not read is skipped.
        {
          get cssRules(): CSSRuleList {
            throw new Error("cross-origin");
          },
        } as unknown as CSSStyleSheet,
      ],
      "https://app.test/",
    );
    expect(faces).toEqual([
      {
        source: 'url("https://app.test/fonts/latin.woff2") format("woff2")',
        descriptors: {
          style: "normal",
          weight: "100 800",
          stretch: undefined,
          unicodeRange: "U+20-7E",
          display: "swap",
        },
      },
    ]);
  });
});

describe("feature families", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names a derived family carrying the features for each declared one", () => {
    const added: { family: string; source: string; settings?: string }[] = [];
    vi.stubGlobal(
      "FontFace",
      class {
        constructor(
          readonly family: string,
          readonly source: string,
          readonly descriptors: FontFaceDescriptors,
        ) {
          added.push({ family, source, settings: descriptors.featureSettings });
        }
      },
    );
    vi.stubGlobal("document", {
      baseURI: "https://app.test/",
      styleSheets: [sheet("https://app.test/assets/index.css", [JETBRAINS])],
      fonts: { add: () => undefined },
    });
    const stack = '"JetBrains Mono", "Fira Code", monospace';
    const settings = '"zero" 1';
    const featured = withFontFeatures(stack, settings);
    expect(featured).toBe(
      '"JetBrains Mono (Terax features 1)", "Fira Code", monospace',
    );
    expect(added).toEqual([
      {
        family: "JetBrains Mono (Terax features 1)",
        source: 'url("https://app.test/fonts/latin.woff2") format("woff2")',
        settings,
      },
    ]);
    // Derived once per family and feature list.
    expect(withFontFeatures(stack, settings)).toBe(featured);
    expect(added).toHaveLength(1);
    // Defaults, and stacks with no declared family, are left alone.
    expect(withFontFeatures(stack, "normal")).toBe(stack);
    expect(withFontFeatures("Menlo, monospace", settings)).toBe(
      "Menlo, monospace",
    );
  });
});
