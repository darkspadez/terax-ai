import type { Tool, UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { withMcpHistoryTools } from "./mcpHistory";

const live = { description: "live" } as unknown as Tool;

function call(toolName: string, type = "dynamic-tool"): UIMessage {
  return {
    id: toolName,
    role: "assistant",
    parts: [
      {
        type,
        toolName,
        toolCallId: `c-${toolName}`,
        state: "output-available",
        input: {},
        output: null,
      } as never,
    ],
  };
}

describe("withMcpHistoryTools", () => {
  it("adds a converter for each MCP call whose tool this run does not offer", () => {
    const tools = withMcpHistoryTools(
      [call("mcp__gone__shot"), call("mcp__live__x"), call("bash_run")],
      { mcp__live__x: live },
    );
    expect(Object.keys(tools).sort()).toEqual([
      "mcp__gone__shot",
      "mcp__live__x",
    ]);
    expect(tools.mcp__live__x).toBe(live);
    expect(tools.mcp__gone__shot).toHaveProperty("toModelOutput");
    expect(tools.mcp__gone__shot).not.toHaveProperty("execute");
  });

  it("looks only at assistant tool calls", () => {
    const user: UIMessage = {
      id: "u",
      role: "user",
      parts: [{ type: "text", text: "mcp__x__y" }],
    };
    expect(withMcpHistoryTools([user], {})).toEqual({});
  });
});
