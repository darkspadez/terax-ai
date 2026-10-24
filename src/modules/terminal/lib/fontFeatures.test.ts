import { afterEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  invoke: vi.fn(async (): Promise<unknown> => []),
  convertFileSrc: (path: string) => `asset://localhost${path}`,
}));
vi.mock("@tauri-apps/api/core", () => core);

import {
  declaredFaces,
  fontFeaturesRevision,
  fontStackFamilies,
  parseFontFeatures,
  resolveSourceUrls,
  subscribeFontFeatures,
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
      '"JetBrains Mono (Oarlock features 1)", "Fira Code", monospace',
    );
    expect(added).toEqual([
      {
        family: "JetBrains Mono (Oarlock features 1)",
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

  it("declares an installed family's faces from their files, ahead of the bundled font only", async () => {
    const added: { family: string; source: string; descriptors: FontFaceDescriptors }[] = [];
    vi.stubGlobal(
      "FontFace",
      class {
        constructor(
          readonly family: string,
          readonly source: string,
          readonly descriptors: FontFaceDescriptors,
        ) {
          added.push({ family, source, descriptors });
        }
      },
    );
    vi.stubGlobal("document", {
      baseURI: "https://app.test/",
      styleSheets: [
        sheet("https://app.test/assets/index.css", [
          { ...JETBRAINS, "font-family": '"Bundled Mono"' },
        ]),
      ],
      fonts: { add: () => undefined },
    });
    core.invoke.mockImplementation(async () => [
      { path: "/fonts/Nerd-Regular.ttf", weight: 400, style: "normal", stretch: 100 },
      { path: "/fonts/Nerd-BoldItalic.ttf", weight: 700, style: "italic", stretch: 100 },
    ]);
    const changed = vi.fn();
    const stop = subscribeFontFeatures(changed);
    const before = fontFeaturesRevision();
    const stack = '"Nerd Mono", "Bundled Mono", Menlo, monospace';
    const settings = '"ss01" 1';

    // Until the lookup answers the installed font draws as named.
    const first = withFontFeatures(stack, settings);
    expect(first).toMatch(/^"Nerd Mono", "Bundled Mono \(Oarlock features \d+\)", Menlo, monospace$/);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    stop();
    expect(fontFeaturesRevision()).toBe(before + 1);
    // Only the font ahead of the bundled one is looked up.
    expect(core.invoke.mock.calls).toEqual([
      ["system_font_faces", { family: "Nerd Mono" }],
    ]);

    const second = withFontFeatures(stack, settings);
    const nerd = /^"(Nerd Mono \(Oarlock features \d+\))"/.exec(second)?.[1];
    expect(nerd).toBeDefined();
    const faces = added.filter((face) => face.family === nerd);
    expect(faces).toEqual([
      {
        family: nerd,
        source: 'url("asset://localhost/fonts/Nerd-Regular.ttf")',
        descriptors: { weight: "400", style: "normal", stretch: "100%", featureSettings: settings },
      },
      {
        family: nerd,
        source: 'url("asset://localhost/fonts/Nerd-BoldItalic.ttf")',
        descriptors: { weight: "700", style: "italic", stretch: "100%", featureSettings: settings },
      },
    ]);
    // Looked up once per family and feature list.
    expect(core.invoke).toHaveBeenCalledOnce();
  });

  it("on macOS declares an installed family from its files with no features", async () => {
    const added: { family: string; source: string; descriptors: FontFaceDescriptors }[] = [];
    vi.stubGlobal(
      "FontFace",
      class {
        constructor(
          readonly family: string,
          readonly source: string,
          readonly descriptors: FontFaceDescriptors,
        ) {
          added.push({ family, source, descriptors });
        }
      },
    );
    vi.stubGlobal("document", {
      baseURI: "https://app.test/",
      styleSheets: [
        sheet("https://app.test/assets/index.css", [
          { ...JETBRAINS, "font-family": '"Plain Bundled"' },
        ]),
      ],
      fonts: { add: () => undefined },
    });
    core.invoke.mockReset();
    core.invoke.mockImplementation(async () => [
      { path: "/Users/me/Library/Fonts/Meslo-Regular.ttf", weight: 400, style: "normal", stretch: 100 },
    ]);
    const changed = vi.fn();
    const stop = subscribeFontFeatures(changed);
    const stack = '"Plain Nerd", "Plain Bundled", Menlo, monospace';

    // Elsewhere webviews draw installed fonts by name.
    expect(withFontFeatures(stack, "normal", false)).toBe(stack);
    expect(core.invoke).not.toHaveBeenCalled();

    expect(withFontFeatures(stack, "normal", true)).toBe(stack);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    stop();
    // Only the font ahead of the bundled one, which stays as it is.
    expect(core.invoke.mock.calls).toEqual([
      ["system_font_faces", { family: "Plain Nerd" }],
    ]);
    const plain = withFontFeatures(stack, "normal", true);
    const nerd = /^"(Plain Nerd \(Oarlock features \d+\))", "Plain Bundled", Menlo, monospace$/.exec(plain)?.[1];
    expect(nerd).toBeDefined();
    expect(added).toEqual([
      {
        family: nerd,
        source: 'url("asset://localhost/Users/me/Library/Fonts/Meslo-Regular.ttf")',
        descriptors: { weight: "400", style: "normal", stretch: "100%", featureSettings: "normal" },
      },
    ]);
  });

  it("leaves macOS's own fonts as named when there are no features", async () => {
    vi.stubGlobal("FontFace", class {});
    vi.stubGlobal("document", { baseURI: "https://app.test/", styleSheets: [], fonts: { add: () => undefined } });
    core.invoke.mockReset();
    core.invoke.mockImplementation(async () => [
      { path: "/System/Library/Fonts/Monaco.ttf", weight: 400, style: "normal", stretch: 100 },
    ]);
    expect(withFontFeatures("Monaco, monospace", "normal", true)).toBe("Monaco, monospace");
    await vi.waitFor(() => expect(core.invoke).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(withFontFeatures("Monaco, monospace", "normal", true)).toBe("Monaco, monospace");
  });

  it("leaves a family that is not installed as named", async () => {
    vi.stubGlobal("FontFace", class {});
    vi.stubGlobal("document", { baseURI: "https://app.test/", styleSheets: [], fonts: { add: () => undefined } });
    core.invoke.mockImplementation(async () => []);
    expect(withFontFeatures('"Missing Font", monospace', '"zero" 1')).toBe('"Missing Font", monospace');
    await vi.waitFor(() => expect(core.invoke).toHaveBeenCalled());
    await Promise.resolve();
    expect(withFontFeatures('"Missing Font", monospace', '"zero" 1')).toBe('"Missing Font", monospace');
  });
});
