import { describe, expect, it } from "vitest";
import { normalizeSkillName, skillNameError } from "./names";

describe("skill names", () => {
  it("accepts names the Agent Skills format accepts", () => {
    for (const name of ["pdf", "pdf-processing", "v2", "a".repeat(64)]) {
      expect(skillNameError(name), name).toBeNull();
    }
  });

  it("explains what is wrong with a name", () => {
    expect(skillNameError("")).toBe("Enter a name");
    expect(skillNameError("a".repeat(65))).toBe("At most 64 characters");
    expect(skillNameError("Pdf")).toBe("Use lowercase letters");
    expect(skillNameError("pdf_x")).toBe(
      "Only lowercase letters, digits and hyphens",
    );
    expect(skillNameError("-pdf")).toBe("No hyphen at the start or end");
    expect(skillNameError("pdf--x")).toBe("No two hyphens in a row");
  });

  it("normalizes what is typed", () => {
    expect(normalizeSkillName("Release Notes_v2")).toBe("release-notes-v2");
  });
});
