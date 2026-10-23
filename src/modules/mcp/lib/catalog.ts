import { create } from "zustand";
import type { McpAnnotations } from "./toolSchema";

/** An MCP tool as this window offers it to the agent. */
export type McpToolInfo = {
  /** The name the agent calls it by (`mcp__<server>__<tool>`). */
  name: string;
  serverId: string;
  serverName: string;
  /** The server's own name for it. */
  tool: string;
  title?: string;
  annotations?: McpAnnotations;
  trusted: boolean;
};

type CatalogState = {
  tools: Record<string, McpToolInfo>;
  setTools: (tools: Record<string, McpToolInfo>) => void;
};

/**
 * The window's live MCP tools, kept by the client runtime and read by the
 * chat (the approval card names the server and shows its annotations). Light
 * on purpose: the chat imports it without loading the MCP client.
 */
export const useMcpCatalog = create<CatalogState>((set) => ({
  tools: {},
  setTools: (tools) => set({ tools }),
}));

/**
 * Who a tool call went to: the live catalog, else the metadata the call
 * carries (`toolMetadata.mcp`, set on every MCP tool), for history.
 */
export function mcpCallTarget(
  name: string,
  toolMetadata: unknown,
): { serverName: string; tool: string } | null {
  const live = useMcpCatalog.getState().tools[name];
  if (live) return { serverName: live.serverName, tool: live.tool };
  const meta =
    typeof toolMetadata === "object" && toolMetadata !== null
      ? (toolMetadata as { mcp?: unknown }).mcp
      : undefined;
  if (typeof meta === "object" && meta !== null) {
    const { server, tool } = meta as { server?: unknown; tool?: unknown };
    if (typeof server === "string" && typeof tool === "string") {
      return { serverName: server, tool };
    }
  }
  return null;
}
