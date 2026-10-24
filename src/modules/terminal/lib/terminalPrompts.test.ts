import { beforeEach, describe, expect, it } from "vitest";
import {
  requestTerminalPrompt,
  useTerminalPromptStore,
} from "./terminalPrompts";

describe("terminal prompts", () => {
  beforeEach(() => useTerminalPromptStore.setState({ queue: [] }));

  const answerHead = (answer: "allow" | "deny") => {
    const { queue, answer: respond } = useTerminalPromptStore.getState();
    respond(queue[0].id, answer);
  };

  it("queues prompts and resolves each with the user's answer", async () => {
    const paste = requestTerminalPrompt({ kind: "paste", text: "ls\n" });
    const read = requestTerminalPrompt({ kind: "clipboard-read" });
    expect(
      useTerminalPromptStore.getState().queue.map((p) => p.request.kind),
    ).toEqual(["paste", "clipboard-read"]);
    answerHead("deny");
    answerHead("allow");
    await expect(paste).resolves.toBe("deny");
    await expect(read).resolves.toBe("allow");
    expect(useTerminalPromptStore.getState().queue).toEqual([]);
  });

  it("shares one pending clipboard-read answer between repeated requests", async () => {
    const first = requestTerminalPrompt({ kind: "clipboard-read" });
    const second = requestTerminalPrompt({ kind: "clipboard-read" });
    expect(useTerminalPromptStore.getState().queue).toHaveLength(1);
    answerHead("allow");
    await expect(Promise.all([first, second])).resolves.toEqual([
      "allow",
      "allow",
    ]);
  });

  it("denies requests beyond the pending bound instead of stacking dialogs", async () => {
    for (let index = 0; index < 8; index += 1) {
      void requestTerminalPrompt({ kind: "paste", text: `${index}\n` });
    }
    await expect(
      requestTerminalPrompt({ kind: "paste", text: "x\n" }),
    ).resolves.toBe("deny");
    expect(useTerminalPromptStore.getState().queue).toHaveLength(8);
  });
});
