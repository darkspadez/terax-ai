import { describe, expect, it } from "vitest";
import { estimateMessageHeight } from "./messageHeightEstimate";

describe("estimateMessageHeight", () => {
  it("never returns less than a one-line message", () => {
    expect(estimateMessageHeight({ role: "assistant", parts: [] })).toBe(40);
    expect(
      estimateMessageHeight({
        role: "user",
        parts: [{ type: "text", text: "hi" }],
      }),
    ).toBeGreaterThanOrEqual(40);
  });

  it("grows with wrapped text and explicit newlines", () => {
    const short = estimateMessageHeight({
      role: "assistant",
      parts: [{ type: "text", text: "a".repeat(40) }],
    });
    const wrapped = estimateMessageHeight({
      role: "assistant",
      parts: [{ type: "text", text: "a".repeat(400) }],
    });
    const lines = estimateMessageHeight({
      role: "assistant",
      parts: [{ type: "text", text: "a\n".repeat(10) }],
    });
    expect(wrapped).toBeGreaterThan(short);
    expect(lines).toBeGreaterThan(short);
  });

  it("counts tool and reasoning parts as fixed-height rows", () => {
    const one = estimateMessageHeight({
      role: "assistant",
      parts: [{ type: "tool-read_file" }],
    });
    const three = estimateMessageHeight({
      role: "assistant",
      parts: [
        { type: "tool-read_file" },
        { type: "reasoning", text: "x".repeat(5000) },
        { type: "tool-bash_run" },
      ],
    });
    expect(three).toBeGreaterThan(one);
    expect(three).toBeLessThan(200);
  });

  it("caps enormous messages so the placeholder cannot dominate the scroll height", () => {
    expect(
      estimateMessageHeight({
        role: "assistant",
        parts: [{ type: "text", text: "x\n".repeat(50_000) }],
      }),
    ).toBe(1200);
  });

  it("gives a sent message's images one row of thumbnails", () => {
    const image = { type: "file", url: "data:image/png;base64,AAAA" };
    const text = { type: "text", text: "what is this?" };
    const one = estimateMessageHeight({ role: "user", parts: [image, text] });
    const three = estimateMessageHeight({
      role: "user",
      parts: [image, image, image, text],
    });
    expect(three).toBe(one);
    expect(one).toBeGreaterThan(
      estimateMessageHeight({ role: "user", parts: [text] }) + 80,
    );
  });

  it("ignores non-string text defensively", () => {
    expect(
      estimateMessageHeight({
        role: "assistant",
        parts: [{ type: "text", text: 42 }],
      }),
    ).toBe(52);
  });
});
