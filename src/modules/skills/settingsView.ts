import type {
  InvalidSkill,
  OpenProject,
  ProjectTrustStatus,
  Skill,
  SkillSource,
  SkillsSnapshot,
  TrustItemKind,
} from "./types";

/** Items of a project Settings > Skills decides and forgets together. */
export type TrustBar = {
  id: "instructions" | "skills";
  /** The kinds it forgets. */
  kinds: TrustItemKind[];
  /** The project's trust state, with only the items of these kinds. */
  status: ProjectTrustStatus;
  accept: string;
  note: string;
};

const TRUST_BARS: Omit<TrustBar, "status">[] = [
  {
    id: "instructions",
    kinds: ["terax-md"],
    accept: "Use instructions",
    note: "The AI reads a project's TERAX.md only after you allow it. Edits made in Terax keep your answer; a change from anywhere else asks again.",
  },
  {
    id: "skills",
    kinds: ["claude-skills", "terax-skills"],
    accept: "Use skills",
    note: "The AI sees a project's skills only after you allow them, and asks again when they change.",
  },
];

/** A project's bars: its TERAX.md, then its skills, each when the project has
 *  such items (Settings > MCP has its `.mcp.json`). */
export function trustBars(status: ProjectTrustStatus): TrustBar[] {
  return TRUST_BARS.flatMap((bar) => {
    const items = status.items.filter((item) => bar.kinds.includes(item.kind));
    return items.length > 0 ? [{ ...bar, status: { ...status, items } }] : [];
  });
}

export type SkillGroup = {
  id: string;
  title: string;
  /** The folder it lists. */
  path: string | null;
  /** The open project it lists, with what Settings decides of its items. */
  project: OpenProject | null;
  trust: TrustBar[];
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
    trust: [],
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
      project: status.project,
      trust: trustBars(status),
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
