/**
 * Whether a conversation's gated tools wait for the user ("ask") or run
 * without asking ("auto"). Auto-approve never covers the tools that launch or
 * message coding agents and never skips a deny-list: `TOOL_GATES` in
 * `tools/tools.ts` decides what each mode covers.
 */
export type ApprovalMode = "ask" | "auto";

/** Only an explicit "auto" auto-approves: a value that is missing (a
 *  conversation from before modes existed) or damaged asks. */
export function normalizeApprovalMode(value: unknown): ApprovalMode {
  return value === "auto" ? "auto" : "ask";
}

/** The modes as the composer and Settings offer them. */
export const APPROVAL_MODE_OPTIONS: readonly {
  mode: ApprovalMode;
  label: string;
  description: string;
}[] = [
  {
    mode: "ask",
    label: "Ask before running",
    description:
      "Edits, new folders and shell commands wait for your approval.",
  },
  {
    mode: "auto",
    label: "Auto-approve",
    description:
      "Edits and shell commands run without asking. Launching or messaging a coding agent still asks, and blocked paths and commands stay blocked.",
  },
];
