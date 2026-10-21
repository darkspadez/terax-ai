import { buildManagedAgentTools } from "./agent";
import { buildEditTools } from "./edit";
import { buildFsTools } from "./fs";
import { buildSearchTools } from "./search";
import { buildShellTools } from "./shell";
import { buildSubagentTools } from "./subagent";
import { buildTerminalTools } from "./terminal";
import { buildTodoTools } from "./todo";

export { resolvePath, type ToolContext } from "./context";

/**
 * AI tool definitions.
 *
 * Approval policy (`TOOL_APPROVAL` below):
 *  - Read-only tools (`read_file`, `list_directory`, `grep`, `glob`)
 *    auto-execute, but go through the security guard which refuses obvious
 *    secret paths (.env*, .ssh/, credentials, etc.).
 *  - Mutating tools (file writes and edits, shell commands, coding agents)
 *    require explicit user approval — the AI SDK pauses on tool-call and
 *    surfaces a `tool-approval-request` part that the UI renders as a
 *    confirmation card.
 *  - `edit` / `multi_edit` additionally enforce a read-before-edit invariant
 *    (the model must have called read_file on the path earlier in the
 *    session).
 *
 * The model sees absolute paths only after they are resolved against the
 * active terminal's cwd (provided via `getCwd`); it should not invent paths
 * outside that.
 */
export function buildTools(ctx: import("./context").ToolContext) {
  return {
    ...buildFsTools(ctx),
    ...buildEditTools(ctx),
    ...buildSearchTools(ctx),
    ...buildShellTools(ctx),
    ...buildSubagentTools(ctx),
    ...buildTerminalTools(ctx),
    ...buildTodoTools(ctx),
    ...buildManagedAgentTools(ctx),
  } as const;
}

export type ToolName = keyof ReturnType<typeof buildTools>;

/**
 * Whether each tool pauses for the user before it runs. Passed as
 * `toolApproval` to every generation that is given these tools. The record is
 * exhaustive, so a new tool does not compile until it is classified here.
 */
export const TOOL_APPROVAL: Readonly<
  Record<ToolName, "user-approval" | "not-applicable">
> = {
  read_file: "not-applicable",
  list_directory: "not-applicable",
  write_file: "user-approval",
  create_directory: "user-approval",
  edit: "user-approval",
  multi_edit: "user-approval",
  grep: "not-applicable",
  glob: "not-applicable",
  bash_run: "user-approval",
  bash_background: "user-approval",
  bash_logs: "not-applicable",
  bash_list: "not-applicable",
  bash_kill: "not-applicable",
  run_subagent: "not-applicable",
  suggest_command: "not-applicable",
  get_terminal_output: "not-applicable",
  open_preview: "not-applicable",
  todo_write: "not-applicable",
  spawn_coding_agent: "user-approval",
  send_to_agent: "user-approval",
  read_agent_output: "not-applicable",
};
