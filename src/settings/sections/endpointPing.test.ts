import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { pingEndpoint } from "./endpointPing";

describe("pingEndpoint", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("counts any HTTP answer as reachable", async () => {
    invoke.mockResolvedValue(401);
    expect(await pingEndpoint("https://llm.example.com/v1")).toEqual({
      status: "ok",
    });
    expect(invoke).toHaveBeenCalledWith("lm_ping", {
      baseUrl: "https://llm.example.com/v1",
    });
  });

  it("keeps the reason a server could not be reached", async () => {
    // Tauri rejects a failed command with the command's error string.
    invoke.mockRejectedValue(
      "error sending request for url (https://llm.internal/v1/models): client error (Connect): invalid peer certificate: UnknownIssuer",
    );
    expect(await pingEndpoint("https://llm.internal/v1")).toEqual({
      status: "fail",
      error:
        "error sending request for url (https://llm.internal/v1/models): client error (Connect): invalid peer certificate: UnknownIssuer",
    });
  });
});
