/**
 * Lifecycle rules of a window's MCP servers, as pure functions: when a crashed
 * server restarts, when it gives up, which servers a run waits for, and what
 * a configuration change does to a running server.
 */

import { launchKey, type McpServerConfig } from "./config";

/** Waits before the 1st, 2nd, ... restart after a crash. */
export const RESTART_DELAYS_MS = [1_000, 3_000, 10_000, 30_000, 60_000];
/** Crashes counted toward giving up. */
export const CRASH_WINDOW_MS = 10 * 60 * 1000;
/** After this many crashes within the window, it stays down until restarted. */
export const MAX_CRASHES = RESTART_DELAYS_MS.length;
/** How long a run waits for a server that is still starting. */
export const START_WAIT_MS = 15_000;

/**
 * The crash at `now` added to `crashes` (older ones outside the window
 * dropped), and the wait before the next start, or null to give up.
 */
export function afterCrash(
  crashes: readonly number[],
  now: number,
): { crashes: number[]; delayMs: number | null } {
  const recent = crashes.filter((t) => now - t < CRASH_WINDOW_MS);
  recent.push(now);
  if (recent.length > MAX_CRASHES) return { crashes: recent, delayMs: null };
  return {
    crashes: recent,
    delayMs: RESTART_DELAYS_MS[recent.length - 1],
  };
}

export type ServerPlan =
  | { kind: "start"; server: McpServerConfig }
  | { kind: "restart"; server: McpServerConfig }
  | { kind: "stop"; id: string }
  | { kind: "update"; server: McpServerConfig };

/**
 * What a new configuration means for the servers a window runs (`running`
 * maps a server id to the launch key it started with): disabled or removed
 * servers stop, new enabled ones start, a changed launch restarts, and a
 * change of name, trust or tool choices only updates what the agent is
 * offered.
 */
export function planConfigChange(
  running: ReadonlyMap<string, string>,
  servers: readonly McpServerConfig[],
): ServerPlan[] {
  const plans: ServerPlan[] = [];
  const enabled = new Map(
    servers.filter((s) => s.enabled).map((s) => [s.id, s] as const),
  );
  for (const id of running.keys()) {
    if (!enabled.has(id)) plans.push({ kind: "stop", id });
  }
  for (const server of enabled.values()) {
    const key = running.get(server.id);
    if (key === undefined) plans.push({ kind: "start", server });
    else if (key !== launchKey(server)) plans.push({ kind: "restart", server });
    else plans.push({ kind: "update", server });
  }
  return plans;
}

/**
 * The servers a run should wait for: those starting, for at most
 * `START_WAIT_MS` since they began. Returns the deadline, or null when none
 * is worth waiting for.
 */
export function startWaitDeadline(
  starting: readonly { startedAt: number }[],
  now: number,
): number | null {
  let deadline: number | null = null;
  for (const { startedAt } of starting) {
    const end = startedAt + START_WAIT_MS;
    if (end > now && (deadline === null || end > deadline)) deadline = end;
  }
  return deadline;
}
