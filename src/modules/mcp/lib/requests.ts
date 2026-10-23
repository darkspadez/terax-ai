import { create } from "zustand";
import type { ElicitContent, ElicitField } from "./elicitation";
import type { SamplingRequestView } from "./sampling";

/**
 * Requests a server makes of the user (sampling, elicitation) while they
 * wait for an answer. The client runtime adds them and awaits the answer;
 * the window's request host shows them (the sampling dialog, the form in the
 * chat). Nothing here answers on its own: only the user does, or the request
 * ends (the server cancels it or stops, or the window can no longer show
 * it). Light on purpose: the chat imports it without loading the client.
 */

export type SamplingAnswer =
  | {
      kind: "result";
      text: string;
      /** The model's name, as the server is told. */
      model: string;
      finishReason: string;
    }
  | { kind: "denied" };

export type ElicitAnswer =
  | { action: "accept"; content: ElicitContent }
  | { action: "decline" }
  | { action: "cancel" };

type Pending<A> = {
  id: string;
  serverId: string;
  serverName: string;
  /** Aborts when the server cancels the request or stops. */
  signal: AbortSignal;
  /** The user's answer; later calls are ignored. */
  answer: (answer: A) => void;
};

export type PendingSampling = Pending<SamplingAnswer> & {
  view: SamplingRequestView;
};

export type PendingElicitation = Pending<ElicitAnswer> & {
  message: string;
  fields: ElicitField[];
};

type RequestsState = {
  /** Mounted request hosts; none means no window here can show a request. */
  hosts: number;
  sampling: PendingSampling[];
  elicitations: PendingElicitation[];
};

export const useMcpRequests = create<RequestsState>(() => ({
  hosts: 0,
  sampling: [],
  elicitations: [],
}));

/** Terax will not take the request now; the reason goes back to the server. */
export class RequestRefused extends Error {}

/** A request that ended without an answer (cancelled by the server, or it stopped). */
export class RequestEnded extends Error {}

const DENIED: SamplingAnswer = { kind: "denied" };
const CANCELLED: ElicitAnswer = { action: "cancel" };

/**
 * Marks this window as able to show requests while mounted. When the last
 * host goes, what is still waiting is answered as the user dismissing it.
 */
export function registerRequestHost(): () => void {
  useMcpRequests.setState((s) => ({ hosts: s.hosts + 1 }));
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    const { hosts, sampling, elicitations } = useMcpRequests.getState();
    useMcpRequests.setState({ hosts: Math.max(0, hosts - 1) });
    if (hosts - 1 > 0) return;
    for (const request of sampling) request.answer(DENIED);
    for (const request of elicitations) request.answer(CANCELLED);
  };
}

let nextId = 0;

type Key = "sampling" | "elicitations";

function ask<A, P extends Pending<A>>(
  key: Key,
  input: Omit<P, "id" | "signal" | "answer">,
  signal: AbortSignal,
  busy: string,
): Promise<A> {
  const state = useMcpRequests.getState();
  if (state.hosts === 0) {
    return Promise.reject(
      new RequestRefused("No Terax window can show this request right now."),
    );
  }
  const list = state[key] as unknown as Pending<unknown>[];
  if (list.some((r) => r.serverId === input.serverId)) {
    return Promise.reject(new RequestRefused(busy));
  }
  if (signal.aborted) {
    return Promise.reject(new RequestEnded("The request was cancelled."));
  }
  return new Promise<A>((resolve, reject) => {
    const id = `mcp-request-${++nextId}`;
    let done = false;
    const remove = () => {
      useMcpRequests.setState((s) => ({
        [key]: (s[key] as unknown as Pending<unknown>[]).filter(
          (r) => r.id !== id,
        ),
      }));
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (done) return;
      done = true;
      remove();
      reject(new RequestEnded("The request was cancelled."));
    };
    const entry = {
      ...input,
      id,
      signal,
      answer: (answer: A) => {
        if (done) return;
        done = true;
        remove();
        resolve(answer);
      },
    } as unknown as P;
    signal.addEventListener("abort", onAbort, { once: true });
    useMcpRequests.setState((s) => ({
      [key]: [...(s[key] as unknown as P[]), entry],
    }));
  });
}

/** Waits for the user to answer a sampling request. */
export function askSampling(
  input: { serverId: string; serverName: string; view: SamplingRequestView },
  signal: AbortSignal,
): Promise<SamplingAnswer> {
  return ask<SamplingAnswer, PendingSampling>(
    "sampling",
    input,
    signal,
    "Another sampling request from this server is waiting for the user.",
  );
}

/** Waits for the user to answer an elicitation form. */
export function askElicitation(
  input: {
    serverId: string;
    serverName: string;
    message: string;
    fields: ElicitField[];
  },
  signal: AbortSignal,
): Promise<ElicitAnswer> {
  return ask<ElicitAnswer, PendingElicitation>(
    "elicitations",
    input,
    signal,
    "Another request for information from this server is waiting for the user.",
  );
}
