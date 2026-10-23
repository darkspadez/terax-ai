import { dynamicTool, jsonSchema, type Tool } from "ai";
import type { McpServerConfig } from "../lib/config";
import { mcpToModelOutput } from "../lib/results";
import type { McpExtras } from "./extras";
import { McpManager, type OfferedTool } from "./manager";

export type { CompletionRef } from "./extras";

export type McpToolAccess = { trusted: boolean; alwaysAllow: boolean };

/** What one agent run gets from the window's MCP servers. */
export type McpRunTools = {
  tools: Record<string, Tool>;
  /** Per tool: what its approval gate depends on. Never-allowed tools are absent. */
  access: Record<string, McpToolAccess>;
  instructions: { server: string; text: string }[];
};

let manager: McpManager | null = null;

function agentTool(manager: McpManager, offered: OfferedTool): Tool {
  const { info } = offered;
  return dynamicTool({
    description: offered.description,
    inputSchema: jsonSchema(offered.inputSchema),
    metadata: {
      mcp: {
        serverId: info.serverId,
        server: info.serverName,
        tool: info.tool,
      },
    },
    execute: (input, { abortSignal }) =>
      manager.callTool(info.serverId, info.tool, input, abortSignal),
    toModelOutput: ({ output }) => mcpToModelOutput(output),
  });
}

/**
 * Brings this window's servers in line with `servers` (starting them the
 * first time), waits briefly for any still starting, and returns their tools.
 */
export async function toolsForRun(
  servers: readonly McpServerConfig[],
  opts: { signal?: AbortSignal; onWaiting?: () => void } = {},
): Promise<McpRunTools> {
  manager ??= new McpManager();
  const current = manager;
  await current.listen();
  current.sync(servers);
  if (current.hasStarting()) {
    opts.onWaiting?.();
    await current.waitForStarting(opts.signal);
  }
  const tools: Record<string, Tool> = {};
  const access: Record<string, McpToolAccess> = {};
  for (const offered of current.offeredTools()) {
    tools[offered.info.name] = agentTool(current, offered);
    access[offered.info.name] = {
      trusted: offered.info.trusted,
      alwaysAllow: offered.alwaysAllow,
    };
  }
  return { tools, access, instructions: current.instructions() };
}

/**
 * Brings this window's servers in line with `servers` for the composer (its
 * `@` and `/` lists) and waits briefly for any still starting.
 */
export async function prepareExtras(
  servers: readonly McpServerConfig[],
  onWaiting?: () => void,
): Promise<void> {
  manager ??= new McpManager();
  const current = manager;
  await current.listen();
  current.sync(servers);
  if (current.hasStarting()) {
    onWaiting?.();
    await current.waitForStarting();
  }
}

/** Resources, prompts and completions of the window's running servers. */
export function extras(): McpExtras {
  manager ??= new McpManager();
  return manager.extras;
}
