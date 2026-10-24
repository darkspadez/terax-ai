import { useEffect, useState } from "react";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { listSkills } from "./api";
import { userSkills } from "./catalog";
import type { Skill } from "./types";

/** The skills the user may call with `/name` in this workspace, read while `active`. */
export function useUserSkills(active: boolean, root: string | null): Skill[] {
  const [skills, setSkills] = useState<Skill[]>([]);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const env = currentWorkspaceEnv();
    listSkills(root ? { root, workspace: env } : null)
      .then((snapshot) => {
        if (alive) setSkills(userSkills(snapshot.skills));
      })
      .catch(() => {
        if (alive) setSkills([]);
      });
    return () => {
      alive = false;
    };
  }, [active, root]);
  return skills;
}
