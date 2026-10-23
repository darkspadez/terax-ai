import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { WorkspaceEnv } from "@/modules/workspace";
import type {
  InstallPreview,
  InstallResult,
  LoadedSkill,
  ProjectInput,
  ProjectTrustStatus,
  RecordedTrust,
  SkillFileRead,
  SkillRef,
  SkillsSnapshot,
  TrustItemKind,
} from "./types";

/** `skills::CHANGED_EVENT`: skills on disk or their settings changed. */
const SKILLS_CHANGED_EVENT = "skills:changed";
/** `project_trust::CHANGED_EVENT`: a trust decision was made or revoked. */
const TRUST_CHANGED_EVENT = "project-trust:changed";

/** The skills a conversation working in `project` may use. */
export function listSkills(
  project: ProjectInput | null,
): Promise<SkillsSnapshot> {
  return invoke<SkillsSnapshot>("skills_list", { project, all: false });
}

/** Every skill, with the open projects' trust states, for Settings. */
export function listAllSkills(): Promise<SkillsSnapshot> {
  return invoke<SkillsSnapshot>("skills_list", { project: null, all: true });
}

export function loadSkill(skill: SkillRef): Promise<LoadedSkill> {
  return invoke<LoadedSkill>("skills_load", { skill });
}

export function readSkillFile(
  skill: SkillRef,
  path: string,
): Promise<SkillFileRead> {
  return invoke<SkillFileRead>("skills_read_file", { skill, path });
}

export function setSkillEnabled(key: string, enabled: boolean): Promise<void> {
  return invoke("skills_set_enabled", { key, enabled });
}

/** Creates a skill in Oarlock's folder; returns its id. */
export function createSkill(
  name: string,
  description: string,
): Promise<string> {
  return invoke<string>("skills_create", { name, description });
}

/** Opens the skill's SKILL.md in the editor of the app window in front. */
export function editSkill(skill: SkillRef): Promise<void> {
  return invoke("skills_edit", { skill });
}

export function deleteSkill(
  id: string,
  permanent: boolean,
): Promise<{ trashed: boolean }> {
  return invoke("skills_delete", { id, permanent });
}

export function installFromGit(url: string): Promise<InstallPreview> {
  return invoke<InstallPreview>("skills_install_git", { url });
}

/** Asks for a zip with the system picker; null when the user cancels. */
export function installFromZip(): Promise<InstallPreview | null> {
  return invoke<InstallPreview | null>("skills_install_zip");
}

export function commitInstall(
  token: string,
  names: string[],
  replace: string[],
): Promise<InstallResult> {
  return invoke<InstallResult>("skills_install_commit", {
    token,
    names,
    replace,
  });
}

export function cancelInstall(token: string): Promise<void> {
  return invoke("skills_install_cancel", { token });
}

/** The trust state of the project this window works in, which it registers. */
export function projectTrustStatus(
  root: string,
  workspace: WorkspaceEnv,
): Promise<ProjectTrustStatus | null> {
  return invoke<ProjectTrustStatus | null>("project_trust_status", {
    root,
    workspace,
  });
}

export type TrustDecision = {
  kind: TrustItemKind;
  hash: string;
  allow: boolean;
};

export function decideProjectTrust(
  project: ProjectInput,
  decisions: TrustDecision[],
): Promise<ProjectTrustStatus> {
  return invoke<ProjectTrustStatus>("project_trust_decide", {
    root: project.root,
    workspace: project.workspace,
    decisions,
  });
}

export function listProjectTrust(): Promise<RecordedTrust[]> {
  return invoke<RecordedTrust[]>("project_trust_list");
}

export function revokeProjectTrust(
  key: string,
  kind: TrustItemKind | null,
): Promise<void> {
  return invoke("project_trust_revoke", { key, kind });
}

/** Calls `onChange` when skills or trust decisions change, in any window. */
export async function onSkillsChanged(
  onChange: () => void,
): Promise<UnlistenFn> {
  const stops = await Promise.all([
    listen(SKILLS_CHANGED_EVENT, onChange),
    listen(TRUST_CHANGED_EVENT, onChange),
  ]);
  return () => {
    for (const stop of stops) stop();
  };
}
