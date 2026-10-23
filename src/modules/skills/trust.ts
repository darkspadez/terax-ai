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

/** Whether an item holds skills (rather than a project's MCP servers). */
export function isSkillsItem(kind: TrustItemKind): boolean {
  return kind === "claude-skills" || kind === "terax-skills";
}

/** The prompt's question, naming what the project provides. */
export function promptTitle(
  items: readonly TrustItem[],
  folder: string,
): string {
  const skills = items.some((item) => isSkillsItem(item.kind));
  const servers = items.some((item) => !isSkillsItem(item.kind));
  const what =
    skills && servers
      ? "the skills and MCP servers"
      : servers
        ? "the MCP servers"
        : "the skills";
  return `Use ${what} in ${folder}?`;
}

/** The accept button's label. */
export function acceptLabel(items: readonly TrustItem[]): string {
  if (items.length > 1) return "Use selected";
  return items.some((item) => !isSkillsItem(item.kind))
    ? "Use servers"
    : "Use skills";
}
