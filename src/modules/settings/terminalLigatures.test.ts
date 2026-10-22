import { expect, it } from "vitest";
import { coerceTerminalLigatures, DEFAULT_PREFERENCES } from "./store";

it("keeps terminal ligatures on unless they were explicitly turned off", () => {
  expect(DEFAULT_PREFERENCES.terminalLigatures).toBe(true);
  expect(coerceTerminalLigatures(undefined)).toBe(true);
  expect(coerceTerminalLigatures(true)).toBe(true);
  expect(coerceTerminalLigatures(false)).toBe(false);
  expect(coerceTerminalLigatures("false")).toBe(true);
  expect(coerceTerminalLigatures(0)).toBe(true);
});
