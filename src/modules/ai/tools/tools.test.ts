import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "./context";

vi.mock("../lib/native", () => ({ native: {} }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
  workspaceScopeKey: () => "local",
}));

import { buildTools, TOOL_APPROVAL } from "./tools";

const ctx = {
  getCwd: () => "/workspace",
  getWorkspaceRoot: () => "/workspace",
  getTerminalContext: () => null,
  isActiveTerminalPrivate: () => false,
  injectIntoActivePty: () => false,
  openPreview: () => false,
  spawnAgent: () => null,
  readAgentOutput: () => null,
  readCache: new Map(),
  getSessionId: () => "session",
} satisfies ToolContext;

describe("TOOL_APPROVAL", () => {
  it("classifies exactly the tools the agent is given", () => {
    expect(Object.keys(TOOL_APPROVAL).sort()).toEqual(
      Object.keys(buildTools(ctx)).sort(),
    );
  });

  // The approval gate is the only thing between a model and a write to disk,
  // a shell command or a new coding agent. Loosening it must be deliberate.
  it("asks the user before every mutating tool runs", () => {
    const gated = Object.entries(TOOL_APPROVAL)
      .filter(([, status]) => status === "user-approval")
      .map(([name]) => name)
      .sort();
    expect(gated).toEqual([
      "bash_background",
      "bash_run",
      "create_directory",
      "edit",
      "multi_edit",
      "send_to_agent",
      "spawn_coding_agent",
      "write_file",
    ]);
  });

  it("leaves approval to the policy rather than the tool definitions", () => {
    for (const [name, tool] of Object.entries(buildTools(ctx))) {
      expect(tool, name).not.toHaveProperty("needsApproval");
    }
  });
});
