import { describe, expect, it } from "vitest";
import { endsContentSelection } from "./useSelectionAskAi";

/** An element whose ancestors match `selectors`. */
const inside = (...selectors: string[]) =>
  ({
    closest: (selector: string) =>
      selectors.some((s) => selector.includes(s)) ? {} : null,
  }) as unknown as EventTarget;

// crynta/terax-ai#240, #852: the popup covered the right-click menu.
describe("endsContentSelection", () => {
  it("offers the popup after a primary-button selection in a terminal or editor", () => {
    for (const target of [
      inside("[data-terax-terminal-surface]"),
      inside(".cm-editor"),
    ]) {
      expect(endsContentSelection({ button: 0, target })).toBe(true);
      // Right and middle clicks open menus or paste.
      expect(endsContentSelection({ button: 2, target })).toBe(false);
      expect(endsContentSelection({ button: 1, target })).toBe(false);
    }
  });

  it("ignores the rest of the window", () => {
    expect(endsContentSelection({ button: 0, target: inside() })).toBe(false);
    expect(endsContentSelection({ button: 0, target: null })).toBe(false);
  });
});
