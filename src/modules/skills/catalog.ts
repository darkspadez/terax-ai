import type { WorkspaceEnv } from "@/modules/workspace";
import { listSkills } from "./api";
import {
  isUsable,
  type ProjectInput,
  type Skill,
  type SkillsSnapshot,
} from "./types";

/** The skills one agent run may use, with the project and environment they were listed for. */
export type AgentSkills = {
  skills: Skill[];
  project: ProjectInput | null;
  env: WorkspaceEnv;
};

export const NO_AGENT_SKILLS: AgentSkills = {
  skills: [],
  project: null,
  env: { kind: "local" },
};

export function agentSkillsFrom(
  snapshot: SkillsSnapshot,
  project: ProjectInput | null,
  env: WorkspaceEnv,
): AgentSkills {
  return { skills: snapshot.skills.filter(isUsable), project, env };
}

/** Lists the skills a conversation working in `root` may use; none when listing fails. */
export async function loadAgentSkills(
  root: string | null,
  env: WorkspaceEnv,
): Promise<AgentSkills> {
  const project = root ? { root, workspace: env } : null;
  try {
    return agentSkillsFrom(await listSkills(project), project, env);
  } catch (error) {
    console.warn("[oarlock] skills unavailable:", error);
    return { skills: [], project, env };
  }
}

/** The skills listed for the model: those it may load on its own. */
export function modelSkills(skills: AgentSkills): Skill[] {
  return skills.skills.filter((skill) => skill.modelInvocable);
}

/** The skills the user may call with `/name`. */
export function userSkills(skills: readonly Skill[]): Skill[] {
  return skills.filter((skill) => isUsable(skill) && skill.userInvocable);
}
