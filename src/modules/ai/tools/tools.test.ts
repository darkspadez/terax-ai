import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "./context";

vi.mock("../lib/native", () => ({ native: {} }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
  workspaceScopeKey: () => "local",
}));

import {
  type ApprovalState,
  buildToolApproval,
  buildTools,
  mcpToolGate,
  mcpToolsWithGates,
  TOOL_APPROVAL,
  TOOL_GATES,
  type ToolGate,
  type ToolName,
  toolApprovalStatus,
} from "./tools";

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

const ALL_STATES: ApprovalState[] = [
  { mode: "ask", planMode: false },
  { mode: "ask", planMode: true },
  { mode: "auto", planMode: false },
  { mode: "auto", planMode: true },
];

function asking(state: ApprovalState): string[] {
  return (Object.keys(TOOL_GATES) as ToolName[])
    .filter(
      (name) => toolApprovalStatus(TOOL_GATES[name], state) === "user-approval",
    )
    .sort();
}

describe("approval modes", () => {
  it("asks before every mutating tool in Ask mode, plan mode or not", () => {
    const gated = [
      "bash_background",
      "bash_run",
      "create_directory",
      "edit",
      "multi_edit",
      "send_to_agent",
      "spawn_coding_agent",
      "write_file",
    ];
    expect(asking({ mode: "ask", planMode: false })).toEqual(gated);
    expect(asking({ mode: "ask", planMode: true })).toEqual(gated);
  });

  it("auto-approves file and shell tools, but never the coding-agent tools", () => {
    expect(asking({ mode: "auto", planMode: false })).toEqual([
      "send_to_agent",
      "spawn_coding_agent",
    ]);
  });

  it("keeps shell commands asking in plan mode, which must not run them", () => {
    // File changes are queued for the plan review instead of written.
    expect(asking({ mode: "auto", planMode: true })).toEqual([
      "bash_background",
      "bash_run",
      "send_to_agent",
      "spawn_coding_agent",
    ]);
  });

  // Launching or messaging a coding agent has no deny-list behind it: the
  // user's approval is its only gate, so no mode may cover it.
  it("always asks before launching or messaging a coding agent", () => {
    const always = (Object.keys(TOOL_GATES) as ToolName[])
      .filter((name) => TOOL_GATES[name] === "always")
      .sort();
    expect(always).toEqual(["send_to_agent", "spawn_coding_agent"]);
    for (const state of ALL_STATES) {
      for (const name of always) {
        expect(toolApprovalStatus(TOOL_GATES[name], state), name).toBe(
          "user-approval",
        );
      }
    }
  });

  it("never asks before read-only tools", () => {
    for (const state of ALL_STATES) {
      for (const name of Object.keys(TOOL_GATES) as ToolName[]) {
        if (TOOL_GATES[name] !== "none") continue;
        expect(toolApprovalStatus("none", state), name).toBe("not-applicable");
      }
    }
  });

  it("builds a run's policy that reads the mode on every call", () => {
    let state: ApprovalState = { mode: "auto", planMode: false };
    const policy = buildToolApproval(() => state);
    const status = (name: ToolName) => {
      const entry = policy[name];
      return typeof entry === "function" ? entry() : entry;
    };
    expect(Object.keys(policy).sort()).toEqual(Object.keys(TOOL_GATES).sort());
    expect(status("bash_run")).toBe("not-applicable");
    expect(status("spawn_coding_agent")).toBe("user-approval");
    expect(status("read_file")).toBe("not-applicable");

    // Turning Auto-approve off stops the next call mid-run.
    state = { mode: "ask", planMode: false };
    expect(status("bash_run")).toBe("user-approval");
    expect(status("write_file")).toBe("user-approval");
  });

  it("fixes sub-agents to Ask mode's policy", () => {
    for (const name of Object.keys(TOOL_GATES) as ToolName[]) {
      expect(TOOL_APPROVAL[name], name).toBe(
        toolApprovalStatus(TOOL_GATES[name], { mode: "ask", planMode: false }),
      );
    }
  });
});

