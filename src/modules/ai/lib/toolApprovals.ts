import type { UIMessage } from "ai";

type Part = UIMessage["parts"][number];
type ApprovalFields = {
  state?: unknown;
  toolCallId?: unknown;
  approval?: { id?: unknown; approved?: unknown };
};

export const SUPERSEDED_APPROVAL_REASON =
  "Not run: the user sent a new message instead of approving this tool call.";

function isToolPart(part: Part): boolean {
  return part.type === "dynamic-tool" || part.type.startsWith("tool-");
}

function approvalId(part: Part): string | null {
  const id = (part as ApprovalFields).approval?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** A call waiting on the user, or approved but never run (the request after
 *  the approval failed or was stopped). Once a new user message follows it,
 *  the call has no result and every later request fails with
 *  MissingToolResultsError. */
function isUnanswered(part: Part): boolean {
  if (!isToolPart(part) || approvalId(part) === null) return false;
  const { state, toolCallId, approval } = part as ApprovalFields;
  if (typeof toolCallId !== "string" || toolCallId.length === 0) return false;
  return (
    state === "approval-requested" ||
    (state === "approval-responded" && approval?.approved === true)
  );
}

/** Settles every unanswered approval as denied, so the model is told the call
 *  did not run. Returns new message objects for what changed (the chat state
 *  and memoized rows compare by identity) and `messages` itself when nothing
 *  was pending. */
export function denyUnansweredApprovals(
  messages: UIMessage[],
  reason: string = SUPERSEDED_APPROVAL_REASON,
): UIMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    if (message.role !== "assistant" || !message.parts.some(isUnanswered)) {
      return message;
    }
    changed = true;
    return {
      ...message,
      parts: message.parts.map((part) => {
        if (!isUnanswered(part)) return part;
        const fields = part as ApprovalFields;
        return {
          ...part,
          state: "output-denied",
          approval: { ...fields.approval, approved: false, reason },
        } as Part;
      }),
    };
  });
  return changed ? next : messages;
}

/** Approvals the user can still answer. Only the newest message can hold one:
 *  any later message supersedes an approval, and answering it then would
 *  leave a call without a result. */
export function pendingApprovalIds(messages: readonly UIMessage[]): string[] {
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant") return [];
  const ids: string[] = [];
  for (const part of last.parts) {
    if (!isToolPart(part)) continue;
    if ((part as ApprovalFields).state !== "approval-requested") continue;
    const id = approvalId(part);
    if (id) ids.push(id);
  }
  return ids;
}
