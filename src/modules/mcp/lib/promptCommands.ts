import type { McpPromptEntry, McpServerExtras } from "./extrasCatalog";

/**
 * MCP prompts as composer commands: `/<server>:<prompt>`. Both parts are
 * lowercase `[a-z0-9_.-]`, so a prompt command always holds a colon and
 * never clashes with a built-in command or a skill's `/name`; a name the
 * slug makes ambiguous gets a number. Pure.
 */

export type McpPromptCommand = {
  /** What follows the slash: `server:prompt`. */
  command: string;
  serverId: string;
  serverName: string;
  prompt: McpPromptEntry;
};

const MAX_SERVER_SLUG = 32;
const MAX_PROMPT_SLUG = 64;

export function commandSlug(text: string, max: number, fallback: string) {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, max)
    .replace(/[-.]+$/, "");
  return slug || fallback;
}

function unique(base: string, taken: Set<string>): string {
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  taken.add(name);
  return name;
}

/** Every prompt of `servers` as a command, in the servers' order. */
export function promptCommands(
  servers: readonly McpServerExtras[],
): McpPromptCommand[] {
  const out: McpPromptCommand[] = [];
  const serverSlugs = new Set<string>();
  for (const server of servers) {
    if (server.prompts.length === 0) continue;
    const serverSlug = unique(
      commandSlug(server.serverName, MAX_SERVER_SLUG, "server"),
      serverSlugs,
    );
    const promptSlugs = new Set<string>();
    for (const prompt of server.prompts) {
      const promptSlug = unique(
        commandSlug(prompt.name, MAX_PROMPT_SLUG, "prompt"),
        promptSlugs,
      );
      out.push({
        command: `${serverSlug}:${promptSlug}`,
        serverId: server.serverId,
        serverName: server.serverName,
        prompt,
      });
    }
  }
  return out;
}

/** The commands a `/` query shows: by command, title or description. */
export function matchPromptCommands(
  commands: readonly McpPromptCommand[],
  query: string,
): McpPromptCommand[] {
  const q = query.toLowerCase();
  if (!q) return [...commands];
  return commands.filter(
    (c) =>
      c.command.includes(q) ||
      (c.prompt.title?.toLowerCase().includes(q) ?? false) ||
      (c.prompt.description?.toLowerCase().includes(q) ?? false),
  );
}
