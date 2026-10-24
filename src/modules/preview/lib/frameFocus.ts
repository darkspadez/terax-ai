/**
 * Calls `onFrameFocus` when focus moves from the app into an embedded frame.
 * A click inside a cross-origin frame never reaches the app's own pointer
 * handlers, so a menu that closes on an outside click stays open; the app's
 * window does get a blur, with the frame as its active element. Returns the
 * function that stops watching.
 */
export function onFocusIntoFrame(
  win: Pick<Window, "addEventListener" | "removeEventListener">,
  doc: { readonly activeElement: { readonly tagName: string } | null },
  onFrameFocus: () => void,
): () => void {
  const onBlur = () => {
    if (doc.activeElement?.tagName === "IFRAME") onFrameFocus();
  };
  win.addEventListener("blur", onBlur);
  return () => win.removeEventListener("blur", onBlur);
}
