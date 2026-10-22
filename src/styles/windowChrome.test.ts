import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  WINDOW_FULLSCREEN_ATTR,
  WINDOW_MAXIMIZED_ATTR,
} from "@/lib/windowFrame";

// Borderless windows (Linux, Windows) paint their own rounded frame, which a
// window filling its screen must not keep (crynta/terax-ai#694).
const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

/** The declarations of every rule whose selector names `attribute`. */
function rulesFor(attribute: string): string[] {
  return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, selector]) => selector.includes(`[${attribute}]`))
    .map(([, selector, body]) => `${selector.replace(/\s+/g, " ")}{${body}}`);
}

describe("borderless window frame", () => {
  it.each([WINDOW_MAXIMIZED_ATTR, WINDOW_FULLSCREEN_ATTR])(
    "squares and unborders every rounded surface while %s",
    (attribute) => {
      const rules = rulesFor(attribute).join("\n");
      for (const surface of ["#root", "#settings-root", ".terax-bg-surface"]) {
        expect(rules).toContain(surface);
      }
      expect(rules).toMatch(/border-radius:\s*0;/);
      expect(rules).toMatch(/border-width:\s*0;/);
      expect(rules).toContain('html[data-chrome="borderless"]');
    },
  );
});
