import { describe, expect, it } from "vitest";
import { displayAgent } from "./format";

describe("displayAgent", () => {
  it("maps known agent ids to their display labels", () => {
    expect(displayAgent("claude")).toBe("Claude Code");
    expect(displayAgent("codex")).toBe("Codex");
    expect(displayAgent("pi")).toBe("Pi");
    expect(displayAgent("antigravity")).toBe("Antigravity");
    expect(displayAgent("gjc")).toBe("GJC");
  });

  it("looks the label up case-insensitively", () => {
    expect(displayAgent("CLAUDE")).toBe("Claude Code");
    expect(displayAgent("gEmInI")).toBe("Gemini");
  });

  it("capitalizes an unknown agent id", () => {
    expect(displayAgent("foobar")).toBe("Foobar");
  });

  it("falls back to 'Agent' for an empty id", () => {
    expect(displayAgent("")).toBe("Agent");
  });
});
