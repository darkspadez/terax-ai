import {
  CLAIMS_MOD_KEY_ATTR,
  focusClaimsChord,
} from "@/modules/shortcuts/lib/shortcutScope";
import { acceptCompletion, autocompletion } from "@codemirror/autocomplete";
import { defaultKeymap, historyKeymap } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, type KeyBinding, keymap } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  completionListClaim,
  completionListClaims,
  completionListKeys,
} from "./completionKeys";

type Platform = "mac" | "win" | "linux";

/** The first command CodeMirror runs for a key on a platform, by precedence. */
function bindingFor(state: EditorState, key: string, platform: Platform) {
  const mod = platform === "mac" ? "Meta-" : "Ctrl-";
  for (const bindings of state.facet(keymap)) {
    for (const b of bindings as readonly KeyBinding[]) {
      const name = (b[platform] ?? b.key)?.replace(/^Mod-/, mod);
      if (name === key) return b.run;
    }
  }
  return undefined;
}

// As in the block editor: the list's keys ahead of the default and history
// keymaps (Emacs Ctrl+N/P on macOS, Ctrl+Y redo elsewhere).
const state = EditorState.create({
  extensions: [
    autocompletion({ defaultKeymap: false }),
    completionListKeys,
    keymap.of([...defaultKeymap, ...historyKeymap]),
  ],
});

// crynta/terax-ai#1052: keyboard-only use of the completion list.
describe("the completion list's keys", () => {
  it.each(["mac", "win", "linux"] as const)(
    "move with Ctrl+N and Ctrl+P like the arrows and accept with Ctrl+Y on %s",
    (platform) => {
      const run = (key: string) => bindingFor(state, key, platform);
      expect(run("Ctrl-n")).toBeDefined();
      expect(run("Ctrl-n")).toBe(run("ArrowDown"));
      expect(run("Ctrl-p")).toBeDefined();
      expect(run("Ctrl-p")).toBe(run("ArrowUp"));
      expect(run("Ctrl-y")).toBe(acceptCompletion);
    },
  );

  it("leave the keys to the editor while no list shows", () => {
    const view = { state } as EditorView;
    for (const key of ["Ctrl-n", "Ctrl-p", "Ctrl-y", "ArrowDown", "Escape"]) {
      expect(bindingFor(state, key, "linux")?.(view), key).toBe(false);
    }
  });

  it("claim the chords from the app's shortcuts only while the list shows", () => {
    expect(completionListClaim(true, false)).toBe("n p y");
    expect(completionListClaim(false, false)).toBeNull();
    // macOS shortcuts are on Cmd: nothing to claim.
    expect(completionListClaim(true, true)).toBeNull();

    const ctrl = (key: string) => ({
      key,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
    });
    const claim = completionListClaim(true, false);
    expect(focusClaimsChord(ctrl("p"), claim, false)).toBe(true);
    expect(focusClaimsChord(ctrl("n"), claim, false)).toBe(true);
    expect(focusClaimsChord(ctrl("y"), claim, false)).toBe(true);
    expect(
      focusClaimsChord({ ...ctrl("p"), shiftKey: true }, claim, false),
    ).toBe(false);
    expect(
      focusClaimsChord(ctrl("p"), completionListClaim(false, false), false),
    ).toBe(false);
  });

  it("set no claim on the editor while no list shows", () => {
    for (const isMac of [false, true]) {
      const editor = EditorState.create({
        extensions: [autocompletion(), completionListClaims(isMac)],
      });
      const attrs = editor
        .facet(EditorView.contentAttributes)
        .map((source) =>
          typeof source === "function"
            ? source({ state: editor } as EditorView)
            : source,
        );
      expect(attrs.some((a) => a && CLAIMS_MOD_KEY_ATTR in a)).toBe(false);
    }
  });
});
