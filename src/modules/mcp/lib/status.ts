/**
 * A server's status as Settings shows it, from what each app window's client
 * reports (`mcp_status_report`; every window runs its own clients). Pure.
 */

type ReportedState = "starting" | "running" | "crashed";

/** Each report a window makes, as the backend announces it. */
export const MCP_STATUS_EVENT = "terax://mcp-status";
/** Settings asks the windows running a server to restart it. */
export const MCP_RESTART_EVENT = "terax://mcp-restart";

/** One window's report, as `mcp_status_list` and `MCP_STATUS_EVENT` give it. */
export type WindowStatus = {
  window: string;
  serverId: string;
  state: ReportedState;
  error: string | null;
  serverInfo: string | null;
  toolCount: number | null;
  retryAtMs: number | null;
};

export type StatusView =
  /** Off in Settings. */
  | { state: "disabled" }
  /** On, but no window has needed it yet (it starts with the first agent run). */
  | { state: "idle" }
  | { state: "starting"; windows: number }
  | {
      state: "running";
      windows: number;
      serverInfo: string | null;
      toolCount: number | null;
      /** Another window's copy crashed meanwhile. */
      crashedElsewhere: string | null;
    }
  | {
      state: "crashed";
      error: string | null;
      /** When the next automatic restart is due; null once it gave up. */
      retryAtMs: number | null;
    };

export function statusView(
  enabled: boolean,
  reports: readonly WindowStatus[],
): StatusView {
  if (!enabled) return { state: "disabled" };
  if (reports.length === 0) return { state: "idle" };
  const running = reports.filter((r) => r.state === "running");
  const crashed = reports.filter((r) => r.state === "crashed");
  if (running.length > 0) {
    return {
      state: "running",
      windows: running.length,
      serverInfo: running[0].serverInfo,
      toolCount: running[0].toolCount,
      crashedElsewhere: crashed[0]?.error ?? null,
    };
  }
  const starting = reports.filter((r) => r.state === "starting");
  if (starting.length > 0)
    return { state: "starting", windows: starting.length };
  const latest = crashed.reduce<WindowStatus | null>(
    (best, r) =>
      best === null ||
      (r.retryAtMs ?? Number.POSITIVE_INFINITY) <
        (best.retryAtMs ?? Number.POSITIVE_INFINITY)
        ? r
        : best,
    null,
  );
  return {
    state: "crashed",
    error: latest?.error ?? null,
    retryAtMs: latest?.retryAtMs ?? null,
  };
}

/** Applies one `terax://mcp-status` event to the known reports. */
export function applyStatusEvent(
  reports: readonly WindowStatus[],
  event: {
    window: string;
    serverId: string;
    report: Omit<WindowStatus, "window"> | null;
  },
): WindowStatus[] {
  const rest = reports.filter(
    (r) => !(r.window === event.window && r.serverId === event.serverId),
  );
  if (event.report === null) return rest;
  return [...rest, { ...event.report, window: event.window }];
}
