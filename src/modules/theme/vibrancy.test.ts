import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(),
  frame: "rgb(20, 20, 20)",
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));

import { terminalBackgroundOpacity } from "./terminalTranslucency";
import { cssColorAlpha, parseCssColor, toHex } from "./vibrancy";

describe("parseCssColor", () => {
  it("reads rgb() in its legacy and modern spellings", () => {
    expect(parseCssColor("rgb(20, 20, 20)")).toEqual([20, 20, 20]);
    expect(parseCssColor("rgb(255 128 0)")).toEqual([255, 128, 0]);
    expect(parseCssColor("rgba(1, 2, 3, 1)")).toEqual([1, 2, 3]);
    expect(parseCssColor("rgb(1 2 3 / 100%)")).toEqual([1, 2, 3]);
  });

  it("reads color(srgb) as the webview serializes color-mix results", () => {
    expect(parseCssColor("color(srgb 0.0784314 0.0784314 0.0784314)")).toEqual([
      20, 20, 20,
    ]);
    expect(parseCssColor("color(srgb 1 1 1)")).toEqual([255, 255, 255]);
  });

  it("converts oklab and oklch to sRGB", () => {
    expect(parseCssColor("oklab(0 0 0)")).toEqual([0, 0, 0]);
    expect(parseCssColor("oklab(1 0 0)")).toEqual([255, 255, 255]);
    expect(parseCssColor("oklab(0.5 0 0)")).toEqual([99, 99, 99]);
    expect(parseCssColor("oklch(0.5 0 120)")).toEqual([99, 99, 99]);
    const [r, g, b] = parseCssColor("oklch(0.6 0.2 30)") ?? [];
    expect(r).toBeGreaterThan(g ?? 0);
    expect(r).toBeGreaterThan(b ?? 0);
  });

  it("rejects translucent, unknown and malformed values", () => {
    for (const bad of [
      "",
      "transparent",
      "rgba(0, 0, 0, 0.5)",
      "rgb(0 0 0 / 0.5)",
      "color(display-p3 1 0 0)",
      "hsl(0 0% 0%)",
      "#141414",
      "rgb(a, b, c)",
    ]) {
      expect(parseCssColor(bad), bad).toBeNull();
    }
  });

  it("formats bytes as the #rrggbb the native side parses", () => {
    expect(toHex([20, 20, 20])).toBe("#141414");
    expect(toHex([255, 160, 177])).toBe("#ffa0b1");
    expect(toHex([0, 0, 0])).toBe("#000000");
  });
});

describe("applyVibrancy", () => {
  beforeEach(() => {
    vi.resetModules();
    bridge.invoke.mockReset();
    bridge.invoke.mockImplementation(async (command: string) =>
      command === "window_backdrop_kind" ? "vibrancy" : undefined,
    );
    const probe = { style: { cssText: "" }, remove: vi.fn() };
    const root = {
      style: { backgroundColor: "" },
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
    };
    vi.stubGlobal("document", {
      documentElement: root,
      createElement: () => probe,
      body: { appendChild: vi.fn() },
    });
    vi.stubGlobal("getComputedStyle", () => ({
      backgroundColor: bridge.frame,
    }));
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => cb());
  });

  const backdropCalls = () =>
    bridge.invoke.mock.calls.filter(([c]) => c === "window_set_backdrop");

  it("turns the window opaque with the theme colour when vibrancy is off", async () => {
    const mod = await import("./vibrancy");
    await mod.applyVibrancy(false, true);
    expect(backdropCalls()).toEqual([
      [
        "window_set_backdrop",
        {
          enabled: false,
          dark: true,
          background: "#141414",
          seeThrough: false,
        },
      ],
    ]);
  });

  it("repeats nothing for an unchanged state but follows a theme colour change", async () => {
    const mod = await import("./vibrancy");
    await mod.applyVibrancy(false, true);
    await mod.applyVibrancy(false, true);
    expect(backdropCalls()).toHaveLength(1);
    bridge.frame = "rgb(40, 42, 54)";
    await mod.applyVibrancy(false, true);
    expect(backdropCalls()).toHaveLength(2);
    expect(backdropCalls()[1][1]).toMatchObject({ background: "#282a36" });
    bridge.frame = "rgb(20, 20, 20)";
  });

  it("makes the window see-through only while the backdrop is on", async () => {
    const mod = await import("./vibrancy");
    await mod.applyVibrancy(true, false);
    expect(backdropCalls()[0][1]).toEqual({
      enabled: true,
      dark: false,
      background: undefined,
      seeThrough: true,
    });
    await mod.applyVibrancy(false, false);
    expect(backdropCalls()[1][1]).toMatchObject({
      enabled: false,
      seeThrough: false,
    });
  });

  it("falls back to opaque if the native call fails", async () => {
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command === "window_backdrop_kind") return "vibrancy";
      throw new Error("native failure");
    });
    const mod = await import("./vibrancy");
    await expect(mod.applyVibrancy(true, true)).resolves.toBeUndefined();
    expect(document.documentElement.style.backgroundColor).toBe("#141414");
  });
});

describe("cssColorAlpha", () => {
  it("reads the alpha of every spelling the webview computes", () => {
    expect(cssColorAlpha("rgb(20, 20, 20)")).toBe(1);
    expect(cssColorAlpha("rgba(20, 20, 20, 0.5)")).toBe(0.5);
    expect(cssColorAlpha("rgba(0, 0, 0, 0)")).toBe(0);
    expect(cssColorAlpha("rgb(1 2 3 / 40%)")).toBe(0.4);
    expect(cssColorAlpha("color(srgb 0.1 0.2 0.3 / 0.25)")).toBe(0.25);
    expect(cssColorAlpha("oklch(0.5 0.1 120 / 0.7)")).toBe(0.7);
  });

  it("treats anything it cannot read as opaque", () => {
    for (const value of [
      "",
      "transparent",
      "rgb(",
      "rgba(1, 2, 3)",
      "x(1 / y)",
    ]) {
      expect(cssColorAlpha(value)).toBe(1);
    }
  });
});

describe("terminalBackgroundOpacity", () => {
  it("multiplies the theme's alpha by the setting", () => {
    expect(terminalBackgroundOpacity(1, 1)).toBe(1);
    expect(terminalBackgroundOpacity(1, 0.8)).toBe(0.8);
    expect(terminalBackgroundOpacity(0.5, 0.8)).toBeCloseTo(0.4);
    expect(terminalBackgroundOpacity(Number.NaN, 0.8)).toBe(0.8);
    expect(terminalBackgroundOpacity(2, 1)).toBe(1);
  });
});
