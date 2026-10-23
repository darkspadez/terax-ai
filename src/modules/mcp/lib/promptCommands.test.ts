import { describe, expect, it } from "vitest";
import type { McpServerExtras } from "./extrasCatalog";
import {
  commandSlug,
  matchPromptCommands,
  promptCommands,
} from "./promptCommands";

function server(
  serverId: string,
  serverName: string,
  prompts: string[],
): McpServerExtras {
  return {
    serverId,
    serverName,
    resources: [],
    templates: [],
    prompts: prompts.map((name) => ({ name, arguments: [] })),
    completions: false,
  };
}

describe("promptCommands", () => {
  it("names each prompt /server:prompt, in lowercase slugs", () => {
    const commands = promptCommands([
      server("a", "My Server", ["Summarize Text", "simple_prompt"]),
    ]);
    expect(commands.map((c) => c.command)).toEqual([
      "my-server:summarize-text",
      "my-server:simple_prompt",
    ]);
    expect(commands[0]).toMatchObject({
      serverId: "a",
      serverName: "My Server",
    });
  });

  it("numbers names that the slugs make ambiguous", () => {
    const commands = promptCommands([
      server("a", "Git", ["Review", "review"]),
      server("b", "git", ["review"]),
      server("c", "!!!", ["???"]),
    ]);
    expect(commands.map((c) => c.command)).toEqual([
      "git:review",
      "git:review-2",
      "git-2:review",
      "server:prompt",
    ]);
  });

  it("always holds a colon, so it never clashes with a command or a skill", () => {
    for (const c of promptCommands([server("a", "init", ["plan"])])) {
      expect(c.command).toContain(":");
    }
  });

  it("skips servers without prompts", () => {
    expect(promptCommands([server("a", "x", [])])).toEqual([]);
  });
});

describe("commandSlug", () => {
  it("trims separators and caps the length", () => {
    expect(commandSlug("--a b--", 10, "x")).toBe("a-b");
    expect(commandSlug("abcdef-ghi", 7, "x")).toBe("abcdef");
    expect(commandSlug("", 5, "fallback")).toBe("fallback");
  });
});

describe("matchPromptCommands", () => {
  it("matches the command, the title and the description", () => {
    const commands = promptCommands([
      {
        ...server("a", "docs", []),
        prompts: [
          { name: "a", title: "Explain", arguments: [] },
          { name: "b", description: "Writes tests", arguments: [] },
        ],
      },
    ]);
    expect(matchPromptCommands(commands, "").map((c) => c.command)).toEqual([
      "docs:a",
      "docs:b",
    ]);
    expect(matchPromptCommands(commands, "explain")).toHaveLength(1);
    expect(matchPromptCommands(commands, "tests")[0].command).toBe("docs:b");
    expect(matchPromptCommands(commands, "docs:b")).toHaveLength(1);
  });
});
