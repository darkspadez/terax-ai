import { useShallow } from "zustand/react/shallow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { Preferences } from "@/modules/settings/store";
import type { CustomEndpointKeys } from "../lib/keyring";
import {
  type LocalProviderConfig,
  modelConfigProblem,
} from "../lib/modelTarget";
import { useChatStore } from "./chatStore";

function modelConfigOf(
  prefs: Preferences,
  customEndpointKeys: CustomEndpointKeys,
): LocalProviderConfig {
  return {
    lmstudioBaseURL: prefs.lmstudioBaseURL,
    lmstudioModelId: prefs.lmstudioModelId,
    mlxBaseURL: prefs.mlxBaseURL,
    mlxModelId: prefs.mlxModelId,
    ollamaBaseURL: prefs.ollamaBaseURL,
    ollamaModelId: prefs.ollamaModelId,
    openaiCompatibleBaseURL: prefs.openaiCompatibleBaseURL,
    openaiCompatibleModelId: prefs.openaiCompatibleModelId,
    openrouterModelId: prefs.openrouterModelId,
    customEndpoints: prefs.customEndpoints,
    customEndpointKeys,
  };
}

/** Everything a model build reads besides the provider keys: local servers,
 *  custom endpoints and their keys. Callers outside the chat take it whole,
 *  so none can leave out the part a custom endpoint needs. */
export function liveModelConfig(): LocalProviderConfig {
  return modelConfigOf(
    usePreferencesStore.getState(),
    useChatStore.getState().customEndpointKeys,
  );
}

/** Why the selected chat model cannot run right now, or null when it can. */
export function useSelectedModelProblem(): string | null {
  const { modelId, keys, endpointKeys } = useChatStore(
    useShallow((s) => ({
      modelId: s.selectedModelId,
      keys: s.apiKeys,
      endpointKeys: s.customEndpointKeys,
    })),
  );
  const config = usePreferencesStore(
    useShallow((s) => modelConfigOf(s, endpointKeys)),
  );
  return modelConfigProblem(modelId, keys, config);
}
