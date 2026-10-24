import { describe, expect, it } from "vitest";
import { detectFileTrigger, detectSnippetTrigger } from "./composerTriggers";

const at = (text: string) => detectSnippetTrigger(text, text.length);

describe("detectSnippetTrigger", () => {
  it("opens on # and / at a word start", () => {
    expect(at("#rev")).toEqual({ start: 0, end: 4, query: "rev", char: "#" });
    expect(at("fix /Skill-1")).toEqual({
      start: 4,
      end: 12,
      query: "skill-1",
      char: "/",
    });
    expect(at("a/b")).toBeNull();
    expect(at("/a b")).toBeNull();
  });

  it("lets / commands hold an MCP prompt's server:prompt", () => {
    expect(at("/git:review_pr.v2")?.query).toBe("git:review_pr.v2");
  });

  it("keeps # snippets to their own names", () => {
    expect(at("#a:b")).toBeNull();
    expect(at("#a_b")).toBeNull();
  });
});

describe("detectFileTrigger", () => {
  it("opens on @ at a word start, whatever follows", () => {
    const text = "see @src/a.ts";
    expect(detectFileTrigger(text, text.length)).toEqual({
      start: 4,
      end: 13,
      query: "src/a.ts",
    });
    expect(detectFileTrigger("a@b", 3)).toBeNull();
    expect(detectFileTrigger("@a b", 4)).toBeNull();
  });
});
