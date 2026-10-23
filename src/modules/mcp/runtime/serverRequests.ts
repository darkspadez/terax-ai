import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CancelledNotificationSchema,
  type ClientCapabilities,
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ErrorCode,
  McpError,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import { invoke } from "@tauri-apps/api/core";
import { bodyText } from "../lib/displayText";
import { elicitationFields } from "../lib/elicitation";
import { useMcpExtras } from "../lib/extrasCatalog";
import { askElicitation, askSampling, RequestRefused } from "../lib/requests";
import { samplingRequestView, samplingResult } from "../lib/sampling";

/**
 * What Terax offers servers: sampling (no tools, no context) and form-mode
 * elicitation. URL-mode elicitation is optional in the spec and not
 * offered, so the SDK refuses it with the spec's Invalid params error.
 */
export const CLIENT_CAPABILITIES: ClientCapabilities = {
  sampling: {},
  elicitation: { form: {} },
};

/** The spec's code for a sampling request the user rejected. */
const USER_REJECTED = -1;
const MAX_MESSAGE = 2000;

function note(serverId: string, text: string): void {
  void invoke("mcp_log_note", { serverId, text }).catch(() => {});
}

/** The server's name as Settings has it now (it may be renamed while connected). */
function nameOf(server: { id: string; name: string }): string {
  return (
    useMcpExtras.getState().servers.find((s) => s.serverId === server.id)
      ?.serverName ?? server.name
  );
}

function refusal(serverId: string, what: string, error: unknown): McpError {
  const reason = error instanceof Error ? error.message : String(error);
  note(serverId, `Refused a ${what}: ${reason}`);
  return error instanceof RequestRefused
    ? new McpError(ErrorCode.InvalidRequest, reason)
    : new McpError(ErrorCode.InvalidParams, reason);
}

/**
 * The signal a waiting request ends on: the SDK's (the connection closed,
 * or the server cancelled it) or a cancellation of request id 0, a server's
 * first request, which the SDK 1.32 ignores (`!requestId`).
 */
function endedSignal(
  pending: Map<RequestId, AbortController>,
  id: RequestId,
  sdk: AbortSignal,
): { signal: AbortSignal; done: () => void } {
  const ended = new AbortController();
  const onAbort = () => ended.abort();
  if (sdk.aborted) ended.abort();
  else sdk.addEventListener("abort", onAbort, { once: true });
  pending.set(id, ended);
  return {
    signal: ended.signal,
    done: () => {
      sdk.removeEventListener("abort", onAbort);
      if (pending.get(id) === ended) pending.delete(id);
    },
  };
}

/**
 * Answers what a server asks of the user. Every request waits for the user
 * in this window (the sampling dialog, the form in the chat): none is
 * answered on its own, whatever the server's trust or the conversation's
 * approval mode. A request ends when the server cancels it or stops (the
 * SDK aborts `extra.signal` then).
 */
export function handleServerRequests(
  client: Client,
  server: { id: string; name: string },
): void {
  // Only these requests wait on the user, so only they need cancelling here;
  // the SDK's own handling still runs for every request (it stops a
  // cancelled request's response), except that it skips id 0.
  const pending = new Map<RequestId, AbortController>();
  const sdk = client as unknown as {
    _oncancel?: (notification: unknown) => Promise<void>;
  };
  const sdkCancel =
    typeof sdk._oncancel === "function" ? sdk._oncancel.bind(client) : null;
  client.setNotificationHandler(
    CancelledNotificationSchema,
    async (notification) => {
      const id = notification.params.requestId;
      if (id !== undefined) pending.get(id)?.abort();
      await sdkCancel?.(notification);
    },
  );

  client.setRequestHandler(
    CreateMessageRequestSchema,
    async (request, extra) => {
      const parsed = samplingRequestView(request.params);
      if ("refused" in parsed) {
        throw refusal(server.id, "sampling request", new Error(parsed.refused));
      }
      let answer: Awaited<ReturnType<typeof askSampling>>;
      const ended = endedSignal(pending, extra.requestId, extra.signal);
      try {
        note(server.id, "Asked to use the model (sampling)");
        answer = await askSampling(
          {
            serverId: server.id,
            serverName: nameOf(server),
            view: parsed.view,
          },
          ended.signal,
        );
      } catch (error) {
        if (error instanceof RequestRefused) {
          throw refusal(server.id, "sampling request", error);
        }
        throw error;
      } finally {
        ended.done();
      }
      if (answer.kind === "denied") {
        note(server.id, "The user declined the sampling request");
        throw new McpError(
          USER_REJECTED,
          "The user declined the sampling request.",
        );
      }
      note(server.id, "Returned a sampling result the user approved");
      return samplingResult(answer.text, answer.model, answer.finishReason);
    },
  );

  client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
    const params = request.params;
    if (params.mode === "url") {
      throw refusal(
        server.id,
        "request for information",
        new Error(
          "Terax does not open URLs for servers (URL-mode elicitation).",
        ),
      );
    }
    if (params.task !== undefined) {
      throw refusal(
        server.id,
        "request for information",
        new Error("Terax does not answer requests for information as tasks."),
      );
    }
    const form = elicitationFields(params.requestedSchema);
    if ("unsupported" in form) {
      throw refusal(
        server.id,
        "request for information",
        new Error(form.unsupported),
      );
    }
    let answer: Awaited<ReturnType<typeof askElicitation>>;
    const ended = endedSignal(pending, extra.requestId, extra.signal);
    try {
      note(server.id, "Asked the user for information");
      answer = await askElicitation(
        {
          serverId: server.id,
          serverName: nameOf(server),
          message: bodyText(params.message, MAX_MESSAGE).trim(),
          fields: form.fields,
        },
        ended.signal,
      );
    } catch (error) {
      if (error instanceof RequestRefused) {
        throw refusal(server.id, "request for information", error);
      }
      throw error;
    } finally {
      ended.done();
    }
    note(
      server.id,
      answer.action === "accept"
        ? "The user sent the requested information"
        : answer.action === "decline"
          ? "The user declined to give the requested information"
          : "The user dismissed the request for information",
    );
    return answer.action === "accept"
      ? { action: "accept", content: answer.content }
      : { action: answer.action };
  });
}
