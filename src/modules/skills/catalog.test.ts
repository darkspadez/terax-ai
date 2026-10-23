import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ listSkills: vi.fn() }));
vi.mock("./api", () => api);

import {
  agentSkillsFrom,
  loadAgentSkills,
  modelSkills,
  userSkills,
} from "./catalog";
import { skill } from "./fixtures";

const LOCAL = { kind: "local" } as const;

beforeEach(() => {
  api.listSkills.mockReset();
});

describe("the skills a run may use", () => {
  const all = [
    skill({ name: "ok" }),
    skill({ name: "off", enabled: false }),
    skill({ name: "untrusted", source: "claude-project", trusted: false }),
    skill({ name: "shadowed", overriddenBy: "user/shadowed" }),
    skill({ name: "manual", modelInvocable: false }),
    skill({ name: "ai-only", userInvocable: false }),
  ];
  const snapshot = {
    oarlockDir: "",
    userDir: null,
    skills: all,
    invalid: [],
    projects: [],
  };

  it("keeps only skills that are on, trusted and not overridden", () => {
    const skills = agentSkillsFrom(snapshot, null, LOCAL);
    expect(skills.skills.map((s) => s.name)).toEqual([
      "ok",
      "manual",
      "ai-only",
    ]);
    expect(modelSkills(skills).map((s) => s.name)).toEqual(["ok", "ai-only"]);
    expect(userSkills(all).map((s) => s.name)).toEqual(["ok", "manual"]);
  });

  it("lists the skills for the conversation's project", async () => {
    api.listSkills.mockResolvedValue(snapshot);
    const env = { kind: "wsl", distro: "Ubuntu" } as const;
    const skills = await loadAgentSkills("/home/me/p", env);
    expect(api.listSkills).toHaveBeenCalledWith({
      root: "/home/me/p",
      workspace: env,
    });
    expect(skills.project).toEqual({ root: "/home/me/p", workspace: env });
    expect(skills.env).toBe(env);
  });

  it("runs without skills when they cannot be listed", async () => {
    api.listSkills.mockImplementation(async () => {
      throw new Error("backend gone");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const skills = await loadAgentSkills(null, LOCAL);
    expect(warn).toHaveBeenCalledOnce();
    expect(api.listSkills).toHaveBeenCalledWith(null);
    expect(skills.skills).toEqual([]);
    warn.mockRestore();
  });
});
