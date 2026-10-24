import { CLAIMS_MOD_KEY_ATTR } from "@/modules/shortcuts/lib/shortcutScope";
import {
  acceptCompletion,
  closeCompletion,
  currentCompletions,
  moveCompletionSelection,
} from "@codemirror/autocomplete";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

const nextCompletion = moveCompletionSelection(true);
const previousCompletion = moveCompletionSelection(false);

/**
 * The completion list's keys: the arrows and readline's Ctrl+N / Ctrl+P move,
 * Ctrl+Y accepts like Tab, Escape closes. Each command is false while no list
 * shows, so the key falls through to what it does without one (the history
 * popover, cursor movement, yank, redo).
 */
export const completionListKeys = Prec.highest(
  keymap.of([
    { key: "ArrowDown", run: nextCompletion },
    { key: "Ctrl-n", run: nextCompletion },
    { key: "ArrowUp", run: previousCompletion },
    { key: "Ctrl-p", run: previousCompletion },
    { key: "Ctrl-y", run: acceptCompletion },
    { key: "Escape", run: closeCompletion },
  ]),
);

/**
 * The chords the list takes from the app's shortcuts while it shows
 * (`focusClaimsChord`). Off macOS those use Ctrl, and Ctrl+P opens the
 * command palette; macOS shortcuts use Cmd and leave Ctrl to the editor.
 */
export function completionListClaim(
  listShowing: boolean,
  isMac: boolean,
): string | null {
  return listShowing && !isMac ? "n p y" : null;
}

export function completionListClaims(isMac: boolean) {
  return EditorView.contentAttributes.of((view) => {
    const claim = completionListClaim(
      currentCompletions(view.state).length > 0,
      isMac,
    );
    return claim === null ? null : { [CLAIMS_MOD_KEY_ATTR]: claim };
  });
}
