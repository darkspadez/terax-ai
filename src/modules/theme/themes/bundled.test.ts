import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseHexColor } from "@/modules/theme/schemes/color";
import { parseGhosttyTheme } from "@/modules/theme/schemes/ghostty";
import { selectionColor } from "@/modules/theme/schemes/scheme";
import { getBuiltinTheme, listBuiltinThemes } from "@/modules/theme/themes";
import type { ThemeMode } from "@/modules/theme/types";
import { validateTheme } from "@/modules/theme/validateTheme";

/** Bundled variants whose terminal colours are Ghostty's copy of the scheme. */
const GHOSTTY_SOURCES: [id: string, mode: ThemeMode, ghostty: string][] = [
  ["github", "dark", "GitHub Dark Default"],
  ["github", "light", "GitHub Light Default"],
  ["one-half", "dark", "One Half Dark"],
  ["one-half", "light", "One Half Light"],
  ["ayu", "dark", "Ayu"],
  ["ayu", "light", "Ayu Light"],
  ["ayu-mirage", "dark", "Ayu Mirage"],
  ["night-owl", "dark", "Night Owl"],
  ["night-owl", "light", "Light Owl"],
  ["tomorrow", "dark", "Tomorrow Night"],
  ["tomorrow", "light", "Tomorrow"],
  ["flexoki", "dark", "Flexoki Dark"],
  ["flexoki", "light", "Flexoki Light"],
];

function ghostty(name: string) {
  const text = readFileSync(
    new URL(`../schemes/__fixtures__/ghostty/${name}`, import.meta.url),
    "utf8",
  );
  return parseGhosttyTheme(text).palettes[0];
}

describe("bundled themes", () => {
  it("all pass the theme validator unchanged", () => {
    for (const theme of listBuiltinThemes()) {
      const result = validateTheme(JSON.parse(JSON.stringify(theme)));
      expect(result.ok, theme.id).toBe(true);
    }
  });

  it("declare a full palette of hex colours wherever they declare one", () => {
    for (const theme of listBuiltinThemes()) {
      for (const variant of Object.values(theme.variants)) {
        const ansi = variant?.terminal?.ansi;
        if (!ansi) continue;
        expect(ansi, theme.id).toHaveLength(16);
        for (const color of ansi) expect(parseHexColor(color), theme.id).toBe(color);
      }
    }
  });

  it.each(GHOSTTY_SOURCES)(
    "%s (%s) matches Ghostty's %s",
    (id, mode, name) => {
      const source = ghostty(name);
      const variant = getBuiltinTheme(id)?.variants[mode];
      expect(variant).toBeDefined();
      expect(variant?.colors?.background).toBe(source.background);
      expect(variant?.colors?.foreground).toBe(source.foreground);
      expect(variant?.terminal?.cursor).toBe(source.cursor);
      expect(variant?.terminal?.cursorAccent).toBe(source.cursorText);
      expect(variant?.terminal?.ansi).toEqual(source.ansi);
      const selection = variant?.terminal?.selection;
      if (selection !== source.selectionBackground) {
        // Only replaced where Ghostty's selection relies on recolouring the
        // selected text, which an overlay cannot do.
        expect(
          selectionColor(
            source.selectionBackground,
            source.background as string,
            source.foreground as string,
          ),
        ).not.toBe(source.selectionBackground);
      }
    },
  );
});
