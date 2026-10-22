import { expect, it } from "vitest";
import {
  clampMinimumContrast,
  clampTerminalLineHeight,
  TERMINAL_LINE_HEIGHT_DEFAULT,
} from "./store";

it("keeps terminal line height between 1 and 2 in hundredths", () => {
  expect(clampTerminalLineHeight(1.333)).toBe(1.33);
  expect(clampTerminalLineHeight(0.5)).toBe(1);
  expect(clampTerminalLineHeight(9)).toBe(2);
  expect(clampTerminalLineHeight("1.5")).toBe(TERMINAL_LINE_HEIGHT_DEFAULT);
  expect(clampTerminalLineHeight(Number.NaN)).toBe(
    TERMINAL_LINE_HEIGHT_DEFAULT,
  );
});

it("keeps the minimum contrast a WCAG ratio, 1 (off) to 21", () => {
  expect(clampMinimumContrast(0)).toBe(1);
  expect(clampMinimumContrast(4.5)).toBe(4.5);
  expect(clampMinimumContrast(99)).toBe(21);
  expect(clampMinimumContrast("4.5")).toBe(1);
  expect(clampMinimumContrast(Number.NaN)).toBe(1);
});
