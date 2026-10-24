import type {
  OpenProject,
  ProjectTrustStatus,
  Skill,
  TrustItem,
} from "./types";

export const PROJECT: OpenProject = {
  key: "/real/proj",
  root: "/work/proj",
  workspace: { kind: "local" },
};

export function skill(overrides: Partial<Skill> = {}): Skill {
  const name = overrides.name ?? "pdf";
  const source = overrides.source ?? "oarlock";
  const id = overrides.id ?? `${source}/${name}`;
  return {
    id,
    key: id,
    source,
    project: null,
    name,
    description: `${name} does things`,
    whenToUse: null,
    argumentHint: null,
    license: null,
    compatibility: null,
    dir: `/skills/${name}`,
    modelInvocable: true,
    userInvocable: true,
    enabled: true,
    trusted: true,
    overriddenBy: null,
    warnings: [],
    ...overrides,
  };
}

export function trustItem(overrides: Partial<TrustItem> = {}): TrustItem {
  return {
    kind: "claude-skills",
    label: "Skills in .claude/skills",
    path: "/work/proj/.claude/skills",
    hash: "h1",
    problem: null,
    entries: [{ title: "deploy", detail: "Deploys the app." }],
    state: "pending",
    ...overrides,
  };
}

export function trustStatus(items: TrustItem[]): ProjectTrustStatus {
  return { project: PROJECT, items };
}
