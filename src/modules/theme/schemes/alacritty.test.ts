import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAlacrittyToml, parseAlacrittyYaml } from "./alacritty";
import { parseMinimalToml } from "./minimalToml";
import { parseMinimalYaml } from "./minimalYaml";

describe("parseAlacrittyToml", () => {
  it("reads an upstream Alacritty theme with 0x colours", () => {
    const text = readFileSync(
      new URL("./__fixtures__/flexoki-dark.toml", import.meta.url),
      "utf8",
    );
    const [p] = parseAlacrittyToml(text).palettes;
    expect(p.background).toBe("#282726");
    expect(p.foreground).toBe("#fffcf0");
    expect(p.cursor).toBe("#fffcf0");
    expect(p.cursorText).toBe("#fffcf0");
    expect(p.ansi).toEqual([
      "#100f0f", "#af3029", "#66800b", "#ad8301",
      "#205ea6", "#a02f6f", "#24837b", "#fffcf0",
      "#100f0f", "#d14d41", "#879a39", "#d0a215",
      "#4385be", "#ce5d97", "#3aa99f", "#fffcf0",
    ]);
  });

  it("reads colours out of a full config in any TOML spelling", () => {
    const text = `
# Alacritty config
import = ["~/.config/alacritty/extra.toml"]
[window]
padding = { x = 4, y = 4 }
opacity = 0.95

[colors]
primary = { background = '#1e1e2e', foreground = "#cdd6f4" } # inline
selection.background = "#585b70"
selection.text = "CellForeground"
draw_bold_text_with_bright_colors = true
indexed_colors = [
  { index = 16, color = "#fab387" },
]

[colors.cursor]
cursor = "CellForeground"
text = "#1e1e2e"

[colors."normal"]
red = "#f38ba8"   # comment with "quotes"
"blue" = "#89b4fa"

[[colors.indexed_colors]]
index = 17
color = "#f5e0dc"

[colors.bright]
red = "#f38ba8"

[font]
normal = { family = "JetBrains Mono" }
`;
    const [p] = parseAlacrittyToml(text).palettes;
    expect(p.background).toBe("#1e1e2e");
    expect(p.foreground).toBe("#cdd6f4");
    expect(p.selectionBackground).toBe("#585b70");
    expect(p.selectionForeground).toBeUndefined();
    expect(p.cursor).toBeUndefined();
    expect(p.cursorText).toBe("#1e1e2e");
    expect(p.ansi[1]).toBe("#f38ba8");
    expect(p.ansi[4]).toBe("#89b4fa");
    expect(p.ansi[9]).toBe("#f38ba8");
    expect(p.ansi.filter(Boolean)).toHaveLength(3);
  });

  it("rejects configs without colours and invalid values", () => {
    expect(() => parseAlacrittyToml("[window]\nopacity = 1\n")).toThrow(
      "No Alacritty colors section found",
    );
    expect(() => parseAlacrittyToml("[colors.primary]\n")).toThrow(
      "No terminal colours found",
    );
    expect(() =>
      parseAlacrittyToml('[colors.primary]\nbackground = "#12"\n'),
    ).toThrow('colors.primary.background: "#12" is not a hex colour');
    expect(() =>
      parseAlacrittyToml("[colors.primary]\nbackground = { r = 1 }\n"),
    ).toThrow("colors.primary.background must be a colour string");
  });
});

