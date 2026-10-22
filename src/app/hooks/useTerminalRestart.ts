import { planTerminalRestart } from "@/app/hooks/terminalRestart";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { leafHasForegroundProcess, restartSession } from "@/modules/terminal";
import { useCallback, useRef, useState } from "react";

/**
 * Restart terminal: ends a pane's shell and starts a new one in its folder,
 * after a confirmation while a program runs there. Owns the pending restart
 * the dialog renders from; only the latest request acts.
 */
export function useTerminalRestart() {
  const [pendingRestartLeaf, setPendingRestartLeaf] = useState<number | null>(
    null,
  );
  const requestRef = useRef(0);

  const requestRestart = useCallback(async (leafId: number) => {
    const request = ++requestRef.current;
    const plan = await planTerminalRestart(
      leafId,
      leafHasForegroundProcess,
      usePreferencesStore.getState().confirmCloseRunningTerminal,
    );
    if (request !== requestRef.current) return;
    if (plan === "confirm") setPendingRestartLeaf(leafId);
    else void restartSession(leafId);
  }, []);

  const confirmRestart = useCallback(() => {
    requestRef.current += 1;
    if (pendingRestartLeaf !== null) void restartSession(pendingRestartLeaf);
    setPendingRestartLeaf(null);
  }, [pendingRestartLeaf]);

  const cancelRestart = useCallback(() => {
    requestRef.current += 1;
    setPendingRestartLeaf(null);
  }, []);

  return { pendingRestartLeaf, requestRestart, confirmRestart, cancelRestart };
}
