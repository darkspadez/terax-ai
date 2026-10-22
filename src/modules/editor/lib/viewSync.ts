import type { EditorView } from "@codemirror/view";
import { ExternalChange } from "@uiw/react-codemirror";

type TextView = Pick<EditorView, "state" | "dispatch">;

/**
 * The single replacement that turns `current` into `next`, trimmed to what
 * differs: the cursor and scroll position survive through CodeMirror's
 * position mapping. Null when the texts are equal.
 */
export function minimalChange(
  current: string,
  next: string,
): { from: number; to: number; insert: string } | null {
  if (current === next) return null;
  let start = 0;
  const minLen = Math.min(current.length, next.length);
  while (start < minLen && current[start] === next[start]) start += 1;
  let endCur = current.length;
  let endNext = next.length;
  while (
    endCur > start &&
    endNext > start &&
    current[endCur - 1] === next[endNext - 1]
  ) {
    endCur -= 1;
    endNext -= 1;
  }
  return { from: start, to: endCur, insert: next.slice(start, endNext) };
}

/** Format-on-save output: reaches onChange like an edit of the user's. */
export function applyFormattedContent(view: TextView, next: string): void {
  const changes = minimalChange(view.state.doc.toString(), next);
  if (changes) view.dispatch({ changes });
}

/**
 * Shows text the document session adopted from disk. Marked external so it
 * does not come back through onChange as an edit.
 */
export function syncViewText(view: TextView, text: string): void {
  const changes = minimalChange(view.state.doc.toString(), text);
  if (changes) {
    view.dispatch({ changes, annotations: ExternalChange.of(true) });
  }
}
