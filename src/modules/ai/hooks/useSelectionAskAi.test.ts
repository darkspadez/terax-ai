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
      expect(endsContentSelection({ button: 0, ctrlKey: false, target }, false)).toBe(true);
      // Right and middle clicks open menus or paste.
      expect(endsContentSelection({ button: 2, ctrlKey: false, target }, false)).toBe(false);
      expect(endsContentSelection({ button: 1, ctrlKey: false, target }, false)).toBe(false);
    }
  });

  it("treats a Control-click on macOS as the right click it is", () => {
    const target = inside(".cm-editor");
    expect(endsContentSelection({ button: 0, ctrlKey: true, target }, true)).toBe(false);
    expect(endsContentSelection({ button: 0, ctrlKey: true, target }, false)).toBe(true);
  });

  it("ignores the rest of the window", () => {
    expect(endsContentSelection({ button: 0, ctrlKey: false, target: inside() }, false)).toBe(false);
    expect(endsContentSelection({ button: 0, ctrlKey: false, target: null }, false)).toBe(false);
  });
});
