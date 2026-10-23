import { describe, expect, it } from "vitest";
import {
  AI_COMPOSER_ATTR,
  isAiComposerTarget,
  isAiSurfaceTarget,
} from "./aiSurface";

/** An element whose ancestors match `selectors`, as `closest` sees them. */
const inside = (...selectors: string[]) =>
  ({
    closest: (selector: string) =>
      selector
        .split(",")
        .map((s) => s.trim())
        .some((s) => selectors.includes(s))
        ? {}
        : null,
  }) as unknown as EventTarget;

const composer = `[${AI_COMPOSER_ATTR}]`;
const chatWindow = "[data-ai-mini-window]";

describe("AI surfaces", () => {
  it("are the composer and the chat window", () => {
    expect(isAiSurfaceTarget(inside(composer))).toBe(true);
    expect(isAiSurfaceTarget(inside(chatWindow))).toBe(true);
  });

  // crynta/terax-ai#444: the new conversation key reaches a terminal elsewhere.
  it("leave out terminals, the shell input and the rest of the window", () => {
    expect(isAiSurfaceTarget(inside("[data-terax-terminal-surface]"))).toBe(
      false,
    );
    // The input bar holds a block terminal's shell input too; only its AI
    // composer is marked.
    expect(isAiSurfaceTarget(inside("[data-ai-input-bar]"))).toBe(false);
    expect(isAiSurfaceTarget(inside())).toBe(false);
    expect(isAiSurfaceTarget(null)).toBe(false);
    expect(isAiSurfaceTarget({} as EventTarget)).toBe(false);
  });

  it("take drops on the composer only", () => {
    expect(isAiComposerTarget(inside(composer))).toBe(true);
    expect(isAiComposerTarget(inside(chatWindow))).toBe(false);
    expect(isAiComposerTarget(inside("[data-ai-input-bar]"))).toBe(false);
    expect(isAiComposerTarget(null)).toBe(false);
  });
});
