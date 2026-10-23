/**
 * The names MCP tools get in the agent: `mcp__<server>__<tool>`. Providers
 * take `[A-Za-z0-9_-]{1,64}`, so both parts are sanitized, a name that would
 * be longer is cut and given a short hash of what it stands for, and a name
 * already taken gets the same suffix. The mapping back to the server and tool
 * is kept, never parsed out of the name.
 */

export const MCP_TOOL_PREFIX = "mcp__";
export const MAX_TOOL_NAME_LENGTH = 64;

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

export function sanitizeNamePart(part: string): string {
  const cleaned = part.replace(/[^A-Za-z0-9_-]/g, "_");
  return cleaned.length > 0 ? cleaned : "_";
}

/** FNV-1a, as six base-36 characters: stable across runs and platforms. */
export function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0").slice(-6);
}

export type ToolNameEntry = {
  serverId: string;
  serverName: string;
  tool: string;
};

/**
 * Exposed names for `entries`, in order (servers in configuration order,
 * each server's tools in the order it lists them), so the same lists always
 * give the same names. Keyed by `toolKey(serverId, tool)`.
 */
export function exposedToolNames(
  entries: readonly ToolNameEntry[],
): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const entry of entries) {
    const key = toolKey(entry.serverId, entry.tool);
    if (out.has(key)) continue;
    const base = `${MCP_TOOL_PREFIX}${sanitizeNamePart(entry.serverName)}__${sanitizeNamePart(entry.tool)}`;
    let name = base;
    if (name.length > MAX_TOOL_NAME_LENGTH || taken.has(name)) {
      const suffix = `_${shortHash(key)}`;
      name = `${base.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
      for (let n = 2; taken.has(name); n++) {
        const counted = `${suffix}${n}`;
        name = `${base.slice(0, MAX_TOOL_NAME_LENGTH - counted.length)}${counted}`;
      }
    }
    taken.add(name);
    out.set(key, name);
  }
  return out;
}

export function toolKey(serverId: string, tool: string): string {
  return `${serverId}\u0000${tool}`;
}
