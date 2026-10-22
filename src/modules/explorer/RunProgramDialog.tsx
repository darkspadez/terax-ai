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
import { useRunPromptStore } from "./lib/openDefault";

/** Asks before "Open in Default App" runs a program or script. */
export function RunProgramDialog() {
  const path = useRunPromptStore((state) => state.pending?.path ?? null);
  const answer = useRunPromptStore((state) => state.answer);
  const name = path?.split(/[\\/]/).pop() ?? "";

  return (
    <AlertDialog
      open={path !== null}
      onOpenChange={(open) => !open && answer(false)}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Run “{name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Opening this file runs it as a program on your computer. Only run it
            if you trust where it came from.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p className="rounded-md bg-muted px-2 py-1.5 font-mono text-[12px] break-all">
          {path}
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => answer(false)}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction onClick={() => answer(true)}>
            Run
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
