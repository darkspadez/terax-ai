import { isSkillsItem } from "./trust";
import type {
  InvalidSkill,
  OpenProject,
  ProjectTrustStatus,
  Skill,
  SkillSource,
  SkillsSnapshot,
} from "./types";

export type SkillGroup = {
  id: string;
  title: string;
  /** The folder it lists. */
  path: string | null;
  /** A project's trust state, its skill items only (Settings > MCP has its `.mcp.json`). */
  project: ProjectTrustStatus | null;
  skills: Skill[];
  invalid: InvalidSkill[];
};

const SOURCE_LABEL: Record<SkillSource, string> = {
  terax: "Terax",
  user: "Claude Code (~/.claude/skills)",
  "claude-project": ".claude/skills",
  "terax-project": ".terax/skills",
};

export function sourceLabel(source: SkillSource): string {
  return SOURCE_LABEL[source];
}

function folderName(root: string): string {
  const parts = root.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? root;
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

const byDir = (a: InvalidSkill, b: InvalidSkill) =>
  a.dirName < b.dirName ? -1 : a.dirName > b.dirName ? 1 : 0;

/** Settings' groups: Terax's folder, the user's `~/.claude/skills`, then each open project. */
export function skillGroups(snapshot: SkillsSnapshot): SkillGroup[] {
  const global = (source: SkillSource, path: string | null): SkillGroup => ({
    id: source,
    title: sourceLabel(source),
    path,
    project: null,
    skills: snapshot.skills.filter((s) => s.source === source).sort(byName),
    invalid: snapshot.invalid.filter((s) => s.source === source).sort(byDir),
  });
  const inProject = (project: OpenProject | null, key: string) =>
    project?.key === key;
  const groups = [
    global("terax", snapshot.teraxDir),
    global("user", snapshot.userDir),
  ];
  for (const status of snapshot.projects) {
    const key = status.project.key;
    groups.push({
      id: `project:${key}`,
      title: folderName(status.project.root),
      path: status.project.root,
      project: {
        ...status,
        items: status.items.filter((item) => isSkillsItem(item.kind)),
      },
      skills: snapshot.skills
        .filter((s) => inProject(s.project, key))
        .sort(byName),
      invalid: snapshot.invalid
        .filter((s) => inProject(s.project, key))
        .sort(byDir),
    });
  }
  return groups;
}

/** What a project skill takes the place of in its project: a global skill of the same name. */
export function overriddenGlobal(
  skill: Skill,
  snapshot: SkillsSnapshot,
): Skill | null {
  if (!skill.project || !skill.trusted || !skill.enabled) return null;
  return (
    snapshot.skills.find(
      (other) =>
        other.project === null &&
        other.name === skill.name &&
        other.enabled &&
        other.overriddenBy === null,
    ) ?? null
  );
}

/** The skill that takes `skill`'s name, for its row. */
export function overridingSkill(
  skill: Skill,
  snapshot: SkillsSnapshot,
): Skill | null {
  if (!skill.overriddenBy) return null;
  return snapshot.skills.find((s) => s.key === skill.overriddenBy) ?? null;
}
