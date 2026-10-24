import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseItermColors } from "./iterm";
import { parsePlist } from "./plist";

function plist(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>`;
}

function color(key: string, r: number, g: number, b: number, space?: string) {
  return `<key>${key}</key>
<dict>
  <key>Alpha Component</key><real>1</real>
  <key>Red Component</key><real>${r}</real>
  <key>Green Component</key><real>${g}</real>
  <key>Blue Component</key><real>${b}</real>
  ${space === undefined ? "" : `<key>Color Space</key><string>${space}</string>`}
</dict>`;
}

describe("parseItermColors", () => {
  it("reads an upstream .itermcolors file", () => {
    const xml = readFileSync(
      new URL("./__fixtures__/OneHalfDark.itermcolors", import.meta.url),
      "utf8",
    );
    const { palettes } = parseItermColors(xml);
    expect(palettes).toHaveLength(1);
    const [p] = palettes;
    expect(p.mode).toBeUndefined();
    expect(p.background).toBe("#282c34");
    expect(p.foreground).toBe("#dcdfe4");
    expect(p.cursor).toBe("#a3b3cc");
    expect(p.selectionBackground).toBe("#474e5d");
    expect(p.ansi).toEqual([
      "#282c34", "#e06c75", "#98c379", "#e5c07b",
      "#61afef", "#c678dd", "#56b6c2", "#dcdfe4",
      "#282c34", "#e06c75", "#98c379", "#e5c07b",
      "#61afef", "#c678dd", "#56b6c2", "#dcdfe4",
    ]);
  });

  it("converts Display P3 and takes other colour spaces as sRGB", () => {
    const { palettes } = parseItermColors(
      plist(
        [
          color("Background Color", 0, 0, 0, "Calibrated"),
          color("Foreground Color", 1, 1, 1),
          color("Ansi 1 Color", 1, 0, 0, "P3"),
          color("Ansi 2 Color", 0.5, 0.5, 0.5, "P3"),
          color("Ansi 4 Color", 0.2, 0.4, 0.6, "sRGB"),
          color("Ansi 5 Color", 1.2, -0.1, 0.5, "Device"),
        ].join("\n"),
      ),
    );
    const [p] = palettes;
    expect(p.background).toBe("#000000");
    expect(p.foreground).toBe("#ffffff");
    expect(p.ansi[1]).toBe("#ff0000");
    // The same matrix as the converter behind Ghostty's copies, rounding included.
    expect(p.ansi[2]).toBe("#807f7f");
    expect(p.ansi[4]).toBe("#336699");
    expect(p.ansi[5]).toBe("#ff0080");
  });

  it("maps a P3 colour outside sRGB into gamut", () => {
    const { palettes } = parseItermColors(
      plist(color("Ansi 2 Color", 0.2, 0.8, 0.3, "P3")),
    );
    expect(palettes[0].ansi[2]).toMatch(/^#[0-9a-f]{6}$/);
    expect(palettes[0].ansi[2]).not.toBe("#33cc4d");
  });

  it("splits separate light and dark colours into two palettes", () => {
    const { palettes } = parseItermColors(
      plist(
        [
          color("Ansi 1 Color", 1, 0, 0),
          color("Background Color (Dark)", 0, 0, 0),
          color("Background Color (Light)", 1, 1, 1),
          color("Ansi 1 Color (Light)", 0.5, 0, 0),
        ].join("\n"),
      ),
    );
    expect(palettes.map((p) => p.mode)).toEqual(["dark", "light"]);
    expect(palettes[0].background).toBe("#000000");
    expect(palettes[0].ansi[1]).toBe("#ff0000");
    expect(palettes[1].background).toBe("#ffffff");
    expect(palettes[1].ansi[1]).toBe("#800000");
  });

  it("reports a colour without components", () => {
    expect(() =>
      parseItermColors(
        plist(
          "<key>Ansi 3 Color</key><dict><key>Red Component</key><real>1</real></dict>",
        ),
      ),
    ).toThrow("Ansi 3 Color: missing Green Component");
    expect(() =>
      parseItermColors(plist("<key>Ansi 3 Color</key><string>red</string>")),
    ).toThrow("Ansi 3 Color must be a colour dictionary");
  });

  it("rejects property lists that are not colour schemes", () => {
    expect(() =>
      parseItermColors(plist("<key>Name</key><string>x</string>")),
    ).toThrow("No terminal colours found");
    expect(() =>
      parseItermColors("<plist><array><string>a</string></array></plist>"),
    ).toThrow("root is not a dictionary");
  });
});

describe("parsePlist", () => {
  it("parses scalars, arrays, entities and self-closing elements", () => {
    expect(
      parsePlist(`<plist><dict>
        <!-- a comment -->
        <key>a&amp;b</key><string>&lt;x&gt; &#65;&#x42;</string>
        <key>n</key><integer>-3</integer>
        <key>t</key><true/>
        <key>f</key><false/>
        <key>e</key><string/>
        <key>d</key><dict/>
        <key>list</key><array><real>1.5</real><array/></array>
      </dict></plist>`),
    ).toEqual({
      "a&b": "<x> AB",
      n: -3,
      t: true,
      f: false,
      e: "",
      d: {},
      list: [1.5, []],
    });
  });

  it("treats a __proto__ key as data", () => {
    const value = parsePlist(
      "<dict><key>__proto__</key><string>x</string></dict>",
    ) as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("rejects malformed documents with a clear error", () => {
    const cases: [string, string][] = [
      ["<dict><key>a</key>", "Invalid property list"],
      ["<dict><key>a</key><real>abc</real></dict>", '"abc" is not a number'],
      ["<dict><string>a</string></dict>", "expected <key>"],
      ["<dict><key>a</key><blob/></dict>", "unsupported element <blob>"],
      ["<plist><dict></plist>", "expected <key>"],
      ["<!-- never closed", 'missing "-->"'],
      ["not xml", "expected an element"],
      ["<plist/>", "the property list is empty"],
    ];
    for (const [xml, message] of cases) {
      expect(() => parsePlist(xml)).toThrow(message);
    }
  });

  it("refuses absurd nesting instead of overflowing the stack", () => {
    const deep = `${"<array>".repeat(40)}${"</array>".repeat(40)}`;
    expect(() => parsePlist(deep)).toThrow("nested too deeply");
  });
});
