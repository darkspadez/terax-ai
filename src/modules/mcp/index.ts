import { loadWindowServers } from "./lib/configStore";
import type { McpRunTools } from "./runtime";

export { mcpCallTarget, useMcpCatalog } from "./lib/catalog";
export { isMcpToolName } from "./lib/toolNames";
export type { McpRunTools } from "./runtime";

let runtime: Promise<typeof import("./runtime")> | null = null;

/**
 * The window's MCP tools for one agent run: the configured servers and those
 * of the window's project its user allows. With no server enabled this reads
 * the configuration and nothing else: the MCP client (the SDK and the
 * runtime) loads only once a server is enabled, and servers start on the
 * first run that needs them. A failure here never fails the run; it costs
 * the run its MCP tools, and the server's status says why.
 */
export async function mcpToolsForRun(
  opts: { signal?: AbortSignal; onWaiting?: () => void } = {},
): Promise<McpRunTools | null> {
  try {
    const servers = await loadWindowServers();
    if (!runtime && !servers.some((s) => s.enabled)) return null;
    runtime ??= import("./runtime").catch((error) => {
      runtime = null;
      throw error;
    });
    const result = await (await runtime).toolsForRun(servers, opts);
    return Object.keys(result.tools).length > 0 ? result : null;
  } catch (error) {
    console.warn("[mcp] tools unavailable for this run", error);
    return null;
  }
}
