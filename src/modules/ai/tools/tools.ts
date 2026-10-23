import type { McpRunTools } from "@/modules/mcp";
import { isMcpToolName } from "@/modules/mcp/lib/toolNames";
import { type AgentSkills, NO_AGENT_SKILLS } from "@/modules/skills/catalog";
import type { Tool } from "ai";
import type { ApprovalMode } from "../lib/approvalMode";
import { buildManagedAgentTools } from "./agent";
import { buildEditTools } from "./edit";
import { buildFsTools } from "./fs";
import { buildSearchTools } from "./search";
import { buildShellTools } from "./shell";
import { buildSkillTools } from "./skills";
import { buildSubagentTools } from "./subagent";
import { buildTerminalTools } from "./terminal";
import { buildTodoTools } from "./todo";

export { resolvePath, type ToolContext } from "./context";

/**
 * AI tool definitions.
 *
 * Approval policy (`TOOL_GATES` below):
 *  - Read-only tools (`read_file`, `list_directory`, `grep`, `glob`)
 *    auto-execute, but go through the security guard which refuses obvious
 *    secret paths (.env*, .ssh/, credentials, etc.).
 *  - Mutating tools (file writes and edits, shell commands, coding agents)
 *    require explicit user approval in Ask mode: the AI SDK pauses on
 *    tool-call and surfaces a `tool-approval-request` part that the UI
 *    renders as a confirmation card. Auto-approve runs file and shell tools
 *    without the card; their deny-lists still refuse in `execute`.
 *  - `edit` / `multi_edit` additionally enforce a read-before-edit invariant
 *    (the model must have called read_file on the path earlier in the
 *    session).
 *  - Tools of MCP servers (`mcp__<server>__<tool>`, added per run by
 *    `runAgentStream`) ask in every mode unless the server is Trusted; see
 *    `mcpToolGate`. Sub-agents never get them.
 *  - `use_skill` / `read_skill_file` read only inside the folders of the
 *    run's usable skills (`skills`), which the backend confines; skill scripts
 *    run through `bash_run` with its approval.
 *
 * The model sees absolute paths only after they are resolved against the
 * active terminal's cwd (provided via `getCwd`); it should not invent paths
 * outside that.
 */
export function buildTools(
  ctx: import("./context").ToolContext,
  skills: AgentSkills = NO_AGENT_SKILLS,
) {
  return {
    ...buildFsTools(ctx),
    ...buildEditTools(ctx),
    ...buildSearchTools(ctx),
    ...buildShellTools(ctx),
    ...buildSubagentTools(ctx),
    ...buildTerminalTools(ctx),
    ...buildTodoTools(ctx),
    ...buildManagedAgentTools(ctx),
    ...buildSkillTools(skills),
  } as const;
}

export type ToolName = keyof ReturnType<typeof buildTools>;

/**
 * How each tool is gated. The record is exhaustive, so a new tool does not
 * compile until it is classified here.
 *  - `none`: read-only or confined to Terax's own state; never asks.
 *  - `approvable`: changes files. Asks in Ask mode and runs unasked in
 *    Auto-approve; `execute` still refuses protected paths, and plan mode
 *    queues the change for review instead of writing it.
 *  - `approvable-outside-plan`: runs shell commands. As `approvable`, except
 *    that plan mode, which must not run commands, keeps asking. `execute`
 *    still refuses the command deny-list.
 *  - `always`: launches or messages a coding agent, which no deny-list
 *    covers, so the user's approval is the only gate: asks in every mode.
 *  - `mcp`: a tool of an MCP server the user has not marked Trusted. The
 *    server is an outside program or service, so it asks in every mode.
 *  - `mcp-trusted`: a tool of a Trusted server. Follows the conversation's
 *    mode as a shell command does: plan mode, which must not act, asks.
 * MCP tools are gated by `mcpToolGate`, from what the user chose for the
 * server and the tool; the server's own annotations (`readOnlyHint` and the
 * like) are never an input, so a server cannot talk its way past a gate.
 */
export type ToolGate =
  | "none"
  | "approvable"
  | "approvable-outside-plan"
  | "always"
  | "mcp"
  | "mcp-trusted";

