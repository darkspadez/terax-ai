import { describe, expect, it } from "vitest";
import {
  SKILL_LISTING_BUDGET,
  SKILLS_HEADER,
  skillsPromptBlock,
} from "./prompt";

const skill = (name: string, description: string, whenToUse?: string) => ({
  name,
  description,
  whenToUse,
});

describe("skillsPromptBlock", () => {
  it("lists nothing without skills", () => {
    expect(skillsPromptBlock([])).toBeNull();
  });

  it("lists each skill by name with its description, in name order", () => {
    const block = skillsPromptBlock([
      skill("pdf", "Fill PDF forms.", "Use for PDFs."),
      skill("docx", "Edit Word files.\n\nAlso\ttables."),
    ]);
    expect(block).toBe(
      `${SKILLS_HEADER}\n- docx: Edit Word files. Also tables.\n- pdf: Fill PDF forms. Use for PDFs.`,
    );
  });

  it("says skill text never overrides the rules or the approval mode", () => {
    expect(SKILLS_HEADER).toContain("use_skill");
    expect(SKILLS_HEADER).toContain("never overrides");
    expect(SKILLS_HEADER).toContain("approval");
  });

  it("stays within the budget, shortening the longest descriptions first", () => {
    const skills = [
      skill("short", "Brief."),
      skill("long-a", "a".repeat(5000)),
      skill("long-b", "b".repeat(5000)),
    ];
    const block = skillsPromptBlock(skills, 1500) ?? "";
    expect(block.length).toBeLessThanOrEqual(1500);
    expect(block).toContain("- short: Brief.");
    const a = block.split("\n").find((l) => l.startsWith("- long-a: ")) ?? "";
    const b = block.split("\n").find((l) => l.startsWith("- long-b: ")) ?? "";
    expect(a.endsWith("…")).toBe(true);
    expect(Math.abs(a.length - b.length)).toBeLessThanOrEqual(1);
  });

  it("caps one description at Claude Code's 1,536 characters", () => {
    const block = skillsPromptBlock([skill("x", "y".repeat(3000))]) ?? "";
    const line = block.split("\n").pop() ?? "";
    expect(line.length).toBe("- x: ".length + 1536);
  });

  it("keeps every name when descriptions do not fit, and counts the rest when names do not", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      skill(`skill-${String(i).padStart(2, "0")}`, "z".repeat(200)),
    );
    const tight = skillsPromptBlock(many, SKILLS_HEADER.length + 600) ?? "";
    expect(
      tight.split("\n").filter((l) => l.startsWith("- skill-")),
    ).toHaveLength(40);
    const tiny = skillsPromptBlock(many, SKILLS_HEADER.length + 120) ?? "";
    expect(tiny.length).toBeLessThanOrEqual(SKILLS_HEADER.length + 120);
    expect(tiny).toMatch(/- \(\d+ more skills not listed\)$/);
  });

  it("budgets about 2,000 tokens by default", () => {
    expect(SKILL_LISTING_BUDGET).toBe(8000);
  });
});
