import { expect, it } from "vitest";
import {
  clampMinimumContrast,
  clampTerminalLineHeight,
  normalizeTerminalCustomShader,
  TERMINAL_CUSTOM_SHADER_MAX_BYTES,
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

it("keeps a custom shader only with usable source", () => {
  const source = "void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }";
  expect(normalizeTerminalCustomShader({ name: "crt.glsl", source })).toEqual({
    name: "crt.glsl",
    source,
  });
  expect(normalizeTerminalCustomShader({ source })?.name).toBe("shader");
  expect(normalizeTerminalCustomShader({ name: "x", source: "  " })).toBeNull();
  expect(
    normalizeTerminalCustomShader({
      name: "huge",
      source: "x".repeat(TERMINAL_CUSTOM_SHADER_MAX_BYTES + 1),
    }),
  ).toBeNull();
  expect(normalizeTerminalCustomShader("crt.glsl")).toBeNull();
  expect(normalizeTerminalCustomShader(null)).toBeNull();
});
