import { afterEach, describe, expect, it } from "vitest";
import {
  askElicitation,
  askSampling,
  registerRequestHost,
  RequestEnded,
  RequestRefused,
  useMcpRequests,
} from "./requests";
import type { SamplingRequestView } from "./sampling";

const view: SamplingRequestView = {
  messages: [{ role: "user", text: "Hi", images: [] }],
  systemPrompt: "",
  maxTokens: 10,
  temperature: null,
  stopSequences: [],
  includeContext: "none",
  hints: [],
  priorities: { cost: null, speed: null, intelligence: null },
};

let hosts: (() => void)[] = [];
function host() {
  const unregister = registerRequestHost();
  hosts.push(unregister);
  return unregister;
}

afterEach(() => {
  for (const unregister of hosts) unregister();
  hosts = [];
  useMcpRequests.setState({ hosts: 0, sampling: [], elicitations: [] });
});

const sampling = (serverId = "s1") => ({ serverId, serverName: "S", view });

describe("server requests", () => {
  it("are refused while no window can show them", async () => {
    await expect(
      askSampling(sampling(), new AbortController().signal),
    ).rejects.toBeInstanceOf(RequestRefused);
    await expect(
      askElicitation(
        { serverId: "s1", serverName: "S", message: "", fields: [] },
        new AbortController().signal,
      ),
    ).rejects.toThrow("No Terax window can show this request right now.");
  });

  it("wait for the user's answer, and only one at a time per server", async () => {
    host();
    const pending = askSampling(sampling(), new AbortController().signal);
    expect(useMcpRequests.getState().sampling).toHaveLength(1);
    await expect(
      askSampling(sampling(), new AbortController().signal),
    ).rejects.toThrow("Another sampling request from this server");
    // Another server, or another kind of request, may wait meanwhile.
    const other = askSampling(sampling("s2"), new AbortController().signal);
    const form = askElicitation(
      { serverId: "s1", serverName: "S", message: "m", fields: [] },
      new AbortController().signal,
    );
    const [first, second] = useMcpRequests.getState().sampling;
    first.answer({
      kind: "result",
      text: "ok",
      model: "m",
      finishReason: "stop",
    });
    first.answer({ kind: "denied" });
    await expect(pending).resolves.toEqual({
      kind: "result",
      text: "ok",
      model: "m",
      finishReason: "stop",
    });
    second.answer({ kind: "denied" });
    await expect(other).resolves.toEqual({ kind: "denied" });
    useMcpRequests.getState().elicitations[0].answer({ action: "decline" });
    await expect(form).resolves.toEqual({ action: "decline" });
    expect(useMcpRequests.getState()).toMatchObject({
      sampling: [],
      elicitations: [],
    });
  });

  it("end when the server cancels them or stops", async () => {
    host();
    const controller = new AbortController();
    const pending = askElicitation(
      { serverId: "s1", serverName: "S", message: "m", fields: [] },
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(RequestEnded);
    expect(useMcpRequests.getState().elicitations).toEqual([]);
    await expect(
      askSampling(sampling(), controller.signal),
    ).rejects.toBeInstanceOf(RequestEnded);
  });

  it("are dismissed when the last window that shows them goes", async () => {
    const first = host();
    const second = host();
    const pending = askSampling(sampling(), new AbortController().signal);
    const form = askElicitation(
      { serverId: "s1", serverName: "S", message: "m", fields: [] },
      new AbortController().signal,
    );
    second();
    expect(useMcpRequests.getState().sampling).toHaveLength(1);
    first();
    first();
    await expect(pending).resolves.toEqual({ kind: "denied" });
    await expect(form).resolves.toEqual({ action: "cancel" });
    expect(useMcpRequests.getState().hosts).toBe(0);
  });
});
