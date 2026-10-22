import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/native", () => ({ native: {} }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
  workspaceScopeKey: () => "local",
}));

import { usePreferencesStore } from "@/modules/settings/preferences";
import { buildConfiguredLanguageModel } from "../lib/agent";
import { EMPTY_PROVIDER_KEYS } from "../lib/keyring";
import { modelConfigProblem } from "../lib/modelTarget";
import { useChatStore } from "./chatStore";
import { liveModelConfig } from "./modelConfig";

describe("liveModelConfig", () => {
  it("carries the custom endpoints and their keys to builders outside the chat", async () => {
    const endpoint = {
      id: "f46e2124",
      name: "Gateway",
      baseURL: "https://llm.example.com/v1",
      modelId: "qwen3-coder",
      contextLimit: 128_000,
    };
    usePreferencesStore.setState({
      customEndpoints: [endpoint],
      ollamaModelId: "qwen3:8b",
    });
    useChatStore.setState({ customEndpointKeys: { f46e2124: "sk-ep" } });

    const config = liveModelConfig();
    expect(config).toMatchObject({
      customEndpoints: [endpoint],
      customEndpointKeys: { f46e2124: "sk-ep" },
      ollamaModelId: "qwen3:8b",
    });
    // Source Control's commit message: "Custom endpoint not found" before.
    expect(
      modelConfigProblem("compat-f46e2124", EMPTY_PROVIDER_KEYS, config),
    ).toBeNull();
    await expect(
      buildConfiguredLanguageModel(
        "compat-f46e2124",
        EMPTY_PROVIDER_KEYS,
        config,
      ),
    ).resolves.toBeDefined();
  });
});
