// crynta/terax-ai#556: terminal opacity is a setting, opaque by default.
import { expect, it } from "vitest";
import {
  clampTerminalOpacity,
  DEFAULT_PREFERENCES,
  TERMINAL_OPACITY_MIN,
} from "./store";

it("keeps terminals opaque unless a readable opacity was chosen", () => {
  expect(DEFAULT_PREFERENCES.terminalOpacity).toBe(1);
  expect(clampTerminalOpacity(undefined)).toBe(1);
  expect(clampTerminalOpacity("0.5")).toBe(1);
  expect(clampTerminalOpacity(Number.NaN)).toBe(1);
  expect(clampTerminalOpacity(0.85)).toBe(0.85);
  expect(clampTerminalOpacity(0.853)).toBe(0.85);
  expect(clampTerminalOpacity(2)).toBe(1);
  expect(clampTerminalOpacity(0)).toBe(TERMINAL_OPACITY_MIN);
  expect(clampTerminalOpacity(-1)).toBe(TERMINAL_OPACITY_MIN);
});
