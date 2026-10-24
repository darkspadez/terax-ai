import { gotoLine } from "@codemirror/search";
import { type Extension, Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";

/**
 * The editor's own keys: Mod+S saves and Ctrl+G goes to a line, as in VS
 * Code. They sit above basicSetup's search keymap, which binds Mod+G (Ctrl+G
 * off macOS) to find-next; F3 still finds the next match.
 */
export function editorKeymap(save: () => void): Extension {
  return Prec.high(
    keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          save();
          return true;
        },
      },
      { key: "Ctrl-g", run: gotoLine },
    ]),
  );
}

/**
 * The `mod+<key>` chord the editor keeps from the app's shortcuts: off macOS
 * Ctrl+G is Source Control's second chord (its first is Ctrl+Shift+G), and
 * in the editor it goes to a line instead. macOS's Cmd+G does not clash.
 */
export function editorClaimedModKey(isMac: boolean): string | undefined {
  return isMac ? undefined : "g";
}
