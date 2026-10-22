import { expect, it } from "vitest";
import { clampTerminalLineHeight, TERMINAL_LINE_HEIGHT_DEFAULT } from "./store";

it("keeps terminal line height between 1 and 2 in hundredths", () => {
  expect(clampTerminalLineHeight(1.333)).toBe(1.33);
  expect(clampTerminalLineHeight(0.5)).toBe(1);
  expect(clampTerminalLineHeight(9)).toBe(2);
  expect(clampTerminalLineHeight("1.5")).toBe(TERMINAL_LINE_HEIGHT_DEFAULT);
  expect(clampTerminalLineHeight(Number.NaN)).toBe(
    TERMINAL_LINE_HEIGHT_DEFAULT,
  );
});
