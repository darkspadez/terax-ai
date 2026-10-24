import { isTerminalSurfaceTarget } from "@/modules/terminal/lib/terminalSurfaceTarget";

type SelectionLike = Pick<Selection, "isCollapsed" | "containsNode">;

const TEXT_INPUT_TYPES = new Set([
  "",
  "text",
  "search",
  "url",
  "email",
  "tel",
  "password",
  "number",
]);

/** The element a target is or, for a text node, sits in. */
function elementOf(target: EventTarget | null): Element | null {
  const node = target as Partial<Element> & {
    readonly parentElement?: Element | null;
  };
  if (typeof node?.closest === "function") return node as Element;
  return node?.parentElement ?? null;
}

function isTextEditable(element: Element): boolean {
  const field = element.closest("textarea, input, [contenteditable]");
  if (!field) return false;
  if (field.tagName === "INPUT") {
    return TEXT_INPUT_TYPES.has(
      (field.getAttribute("type") ?? "").toLowerCase(),
    );
  }
  return field.getAttribute("contenteditable") !== "false";
}

/**
 * Whether a right click on `target` may open the webview's own menu. Its page
 * menu offers Reload, which reloads the window and ends every shell in it, and
 * its link and image menus open them inside the webview. Text keeps it:
 * editable fields, the terminal (which hands the menu its selection,
 * `TerminalNativeSelection`) and selected text that is no link or image.
 */
export function allowsNativeContextMenu(
  target: EventTarget | null,
  selection: SelectionLike | null,
): boolean {
  const element = elementOf(target);
  if (!element) return false;
  if (isTextEditable(element) || isTerminalSurfaceTarget(target)) return true;
  return (
    !!selection &&
    !selection.isCollapsed &&
    selection.containsNode(element, true) &&
    !element.closest("a[href], img")
  );
}

/**
 * Keeps the webview's menu to what `allowsNativeContextMenu` allows. Runs
 * after the page's own handlers: a menu of ours (Radix) has already prevented
 * the default by then.
 */
export function installNativeContextMenuGuard(
  scope: Pick<Window, "addEventListener" | "getSelection"> = window,
): void {
  scope.addEventListener("contextmenu", (event) => {
    if (event.defaultPrevented) return;
    if (!allowsNativeContextMenu(event.target, scope.getSelection())) {
      event.preventDefault();
    }
  });
}

/**
 * A plain primary click, not one that opens a context menu (the secondary
 * button, or Control-click on macOS) or pastes (the middle button).
 */
export function isPrimaryClick(
  event: Pick<MouseEvent, "button" | "ctrlKey">,
  isMac: boolean,
): boolean {
  return event.button === 0 && !(isMac && event.ctrlKey);
}
