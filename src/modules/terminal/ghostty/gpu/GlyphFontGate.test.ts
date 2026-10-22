import { describe, expect, it, vi } from "vitest";
import { GlyphFontGate, hasPrivateUseCodepoint } from "./GlyphFontGate";

const FONT = '400 28px "JetBrains Mono", "Terax Symbols", monospace';

function deferredLoader() {
  const loads: Array<{ resolve: () => void; reject: () => void }> = [];
  return {
    loads,
    loader: {
      check: vi.fn(() => false),
      load: vi.fn(
        () =>
          new Promise<void>((resolve, reject) => {
            loads.push({ resolve, reject: () => reject(new Error("404")) });
          }),
      ),
    },
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("hasPrivateUseCodepoint", () => {
  it("finds BMP and supplementary private-use codepoints, surrogates included", () => {
    expect(hasPrivateUseCodepoint("")).toBe(true);
    expect(hasPrivateUseCodepoint("")).toBe(true);
    expect(hasPrivateUseCodepoint("\u{f0001}")).toBe(true);
    expect(hasPrivateUseCodepoint("a\u{f1af0}")).toBe(true);
    expect(hasPrivateUseCodepoint("\u{10fffd}")).toBe(true);
  });

  it("ignores ordinary text, emoji and lone surrogate halves of other planes", () => {
    expect(hasPrivateUseCodepoint("abc")).toBe(false);
    expect(hasPrivateUseCodepoint("❯")).toBe(false);
    expect(hasPrivateUseCodepoint("\u{1f600}")).toBe(false);
    expect(hasPrivateUseCodepoint("\udbc0")).toBe(false);
    expect(hasPrivateUseCodepoint("\udfff")).toBe(false);
  });
});

describe("GlyphFontGate", () => {
  it("is always ready without a font set or for ordinary text", () => {
    expect(new GlyphFontGate(null).ready(FONT, "")).toBe(true);
    const { loader } = deferredLoader();
    expect(new GlyphFontGate(loader).ready(FONT, "a")).toBe(true);
    expect(loader.check).not.toHaveBeenCalled();
  });

  it("starts one load per glyph and font and notifies once per batch", async () => {
    const { loads, loader } = deferredLoader();
    const gate = new GlyphFontGate(loader);
    const listener = vi.fn();
    gate.subscribe(listener);

    expect(gate.ready(FONT, "")).toBe(false);
    expect(gate.ready(FONT, "")).toBe(false);
    expect(gate.ready(FONT, "")).toBe(false);
    expect(loader.load).toHaveBeenCalledTimes(2);

    for (const load of loads) load.resolve();
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(gate.ready(FONT, "")).toBe(true);
  });

  // A missing or broken font file must not leave icons deferred forever: the
  // glyph is drawn with whatever the stack provides once the load settles.
  it("treats a failed load as settled", async () => {
    const { loads, loader } = deferredLoader();
    const gate = new GlyphFontGate(loader);
    const listener = vi.fn();
    const unsubscribe = gate.subscribe(listener);
    expect(gate.ready(FONT, "")).toBe(false);
    loads[0].reject();
    await flush();
    expect(listener).toHaveBeenCalledOnce();
    expect(gate.ready(FONT, "")).toBe(true);
    expect(loader.load).toHaveBeenCalledOnce();

    unsubscribe();
    expect(gate.ready(FONT, "")).toBe(false);
    loads[1].resolve();
    await flush();
    expect(listener).toHaveBeenCalledOnce();
  });

  it("does not defer when the font set cannot parse the font", () => {
    const gate = new GlyphFontGate({
      check: () => {
        throw new SyntaxError("bad font");
      },
      load: vi.fn(),
    });
    expect(gate.ready("not a font", "")).toBe(true);
  });
});
