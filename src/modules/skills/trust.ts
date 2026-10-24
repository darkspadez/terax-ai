import type { TrustDecision } from "./api";
import type { ProjectTrustStatus, TrustItem, TrustItemKind } from "./types";

/** The items the trust prompt asks about: never decided, or changed since. */
export function askingItems(status: ProjectTrustStatus): TrustItem[] {
  return status.items.filter(
    (item) => item.state === "pending" || item.state === "changed",
  );
}

/** Identifies one prompt: the project and the content it asks about. A prompt the user
 *  closed stays closed until that content changes. */
export function promptKey(status: ProjectTrustStatus): string {
  const items = askingItems(status)
    .map((item) => `${item.kind}:${item.hash ?? ""}`)
    .join(",");
  return `${status.project.key}|${items}`;
}

/** The answer for each item asked about: allowed when its kind is in `allowed`. Each carries
 *  the hash the user saw, so content that changed meanwhile is asked about again. */
export function trustDecisions(
  items: readonly TrustItem[],
  allowed: ReadonlySet<TrustItemKind>,
): TrustDecision[] {
  return items.flatMap((item) =>
    item.hash
      ? [{ kind: item.kind, hash: item.hash, allow: allowed.has(item.kind) }]
      : [],
  );
}

/** Whether an item holds skills (rather than instructions or MCP servers). */
export function isSkillsItem(kind: TrustItemKind): boolean {
  return kind === "claude-skills" || kind === "oarlock-skills";
}

/** What a project provides, as the prompt names it, in the prompt's order. */
type ItemGroup = "instructions" | "skills" | "servers";

const GROUP_ORDER: readonly ItemGroup[] = ["instructions", "skills", "servers"];

const GROUP_NAME: Record<ItemGroup, string> = {
  instructions: "project instructions",
  skills: "skills",
  servers: "MCP servers",
};

const GROUP_ACCEPT: Record<ItemGroup, string> = {
  instructions: "Use instructions",
  skills: "Use skills",
  servers: "Use servers",
};

function itemGroup(kind: TrustItemKind): ItemGroup {
  if (kind === "agents-md") return "instructions";
  return isSkillsItem(kind) ? "skills" : "servers";
}

/** Which kinds of content the items provide: the prompt explains each one asked about. */
export function promptGroups(
  items: readonly TrustItem[],
): Record<ItemGroup, boolean> {
  const has = (group: ItemGroup) =>
    items.some((item) => itemGroup(item.kind) === group);
  return {
    instructions: has("instructions"),
    skills: has("skills"),
    servers: has("servers"),
  };
}

function listText(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The prompt's question, naming what the project provides. */
export function promptTitle(
  items: readonly TrustItem[],
  folder: string,
): string {
  const groups = promptGroups(items);
  const names = GROUP_ORDER.filter((group) => groups[group]).map(
    (group) => GROUP_NAME[group],
  );
  return `Use the ${listText(names)} in ${folder}?`;
}

/** The accept button's label. */
export function acceptLabel(items: readonly TrustItem[]): string {
  if (items.length !== 1) return "Use selected";
  return GROUP_ACCEPT[itemGroup(items[0].kind)];
}
