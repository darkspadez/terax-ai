import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { validateTheme } from "../validateTheme";
import {
  detectSourceFormat,
  importThemeFiles,
  importThemeText,
  MAX_THEME_SOURCE_BYTES,
  schemeNameFromFileName,
  type ThemeSourceFile,
  themeIdFromName,
} from "./importTheme";

function fixture(path: string): string {
  return readFileSync(new URL(`./__fixtures__/${path}`, import.meta.url), "utf8");
}

function imported(text: string, fileName?: string, takenIds: string[] = []) {
  const result = importThemeText(text, { fileName, takenIds });
  if (!result.ok) throw new Error(result.error);
  return result.themes;
}

function file(name: string, text: string, size = text.length): ThemeSourceFile {
  return { name, size, text: async () => text };
}

describe("detectSourceFormat", () => {
  it("trusts known extensions", () => {
    expect(detectSourceFormat("x", "Dracula.itermcolors")).toBe("iterm2");
    expect(detectSourceFormat("x", "theme.TOML")).toBe("alacritty-toml");
    expect(detectSourceFormat("x", "theme.yml")).toBe("alacritty-yaml");
    expect(detectSourceFormat("x", "theme.yaml")).toBe("alacritty-yaml");
    expect(detectSourceFormat("x", "scheme.json")).toBe("json");
    expect(detectSourceFormat("x", "mine.terax-theme")).toBe("json");
  });

  it("sniffs content when the name says nothing", () => {
    expect(detectSourceFormat("  <?xml ?><plist/>")).toBe("iterm2");
    expect(detectSourceFormat('{"name": "x"}')).toBe("json");
    expect(detectSourceFormat('[{"name": "x"}]', "Some.Theme.v2")).toBe("json");
    expect(detectSourceFormat("[colors.primary]\nbackground = '#000'")).toBe(
      "alacritty-toml",
    );
    expect(detectSourceFormat('colors.primary.background = "#000"')).toBe(
      "alacritty-toml",
    );
    expect(detectSourceFormat("# c\ncolors:\n  primary:\n")).toBe(
      "alacritty-yaml",
    );
    expect(detectSourceFormat("background = #000000", "Atom One Dark")).toBe(
      "ghostty",
    );
    expect(detectSourceFormat("palette = 0=#000000", "nord.conf")).toBe(
      "ghostty",
    );
  });
});

describe("names and ids", () => {
  it("derives a readable name from the file name", () => {
    expect(schemeNameFromFileName("rose-pine-moon.toml")).toBe("Rose Pine Moon");
    expect(schemeNameFromFileName("/themes/Atom One Dark")).toBe("Atom One Dark");
    expect(schemeNameFromFileName("C:\\x\\tokyo_night.yml")).toBe("Tokyo Night");
    expect(schemeNameFromFileName("Andromeda.v2")).toBe("Andromeda.v2");
    expect(schemeNameFromFileName(".toml")).toBe(".toml");
    expect(schemeNameFromFileName("   ")).toBeNull();
    expect(schemeNameFromFileName("--_.toml")).toBeNull();
  });

  it("slugs names into valid theme ids", () => {
    expect(themeIdFromName("Rosé Pine Moon")).toBe("rose-pine-moon");
    expect(themeIdFromName("  GitHub (Dark) Default!! ")).toBe(
      "github-dark-default",
    );
    expect(themeIdFromName("東京")).toBe("imported-scheme");
    expect(themeIdFromName("x".repeat(80))).toHaveLength(48);
  });
});

