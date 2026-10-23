import { describe, expect, it, vi } from "vitest";
import { isCompleteEndpoint } from "../config";
import { listEndpointModels } from "./endpointModels";
import {
  ENDPOINT_PRESETS,
  endpointPresetFor,
  newCustomEndpoint,
} from "./endpointPresets";
import { opencodeSessionHeaders } from "./opencodeSession";

vi.mock("./proxyFetch", () => ({ createProxyFetch: () => fetch }));

const opencodeGo = ENDPOINT_PRESETS.find((p) => p.id === "opencode-go");

describe("custom endpoints", () => {
  it("start empty, with the default context window", () => {
    expect(newCustomEndpoint("ab12cd34")).toEqual({
      id: "ab12cd34",
      name: "",
      baseURL: "",
      modelId: "",
      contextLimit: 128_000,
    });
  });
});

// crynta/terax-ai#9, #666: OpenCode Go as a ready-made custom endpoint.
describe("the OpenCode Go preset", () => {
  it("fills the name and base URL and leaves the model to pick", () => {
    if (!opencodeGo) throw new Error("no OpenCode Go preset");
    const endpoint = newCustomEndpoint("ab12cd34", opencodeGo);
    expect(endpoint).toEqual({
      id: "ab12cd34",
      name: "OpenCode Go",
      baseURL: "https://opencode.ai/zen/go/v1",
      modelId: "",
      contextLimit: 128_000,
    });
    // Not usable until a model is picked.
    expect(isCompleteEndpoint(endpoint)).toBe(false);
  });

  it("is an endpoint that gets OpenCode's session header", () => {
    if (!opencodeGo) throw new Error("no OpenCode Go preset");
    expect(opencodeSessionHeaders(opencodeGo.baseURL, "k")).toEqual({
      "x-opencode-session": "k",
    });
    expect(opencodeGo.keyUrl.startsWith("https://opencode.ai/")).toBe(true);
  });

  it("lists its models from the gateway's model list, with the key", async () => {
    if (!opencodeGo) throw new Error("no OpenCode Go preset");
    const fetchImpl = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [{ id: "kimi-k3" }, { id: "glm-5.3" }],
          }),
        ),
    );
    const models = await listEndpointModels(
      opencodeGo.baseURL,
      "sk-go",
      fetchImpl as unknown as typeof fetch,
    );
    expect(models).toEqual(["glm-5.3", "kimi-k3"]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://opencode.ai/zen/go/v1/models",
      { headers: { Authorization: "Bearer sk-go" } },
    );
  });

  it("is recognised while the endpoint keeps its base URL", () => {
    expect(endpointPresetFor("https://opencode.ai/zen/go/v1")).toBe(opencodeGo);
    expect(endpointPresetFor(" https://OpenCode.ai/zen/go/v1/ ")).toBe(
      opencodeGo,
    );
    expect(endpointPresetFor("https://api.example.com/v1")).toBeNull();
    expect(endpointPresetFor("")).toBeNull();
  });
});
