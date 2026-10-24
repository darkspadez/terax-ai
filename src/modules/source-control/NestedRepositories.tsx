import { native } from "@/modules/ai/lib/native";
import { relativePath } from "@/modules/explorer/lib/contextActions";
import { FolderGitTwoIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";

/**
 * The repositories inside a folder that is not one itself (a folder of
 * projects), each opening in Source Control. Renders nothing until git has
 * answered, or when there are none.
 */
export function NestedRepositories({
  folder,
  onOpen,
}: {
  folder: string;
  onOpen: (repoRoot: string) => void;
}) {
  const [repos, setRepos] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    setRepos([]);
    native
      .gitDiscoverRepos(folder)
      .then((found) => {
        if (alive) setRepos(found);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [folder]);

  if (repos.length === 0) return null;
  return (
    <div className="mt-2 flex w-full max-w-64 flex-col gap-0.5 text-left">
      <div className="px-2 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/85">
        Repositories in this folder
      </div>
      {repos.map((repo) => (
        <button
          key={repo}
          type="button"
          title={repo}
          onClick={() => onOpen(repo)}
          className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-foreground/90 transition-colors hover:bg-accent/50"
        >
          <HugeiconsIcon
            icon={FolderGitTwoIcon}
            size={13}
            strokeWidth={1.85}
            className="shrink-0 text-muted-foreground"
          />
          <span className="truncate">{relativePath(folder, repo)}</span>
        </button>
      ))}
    </div>
  );
}
