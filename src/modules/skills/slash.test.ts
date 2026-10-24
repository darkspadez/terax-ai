import { describe, expect, it } from "vitest";
import { parseSkillInvocation } from "./slash";

describe("parseSkillInvocation", () => {
  it("reads a skill name and the text after it", () => {
    expect(parseSkillInvocation("/pdf-tools fill form.pdf\nwith care")).toEqual(
      { name: "pdf-tools", args: "fill form.pdf\nwith care" },
    );
    expect(parseSkillInvocation("  /deploy  ")).toEqual({
      name: "deploy",
      args: "",
    });
  });

  it("ignores what cannot be a skill call", () => {
    for (const text of [
      "pdf-tools",
      "/Pdf",
      "/pdf--x",
      "/-x",
      "/x- y",
      "/path/to/file",
      "#init",
      "a /pdf",
    ]) {
      expect(parseSkillInvocation(text), text).toBeNull();
    }
  });
});
