import { useEffect, useRef } from "react";
import { IS_MAC } from "@/lib/platform";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { matchShortcut, type ShortcutId } from "../shortcuts";
import { CLAIMS_MOD_KEY_ATTR, focusClaimsChord } from "./shortcutScope";

type ShortcutHandler = (e: KeyboardEvent) => void;
export type ShortcutHandlers = Partial<Record<ShortcutId, ShortcutHandler>>;

export type UseGlobalShortcutsOptions = {
  isDisabled?: (id: ShortcutId, e: KeyboardEvent) => boolean;
};

export function useGlobalShortcuts(
  handlers: ShortcutHandlers,
  options?: UseGlobalShortcutsOptions,
) {
  const latest = useRef({ handlers, options });
  latest.current = { handlers, options };

  // Access the shortcuts from the store
  const userShortcuts = usePreferencesStore((s) => s.shortcuts);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const claimed =
        e.target instanceof Element
          ? e.target
              .closest(`[${CLAIMS_MOD_KEY_ATTR}]`)
              ?.getAttribute(CLAIMS_MOD_KEY_ATTR)
          : null;
      if (focusClaimsChord(e, claimed, IS_MAC)) return;
      const { handlers, options } = latest.current;
      const id = matchShortcut(e, userShortcuts);
      if (id === null || options?.isDisabled?.(id, e)) return;
      const h = handlers[id];
      if (!h) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      h(e);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [userShortcuts]);
}
