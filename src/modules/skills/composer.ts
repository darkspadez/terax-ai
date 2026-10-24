import type { WorkspaceEnv } from "@/modules/workspace";
import { listSkills, loadSkill } from "./api";
import { userSkills } from "./catalog";
import {
  expandSkillText,
  pathForWorkspace,
  skillMessageBlock,
} from "./invocation";
import { skillRef } from "./types";

export type SkillInvocation =
  | { kind: "block"; block: string }
  /** No skill of that name the user may call here: the text is sent as written. */
  | { kind: "missing" };

/**
 * `/name args` in the composer: loads the skill the user may call by that name in the window's
 * workspace and returns the block that goes before their message.
 */
export async function skillInvocation(
  name: string,
  args: string,
  root: string | null,
  env: WorkspaceEnv,
): Promise<SkillInvocation> {
  const snapshot = await listSkills(root ? { root, workspace: env } : null);
  const skill = userSkills(snapshot.skills).find((s) => s.name === name);
  if (!skill) return { kind: "missing" };
  const loaded = await loadSkill(skillRef(skill));
  const dir = pathForWorkspace(loaded.dir, env);
  const content = expandSkillText(loaded.body, { dir, args });
  return { kind: "block", block: skillMessageBlock(skill.name, dir, content) };
}
