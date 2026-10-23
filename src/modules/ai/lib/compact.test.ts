import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  approxTextTokens,
  compactModelMessages,
  compactModelMessagesDetailed,
  maxMemoryBytes,
  memoryOverflow,
  systemPromptOverflow,
} from "./compact";

const BIG = "x".repeat(2000);

function readCall(id: string, path: string): ModelMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: id,
        toolName: "read_file",
        input: { path },
      },
    ],
  } as unknown as ModelMessage;
}

function readResult(id: string, value: string): ModelMessage {
  return {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: id, output: { type: "text", value } },
    ],
  } as unknown as ModelMessage;
}

function writeCall(id: string, path: string): ModelMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: id,
        toolName: "write_file",
        input: { path },
      },
    ],
  } as unknown as ModelMessage;
}

function outputOf(message: ModelMessage): { __elided?: boolean } {
  const parts = message.content as Array<{ output?: { __elided?: boolean } }>;
  return parts[0].output ?? {};
}

function isElided(message: ModelMessage): boolean {
  return outputOf(message).__elided === true;
}

describe("compactModelMessagesDetailed", () => {
  it("returns the input untouched when it fits the context budget", () => {
    const messages = [{ role: "user", content: "hi" }] as ModelMessage[];
    const result = compactModelMessagesDetailed(messages, 1000);
    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it("elides a read result once its file has been written", () => {
    const messages = [
      readCall("c1", "/a.txt"),
      readResult("c1", BIG),
      writeCall("c2", "/a.txt"),
      { role: "user", content: BIG } as ModelMessage,
    ];
    const result = compactModelMessagesDetailed(messages, 1000);
    expect(result.compacted).toBe(true);
    expect(isElided(result.messages[1])).toBe(true);
  });

  it("keeps the latest read of a path and elides the superseded one", () => {
    const messages = [
      readCall("c1", "/a.txt"),
      readResult("c1", BIG),
      readCall("c2", "/a.txt"),
      readResult("c2", BIG),
      { role: "user", content: BIG } as ModelMessage,
    ];
    const result = compactModelMessagesDetailed(messages, 1000);
    expect(isElided(result.messages[1])).toBe(true);
    expect(isElided(result.messages[3])).toBe(false);
  });

  it("does not elide superseded reads while under the budget", () => {
    const messages = [
      readCall("c1", "/a.txt"),
      readResult("c1", "tiny"),
      readCall("c2", "/a.txt"),
      readResult("c2", "tiny"),
    ];
    const result = compactModelMessagesDetailed(messages, 100_000);
    expect(result.compacted).toBe(false);
    expect(isElided(result.messages[1])).toBe(false);
  });

  it("is idempotent: re-running does not re-elide an already-elided result", () => {
    const messages = [
      readCall("c1", "/a.txt"),
      readResult("c1", BIG),
      writeCall("c2", "/a.txt"),
      { role: "user", content: BIG } as ModelMessage,
    ];
    const once = compactModelMessagesDetailed(messages, 1000);
    const twice = compactModelMessagesDetailed(once.messages, 1000);
    expect(twice.compacted).toBe(false);
    expect(isElided(twice.messages[1])).toBe(true);
  });
});

describe("compactModelMessages", () => {
  it("returns the messages array from the detailed result", () => {
    const messages = [{ role: "user", content: "hi" }] as ModelMessage[];
    expect(compactModelMessages(messages, 1000)).toBe(messages);
  });
});

describe("the system prompt in the context", () => {
  /** Thirty reads of different files, each result 500 tokens. */
  const history = Array.from({ length: 30 }, (_, i) => [
    readCall(`c${i}`, `/f${i}.txt`),
    readResult(`c${i}`, BIG),
  ]).flat();

  it("counts what every request carries against the context with the history", () => {
    // 15,000 tokens of history fit a 100,000-token context on their own...
    const alone = compactModelMessagesDetailed(history, 100_000);
    expect(alone.compacted).toBe(false);

    // ...but not beside a 56,000-token system prompt (a large TERAX.md):
    // older results are elided, the recent ones kept.
    const beside = compactModelMessagesDetailed(history, 100_000, 56_000);
    expect(beside.compacted).toBe(true);
    expect(isElided(beside.messages[1])).toBe(true);
    expect(isElided(beside.messages[beside.messages.length - 1])).toBe(false);
  });

  it("estimates four characters a token and sizes the largest TERAX.md a model could take", () => {
    expect(approxTextTokens("x".repeat(4000))).toBe(1000);
    // At most four bytes a character: a larger file holds more characters
    // than the whole context.
    expect(maxMemoryBytes(128_000)).toBe(128_000 * 4 * 4);
  });

  it("fails a run whose system prompt cannot fit, naming TERAX.md when it is the cause", () => {
    expect(systemPromptOverflow(99_999, 100_000, null)).toBeNull();
    const memory = { size: 1_600_000, tokens: 400_000 };
    expect(systemPromptOverflow(99_999, 100_000, memory)).toBeNull();

    expect(systemPromptOverflow(405_000, 100_000, memory)).toBe(
      "This project's TERAX.md (1.5 MB) does not fit in the model's context of 100,000 tokens. Shorten it, stop using it in Settings > Skills, or choose a model with a larger context.",
    );
    // Without TERAX.md it would not fit either: the message names no file.
    expect(systemPromptOverflow(505_000, 100_000, memory)).toBe(
      "The instructions for this run (about 505,000 tokens, with your custom instructions, the project's TERAX.md, skills and MCP servers) do not fit in the model's context of 100,000 tokens.",
    );
    expect(systemPromptOverflow(100_000, 100_000, null)).toMatch(
      /^The instructions for this run/,
    );
    expect(memoryOverflow(900, 128_000)).toContain("TERAX.md (900 bytes)");
    expect(memoryOverflow(40 * 1024, 128_000)).toContain("TERAX.md (40.0 KB)");
  });
});
