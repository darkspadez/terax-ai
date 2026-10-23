import type {
  McpResourceEntry,
  McpServerExtras,
  McpTemplateEntry,
} from "./extrasCatalog";

/**
 * The composer's `@` picker, MCP part: one section per running server with
 * the resources and templates that match what follows the `@`. Pure.
 */

export type McpPickerItem =
  | {
      kind: "resource";
      serverId: string;
      serverName: string;
      resource: McpResourceEntry;
    }
  | {
      kind: "template";
      serverId: string;
      serverName: string;
      template: McpTemplateEntry;
    };

export type McpPickerSection = {
  serverId: string;
  serverName: string;
  items: McpPickerItem[];
  /** More matched than the section shows. */
  truncated: boolean;
};

/** Items one server's section shows at most; typing narrows them. */
const MCP_PICKER_CAP = 30;

function matches(
  entry: { name: string; title?: string },
  address: string,
  q: string,
): boolean {
  return (
    !q ||
    entry.name.toLowerCase().includes(q) ||
    (entry.title?.toLowerCase().includes(q) ?? false) ||
    address.toLowerCase().includes(q)
  );
}

export function mcpPickerSections(
  servers: readonly McpServerExtras[],
  query: string,
  cap = MCP_PICKER_CAP,
): McpPickerSection[] {
  const q = query.trim().toLowerCase();
  const sections: McpPickerSection[] = [];
  for (const server of servers) {
    const matched: McpPickerItem[] = [];
    let total = 0;
    const base = { serverId: server.serverId, serverName: server.serverName };
    for (const resource of server.resources) {
      if (!matches(resource, resource.uri, q)) continue;
      total += 1;
      if (matched.length < cap) {
        matched.push({ kind: "resource", ...base, resource });
      }
    }
    for (const template of server.templates) {
      if (!matches(template, template.uriTemplate, q)) continue;
      total += 1;
      if (matched.length < cap) {
        matched.push({ kind: "template", ...base, template });
      }
    }
    if (matched.length > 0) {
      sections.push({ ...base, items: matched, truncated: total > cap });
    }
  }
  return sections;
}
