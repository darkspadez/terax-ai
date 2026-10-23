import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ listSkills: vi.fn(), loadSkill: vi.fn() }));
vi.mock("./api", () => api);

import { skillInvocation } from "./composer";
import { PROJECT, skill } from "./fixtures";

function listed(...skills: ReturnType<typeof skill>[]) {
  return { oarlockDir: "", userDir: null, skills, invalid: [], projects: [] };
}

beforeEach(() => {
  api.listSkills.mockReset();
  api.loadSkill.mockReset();
});

describe("skillInvocation", () => {
  it("loads the skill and fills in the user's arguments", async () => {
    const deploy = skill({
      name: "deploy",
      source: "claude-project",
      project: PROJECT,
    });
    api.listSkills.mockResolvedValue(listed(deploy));
    api.loadSkill.mockResolvedValue({
      id: deploy.id,
      name: "deploy",
      dir: "/work/proj/.claude/skills/deploy",
      body: "Deploy $ARGUMENTS[0] now.",
      files: [],
      filesTruncated: false,
    });
    const result = await skillInvocation(
      "deploy",
      "staging",
      "/work/proj",
      PROJECT.workspace,
    );
    expect(api.listSkills).toHaveBeenCalledWith({
      root: "/work/proj",
      workspace: PROJECT.workspace,
    });
    expect(api.loadSkill).toHaveBeenCalledWith({
      id: deploy.id,
      project: { root: PROJECT.root, workspace: PROJECT.workspace },
    });
    expect(result.kind).toBe("block");
    expect(result.kind === "block" && result.block).toContain(
      "Deploy staging now.",
    );
  });

  it("reports a name no skill the user may call has", async () => {
    api.listSkills.mockResolvedValue(
      listed(
        skill({ name: "ai-only", userInvocable: false }),
        skill({ name: "off", enabled: false }),
      ),
    );
    for (const name of ["ai-only", "off", "missing"]) {
      expect(await skillInvocation(name, "", null, { kind: "local" })).toEqual({
        kind: "missing",
      });
    }
    expect(api.loadSkill).not.toHaveBeenCalled();
  });
});
