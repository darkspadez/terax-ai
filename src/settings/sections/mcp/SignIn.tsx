import { Button } from "@/components/ui/button";
import {
  type AuthStatus,
  authStatusText,
  MCP_AUTH_EVENT,
} from "@/modules/mcp/lib/auth";
import { type McpServerConfig, usesSignIn } from "@/modules/mcp/lib/config";
import { MCP_RESTART_EVENT } from "@/modules/mcp/lib/status";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

function shell(): string | null {
  return usePreferencesStore.getState().terminalShell || null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The client a server's configuration gives sign-in, as the backend takes it. */
function clientInput(server: McpServerConfig) {
  const t = server.transport;
  if (t.type === "stdio" || !t.oauth) return null;
  return {
    clientId: t.oauth.clientId,
    hasSecret: t.oauth.clientSecret,
    scopes: t.oauth.scopes,
    callbackPort: t.oauth.callbackPort,
  };
}

function urlOf(server: McpServerConfig): string {
  return server.transport.type === "stdio" ? "" : server.transport.url;
}

export type SignInControls = {
  statuses: Record<string, AuthStatus>;
  errors: Record<string, string>;
  signIn: (server: McpServerConfig) => void;
  signOut: (server: McpServerConfig) => void;
  cancel: (server: McpServerConfig) => void;
};

/**
 * The sign-in state of every remote server Settings lists. The backend runs
 * sign-in and keeps the tokens; this only reads what it says (never a token)
 * and asks it to start or end one. A server that publishes protected resource
 * metadata is probed once, so it shows "Sign in required" before it fails.
 */
export function useSignIn(servers: readonly McpServerConfig[]): SignInControls {
  const [statuses, setStatuses] = useState<Record<string, AuthStatus>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const probed = useRef(new Set<string>());
  const remote = useMemo(() => servers.filter(usesSignIn), [servers]);
  const latest = useRef(remote);
  latest.current = remote;

  const refresh = useCallback(async () => {
    const list = latest.current;
    if (list.length === 0) return;
    const next = await invoke<AuthStatus[]>("mcp_oauth_status", {
      servers: list.map((s) => ({ serverId: s.id, url: urlOf(s) })),
      shell: shell(),
    }).catch(() => null);
    if (next) setStatuses(Object.fromEntries(next.map((s) => [s.serverId, s])));
    for (const status of next ?? []) {
      const server = list.find((s) => s.id === status.serverId);
      const probeKey = server ? `${server.id}=${urlOf(server)}` : "";
      // Only servers the user turned on: a disabled one is not contacted.
      if (
        !server?.enabled ||
        status.state !== "none" ||
        probed.current.has(probeKey)
      )
        continue;
      probed.current.add(probeKey);
      void invoke<AuthStatus>("mcp_oauth_probe", {
        serverId: server.id,
        url: urlOf(server),
        shell: shell(),
      })
        .then((probedStatus) =>
          setStatuses((old) => ({ ...old, [server.id]: probedStatus })),
        )
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (remote.length > 0) void refresh();
  }, [remote, refresh]);

  useEffect(() => {
    const stop = listen(MCP_AUTH_EVENT, () => void refresh());
    return () => void stop.then((fn) => fn());
  }, [refresh]);

  const signIn = useCallback(
    (server: McpServerConfig) => {
      setErrors(({ [server.id]: _, ...rest }) => rest);
      void invoke<AuthStatus>("mcp_oauth_sign_in", {
        serverId: server.id,
        url: urlOf(server),
        client: clientInput(server),
        shell: shell(),
      }).then(
        (status) => {
          setStatuses((old) => ({ ...old, [server.id]: status }));
          // Windows that run it reconnect with the new sign-in.
          void emit(MCP_RESTART_EVENT, { serverId: server.id });
        },
        (error) => {
          setErrors((old) => ({ ...old, [server.id]: errorText(error) }));
          void refresh();
        },
      );
    },
    [refresh],
  );

  const signOut = useCallback(
    (server: McpServerConfig) => {
      setErrors(({ [server.id]: _, ...rest }) => rest);
      void invoke("mcp_oauth_sign_out", { serverId: server.id }).then(
        () => {
          void emit(MCP_RESTART_EVENT, { serverId: server.id });
          void refresh();
        },
        (error) =>
          setErrors((old) => ({ ...old, [server.id]: errorText(error) })),
      );
    },
    [refresh],
  );

  const cancel = useCallback((server: McpServerConfig) => {
    void invoke("mcp_oauth_cancel", { serverId: server.id }).catch(() => {});
  }, []);

  return { statuses, errors, signIn, signOut, cancel };
}

/** The sign-in row of an expanded remote server. */
export function SignInRow({
  status,
  error,
  onSignIn,
  onSignOut,
  onCancel,
}: {
  status: AuthStatus | undefined;
  error: string | undefined;
  onSignIn: () => void;
  onSignOut: () => void;
  onCancel: () => void;
}) {
  const now = Date.now();
  const signedIn = status?.state === "signed-in";
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[11px] font-medium text-muted-foreground">
          Sign-in
        </span>
        <span
          className={
            status?.state === "required" && !status.signingIn
              ? "text-[10.5px] leading-relaxed text-amber-700 dark:text-amber-400"
              : "text-[10.5px] leading-relaxed text-muted-foreground"
          }
        >
          {status ? authStatusText(status, now) : "Checking…"}
        </span>
        {error ? (
          <span className="text-[10.5px] leading-relaxed text-destructive">
            {error}
          </span>
        ) : null}
        <span className="text-[10px] leading-relaxed text-muted-foreground/80">
          Sign-in opens your browser. Oarlock keeps the tokens in your system
          keychain and adds them to this server's requests itself; the agent and
          the app's pages never see them.
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {status?.signingIn ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={onCancel}
          >
            Cancel
          </Button>
        ) : (
          <>
            {signedIn ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                onClick={onSignOut}
              >
                Sign out
              </Button>
            ) : null}
            <Button
              size="sm"
              variant={signedIn ? "outline" : "default"}
              className="h-6 px-2 text-[11px]"
              onClick={onSignIn}
            >
              {signedIn ? "Sign in again" : "Sign in"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
