import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  loadSkill: vi.fn(),
  readSkillFile: vi.fn(),
}));
vi.mock("@/modules/skills/api", () => api);

import type { AgentSkills } from "@/modules/skills/catalog";
import { PROJECT, skill } from "@/modules/skills/fixtures";
import { buildSkillTools, SKILL_BODY_CAP } from "./skills";

type Exec = (
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

function tools(skills: AgentSkills) {
  const built = buildSkillTools(skills) as unknown as Record<
    string,
    { execute: (input: unknown, options: unknown) => Promise<unknown> }
  >;
  const exec =
    (name: string): Exec =>
    (input) =>
      built[name].execute(input, { toolCallId: "t", messages: [] }) as Promise<
        Record<string, unknown>
      >;
  return { use: exec("use_skill"), read: exec("read_skill_file") };
}

const pdf = skill({ name: "pdf", dir: "C:/cfg/skills/pdf" });
const manual = skill({ name: "manual", modelInvocable: false });
const deploy = skill({
  name: "deploy",
  source: "claude-project",
  project: PROJECT,
  dir: "/work/proj/.claude/skills/deploy",
});
const RUN: AgentSkills = {
  skills: [pdf, manual, deploy],
  project: { root: PROJECT.root, workspace: PROJECT.workspace },
  env: { kind: "local" },
};

beforeEach(() => {
  api.loadSkill.mockReset();
  api.readSkillFile.mockReset();
});

describe("use_skill", () => {
  it("returns the instructions with the skill's folder filled in", async () => {
    api.loadSkill.mockResolvedValue({
      id: pdf.id,
      name: "pdf",
      dir: pdf.dir,
      body: `\nRun ${["$", "{CLAUDE_SKILL_DIR}"].join("")}/scripts/fill.py\n`,
      files: ["scripts/fill.py"],
      filesTruncated: false,
    });
    const result = await tools(RUN).use({ name: "pdf" });
    expect(api.loadSkill).toHaveBeenCalledWith({ id: pdf.id, project: null });
    expect(result).toMatchObject({
      name: "pdf",
      dir: "C:/cfg/skills/pdf",
      instructions: "Run C:/cfg/skills/pdf/scripts/fill.py",
      files: ["scripts/fill.py"],
    });
    expect(String(result.note)).toContain("not from the user");
  });

  it("names a project skill with its project", async () => {
    api.loadSkill.mockResolvedValue({
      id: deploy.id,
      name: "deploy",
      dir: deploy.dir,
      body: "x",
      files: [],
      filesTruncated: true,
    });
    const result = await tools(RUN).use({ name: "deploy" });
    expect(api.loadSkill).toHaveBeenCalledWith({
      id: deploy.id,
      project: { root: PROJECT.root, workspace: PROJECT.workspace },
    });
    expect(result.files_truncated).toBe(true);
  });

  it("spells the folder as a WSL shell reaches it", async () => {
    api.loadSkill.mockResolvedValue({
      id: pdf.id,
      name: "pdf",
      dir: pdf.dir,
      body: "x",
      files: [],
      filesTruncated: false,
    });
    const wsl = { ...RUN, env: { kind: "wsl", distro: "Ubuntu" } as const };
    expect((await tools(wsl).use({ name: "pdf" })).dir).toBe(
      "/mnt/c/cfg/skills/pdf",
    );
  });

  it("refuses skills the model may not load on its own, and unknown names", async () => {
    for (const name of ["manual", "nope"]) {
      expect((await tools(RUN).use({ name })).error).toContain(
        "No skill named",
      );
    }
    expect(api.loadSkill).not.toHaveBeenCalled();
  });

  it("cuts very long instructions and says where the rest is", async () => {
    api.loadSkill.mockResolvedValue({
      id: pdf.id,
      name: "pdf",
      dir: pdf.dir,
      body: "y".repeat(SKILL_BODY_CAP + 10),
      files: [],
      filesTruncated: false,
    });
    const result = await tools(RUN).use({ name: "pdf" });
    expect(String(result.instructions)).toHaveLength(SKILL_BODY_CAP);
    expect(result.truncated).toBe(true);
  });

  it("returns a backend refusal as a tool error", async () => {
    api.loadSkill.mockRejectedValue("the skill `pdf` is turned off");
    expect((await tools(RUN).use({ name: "pdf" })).error).toContain(
      "turned off",
    );
  });
});

describe("read_skill_file", () => {
  it("reads a bundled file by its path in the skill", async () => {
    api.readSkillFile.mockResolvedValue({
      kind: "text",
      content: "a\nb\nc",
      size: 5,
    });
    const result = await tools(RUN).read({
      name: "manual",
      path: "references/guide.md",
      offset: 1,
      limit: 1,
    });
    expect(api.readSkillFile).toHaveBeenCalledWith(
      { id: manual.id, project: null },
      "references/guide.md",
    );
    expect(result).toMatchObject({
      content: "b",
      total_lines: 3,
      truncated: true,
    });
  });

  it("refuses secret files before asking the backend", async () => {
    for (const path of [".env", "keys/id_rsa", "deploy.pem"]) {
      expect((await tools(RUN).read({ name: "pdf", path })).error).toMatch(
        /Refused/,
      );
    }
    expect(api.readSkillFile).not.toHaveBeenCalled();
  });

  it("reports binary and oversized files", async () => {
    api.readSkillFile.mockResolvedValueOnce({ kind: "binary", size: 9 });
    expect((await tools(RUN).read({ name: "pdf", path: "a.png" })).error).toBe(
      "binary file refused",
    );
    api.readSkillFile.mockResolvedValueOnce({
      kind: "toolarge",
      size: 2,
      limit: 1,
    });
    expect(
      (await tools(RUN).read({ name: "pdf", path: "big.txt" })).error,
    ).toContain("too large");
  });

  it("only reads files of the run's skills", async () => {
    expect(
      (await tools(RUN).read({ name: "other", path: "x.md" })).error,
    ).toContain("No skill named");
  });
});
