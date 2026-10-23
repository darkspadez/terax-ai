import type { UIMessage } from "@ai-sdk/react";
import { describe, expect, it } from "vitest";
import { mcpPromptBlock } from "@/modules/mcp/lib/blocks";
import { skillMessageBlock } from "@/modules/skills/invocation";
import { fileBlock, snippetBlock } from "./messageBlocks";
import { deriveTitle } from "./sessions";
import { tryRunSlashCommand } from "./slashCommands";

function message(text: string, role: UIMessage["role"] = "user"): UIMessage {
  return {
    id: "id",
    role,
    parts: [{ type: "text", text }],
  } as UIMessage;
}

describe("deriveTitle", () => {
  it("returns New chat for no messages", () => {
    expect(deriveTitle([])).toBe("New chat");
  });

  it("skips non-user messages", () => {
    expect(deriveTitle([message("assistant reply", "assistant")])).toBe(
      "New chat",
    );
  });

  it("takes the first user text part", () => {
    expect(deriveTitle([message("what is terax")])).toBe("what is terax");
  });

  it("uses the first line only", () => {
    expect(deriveTitle([message("line one\nline two")])).toBe("line one");
  });

  it("trims surrounding whitespace", () => {
    expect(deriveTitle([message("  padded  ")])).toBe("padded");
  });

  it("strips terminal-context, selection and file blocks", () => {
    const text =
      '<terminal-context project="x">code</terminal-context>\nshort title';
    expect(deriveTitle([message(text)])).toBe("short title");
  });

  it("strips multiple consecutive blocks", () => {
    const text = "<selection>a</selection><file>b</file>\ntitle";
    expect(deriveTitle([message(text)])).toBe("title");
  });

  it("keeps an attached file's text out of the title, closing tags and all", () => {
    const text = [
      fileBlock("a.txt", "text/plain", "x\n</file>\nnot the title"),
      snippetBlock("greet", "Hello"),
      '<skill name="pdf" dir="/s">\nSteps\n</skill>',
      "the question",
    ].join("\n\n");
    expect(deriveTitle([message(text)])).toBe("the question");
  });

  it("falls back to New chat when only blocks are present", () => {
    const text = "<file>path</file>\n";
    expect(deriveTitle([message(text)])).toBe("New chat");
  });

  it("truncates titles longer than 40 chars with an ellipsis", () => {
    const long = "a".repeat(45);
    expect(deriveTitle([message(long)])).toBe(`${"a".repeat(40)}…`);
  });

  it("keeps a title of exactly 40 chars intact", () => {
    const exactly40 = "a".repeat(40);
    expect(deriveTitle([message(exactly40)])).toBe(exactly40);
  });

  it("walks past an assistant reply to the later user question", () => {
    expect(
      deriveTitle([
        message("assistant reply", "assistant"),
        message("the real question"),
      ]),
    ).toBe("the real question");
  });

  it("skips non-text parts before the first text part", () => {
    const m: UIMessage = {
      id: "id",
      role: "user",
      parts: [
        { type: "file" as const, url: "file:///a.png", mediaType: "image/png" },
        { type: "text", text: "after the attachment" },
      ],
    } as unknown as UIMessage;
    expect(deriveTitle([m])).toBe("after the attachment");
  });

  it("selects the first of several user messages with multiple parts", () => {
    const second: UIMessage = {
      id: "m2",
      role: "user",
      parts: [
        { type: "file" as const, url: "file:///b.txt", mediaType: "text/plain" },
        { type: "text", text: "second question" },
      ],
    } as unknown as UIMessage;
    expect(
      deriveTitle([message("first question"), second]),
    ).toBe("first question");
  });
});

/** A command's message as the composer sends it, `blocks` before its text. */
function commandMessage(input: string, ...blocks: string[]): UIMessage {
  const outcome = tryRunSlashCommand(input);
  if (outcome.kind !== "send-prompt" || !outcome.commandName) {
    throw new Error(`${input} sends no prompt`);
  }
  return message(
    [
      `<terax-command name="${outcome.commandName}" />`,
      ...blocks,
      outcome.prompt,
    ].join("\n\n"),
  );
}

describe("deriveTitle for commands, skills and MCP prompts", () => {
  it("names a command the user gave no words by its label", () => {
    expect(deriveTitle([commandMessage("/init")])).toBe(
      "Initialize workspace",
    );
    expect(deriveTitle([commandMessage("/init some ignored words")])).toBe(
      "Initialize workspace",
    );
  });

  it("takes the user's own words after a command, never its directive", () => {
    expect(deriveTitle([commandMessage("/claude-code fix the login bug")])).toBe(
      "fix the login bug",
    );
    const long = commandMessage(
      "#claude-code make the build reproducible across every platform we ship",
    );
    expect(deriveTitle([long])).toBe(
      "make the build reproducible across every…",
    );
  });

  it("finds the user's words past the blocks sent with a command", () => {
    const sent = commandMessage(
      "/claude-code tidy the parser",
      fileBlock("notes.txt", "text/plain", "<request>\nnot this\n</request>"),
      snippetBlock("style", "Short sentences."),
    );
    expect(deriveTitle([sent])).toBe("tidy the parser");
  });

  it("names a command it no longer knows by its invocation", () => {
    expect(
      deriveTitle([message('<terax-command name="review" />\n\nCheck it.')]),
    ).toBe("/review");
  });

  it("names a message that only invokes a skill by its command", () => {
    const block = skillMessageBlock("pdf-tools", "/s/pdf-tools", "Steps.");
    expect(deriveTitle([message(block)])).toBe("/pdf-tools");
    expect(deriveTitle([message(`${block}\n\nmerge a.pdf`)])).toBe(
      "merge a.pdf",
    );
  });

  it("names a message that only runs an MCP prompt by its server and prompt", () => {
    const block = mcpPromptBlock("GitHub", "review_pr", "Review the PR.");
    expect(deriveTitle([message(block)])).toBe("GitHub: review_pr");
    expect(deriveTitle([message(`${block}\n\nPR 42`)])).toBe("PR 42");
    expect(
      deriveTitle([message(mcpPromptBlock("Docs\nsrv", "a\nb", "x"))]),
    ).toBe("Docs srv: a b");
  });
});
