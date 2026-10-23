import { describe, expect, it } from "vitest";
import { trustItem, trustStatus } from "./fixtures";
import {
  acceptLabel,
  askingItems,
  isSkillsItem,
  promptGroups,
  promptKey,
  promptTitle,
  trustDecisions,
} from "./trust";

describe("project trust prompt", () => {
  it("asks about items never decided and items changed since", () => {
    const status = trustStatus([
      trustItem({ kind: "claude-skills", state: "pending" }),
      trustItem({ kind: "oarlock-skills", state: "changed", hash: "t2" }),
    ]);
    expect(askingItems(status).map((i) => i.kind)).toEqual([
      "claude-skills",
      "oarlock-skills",
    ]);
    for (const state of ["allowed", "denied", "unreviewable"] as const) {
      expect(askingItems(trustStatus([trustItem({ state })]))).toEqual([]);
    }
  });

  it("closes a prompt until the content it asked about changes", () => {
    const before = promptKey(trustStatus([trustItem({ hash: "h1" })]));
    expect(promptKey(trustStatus([trustItem({ hash: "h1" })]))).toBe(before);
    expect(promptKey(trustStatus([trustItem({ hash: "h2" })]))).not.toBe(
      before,
    );
  });

  it("answers each item with the hash the user saw", () => {
    const items = [
      trustItem({ kind: "claude-skills", hash: "a" }),
      trustItem({ kind: "oarlock-skills", hash: "b" }),
      trustItem({ kind: "oarlock-skills", hash: null, state: "unreviewable" }),
    ];
    expect(trustDecisions(items, new Set(["oarlock-skills"]))).toEqual([
      { kind: "claude-skills", hash: "a", allow: false },
      { kind: "oarlock-skills", hash: "b", allow: true },
    ]);
  });
});

describe("prompt wording", () => {
  it("names what the project provides", () => {
    const skills = trustItem();
    const servers = trustItem({ kind: "mcp-json" });
    expect(promptTitle([skills], "p")).toBe("Use the skills in p?");
    expect(promptTitle([servers], "p")).toBe("Use the MCP servers in p?");
    expect(promptTitle([skills, servers], "p")).toBe(
      "Use the skills and MCP servers in p?",
    );
    expect(acceptLabel([skills])).toBe("Use skills");
    expect(acceptLabel([servers])).toBe("Use servers");
    expect(acceptLabel([skills, servers])).toBe("Use selected");
    expect(isSkillsItem("oarlock-skills")).toBe(true);
    expect(isSkillsItem("mcp-json")).toBe(false);
  });

  it("names a project's AGENTS.md as its instructions, first", () => {
    const memory = trustItem({ kind: "agents-md" });
    const skills = trustItem();
    const servers = trustItem({ kind: "mcp-json" });
    expect(promptTitle([memory], "p")).toBe(
      "Use the project instructions in p?",
    );
    expect(promptTitle([skills, memory], "p")).toBe(
      "Use the project instructions and skills in p?",
    );
    expect(promptTitle([servers, skills, memory], "p")).toBe(
      "Use the project instructions, skills and MCP servers in p?",
    );
    expect(acceptLabel([memory])).toBe("Use instructions");
    expect(acceptLabel([memory, servers])).toBe("Use selected");
    expect(isSkillsItem("agents-md")).toBe(false);
    expect(promptGroups([memory])).toEqual({
      instructions: true,
      skills: false,
      servers: false,
    });
    expect(promptGroups([skills, servers])).toEqual({
      instructions: false,
      skills: true,
      servers: true,
    });
  });
});
