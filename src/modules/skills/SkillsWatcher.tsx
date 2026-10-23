import { lazy, Suspense, useEffect, useState } from "react";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import { onSkillsChanged, projectTrustStatus } from "./api";
import { useSkillEditRequests } from "./useSkillEditRequests";
import { askingItems, promptKey } from "./trust";
import type { ProjectTrustStatus } from "./types";

const ProjectTrustPrompt = lazy(() =>
  import("./ProjectTrustPrompt").then((m) => ({
    default: m.ProjectTrustPrompt,
  })),
);

// A `cd` through several folders asks only about where it ends.
const SETTLE_MS = 400;

type Props = {
  /** The project this window works in. */
  root: string | null;
  openFileTab: (path: string) => void;
};

/**
 * Registers the project this window works in and asks once whether to trust what it provides
 * (its skills), again when that content changes; opens the SKILL.md Settings hands over. The
 * prompt loads only when needed.
 */
export function SkillsWatcher({ root, openFileTab }: Props) {
  useSkillEditRequests(openFileTab);
  const env = useWorkspaceEnvStore((s) => s.env);
  const [status, setStatus] = useState<ProjectTrustStatus | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let timer = 0;
    let stop: (() => void) | undefined;
    const check = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        projectTrustStatus(root ?? "", env).then(
          (next) => {
            if (alive) setStatus(next);
          },
          () => {
            if (alive) setStatus(null);
          },
        );
      }, SETTLE_MS);
    };
    check();
    void onSkillsChanged(check).then((unlisten) => {
      if (alive) stop = unlisten;
      else unlisten();
    });
    return () => {
      alive = false;
      window.clearTimeout(timer);
      stop?.();
    };
  }, [root, env]);

  if (!status || askingItems(status).length === 0) return null;
  const key = promptKey(status);
  if (key === dismissed) return null;
  return (
    <Suspense fallback={null}>
      <ProjectTrustPrompt
        key={key}
        status={status}
        onDismiss={() => setDismissed(key)}
        onDecided={setStatus}
      />
    </Suspense>
  );
}
