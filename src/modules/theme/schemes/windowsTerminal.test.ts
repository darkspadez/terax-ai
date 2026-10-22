import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseJsonc, parseWindowsTerminalSchemes } from "./windowsTerminal";

describe("parseWindowsTerminalSchemes", () => {
  it("reads an upstream scheme file", () => {
    const text = readFileSync(
      new URL("./__fixtures__/flexoki-dark.json", import.meta.url),
      "utf8",
    );
    const [scheme] = parseWindowsTerminalSchemes(parseJsonc(text));
    const [p] = scheme.palettes;
    expect(scheme.name).toBe("Flexoki Dark");
    expect(p.background).toBe("#100f0f");
    expect(p.foreground).toBe("#e6e4d9");
    expect(p.cursor).toBe("#dad8ce");
    expect(p.selectionBackground).toBe("#cecdc3");
    expect(p.ansi).toEqual([
      "#100f0f", "#af3029", "#66800b", "#c19c00",
      "#205ea6", "#5e409d", "#24837b", "#f2f0e5",
      "#575653", "#d14d41", "#879a39", "#d0a215",
      "#4385be", "#8b7ec8", "#3aa99f", "#fffcf0",
    ]);
  });

  it("imports every scheme of a settings.json with comments and trailing commas", () => {
    const text = `// Windows Terminal settings
{
  "$schema": "https://aka.ms/terminal-profiles-schema",
  /* user schemes */
  "schemes": [
    { "name": "One", "background": "#000", "magenta": "#ff00ff", },
    { "name": "Not a scheme", "fontFace": "Cascadia // Code" },
    { "background": "#FFFFFF", "brightMagenta": "#aa00aa", "purple": "#800080" },
  ],
}`;
    const schemes = parseWindowsTerminalSchemes(parseJsonc(text));
    expect(schemes).toHaveLength(2);
    expect(schemes[0].name).toBe("One");
    expect(schemes[0].palettes[0].background).toBe("#000000");
    expect(schemes[0].palettes[0].ansi[5]).toBe("#ff00ff");
    expect(schemes[1].name).toBeUndefined();
    expect(schemes[1].palettes[0].ansi[5]).toBe("#800080");
    expect(schemes[1].palettes[0].ansi[13]).toBe("#aa00aa");
  });

  it("accepts a bare array of schemes", () => {
    const schemes = parseWindowsTerminalSchemes([
      { name: "A", black: "#010101" },
      { name: "B", brightWhite: "#fefefe" },
    ]);
    expect(schemes.map((s) => s.name)).toEqual(["A", "B"]);
    expect(schemes[1].palettes[0].ansi[15]).toBe("#fefefe");
  });

  it("names the scheme and key of an invalid colour", () => {
    expect(() =>
      parseWindowsTerminalSchemes({ name: "Broken", red: "crimson" }),
    ).toThrow('Scheme "Broken": "red": "crimson" is not a hex colour');
    expect(() => parseWindowsTerminalSchemes([{ blue: 3 }])).toThrow(
      'Scheme 1: "blue" must be a colour string',
    );
  });

  it("rejects JSON that holds no scheme", () => {
    for (const doc of [{ profiles: {} }, [], "text", null, { schemes: [] }]) {
      expect(() => parseWindowsTerminalSchemes(doc)).toThrow(
        "No Windows Terminal colour scheme found",
      );
    }
  });
});

describe("parseJsonc", () => {
  it("keeps comment markers and commas inside strings", () => {
    expect(
      parseJsonc('{"a": "// not, a comment ]", "b": "/* x */",}'),
    ).toEqual({ a: "// not, a comment ]", b: "/* x */" });
    expect(parseJsonc('["a\\"", /* c */ 1,]')).toEqual(['a"', 1]);
  });

  it("reports invalid JSON", () => {
    expect(() => parseJsonc("{ name: 1 }")).toThrow(/^Invalid JSON: /);
  });
});
