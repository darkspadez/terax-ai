import { mcpToModelOutput } from "@/modules/mcp/lib/results";
import { isMcpToolName } from "@/modules/mcp/lib/toolNames";
import { dynamicTool, jsonSchema, type Tool, type UIMessage } from "ai";

/**
 * The tools history is converted with: the run's own, plus a converter for
 * every MCP call in the conversation whose tool this run does not offer (its
 * server stopped, was renamed or the tool is never allowed now). Such a call
 * still reaches the model as text and images, not as a JSON dump carrying
 * base64 images.
 */
export function withMcpHistoryTools(
  messages: readonly UIMessage[],
  tools: Readonly<Record<string, Tool>>,
): Record<string, Tool> {
  const out: Record<string, Tool> = { ...tools };
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "dynamic-tool") continue;
      const name = part.toolName;
      // MCP names never meet a prototype property, so a lookup is enough.
      if (!isMcpToolName(name) || out[name] !== undefined) continue;
      out[name] = dynamicTool({
        inputSchema: jsonSchema({ type: "object" }),
        outputSchema: jsonSchema({}),
        toModelOutput: ({ output }) => mcpToModelOutput(output),
      });
    }
  }
  return out;
}
