import { describe, expect, it, vi } from "vitest";
import {
  handOffThemeEdit,
  isThemeFilePath,
  parseThemeFile,
  starterTheme,
} from "./themeFiles";

describe("isThemeFilePath", () => {
  it("accepts the terax theme extension in any case", () => {
    expect(isThemeFilePath("/themes/my.terax-theme")).toBe(true);
    expect(isThemeFilePath("/themes/MY.TERAX-THEME")).toBe(true);
    expect(isThemeFilePath("theme.TERAX-Theme")).toBe(true);
  });

  it("refuses other extensions", () => {
    expect(isThemeFilePath("/themes/my.json")).toBe(false);
    expect(isThemeFilePath("/themes/my.terax-themes")).toBe(false);
    expect(isThemeFilePath("mytheme")).toBe(false);
  });
});

describe("parseThemeFile", () => {
  it("maps broken JSON to an error result", () => {
    const r = parseThemeFile("{ not json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });

  it("rejects JSON that is not a valid theme", () => {
    expect(parseThemeFile('{"id":true}').ok).toBe(false);
    expect(parseThemeFile("42").ok).toBe(false);
    expect(parseThemeFile("{}").ok).toBe(false);
  });

  it("accepts a serialized starter theme", () => {
    const text = JSON.stringify(starterTheme());
    expect(parseThemeFile(text)).toMatchObject({ ok: true });
  });
});

describe("starterTheme", () => {
  it("exposes terminal font settings in newly created themes", () => {
    expect(starterTheme().variants.dark?.terminal).toMatchObject({
      fontFamily: "JetBrains Mono",
      fontWeight: "normal",
      fontSize: 14,
    });
  });

  it("uses a namespaced unique id", () => {
    const a = starterTheme();
    const b = starterTheme();
    expect(a.id.startsWith("my-theme-")).toBe(true);
    expect(a.id).not.toBe(b.id);
  });
});

describe("handOffThemeEdit", () => {
  it("emits the request before closing the settings window", async () => {
    const calls: string[] = [];
    const emit = vi.fn(async () => {
      await Promise.resolve();
      calls.push("emit");
    });
    const close = vi.fn(async () => {
      calls.push("close");
    });
    await expect(
      handOffThemeEdit({ action: "edit", id: "mine" }, close, emit),
    ).resolves.toBe(true);
    expect(emit).toHaveBeenCalledWith({ action: "edit", id: "mine" });
    expect(calls).toEqual(["emit", "close"]);
  });

  it("keeps Settings open when the request cannot be delivered", async () => {
    const close = vi.fn(async () => undefined);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      handOffThemeEdit({ action: "create" }, close, async () => {
        throw new Error("bus down");
      }),
    ).resolves.toBe(false);
    expect(close).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("still reports delivery when the window refuses to close", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      handOffThemeEdit(
        { action: "create" },
        async () => {
          throw new Error("denied");
        },
        async () => undefined,
      ),
    ).resolves.toBe(true);
    spy.mockRestore();
  });
});
