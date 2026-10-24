/**
 * True when a keydown belongs to an IME composition (Chinese pinyin, Japanese
 * kana, Korean jamo, dead keys). Such a key, notably the Enter that confirms a
 * candidate, is the IME's: it must not submit, pick or navigate anything.
 * WebKit fires compositionend before the keydown of that Enter, so
 * `isComposing` is already false there; its keyCode is still 229 ("Process"),
 * the same check the terminal's key handler makes.
 */
export function isImeKeyEvent(e: {
  isComposing: boolean;
  keyCode: number;
  key: string;
}): boolean {
  return e.isComposing || e.keyCode === 229 || e.key === "Process";
}

/**
 * What Enter and Escape do in a one-line text field (renaming a tab or a
 * space, naming a new file, the explorer search): commit or cancel, or
 * nothing while an input method owns the key, so confirming a candidate
 * never commits the half-typed name.
 */
export function textFieldKey(e: {
  isComposing: boolean;
  keyCode: number;
  key: string;
}): "commit" | "cancel" | null {
  if (isImeKeyEvent(e)) return null;
  if (e.key === "Enter") return "commit";
  if (e.key === "Escape") return "cancel";
  return null;
}
