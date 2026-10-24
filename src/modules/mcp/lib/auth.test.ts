import { describe, expect, it, vi } from "vitest";
import {
  type AuthStatus,
  authStatusText,
  isSignInError,
  SignInRequiredError,
  watchUnauthorized,
} from "./auth";

function status(overrides: Partial<AuthStatus> = {}): AuthStatus {
  return {
    serverId: "s1",
    state: "none",
    reason: null,
    requiredScope: null,
    scope: null,
    issuer: null,
    expiresAtMs: null,
    canRefresh: false,
    signingIn: false,
    ...overrides,
  };
}

describe("authStatusText", () => {
  const now = 1_000_000;

  it("says why sign-in is required, with the scopes asked for", () => {
    expect(
      authStatusText(
        status({ state: "required", reason: "unauthorized" }),
        now,
      ),
    ).toBe("Sign in required. The server asks you to sign in.");
    expect(
      authStatusText(
        status({
          state: "required",
          reason: "scope",
          requiredScope: "files:write",
        }),
        now,
      ),
    ).toBe(
      "Sign in required. The server asks for more access than you granted. It asks for: files:write.",
    );
  });

  it("says who the user is signed in with and when access renews", () => {
    expect(
      authStatusText(
        status({
          state: "signed-in",
          issuer: "https://auth.example.com/tenant",
          expiresAtMs: now + 30 * 60_000,
          canRefresh: true,
        }),
        now,
      ),
    ).toBe(
      "Signed in with auth.example.com, access renews automatically in 30 min",
    );
    expect(
      authStatusText(
        status({ state: "signed-in", expiresAtMs: now - 1, canRefresh: false }),
        now,
      ),
    ).toBe("Signed in, access expired; sign in again");
  });

  it("shows a sign-in in progress first", () => {
    expect(
      authStatusText(status({ state: "required", signingIn: true }), now),
    ).toContain("browser");
  });
});

describe("watchUnauthorized", () => {
  it("notes a 401 the backend marks as needing sign-in, passing every response through", async () => {
    const onUnauthorized = vi.fn();
    const fetch = watchUnauthorized(async (input) => {
      const path = new URL(String(input)).pathname;
      return new Response(null, {
        status: path === "/ok" ? 200 : 401,
        headers: path === "/sign-in" ? { "x-oarlock-sign-in": "required" } : {},
      });
    }, onUnauthorized);
    expect((await fetch("https://x/ok")).status).toBe(200);
    expect((await fetch("https://x/api-key")).status).toBe(401);
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect((await fetch("https://x/sign-in")).status).toBe(401);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});

describe("isSignInError", () => {
  it("recognizes the error a connection that needs sign-in reports", () => {
    expect(isSignInError(new SignInRequiredError().message)).toBe(true);
    expect(isSignInError("Exited with code 1")).toBe(false);
    expect(isSignInError(null)).toBe(false);
  });
});