const mcpTool = { description: "x" } as unknown as import("ai").Tool;

describe("MCP tools", () => {
  const status = (gate: ToolGate | undefined, state: ApprovalState) =>
    gate === undefined ? undefined : toolApprovalStatus(gate, state);

  // An MCP server is an outside program or service with no deny-list behind
  // it: unless the user trusts it, every call asks, Auto-approve or not.
  it("asks before every call of an untrusted server's tool, in every mode", () => {
    const gate = mcpToolGate({ trusted: false, alwaysAllow: false });
    for (const state of ALL_STATES) {
      expect(status(gate, state)).toBe("user-approval");
    }
  });

  it("lets a trusted server's tools follow the conversation's mode", () => {
    const gate = mcpToolGate({ trusted: true, alwaysAllow: false });
    expect(status(gate, { mode: "ask", planMode: false })).toBe(
      "user-approval",
    );
    expect(status(gate, { mode: "auto", planMode: false })).toBe(
      "not-applicable",
    );
    // Plan mode must not act: it keeps asking, as for shell commands.
    expect(status(gate, { mode: "auto", planMode: true })).toBe(
      "user-approval",
    );
  });

  it("runs a tool the user always allows without asking, in every mode", () => {
    for (const trusted of [false, true]) {
      const gate = mcpToolGate({ trusted, alwaysAllow: true });
      for (const state of ALL_STATES) {
        expect(status(gate, state)).toBe("not-applicable");
      }
    }
  });

  it("gates only from the user's choices, never from what the server says", () => {
    // Annotations ride along on the tool; the gate never reads them.
    const annotated = {
      trusted: false,
      alwaysAllow: false,
      annotations: { readOnlyHint: true, destructiveHint: false },
    };
    expect(mcpToolGate(annotated)).toBe("mcp");
  });

  it("offers an MCP tool only with an access entry, and gates every one offered", () => {
    const { tools, gates } = mcpToolsWithGates({
      tools: {
        mcp__a__ask: mcpTool,
        mcp__a__trusted: mcpTool,
        mcp__a__allowed: mcpTool,
        mcp__a__no_access: mcpTool,
        not_mcp_name: mcpTool,
        bash_run: mcpTool,
      },
      access: {
        mcp__a__ask: { trusted: false, alwaysAllow: false },
        mcp__a__trusted: { trusted: true, alwaysAllow: false },
        mcp__a__allowed: { trusted: false, alwaysAllow: true },
        not_mcp_name: { trusted: true, alwaysAllow: true },
        bash_run: { trusted: true, alwaysAllow: true },
      },
      instructions: [],
    });
    expect(Object.keys(tools).sort()).toEqual([
      "mcp__a__allowed",
      "mcp__a__ask",
      "mcp__a__trusted",
    ]);
    expect(gates).toEqual({
      mcp__a__allowed: "none",
      mcp__a__ask: "mcp",
      mcp__a__trusted: "mcp-trusted",
    });
    expect(mcpToolsWithGates(null)).toEqual({ tools: {}, gates: {} });
  });

  it("adds MCP gates to a run's policy without regating built-in tools", () => {
    let state: ApprovalState = { mode: "auto", planMode: false };
    const policy = buildToolApproval(() => state, {
      mcp__a__x: "mcp",
      mcp__a__y: "mcp-trusted",
      bash_run: "none",
    });
    const resolve = (name: string) => {
      const entry = policy[name];
      return typeof entry === "function" ? entry() : entry;
    };
    expect(resolve("mcp__a__x")).toBe("user-approval");
    expect(resolve("mcp__a__y")).toBe("not-applicable");
    expect(resolve("bash_run")).toBe("not-applicable");
    state = { mode: "ask", planMode: false };
    expect(resolve("bash_run")).toBe("user-approval");
    expect(resolve("mcp__a__y")).toBe("user-approval");
  });

  it("keeps MCP tools away from sub-agents", () => {
    expect(
      Object.keys(TOOL_APPROVAL).filter((name) => name.startsWith("mcp__")),
    ).toEqual([]);
  });
});
