import {
  type CustomEndpoint,
  endpointIdFromCompatModel,
  isCompatModelId,
  type ProviderId,
  providerNeedsKey,
  resolveModel,
} from "../config";
import type { CustomEndpointKeys, ProviderKeys } from "./keyring";

// Kept free of the AI SDK so a surface can check a model's configuration
// without loading it; agent.ts builds the model from the same target.

export type BuildModelOptions = {
  modelIdOverride?: string;
  lmstudioBaseURL?: string;
  mlxBaseURL?: string;
  ollamaBaseURL?: string;
  openaiCompatibleBaseURL?: string;
};

export function missingKeyMessage(provider: ProviderId): string {
  return `No API key configured for ${provider}. Open Settings → Models to add one.`;
}

export type LocalProviderConfig = {
  lmstudioBaseURL?: string;
  lmstudioModelId?: string;
  mlxBaseURL?: string;
  mlxModelId?: string;
  ollamaBaseURL?: string;
  ollamaModelId?: string;
  openaiCompatibleBaseURL?: string;
  openaiCompatibleModelId?: string;
  openrouterModelId?: string;
  customEndpoints?: readonly CustomEndpoint[];
  customEndpointKeys?: CustomEndpointKeys;
};

type ModelTarget = {
  provider: ProviderId;
  /** The id the provider is sent: a local server's or endpoint's own id. */
  modelId: string;
  options: BuildModelOptions;
  endpointKey?: string | null;
};

/** Where `modelId` runs with this configuration. Throws, with what to fix,
 *  when the configuration it needs is missing. */
export function resolveModelTarget(
  modelId: string,
  local: LocalProviderConfig,
): ModelTarget {
  if (isCompatModelId(modelId)) {
    const eid = endpointIdFromCompatModel(modelId);
    const ep = local.customEndpoints?.find((e) => e.id === eid);
    if (!ep) throw new Error(`Custom endpoint not found: ${eid}`);
    if (!ep.modelId.trim()) {
      throw new Error(`${ep.name}: no model id set. Open Settings → Models.`);
    }
    return {
      provider: "openai-compatible",
      modelId: ep.modelId.trim(),
      options: { openaiCompatibleBaseURL: ep.baseURL },
      endpointKey: local.customEndpointKeys?.[eid],
    };
  }
  const m = resolveModel(modelId);
  let resolvedId: string = m.id;
  if (m.id === "lmstudio-local") {
    if (!local.lmstudioModelId?.trim()) {
      throw new Error(
        "LM Studio: no model id set. Open Settings → Models and enter the model id loaded in LM Studio.",
      );
    }
    resolvedId = local.lmstudioModelId.trim();
  } else if (m.id === "mlx-local") {
    if (!local.mlxModelId?.trim()) {
      throw new Error(
        "MLX: no model id set. Open Settings → Models and enter the model id served by mlx_lm.server.",
      );
    }
    resolvedId = local.mlxModelId.trim();
  } else if (m.id === "ollama-local") {
    if (!local.ollamaModelId?.trim()) {
      throw new Error(
        "Ollama: no model id set. Open Settings → Models and enter the model id (e.g. the name from `ollama list`).",
      );
    }
    resolvedId = local.ollamaModelId.trim();
  } else if (m.id === "openai-compatible-custom") {
    if (!local.openaiCompatibleModelId?.trim()) {
      throw new Error(
        "OpenAI-compatible: no model id set. Open Settings → Models.",
      );
    }
    resolvedId = local.openaiCompatibleModelId.trim();
  } else if (m.id === "openrouter-custom") {
    if (!local.openrouterModelId?.trim()) {
      throw new Error(
        "OpenRouter: no model id set. Open Settings → Models and enter an OpenRouter model id (e.g. anthropic/claude-sonnet-5).",
      );
    }
    resolvedId = local.openrouterModelId.trim();
  }
  return {
    provider: m.provider,
    modelId: resolvedId,
    options: {
      lmstudioBaseURL: local.lmstudioBaseURL,
      mlxBaseURL: local.mlxBaseURL,
      ollamaBaseURL: local.ollamaBaseURL,
      openaiCompatibleBaseURL: local.openaiCompatibleBaseURL,
    },
  };
}

/** Why `modelId` cannot run with this configuration, or null when it can:
 *  the same checks buildConfiguredLanguageModel makes, for gating an action
 *  before it starts. */
export function modelConfigProblem(
  modelId: string,
  keys: ProviderKeys,
  local: LocalProviderConfig = {},
): string | null {
  try {
    const { provider } = resolveModelTarget(modelId, local);
    return providerNeedsKey(provider) && !keys[provider]
      ? missingKeyMessage(provider)
      : null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
