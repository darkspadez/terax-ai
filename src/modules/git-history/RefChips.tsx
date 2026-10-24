import { cn } from "@/lib/utils";
import type { GitLogRef } from "@/modules/ai/lib/native";
import { Tag01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { splitRefs } from "./lib/refs";

const KIND_LABEL: Record<GitLogRef["kind"], string> = {
  head: "Detached HEAD",
  branch: "Branch",
  tag: "Tag",
  remote: "Remote branch",
};

function chipTone(gitRef: GitLogRef): string {
  if (gitRef.kind === "tag") {
    return "bg-amber-500/12 text-amber-700 dark:text-amber-300";
  }
  if (gitRef.kind === "remote") return "bg-foreground/6 text-muted-foreground";
  if (gitRef.head) return "bg-primary/18 font-semibold text-primary";
  return "bg-primary/8 text-primary/90";
}

function chipTitle(gitRef: GitLogRef): string {
  if (gitRef.kind === "head") return KIND_LABEL.head;
  const label = `${KIND_LABEL[gitRef.kind]} ${gitRef.name}`;
  return gitRef.head ? `${label} (HEAD)` : label;
}

const CHIP =
  "inline-flex h-4 max-w-36 shrink-0 items-center gap-0.5 rounded px-1 text-[10px] font-medium leading-none";

/**
 * The branches and tags on a commit. With `max`, only that many fit and the
 * rest sit behind a count whose tooltip names them.
 */
export function RefChips({
  refs,
  max,
  className,
}: {
  refs: readonly GitLogRef[];
  max?: number;
  className?: string;
}) {
  if (refs.length === 0) return null;
  const { shown, hidden } =
    max === undefined ? { shown: refs, hidden: [] } : splitRefs(refs, max);
  return (
    <span className={cn("flex min-w-0 items-center gap-1", className)}>
      {shown.map((gitRef) => (
        <span
          key={`${gitRef.kind}:${gitRef.name}`}
          className={cn(CHIP, chipTone(gitRef))}
          title={chipTitle(gitRef)}
        >
          {gitRef.kind === "tag" ? (
            <HugeiconsIcon
              icon={Tag01Icon}
              size={9}
              strokeWidth={2}
              className="shrink-0"
            />
          ) : null}
          <span className="truncate">{gitRef.name}</span>
        </span>
      ))}
      {hidden.length > 0 ? (
        <span
          className={cn(CHIP, "bg-foreground/6 text-muted-foreground")}
          title={hidden.map(chipTitle).join("\n")}
        >
          +{hidden.length}
        </span>
      ) : null}
    </span>
  );
}
