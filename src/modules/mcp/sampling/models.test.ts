import { describe, expect, it } from "vitest";
import { EMPTY_PROVIDER_KEYS } from "@/modules/ai/lib/keyring";
import { samplingModelChoice, usableSamplingModels } from "./models";

describe("sampling models", () => {
  it("lists only the models that can run now", () => {
    const models = usableSamplingModels(
      { ...EMPTY_PROVIDER_KEYS, anthropic: "sk" },
      {
        ollamaModelId: "qwen3",
        customEndpoints: [
          {
            id: "box",
            name: "Box",
            baseURL: "https://box/v1",
            modelId: "llama",
            contextLimit: 8000,
          },
          {
            id: "half",
            name: "Half",
            baseURL: "",
            modelId: "",
            contextLimit: 8000,
          },
        ],
        customEndpointKeys: {},
      },
    );
    const ids = models.map((m) => m.id);
    expect(ids).toContain("claude-sonnet-5");
    expect(ids).toContain("ollama-local");
    expect(ids).toContain("compat-box");
    expect(ids).not.toContain("gpt-5.4-mini");
    expect(ids).not.toContain("lmstudio-local");
    expect(ids).not.toContain("compat-half");
    expect(models.find((m) => m.id === "ollama-local")?.label).toBe(
      "Ollama (qwen3)",
    );
  });

  it("names a model that cannot run by its id", () => {
    expect(samplingModelChoice("nope", {})).toEqual({
      id: "nope",
      label: "nope",
    });
    expect(samplingModelChoice("claude-sonnet-5", {}).label).toBe(
      "Claude Sonnet 5",
    );
  });
});