describe("importThemeText", () => {
  it("turns a Ghostty theme into a Terax theme with the exact palette", () => {
    const [theme] = imported(fixture("ghostty/One Half Dark"), "One Half Dark");
    expect(theme.id).toBe("one-half-dark");
    expect(theme.name).toBe("One Half Dark");
    expect(theme.description).toBe("Imported Ghostty theme.");
    const variant = theme.variants.dark;
    expect(theme.variants.light).toBeUndefined();
    expect(variant?.colors?.background).toBe("#282c34");
    expect(variant?.terminal).toMatchObject({
      background: "#282c34",
      foreground: "#dcdfe4",
      cursor: "#a3b3cc",
      cursorAccent: "#e9ecf1",
      selection: "#474e5d",
    });
    expect(variant?.terminal?.ansi?.[8]).toBe("#5d677a");
    expect(validateTheme(JSON.parse(JSON.stringify(theme))).ok).toBe(true);
  });

  it("imports every supported format", () => {
    const yaml = "colors:\n  primary:\n    background: '#000000'\n";
    const cases: [string, string, string][] = [
      [fixture("OneHalfDark.itermcolors"), "x.itermcolors", "iTerm2"],
      [fixture("flexoki-dark.toml"), "x.toml", "Alacritty"],
      [fixture("flexoki-dark.json"), "x.json", "Windows Terminal"],
      [yaml, "x.yml", "Alacritty"],
    ];
    for (const [text, name, format] of cases) {
      const [theme] = imported(text, name);
      const description = `Imported ${format} colour scheme.`;
      expect(theme.description).toBe(description);
      expect(validateTheme(JSON.parse(JSON.stringify(theme))).ok).toBe(true);
    }
  });

  it("prefers the scheme's own name over the file name", () => {
    const [theme] = imported(fixture("flexoki-dark.json"), "export (3).json");
    expect(theme.name).toBe("Flexoki Dark");
    expect(theme.id).toBe("flexoki-dark");
  });

  it("never reuses a taken id, also within one import", () => {
    const text = JSON.stringify([
      { name: "Nord", background: "#2e3440" },
      { name: "Nord", background: "#3b4252" },
    ]);
    const themes = imported(text, "schemes.json", ["nord", "nord-2"]);
    expect(themes.map((t) => [t.id, t.name])).toEqual([
      ["nord-3", "Nord 3"],
      ["nord-4", "Nord 4"],
    ]);
  });

  it("keeps a Terax theme's own id so re-importing updates it", () => {
    const theme = {
      id: "nord",
      name: "My Nord",
      variants: { dark: { colors: { background: "#000000" } } },
    };
    const result = importThemeText(JSON.stringify(theme), {
      fileName: "mine.terax-theme",
      takenIds: ["nord"],
    });
    expect(result.ok && result.themes.map((t) => [t.id, t.name])).toEqual([
      ["nord", "My Nord"],
    ]);
    expect(
      importThemeText('{"id": "X", "name": "x", "variants": {}}', {
        fileName: "bad.json",
      }),
    ).toEqual({
      ok: false,
      error: "id must be a kebab-case string (a-z, 0-9, -)",
    });
  });

  it("bounds the length of an imported name", () => {
    const text = JSON.stringify({ name: "x".repeat(500), black: "#000000" });
    const [theme] = imported(text, "long.json");
    expect(theme.name).toHaveLength(64);
    expect(theme.id).toHaveLength(48);
  });

  it("names pasted schemes from the fallback", () => {
    const result = importThemeText("background = #000000", {
      fallbackName: "Pasted Scheme",
    });
    expect(result.ok && result.themes[0].name).toBe("Pasted Scheme");
    const unnamed = importThemeText("background = #000000");
    expect(unnamed.ok && unnamed.themes[0].id).toBe("imported-scheme");
  });

  it("strips a byte order mark", () => {
    expect(imported("\uFEFFbackground = #000000")).toHaveLength(1);
  });

  it("rejects input that is not a colour scheme with a clear message", () => {
    const cases: [string, string | undefined, string][] = [
      ["", undefined, "The file is empty"],
      [" \n\t", "x.json", "The file is empty"],
      ["\u0000\u0001PNG", "image.png", "the file is binary"],
      ["Dear diary,\nI wrote a novel.", "notes", "Not a recognised colour scheme"],
      ["{ broken", "x.json", "Invalid JSON"],
      ["<html><body/></html>", "x.itermcolors", "Invalid property list"],
      ['{"profiles": {}}', "settings.json", "No Windows Terminal colour scheme"],
      ["[window]\nopacity = 1", "alacritty.toml", "No Alacritty colors section"],
      ["font-size = 12\nfoo = bar", "config", "No terminal colours found"],
    ];
    for (const [text, fileName, message] of cases) {
      const result = importThemeText(text, { fileName });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(message);
    }
  });

  it("refuses oversized input", () => {
    const result = importThemeText(
      `background = #000000\n${"#".repeat(MAX_THEME_SOURCE_BYTES)}`,
    );
    expect(result).toEqual({
      ok: false,
      error: "The file is too large to be a colour scheme",
    });
  });
});

describe("importThemeFiles", () => {
  it("imports what it can and reports each failure by file", async () => {
    const unreadable: ThemeSourceFile = {
      name: "locked.toml",
      size: 10,
      text: () => Promise.reject(new Error("EACCES")),
    };
    const result = await importThemeFiles(
      [
        file("Night Owl", fixture("ghostty/Night Owl")),
        file("broken.json", "{"),
        file("huge.toml", "", MAX_THEME_SOURCE_BYTES + 1),
        unreadable,
        file("night-owl.itermcolors", fixture("OneHalfDark.itermcolors")),
      ],
      ["night-owl"],
    );
    expect(result.themes.map((t) => t.id)).toEqual([
      "night-owl-2",
      "night-owl-3",
    ]);
    expect(result.errors).toEqual([
      expect.stringMatching(/^broken\.json: Invalid JSON/),
      "huge.toml: too large to be a colour scheme",
      "locked.toml: could not be read",
    ]);
  });

  it("reports an unexpected failure without losing the batch", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hostile: ThemeSourceFile = {
      name: "weird",
      size: 1,
      text: async () => ({ length: 1 }) as unknown as string,
    };
    const result = await importThemeFiles(
      [hostile, file("ok", "background = #000000")],
      [],
    );
    expect(result.errors).toEqual(["weird: could not be imported"]);
    expect(result.themes.map((t) => t.id)).toEqual(["ok"]);
    spy.mockRestore();
  });
});
