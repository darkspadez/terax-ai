import type { CustomEndpoint } from "../config";

/**
 * A custom endpoint Settings can add ready-made: it fills the name and base
 * URL, and the result is an ordinary custom endpoint (its key in the OS
 * keychain, its model picked from the server's `GET <base>/models` list).
 */
export type EndpointPreset = {
  id: string;
  label: string;
  baseURL: string;
  /** Where the user gets an API key. */
  keyUrl: string;
  /** One line shown above the endpoint's fields. */
  hint: string;
};

export const ENDPOINT_PRESETS: readonly EndpointPreset[] = [
  {
    id: "opencode-go",
    label: "OpenCode Go",
    // The gateway's OpenAI-compatible API, which also lists its models. It
    // takes only requests with `x-opencode-session` (`opencodeSession.ts`).
    baseURL: "https://opencode.ai/zen/go/v1",
    keyUrl: "https://opencode.ai/console",
    hint: "Your OpenCode Go subscription, through its OpenAI-compatible API. Save your key, then pick a model with Browse; a model OpenCode serves only through another API may not answer here.",
  },
];

const DEFAULT_CONTEXT_LIMIT = 128_000;

/** A new custom endpoint: empty, or filled from `preset`. */
export function newCustomEndpoint(
  id: string,
  preset?: EndpointPreset,
): CustomEndpoint {
  return {
    id,
    name: preset?.label ?? "",
    baseURL: preset?.baseURL ?? "",
    modelId: "",
    contextLimit: DEFAULT_CONTEXT_LIMIT,
  };
}

const comparable = (url: string) =>
  url.trim().replace(/\/+$/, "").toLowerCase();

/** The preset whose base URL an endpoint still uses, if any. */
export function endpointPresetFor(baseURL: string): EndpointPreset | null {
  const url = comparable(baseURL);
  if (!url) return null;
  return ENDPOINT_PRESETS.find((p) => comparable(p.baseURL) === url) ?? null;
}
