import { IS_MAC } from "@/lib/platform";
import { useEffect, useEffectEvent } from "react";
import type { ShortcutId } from "../shortcuts";
import type { MenuShortcut, MenuShortcutId } from "./menuShortcuts";
import type { ShortcutHandlers } from "./useGlobalShortcuts";

export type MenuShortcutOptions = {
  isDisabled?: (id: ShortcutId, e: KeyboardEvent) => boolean;
  /** What a menu item runs instead of its shortcut's key handler. */
  instead?: Partial<Record<MenuShortcutId, () => void>>;
};

/**
 * macOS: the menu bar carries some shortcuts too, so they work while a
 * preview frame has the keyboard and the page never sees their keys. This
 * runs the one chosen there in this window with the handler its keys run.
 * The bridge loads on macOS only (`menuBridge.ts`).
 */
export function useMenuShortcuts(
  handlers: ShortcutHandlers,
  options: MenuShortcutOptions = {},
) {
  const run = useEffectEvent((shortcut: MenuShortcut) => {
    const instead = options.instead?.[shortcut.id];
    if (instead) {
      instead();
      return;
    }
    // The key the item stands for; Jump to tab reads its digit.
    const event = new KeyboardEvent("keydown", {
      key: shortcut.id === "tab.selectByIndex" ? String(shortcut.tab) : "",
    });
    if (options.isDisabled?.(shortcut.id, event)) return;
    handlers[shortcut.id]?.(event);
  });

  useEffect(() => {
    if (!IS_MAC) return;
    let stop: (() => void) | undefined;
    let disposed = false;
    void import("./menuBridge").then(({ startMenuBridge }) => {
      if (!disposed) stop = startMenuBridge((shortcut) => run(shortcut));
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
}
