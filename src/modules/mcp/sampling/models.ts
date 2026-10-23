import {
  compatModelIdForEndpoint,
  MODELS,
  resolveModel,
} from "@/modules/ai/config";
import type { ProviderKeys } from "@/modules/ai/lib/keyring";
import {
  type LocalProviderConfig,
  modelConfigProblem,
  resolveModelTarget,
} from "@/modules/ai/lib/modelTarget";
import type { ModelChoice } from "../lib/sampling";

/**
 * A model as the sampling dialog names it: its label, with the id a local
 * server or endpoint runs when that differs ("LM Studio (qwen3)").
 */
export function samplingModelChoice(
  id: string,
  config: LocalProviderConfig,
): ModelChoice {
  let label = id;
  try {
    label = resolveModel(id, config.customEndpoints ?? []).label;
    const target = resolveModelTarget(id, config).modelId;
    if (target !== id && !label.includes(target))
      label = `${label} (${target})`;
  } catch {
    // An id whose configuration is missing keeps its id as its name.
  }
  return { id, label };
}

/** Every model that can run now: its provider has a key, its server an id. */
export function usableSamplingModels(
  keys: ProviderKeys,
  config: LocalProviderConfig,
): ModelChoice[] {
  const ids = [
    ...MODELS.map((m) => m.id as string),
    ...(config.customEndpoints ?? []).map((e) =>
      compatModelIdForEndpoint(e.id),
    ),
  ];
  return ids
    .filter((id) => modelConfigProblem(id, keys, config) === null)
    .map((id) => samplingModelChoice(id, config));
}
