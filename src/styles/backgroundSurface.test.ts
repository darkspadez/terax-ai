import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The background image surface lies over the whole page; a modal overlay
// must still dim and blur it (crynta/terax-ai#863).
const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");
const source = (path: string) =>
  readFileSync(new URL(`../components/ui/${path}`, import.meta.url), "utf8");

const OVERLAYS = [
  ["dialog.tsx", "dialog-overlay"],
  ["alert-dialog.tsx", "alert-dialog-overlay"],
  ["sheet.tsx", "sheet-overlay"],
] as const;

describe("background image under modal overlays", () => {
  it("drops below every modal overlay while one is open", () => {
    const rule = /body:has\(([^{]*)\)\s*\.oarlock-bg-surface\s*\{([^}]*)\}/.exec(
      css,
    );
    expect(rule).not.toBeNull();
    const [, slots = "", body = ""] = rule ?? [];
    const zIndex = Number(/z-index:\s*(\d+)\s*!important/.exec(body)?.[1]);
    for (const [file, slot] of OVERLAYS) {
      expect(slots).toContain(`[data-slot="${slot}"]`);
      const overlay = new RegExp(
        `data-slot="${slot}"[\\s\\S]*?"[^"]*\\bz-(\\d+)\\b`,
      ).exec(source(file));
      expect(Number(overlay?.[1])).toBeGreaterThan(zIndex);
    }
  });
});
