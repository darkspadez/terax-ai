import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGhosttyTheme } from "./ghostty";

function fixture(name: string): string {
  return readFileSync(
    new URL(`./__fixtures__/ghostty/${name}`, import.meta.url),
    "utf8",
  );
}

describe("parseGhosttyTheme", () => {
  it("reads a theme file Ghostty bundles", () => {
    const [palette] = parseGhosttyTheme(fixture("One Half Dark")).palettes;
    expect(palette.background).toBe("#282c34");
    expect(palette.foreground).toBe("#dcdfe4");
    expect(palette.cursor).toBe("#a3b3cc");
    expect(palette.cursorText).toBe("#e9ecf1");
    expect(palette.selectionBackground).toBe("#474e5d");
    expect(palette.selectionForeground).toBe("#dcdfe4");
    expect(palette.ansi).toEqual([
      "#282c34", "#e06c75", "#98c379", "#e5c07b",
      "#61afef", "#c678dd", "#56b6c2", "#dcdfe4",
      "#5d677a", "#e06c75", "#98c379", "#e5c07b",
      "#61afef", "#c678dd", "#56b6c2", "#dcdfe4",
    ]);
  });

  it("skips comments and non-colour keys of a full config, last value wins", () => {
    const text = [
      "# my config",
      "font-family = JetBrains Mono",
      "theme = light:Foo,dark:Bar",
      "keybind = ctrl+a=select_all",
      "",
      'background = "#101010"',
      "background = 202020",
      "\tforeground   =   #ABC   ",
      "palette = 3 = #ff0000",
      "palette = 200=#123456",
    ].join("\r\n");
    const [palette] = parseGhosttyTheme(text).palettes;
    expect(palette.background).toBe("#202020");
    expect(palette.foreground).toBe("#aabbcc");
    expect(palette.ansi[3]).toBe("#ff0000");
    expect(palette.ansi.filter(Boolean)).toHaveLength(1);
  });

  it("treats an empty value and cell references as unset", () => {
    const text = [
      "cursor-color = #ff0000",
      "cursor-color =",
      "selection-background = cell-foreground",
      "selection-foreground = cell-background",
      "foreground = #ffffff",
    ].join("\n");
    const [palette] = parseGhosttyTheme(text).palettes;
    expect(palette.cursor).toBeUndefined();
    expect(palette.selectionBackground).toBeUndefined();
    expect(palette.selectionForeground).toBeUndefined();
  });

  it("names the line of an invalid colour", () => {
    expect(() => parseGhosttyTheme("background = #000\nforeground = wheat")).toThrow(
      'Line 2 (foreground): "wheat" is not a hex colour',
    );
    expect(() => parseGhosttyTheme("palette = 1=nope")).toThrow(
      'Line 1 (palette 1): "nope" is not a hex colour',
    );
  });

  it("rejects malformed lines and palette entries", () => {
    expect(() => parseGhosttyTheme("background #000000")).toThrow(
      'Line 1: expected "key = value"',
    );
    expect(() => parseGhosttyTheme("= #000000")).toThrow("Line 1");
    expect(() => parseGhosttyTheme("palette = #000000")).toThrow(
      "palette entries look like",
    );
    expect(() => parseGhosttyTheme("palette = 256=#000000")).toThrow(
      "palette entries look like",
    );
  });

  it("rejects a file without any colour", () => {
    expect(() => parseGhosttyTheme("# nothing\nfont-size = 13\n")).toThrow(
      "No terminal colours found",
    );
  });
});
