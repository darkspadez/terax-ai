/**
 * Sign-in to remote servers (OAuth), as the page sees it. Sign-in itself runs
 * in the backend (`mcp/oauth/`): the page never holds a token, only this
 * status, and only Settings may sign in or out. Pure.
 */

/** Sent by the backend when a server's sign-in state changes: `{ serverId }`. */
export const MCP_AUTH_EVENT = "terax://mcp-auth";

type AuthReason = "unauthorized" | "metadata" | "scope" | "expired";

/** `oauth::AuthStatus`: never a token, a secret or the client id. */
export type AuthStatus = {
  serverId: string;
  state: "signed-in" | "required" | "none";
  reason: AuthReason | null;
  /** The scopes the server asked for, when it did. */
  requiredScope: string | null;
  scope: string | null;
  issuer: string | null;
  expiresAtMs: number | null;
  canRefresh: boolean;
  signingIn: boolean;
};

const REASON: Record<AuthReason, string> = {
  unauthorized: "The server asks you to sign in.",
  metadata: "The server uses sign-in.",
  scope: "The server asks for more access than you granted.",
  expired: "Your sign-in expired.",
};

function minutes(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000));
  if (total < 60) return `${total} min`;
  const hours = Math.round(total / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

/** One line for the server's card. */
export function authStatusText(status: AuthStatus, now: number): string {
  if (status.signingIn) return "Waiting for you to sign in in your browser…";
  switch (status.state) {
    case "required": {
      const why = status.reason ? REASON[status.reason] : "";
      const scope = status.requiredScope
        ? ` It asks for: ${status.requiredScope}.`
        : "";
      return `Sign in required. ${why}${scope}`.trim();
    }
    case "signed-in": {
      const parts = ["Signed in"];
      if (status.issuer) parts[0] += ` with ${hostOf(status.issuer)}`;
      if (status.expiresAtMs !== null) {
        const left = status.expiresAtMs - now;
        parts.push(
          left > 0
            ? `access renews ${status.canRefresh ? "automatically " : ""}in ${minutes(left)}`
            : status.canRefresh
              ? "access renews on the next request"
              : "access expired; sign in again",
        );
      }
      return parts.join(", ");
    }
    case "none":
      return "Not signed in. Sign in if the server asks for it.";
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The message a connection that needs sign-in fails with. */
const SIGN_IN_REQUIRED =
  "Sign in required: sign in to this server in Settings, MCP.";

/** Whether a server's reported error is that it needs sign-in. */
export function isSignInError(error: string | null): boolean {
  return error === SIGN_IN_REQUIRED;
}

/** A connection refused for lack of sign-in: restarting cannot help. */
export class SignInRequiredError extends Error {
  constructor() {
    super(SIGN_IN_REQUIRED);
    this.name = "SignInRequiredError";
  }
}

/**
 * Marks a 401 the backend decided needs the user's sign-in
 * (`oauth::SIGN_IN_HEADER`): a token it could not refresh, or the server's
 * Bearer challenge. Any other 401 (a wrong API key) is an ordinary failure.
 */
const SIGN_IN_HEADER = "x-terax-sign-in";

/** A fetch that notes when the server's answer means the user has to sign in. */
export function watchUnauthorized(
  fetch: typeof globalThis.fetch,
  onUnauthorized: () => void,
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    if (
      response.status === 401 &&
      response.headers.get(SIGN_IN_HEADER) === "required"
    ) {
      onUnauthorized();
    }
    return response;
  };
}
