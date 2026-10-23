import { describe, expect, it } from "vitest";
import { PROJECT, skill, trustItem, trustStatus } from "./fixtures";
import {
  overriddenGlobal,
  overridingSkill,
  skillGroups,
  sourceLabel,
  trustBars,
} from "./settingsView";
import type { SkillsSnapshot } from "./types";

function snapshot(): SkillsSnapshot {
  return {
    teraxDir: "/cfg/skills",
    userDir: "/home/me/.claude/skills",
    skills: [
      skill({ name: "zeta" }),
      skill({ name: "pdf", overriddenBy: "user/pdf" }),
      skill({ name: "pdf", source: "user" }),
      skill({
        name: "pdf",
        source: "claude-project",
        project: PROJECT,
        key: `claude-project/pdf@${PROJECT.key}`,
      }),
    ],
    invalid: [
      {
        id: "terax/Broken",
        source: "terax",
        project: null,
        dirName: "Broken",
        dir: "/cfg/skills/Broken",
        errors: ["`name` `Broken` has uppercase letters"],
      },
    ],
    projects: [trustStatus([trustItem({ state: "allowed" })])],
  };
}

describe("skillGroups", () => {
  it("groups Terax's folder, the user's folder and each open project", () => {
    const groups = skillGroups(snapshot());
    expect(groups.map((g) => [g.id, g.title, g.path])).toEqual([
      ["terax", "Terax", "/cfg/skills"],
      ["user", "Claude Code (~/.claude/skills)", "/home/me/.claude/skills"],
      [`project:${PROJECT.key}`, "proj", "/work/proj"],
    ]);
    expect(groups[0].skills.map((s) => s.name)).toEqual(["pdf", "zeta"]);
    expect(groups[0].invalid.map((s) => s.dirName)).toEqual(["Broken"]);
    expect(groups[2].skills.map((s) => s.source)).toEqual(["claude-project"]);
    expect(groups[2].project).toEqual(PROJECT);
    expect(groups[2].trust[0].status.items[0].state).toBe("allowed");
    expect(groups[0].trust).toEqual([]);
  });

  it("names what overrides a skill and what a project skill overrides", () => {
    const snap = snapshot();
    const [teraxPdf, userPdf, projectPdf] = [
      snap.skills[1],
      snap.skills[2],
      snap.skills[3],
    ];
    expect(overridingSkill(teraxPdf, snap)?.source).toBe("user");
    expect(overridingSkill(userPdf, snap)).toBeNull();
    expect(overriddenGlobal(projectPdf, snap)?.source).toBe("user");
    expect(
      overriddenGlobal({ ...projectPdf, trusted: false }, snap),
    ).toBeNull();
    expect(sourceLabel("terax-project")).toBe(".terax/skills");
  });
});

describe("project groups", () => {
  it("decide the project's TERAX.md and its skills apart: its .mcp.json belongs to Settings > MCP", () => {
    const groups = skillGroups({
      teraxDir: "/t",
      userDir: null,
      skills: [],
      invalid: [],
      projects: [
        trustStatus([
          trustItem({ kind: "terax-md", path: "/work/proj/TERAX.md" }),
          trustItem(),
          trustItem({ kind: "terax-skills", path: "/work/proj/.terax/skills" }),
          trustItem({ kind: "mcp-json", path: "/work/proj/.mcp.json" }),
        ]),
      ],
    });
    const bars = groups[2].trust;
    expect(bars.map((bar) => bar.id)).toEqual(["instructions", "skills"]);
    expect(bars[0].status.items.map((i) => i.kind)).toEqual(["terax-md"]);
    expect(bars[0].kinds).toEqual(["terax-md"]);
    expect(bars[0].accept).toBe("Use instructions");
    expect(bars[0].note).toContain("TERAX.md only after you allow it");
    expect(bars[1].status.items.map((i) => i.kind)).toEqual([
      "claude-skills",
      "terax-skills",
    ]);
    expect(bars[1].kinds).toEqual(["claude-skills", "terax-skills"]);
    expect(bars[1].accept).toBe("Use skills");
    expect(bars.every((bar) => bar.status.project === PROJECT)).toBe(true);
  });

  it("shows a bar only for what the project provides", () => {
    expect(trustBars(trustStatus([])).length).toBe(0);
    expect(
      trustBars(trustStatus([trustItem({ kind: "mcp-json" })])).length,
    ).toBe(0);
    expect(
      trustBars(trustStatus([trustItem({ kind: "terax-md" })])).map(
        (bar) => bar.id,
      ),
    ).toEqual(["instructions"]);
  });
});