export const TOOL_GATES: Readonly<Record<ToolName, ToolGate>> = {
  read_file: "none",
  list_directory: "none",
  write_file: "approvable",
  create_directory: "approvable",
  edit: "approvable",
  multi_edit: "approvable",
  grep: "none",
  glob: "none",
  bash_run: "approvable-outside-plan",
  bash_background: "approvable-outside-plan",
  bash_logs: "none",
  bash_list: "none",
  bash_kill: "none",
  run_subagent: "none",
  suggest_command: "none",
  get_terminal_output: "none",
  open_preview: "none",
  todo_write: "none",
  spawn_coding_agent: "always",
  send_to_agent: "always",
  read_agent_output: "none",
  use_skill: "none",
  read_skill_file: "none",
};

type ApprovalStatus = "user-approval" | "not-applicable";

/** What a run's approval policy reads on every gated call. */
export type ApprovalState = { mode: ApprovalMode; planMode: boolean };

export function toolApprovalStatus(
  gate: ToolGate,
  { mode, planMode }: ApprovalState,
): ApprovalStatus {
  switch (gate) {
    case "none":
      return "not-applicable";
    case "always":
    case "mcp":
      return "user-approval";
    case "approvable":
      return mode === "auto" ? "not-applicable" : "user-approval";
    case "approvable-outside-plan":
    case "mcp-trusted":
      return mode === "auto" && !planMode ? "not-applicable" : "user-approval";
  }
}

/**
 * The gate of an MCP tool. "Always allow" runs it unasked in every mode;
 * otherwise a Trusted server's tools follow the conversation's mode and any
 * other server's ask every time. Tools the user never allows are not offered
 * to the model at all, so they have no gate.
 */
export function mcpToolGate(access: {
  trusted: boolean;
  alwaysAllow: boolean;
}): ToolGate {
  if (access.alwaysAllow) return "none";
  return access.trusted ? "mcp-trusted" : "mcp";
}

/**
 * The MCP tools one run offers, each with its gate. A tool comes through only
 * with an MCP name and an access entry, so none is ever offered ungated.
 */
export function mcpToolsWithGates(mcp: McpRunTools | null | undefined): {
  tools: Record<string, Tool>;
  gates: Record<string, ToolGate>;
} {
  const tools: Record<string, Tool> = {};
  const gates: Record<string, ToolGate> = {};
  if (!mcp) return { tools, gates };
  for (const [name, tool] of Object.entries(mcp.tools)) {
    if (!isMcpToolName(name) || name in TOOL_GATES) continue;
    // An MCP name never meets a prototype property, so a lookup is enough.
    const access = mcp.access[name];
    if (!access) continue;
    tools[name] = tool;
    gates[name] = mcpToolGate(access);
  }
  return { tools, gates };
}

/**
 * The `toolApproval` policy of one run. Gated tools read the conversation's
 * state on every call, so turning Auto-approve off stops the very next call
 * from running unasked, even mid-run. Auto-approved calls run as read-only
 * tools do, with no approval part, so nothing waits on the user. `extra`
 * gates the run's MCP tools; it can never regate a built-in tool.
 */
export function buildToolApproval(
  state: () => ApprovalState,
  extra: Readonly<Record<string, ToolGate>> = {},
): Readonly<Record<string, ApprovalStatus | (() => ApprovalStatus)>> {
  const policy: Record<string, ApprovalStatus | (() => ApprovalStatus)> = {};
  const gates: [string, ToolGate][] = [
    ...Object.entries(extra).filter(([name]) => !(name in TOOL_GATES)),
    ...(Object.entries(TOOL_GATES) as [ToolName, ToolGate][]),
  ];
  for (const [name, gate] of gates) {
    policy[name] =
      gate === "none"
        ? "not-applicable"
        : () => toolApprovalStatus(gate, state());
  }
  return policy;
}

/**
 * Ask mode's policy, fixed: what sub-agents run under (they only get
 * read-only tools, and a mutating tool given to one by mistake must stop
 * rather than run).
 */
export const TOOL_APPROVAL: Readonly<Record<ToolName, ApprovalStatus>> =
  Object.fromEntries(
    (Object.entries(TOOL_GATES) as [ToolName, ToolGate][]).map(
      ([name, gate]) => [
        name,
        toolApprovalStatus(gate, { mode: "ask", planMode: false }),
      ],
    ),
  ) as Record<ToolName, ApprovalStatus>;
