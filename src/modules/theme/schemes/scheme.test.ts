import { describe, expect, it } from "vitest";
import { validateTheme } from "../validateTheme";
import { contrastRatio, hexToRgb } from "./color";
import {
  completePalette,
  deriveUiColors,
  emptyPalette,
  GHOSTTY_BACKGROUND,
  GHOSTTY_PALETTE,
  type SchemePalette,
  SchemeError,
  schemeToTheme,
  selectionColor,
} from "./scheme";

function palette(over: Partial<SchemePalette> = {}): SchemePalette {
  return { ...emptyPalette(), ...over };
}

function contrast(a: string, b: string): number {
  return contrastRatio(hexToRgb(a), hexToRgb(b));
}

describe("completePalette", () => {
  it("fills a missing half of the palette from its twin, then from Ghostty", () => {
    const ansi = new Array(16).fill(undefined);
    ansi[1] = "#aa0000";
    ansi[10] = "#00bb00";
    const complete = completePalette(palette({ ansi }));
    expect(complete.ansi[1]).toBe("#aa0000");
    expect(complete.ansi[9]).toBe("#aa0000");
    expect(complete.ansi[2]).toBe("#00bb00");
    expect(complete.ansi[10]).toBe("#00bb00");
    expect(complete.ansi[0]).toBe(GHOSTTY_PALETTE[0]);
    expect(complete.ansi[15]).toBe(GHOSTTY_PALETTE[15]);
  });

  it("uses Ghostty's background and a readable foreground when absent", () => {
    expect(completePalette(palette()).background).toBe(GHOSTTY_BACKGROUND);
    expect(completePalette(palette()).foreground).toBe("#ffffff");
    expect(
      completePalette(palette({ background: "#fdf6e3" })).foreground,
    ).toBe("#000000");
  });

  it("derives the cursor from the foreground and its text from the background", () => {
    const complete = completePalette(
      palette({ background: "#101010", foreground: "#eeeeee" }),
    );
    expect(complete.cursor).toBe("#eeeeee");
    expect(complete.cursorText).toBe("#101010");
  });

  it("keeps declared cursor colours", () => {
    const complete = completePalette(
      palette({ cursor: "#ff0000", cursorText: "#00ff00" }),
    );
    expect(complete.cursor).toBe("#ff0000");
    expect(complete.cursorText).toBe("#00ff00");
  });
});

describe("selectionColor", () => {
  it("keeps a selection that default text stays readable on", () => {
    expect(selectionColor("#44475a", "#282a36", "#f8f8f2")).toBe("#44475a");
  });

  it("turns an inverting selection translucent until text reads on it", () => {
    const sel = selectionColor("#e6edf3", "#0d1117", "#e6edf3");
    expect(sel).toBe("rgba(230,237,243,0.4)");
  });

  it("never goes below a visible floor", () => {
    const sel = selectionColor("#ffffff", "#ffffff", "#fefefe");
    expect(sel).toMatch(/^rgba\(/);
    expect(selectionColor("#000000", "#000000", "#010101")).toBe(
      "rgba(1,1,1,0.25)",
    );
    expect(selectionColor("#888888", "#777777", "#888888")).toBe(
      "rgba(136,136,136,0.2)",
    );
  });

  it("falls back to a translucent foreground without a selection colour", () => {
    expect(selectionColor(undefined, "#000000", "#ffffff")).toBe(
      "rgba(255,255,255,0.25)",
    );
  });
});

describe("deriveUiColors", () => {
  it("keeps chrome readable against the terminal background", () => {
    const complete = completePalette(
      palette({
        background: "#f8f9fa",
        foreground: "#5c6166",
        ansi: [
          "#000000", "#ea6c6d", "#6cbf43", "#eca944",
          "#3199e1", "#9e75c7", "#46ba94", "#bababa",
          "#686868", "#f07171", "#86b300", "#f2ae49",
          "#399ee6", "#a37acc", "#4cbf99", "#d1d1d1",
        ],
      }),
    );
    const ui = deriveUiColors(complete);
    expect(ui.background).toBe("#f8f9fa");
    expect(ui.foreground).toBe("#5c6166");
    expect(contrast(ui.primary as string, "#f8f9fa")).toBeGreaterThanOrEqual(3);
    expect(contrast(ui.destructive as string, "#f8f9fa")).toBeGreaterThanOrEqual(3);
    expect(
      contrast(ui.mutedForeground as string, "#f8f9fa"),
    ).toBeGreaterThanOrEqual(4.5);
    expect(ui.card).not.toBe(ui.background);
  });

  it("prefers the scheme's own blue and red when they stand out", () => {
    const ui = deriveUiColors(completePalette(palette()));
    expect(ui.primary).toBe(GHOSTTY_PALETTE[4]);
    expect(ui.destructive).toBe(GHOSTTY_PALETTE[1]);
    expect(ui.primaryForeground).toBe(GHOSTTY_BACKGROUND);
  });
});

describe("schemeToTheme", () => {
  it("places a palette by its background and produces a valid theme", () => {
    const theme = schemeToTheme(
      { palettes: [palette({ background: "#fafafa", foreground: "#383a42" })] },
      { id: "one-light", name: "One Light", description: "Imported." },
    );
    expect(Object.keys(theme.variants)).toEqual(["light"]);
    expect(theme.variants.light?.terminal?.background).toBe("#fafafa");
    expect(theme.description).toBe("Imported.");
    expect(validateTheme(JSON.parse(JSON.stringify(theme)))).toEqual({
      ok: true,
      theme,
    });
  });

  it("honours declared modes and keeps the first palette per mode", () => {
    const theme = schemeToTheme(
      {
        palettes: [
          palette({ mode: "dark", background: "#ffffff" }),
          palette({ mode: "light", background: "#eeeeee" }),
          palette({ mode: "dark", background: "#000000" }),
        ],
      },
      { id: "dual", name: "Dual" },
    );
    expect(theme.variants.dark?.colors?.background).toBe("#ffffff");
    expect(theme.variants.light?.colors?.background).toBe("#eeeeee");
    expect(theme.description).toBeUndefined();
  });

  it("refuses a scheme without palettes", () => {
    expect(() =>
      schemeToTheme({ palettes: [] }, { id: "none", name: "None" }),
    ).toThrow(SchemeError);
  });
});
