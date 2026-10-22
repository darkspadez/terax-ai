import { describe, expect, it } from "vitest";
import { mergeInterleavedReasoning } from "./reasoningDisplay";

type Part = { type: string; text?: string; state?: string; id?: string };

const r = (text: string, state = "done"): Part => ({
  type: "reasoning",
  text,
  state,
});
const t = (text: string, state = "done"): Part => ({
  type: "text",
  text,
  state,
});
const step: Part = { type: "step-start" };
const tool = (id: string): Part => ({ type: "tool-read_file", id });

describe("mergeInterleavedReasoning", () => {
  it("shows an interleaved answer as one reasoning block and one text", () => {
    const parts = [
      step,
      r("Thinking A. "),
      t("Answer part 1. "),
      r("Thinking B. "),
      t("Answer part 2."),
      r("Thinking C."),
    ];
    expect(mergeInterleavedReasoning(parts)).toEqual([
      step,
      r("Thinking A. Thinking B. Thinking C."),
      t("Answer part 1. Answer part 2."),
    ]);
  });

  it("keeps each step's reasoning in its step, around tool calls", () => {
    const parts = [
      step,
      r("plan "),
      t("Reading. "),
      r("more"),
      tool("c1"),
      step,
      r("got it"),
      t("Done."),
    ];
    expect(mergeInterleavedReasoning(parts)).toEqual([
      step,
      r("plan more"),
      t("Reading. "),
      tool("c1"),
      step,
      r("got it"),
      t("Done."),
    ]);
  });

  it("marks a merged block streaming while any fragment streams", () => {
    expect(
      mergeInterleavedReasoning([r("a"), t("b"), r("c", "streaming")]),
    ).toEqual([r("ac", "streaming"), t("b")]);
  });

  it("returns the same array when there is nothing to merge", () => {
    const parts = [step, r("why"), t("answer"), tool("c1"), step, t("ok")];
    expect(mergeInterleavedReasoning(parts)).toBe(parts);
    const plain = [t("hello")];
    expect(mergeInterleavedReasoning(plain)).toBe(plain);
  });
});
