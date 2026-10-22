import { isImeKeyEvent } from "@/lib/ime";

export type ComposerKey = {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;
};

export type ComposerKeyAction =
  | "picker-next"
  | "picker-prev"
  | "picker-pick"
  | "picker-dismiss"
  | "submit"
  | null;

/** What a keydown in the AI composer does; null leaves it to the textarea
 *  (typing, a Shift+Enter newline) or to the IME. */
export function composerKeyAction(
  e: ComposerKey,
  picker: { open: boolean; items: number },
): ComposerKeyAction {
  if (isImeKeyEvent(e)) return null;
  if (picker.open) {
    if (e.key === "ArrowDown") return "picker-next";
    if (e.key === "ArrowUp") return "picker-prev";
    if ((e.key === "Tab" || e.key === "Enter") && picker.items > 0) {
      return "picker-pick";
    }
    if (e.key === "Escape") return "picker-dismiss";
  }
  return e.key === "Enter" && !e.shiftKey ? "submit" : null;
}
