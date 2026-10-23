import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { type GitLogEntry, native } from "@/modules/ai/lib/native";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { showFileError } from "@/modules/mac-privacy";

type Props = {
  repoRoot: string;
  /** The commit to undo, with the branch it is the tip of; null when closed. */
  target: { commit: GitLogEntry; branch: string } | null;
  onClose: () => void;
  onUndone: () => void;
};

/**
 * Confirms undoing the newest commit of a branch (`git reset --soft HEAD~1`).
 * The changes go back to the staged list, so nothing is lost, but a commit
 * that is already on a remote branch gets a warning first.
 */
export function UndoCommitDialog({
  repoRoot,
  target,
  onClose,
  onUndone,
}: Props) {
  const sha = target?.commit.sha ?? null;
  // undefined while asking git, null when no remote branch has the commit.
  const [pushedTo, setPushedTo] = useState<string | null | undefined>();

  useEffect(() => {
    setPushedTo(undefined);
    if (!sha) return;
    let alive = true;
    native
      .gitCommitOnRemote(repoRoot, sha)
      .then((remote) => {
        if (alive) setPushedTo(remote);
      })
      .catch(() => {
        if (alive) setPushedTo(null);
      });
    return () => {
      alive = false;
    };
  }, [repoRoot, sha]);

  const undo = async () => {
    if (!target) return;
    const { commit, branch } = target;
    onClose();
    try {
      await native.gitUndoCommit(repoRoot, commit.sha);
      toast.success(`Undid ${commit.shortSha} on ${branch}`, {
        description: "Its changes are staged again.",
      });
      onUndone();
    } catch (e) {
      showFileError("Could not undo the commit", {
        path: repoRoot,
        error: e,
        description: String(e),
      });
    }
  };

  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Undo commit?</AlertDialogTitle>
          <AlertDialogDescription>
            {target
              ? `"${target.commit.subject || target.commit.shortSha}" is removed from ${target.branch}, and its changes go back to the staged list.`
              : null}
            {pushedTo
              ? ` It is already on ${pushedTo}: pushing ${target?.branch} afterwards rewrites history others may have.`
              : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={pushedTo ? "destructive" : "default"}
            disabled={pushedTo === undefined}
            onClick={() => void undo()}
          >
            Undo Commit
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
