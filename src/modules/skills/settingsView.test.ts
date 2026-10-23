import { describe, expect, it } from "vitest";
import { PROJECT, skill, trustItem, trustStatus } from "./fixtures";
import {
  overriddenGlobal,
  overridingSkill,
  skillGroups,
  sourceLabel,
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
    expect(groups[2].project?.items[0].state).toBe("allowed");
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
  it("decide only the project's skills: its .mcp.json belongs to Settings > MCP", () => {
    const groups = skillGroups({
      teraxDir: "/t",
      userDir: null,
      skills: [],
      invalid: [],
      projects: [
        trustStatus([
          trustItem(),
          trustItem({ kind: "mcp-json", path: "/work/proj/.mcp.json" }),
        ]),
      ],
    });
    expect(groups[2].project?.items.map((i) => i.kind)).toEqual([
      "claude-skills",
    ]);
  });
});
