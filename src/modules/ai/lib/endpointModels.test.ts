import { describe, expect, it, vi } from "vitest";
import { listEndpointModels, parseModelList } from "./endpointModels";

describe("listEndpointModels", () => {
  it("asks the server's /models with the endpoint key and lists the ids sorted", async () => {
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [
              { id: "qwen3-coder", object: "model" },
              { id: "deepseek-v4-pro", object: "model" },
              { id: "qwen3-coder" },
            ],
          }),
        ),
    );
    const ids = await listEndpointModels(
      "https://opencode.ai/zen/go/v1/",
      "sk-ep",
      fetchImpl as unknown as typeof fetch,
    );
    expect(ids).toEqual(["deepseek-v4-pro", "qwen3-coder"]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://opencode.ai/zen/go/v1/models");
    expect(init?.headers).toEqual({ Authorization: "Bearer sk-ep" });
  });

  it("sends no Authorization header without a key", async () => {
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: [] })),
    );
    await listEndpointModels(
      "http://127.0.0.1:11434/v1",
      null,
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl.mock.calls[0][1]?.headers).toEqual({});
  });

  it("reports the server's error", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          error: { code: "invalid_api_key", message: "Incorrect API key." },
        }),
        { status: 401 },
      );
    await expect(
      listEndpointModels("https://llm.example.com/v1", "bad", fetchImpl),
    ).rejects.toThrow("HTTP 401: Authentication failed: Incorrect API key.");
  });
});

describe("parseModelList", () => {
  it("refuses a body that is not an OpenAI model list", () => {
    expect(() => parseModelList({ models: [] })).toThrow(/OpenAI format/);
    expect(() => parseModelList(null)).toThrow(/OpenAI format/);
  });
});
