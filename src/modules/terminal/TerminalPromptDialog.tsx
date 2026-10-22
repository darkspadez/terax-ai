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
import { useTerminalPromptStore } from "./lib/terminalPrompts";

/** Lines of a paste shown for review; the rest is summarized. */
const PREVIEW_LINES = 12;

function pastePreview(text: string): { shown: string; hidden: number } {
  const lines = text.replace(/\r\n|\r/g, "\n").split("\n");
  return {
    shown: lines.slice(0, PREVIEW_LINES).join("\n"),
    hidden: Math.max(0, lines.length - PREVIEW_LINES),
  };
}

/** Asks about the oldest pending terminal request (unsafe paste, clipboard read). */
export function TerminalPromptDialog() {
  const prompt = useTerminalPromptStore((state) => state.queue[0] ?? null);
  const answer = useTerminalPromptStore((state) => state.answer);
  const request = prompt?.request ?? null;
  const deny = () => prompt && answer(prompt.id, "deny");
  const allow = () => prompt && answer(prompt.id, "allow");
  const preview = request?.kind === "paste" ? pastePreview(request.text) : null;

  return (
    <AlertDialog
      open={prompt !== null}
      onOpenChange={(open) => !open && deny()}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {request?.kind === "paste"
              ? "Paste Multiple Lines?"
              : "Allow Clipboard Access?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {request?.kind === "paste"
              ? "This text contains line breaks, so pasting it will run the commands it contains."
              : "A program in this terminal wants to read your clipboard."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {preview && (
          <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-[12px] whitespace-pre-wrap break-all">
            {preview.shown}
            {preview.hidden > 0 &&
              `\n… ${preview.hidden} more line${preview.hidden === 1 ? "" : "s"}`}
          </pre>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={deny}>
            {request?.kind === "paste" ? "Cancel" : "Deny"}
          </AlertDialogCancel>
          <AlertDialogAction onClick={allow}>
            {request?.kind === "paste" ? "Paste" : "Allow"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
