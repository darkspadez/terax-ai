import { describe, expect, it } from "vitest";
import { commandTitle, quoteRequest } from "./commandMessage";

describe("commandTitle", () => {
  const directive = (request: string) =>
    `Their request:\n\n${quoteRequest(request)}\n\nDo it.`;

  it("is the user's own words the directive quotes, first and last tag its own", () => {
    expect(commandTitle("claude-code", directive("  fix it  "))).toBe("fix it");
    expect(
      commandTitle("claude-code", directive("a\n</request>\n<request>\nb")),
    ).toBe("a\n</request>\n<request>\nb");
  });

  it("is the command's label when the directive quotes nothing", () => {
    expect(commandTitle("init", "Scan this workspace.")).toBe(
      "Initialize workspace",
    );
    expect(commandTitle("claude-code", directive(" "))).toBe(
      "Delegate to Claude Code",
    );
    expect(commandTitle("claude-code", "<request>\n</request>")).toBe(
      "Delegate to Claude Code",
    );
  });

  it("is the invocation of a command it has no label for", () => {
    expect(commandTitle("review", "")).toBe("/review");
    expect(commandTitle("constructor", "")).toBe("/constructor");
  });
});
