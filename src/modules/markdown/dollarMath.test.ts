import { describe, expect, it } from "vitest";
import { guardDollarMath, isDollarMath } from "./dollarMath";

/** isDollarMath for the first `$...$` span written in `text`. */
function spanOk(text: string, open: number, close: number): boolean {
  return isDollarMath(text, open, close + 1);
}

describe("isDollarMath", () => {
  it("accepts a span that hugs its content", () => {
    expect(spanOk("$x$", 0, 2)).toBe(true);
    expect(spanOk("a $x^2 + 1$ b", 2, 10)).toBe(true);
    expect(spanOk("$5x$", 0, 3)).toBe(true);
    expect(spanOk("($x$)", 1, 3)).toBe(true);
    expect(spanOk("$x$.", 0, 2)).toBe(true);
  });

  it("rejects spaces inside either delimiter", () => {
    expect(spanOk("$ x$", 0, 3)).toBe(false);
    expect(spanOk("$x $", 0, 3)).toBe(false);
    expect(spanOk("$5 and $10", 0, 7)).toBe(false);
    expect(spanOk("$x\n$", 0, 3)).toBe(false);
  });

  it("rejects a closing dollar followed by a digit", () => {
    expect(spanOk("$x$5", 0, 2)).toBe(false);
  });

  it("always accepts double-dollar spans", () => {
    expect(isDollarMath("$$ x $$", 0, 7)).toBe(true);
    expect(isDollarMath("$$x$$5", 0, 5)).toBe(true);
  });
});

describe("guardDollarMath", () => {
  const at = (start: number, end: number) => ({
    start: { offset: start },
    end: { offset: end },
  });

  it("swaps a rejected span for what the parser makes of it, unescaped once", () => {
    const source = "a $5 b $10";
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "a " },
            { type: "inlineMath", value: "5 b ", position: at(2, 8) },
            { type: "text", value: "10" },
          ],
        },
      ],
    };
    const parsed: string[] = [];
    guardDollarMath(tree, source, (md) => {
      parsed.push(md);
      return {
        type: "root",
        children: [
          { type: "paragraph", children: [{ type: "text", value: "$5 b $" }] },
        ],
      };
    });
    expect(parsed).toEqual(["\\$5 b $"]);
    expect(tree.children[0].children).toEqual([
      { type: "text", value: "a " },
      { type: "text", value: "$5 b $" },
      { type: "text", value: "10" },
    ]);
  });

  it("keeps accepted spans and spans without positions", () => {
    const keep = { type: "inlineMath", value: "x", position: at(0, 3) };
    const bare = { type: "inlineMath", value: " y " };
    const tree = { type: "root", children: [keep, bare] };
    guardDollarMath(tree, "$x$", () => {
      throw new Error("not parsed");
    });
    expect(tree.children).toEqual([keep, bare]);
  });

  it("falls back to plain text when the reparse is not one paragraph", () => {
    const tree = {
      type: "root",
      children: [{ type: "inlineMath", value: " x ", position: at(0, 5) }],
    };
    guardDollarMath(tree, "$ x $", () => ({ type: "root", children: [] }));
    expect(tree.children).toEqual([{ type: "text", value: "$ x $" }]);
  });
});
