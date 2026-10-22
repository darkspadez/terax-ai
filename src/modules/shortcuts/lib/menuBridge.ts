import { usePreferencesStore } from "@/modules/settings/preferences";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { KeyBinding, ShortcutId } from "../shortcuts";
import {
  MENU_SHORTCUT_EVENT,
  type MenuShortcut,
  menuCarriesKey,
  menuShortcutPlan,
  parseMenuShortcut,
} from "./menuShortcuts";

/**
 * macOS: gives the menu bar's shortcut items the user's bindings, now and
 * whenever they change, marks the keys they carry handled when this page sees
 * them (`menuCarriesKey`), and hands `run` the shortcut chosen in the menu for
 * this window. Returns the teardown.
 */
export function startMenuBridge(
  run: (shortcut: MenuShortcut) => void,
): () => void {
  let chords: KeyBinding[] = [];
  const carry = (bindings: Partial<Record<ShortcutId, KeyBinding[]>>) => {
    const plan = menuShortcutPlan(bindings);
    chords = plan.chords;
    invoke("app_menu_set_shortcuts", {
      accelerators: plan.accelerators,
    }).catch((error: unknown) =>
      console.warn("[terax] could not set the menu's shortcuts:", error),
    );
  };
  carry(usePreferencesStore.getState().shortcuts);
  const unsubscribe = usePreferencesStore.subscribe((state, previous) => {
    if (state.shortcuts !== previous.shortcuts) carry(state.shortcuts);
  });

  const onKey = (e: KeyboardEvent) => {
    if (menuCarriesKey(e, chords)) e.preventDefault();
  };
  window.addEventListener("keydown", onKey, { capture: true });

  let unlisten: (() => void) | undefined;
  let stopped = false;
  void getCurrentWindow()
    .listen<unknown>(MENU_SHORTCUT_EVENT, ({ payload }) => {
      const shortcut = parseMenuShortcut(payload);
      if (shortcut) run(shortcut);
    })
    .then((stop) => {
      if (stopped) stop();
      else unlisten = stop;
    });

  return () => {
    stopped = true;
    unsubscribe();
    window.removeEventListener("keydown", onKey, { capture: true });
    unlisten?.();
  };
}
