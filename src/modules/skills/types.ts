import type { WorkspaceEnv } from "@/modules/workspace";

/** Where a skill comes from (`skills::discover::SourceKind`). */
export type SkillSource = "terax" | "user" | "claude-project" | "terax-project";

/** A project a window has open (`project_trust::OpenProject`). */
export type OpenProject = {
  /** The real root: the key of its trust record. */
  key: string;
  /** The root as the window spells it. */
  root: string;
  workspace: WorkspaceEnv;
};

export type Skill = {
  /** `<source>/<folder>`; a project skill is named by it and its project. */
  id: string;
  /** What its on/off state is kept under. */
  key: string;
  source: SkillSource;
  project: OpenProject | null;
  name: string;
  description: string;
  whenToUse: string | null;
  argumentHint: string | null;
  license: string | null;
  compatibility: string | null;
  /** Its folder, spelled for the user and the model. */
  dir: string;
  modelInvocable: boolean;
  userInvocable: boolean;
  enabled: boolean;
  /** False for a project skill whose project content is not trusted. */
  trusted: boolean;
  /** The key of the skill that takes this name instead. */
  overriddenBy: string | null;
  warnings: string[];
};

export type InvalidSkill = {
  id: string;
  source: SkillSource;
  project: OpenProject | null;
  dirName: string;
  dir: string;
  errors: string[];
};

export type TrustItemKind =
  | "terax-md"
  | "claude-skills"
  | "terax-skills"
  | "mcp-json";

type TrustItemState =
  | "allowed"
  | "denied"
  | "pending"
  | "changed"
  | "unreviewable";

type TrustEntry = { title: string; detail: string };

export type TrustItem = {
  kind: TrustItemKind;
  label: string;
  path: string;
  hash: string | null;
  problem: string | null;
  entries: TrustEntry[];
  state: TrustItemState;
};

export type ProjectTrustStatus = {
  project: OpenProject;
  items: TrustItem[];
};

export type SkillsSnapshot = {
  teraxDir: string;
  userDir: string | null;
  skills: Skill[];
  invalid: InvalidSkill[];
  projects: ProjectTrustStatus[];
};

export type LoadedSkill = {
  id: string;
  name: string;
  dir: string;
  body: string;
  files: string[];
  filesTruncated: boolean;
};

export type SkillFileRead =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

export type InstallCandidate = {
  name: string;
  description: string | null;
  location: string;
  errors: string[];
  warnings: string[];
  exists: boolean;
};

export type InstallPreview = {
  token: string;
  source: string;
  candidates: InstallCandidate[];
};

export type InstallResult = {
  installed: string[];
  /** `name: reason` of each picked skill that could not be installed. */
  failed: string[];
};

export type RecordedTrust = {
  key: string;
  root: string;
  exists: boolean;
  items: { kind: string; label: string; allowed: boolean; at: number }[];
};

/** A project as a command takes it. */
export type ProjectInput = { root: string; workspace: WorkspaceEnv };

/** A skill as a command takes it. */
export type SkillRef = { id: string; project: ProjectInput | null };

export function skillRef(skill: Pick<Skill, "id" | "project">): SkillRef {
  return {
    id: skill.id,
    project: skill.project
      ? { root: skill.project.root, workspace: skill.project.workspace }
      : null,
  };
}

/** A skill a conversation may use: on, trusted and not overridden. */
export function isUsable(skill: Skill): boolean {
  return skill.enabled && skill.trusted && skill.overriddenBy === null;
}