describe("parseMinimalToml", () => {
  it("decodes escapes and keeps quoted dots inside keys", () => {
    expect(
      parseMinimalToml(`a."b.c" = "x\\"y\\u0041"\nlit = 'C:\\path'`),
    ).toEqual({ a: { "b.c": 'x"yA' }, lit: "C:\\path" });
  });

  it("skips multi-line strings and arrays", () => {
    expect(
      parseMinimalToml(
        ['doc = """', "[not.a.table]", '"""', "list = [", "  1,", "]", 'k = "v"'].join(
          "\n",
        ),
      ),
    ).toEqual({ k: "v" });
  });

  it("reports malformed lines with their number", () => {
    const cases: [string, string][] = [
      ["[colors", "Line 1: malformed table header"],
      ["[[x]", "Line 1: malformed table header"],
      ['a = "b"\njust words', 'Line 2: expected "key = value"'],
      ["a = ", "Line 1: missing value"],
      ['a = "open', "Line 1: unterminated string"],
      ["a = 'open", "Line 1: unterminated string"],
      ['a = "\\q"', 'Line 1: invalid escape "\\q"'],
      ["bad key = 1", 'Line 1: invalid key "bad key"'],
      ["a = { b = 1", "Line 1: inline tables must close on the same line"],
      ['a = "x"\n[a]', 'Line 2: "a" is already a value'],
    ];
    for (const [text, message] of cases) {
      expect(() => parseMinimalToml(text)).toThrow(message);
    }
  });

  it("treats a __proto__ key as data", () => {
    const doc = parseMinimalToml('[__proto__]\npolluted = "yes"');
    expect(Object.keys(doc)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("parseAlacrittyYaml", () => {
  it("reads the legacy alacritty.yml layout", () => {
    const text = `
# Colors (Dracula)
colors:
  # Default colors
  primary:
    background: '0x282a36'
    foreground: "#f8f8f2"
  cursor:
    text: CellBackground
    cursor: CellForeground
  selection:
    text: CellForeground
    background: '#44475a'
  normal:
    black:   '#21222c'
    red:     '#ff5555'
  bright:
    white:   '#ffffff'
font:
  size: 12
`;
    const [p] = parseAlacrittyYaml(text).palettes;
    expect(p.background).toBe("#282a36");
    expect(p.foreground).toBe("#f8f8f2");
    expect(p.cursor).toBeUndefined();
    expect(p.cursorText).toBeUndefined();
    expect(p.selectionBackground).toBe("#44475a");
    expect(p.ansi[0]).toBe("#21222c");
    expect(p.ansi[1]).toBe("#ff5555");
    expect(p.ansi[15]).toBe("#ffffff");
  });

  it("resolves a scheme picked with an alias", () => {
    const text = `
schemes:
  light: &light
    primary:
      background: '#fdf6e3'
      foreground: '#657b83'
  dark: &dark
    primary:
      background: '#002b36'
key_bindings:
  - { key: V, mods: Control, action: Paste }
  - key: C
    mods: Control
colors: *light
`;
    const [p] = parseAlacrittyYaml(text).palettes;
    expect(p.background).toBe("#fdf6e3");
    expect(p.foreground).toBe("#657b83");
  });

  it("rejects YAML without colours", () => {
    expect(() => parseAlacrittyYaml("font:\n  size: 12\n")).toThrow(
      "No Alacritty colors section found",
    );
  });
});

describe("parseMinimalYaml", () => {
  it("handles merges, quoting, block scalars and flow values", () => {
    expect(
      parseMinimalYaml(`---
base: &base
  a: '1'
  b: "two # not a comment"
child:
  <<: *base
  b: three # a comment
  note: |
    multi
    line
  flow: [1, 2]
empty:
...`),
    ).toEqual({
      base: { a: "1", b: "two # not a comment" },
      child: { a: "1", b: "three", note: null, flow: null },
      empty: null,
    });
  });

  it("reports what it cannot read", () => {
    const cases: [string, string][] = [
      ["a:\n\tb: 1", "Line 2: tabs are not allowed for indentation"],
      ["a: 1\n  b: 2", "Line 2: unexpected indentation"],
      ["just text", 'Line 1: expected "key: value"'],
      ["a: *missing", 'Line 1: unknown alias "*missing"'],
      ["a: 'open", "Line 1: unterminated string"],
      ["  a: 1\nb: 2", "Line 2: unexpected indentation"],
    ];
    for (const [text, message] of cases) {
      expect(() => parseMinimalYaml(text)).toThrow(message);
    }
  });
});
